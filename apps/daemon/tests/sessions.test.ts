import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { channel, digest, namespace } from "@perishcode/protocol";
import { Client, type Lease, readDirectory, serve } from "@perishcode/sidecar";
import { it } from "vitest";

const scope = { namespace: namespace("slim"), channel: channel("stable") };
const other = { ...scope, channel: channel("beta") };
const identity = { ...scope, generation: digest("sessions probe"), service: "probe" };
const sdk = pathToFileURL(createRequire(import.meta.url).resolve("@perishcode/sidecar")).href;
function deferred() {
  let done = () => {};
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, done };
}
async function worker(program: string, args: string[]) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", program, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("session worker timeout"));
    }, 5000);
    child.once("error", (fault) => {
      clearTimeout(timer);
      reject(fault);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("session worker exited"));
    });
    lines.once("line", () => {
      clearTimeout(timer);
      lines.close();
      done();
    });
  });
  return child;
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGKILL");
  await exited;
}
it("consumes lifecycle sessions from the package boundary and preserves interrupted ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "slim-sessions-"));
  const children: ChildProcess[] = [];
  const service = await serve(join(root, "local/manager.sock"));
  try {
    const client = new Client(service.endpoint, service.authority);
    let lease: Lease | undefined;
    const attached = await service.session(scope, () =>
      service.expose({
        identity,
        handlers: {},
        lifecycle: {
          initialize: async () =>
            client.session(scope, async (scoped) => {
              lease = await scoped.start({
                ...scope,
                generation: identity.generation,
                slot: "daemon",
                command: process.execPath,
                args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
                ready: "ready",
                grace: 100,
              });
            }),
          stop: async () => {
            if (lease) await client.release(lease);
          },
        },
      }),
    );
    const nested = service.directory();
    assert.equal(nested.sessions[0]?.phase, "completed");
    assert.equal(nested.instances.length, 2);
    const entered = deferred(),
      gate = deferred();
    const trace: string[] = [];
    let retained: Client | undefined;
    const first = client.session(scope, async () => {
      entered.done();
      await gate.promise;
      trace.push("first");
    });
    await entered.promise;
    const second = client.session(scope, async (scoped) => {
      retained = scoped;
      trace.push("second");
    });
    try {
      await client.session(other, async () => {
        trace.push("other");
      });
      assert.deepEqual(trace, ["other"]);
    } finally {
      gate.done();
    }
    await Promise.all([first, second]);
    assert.deepEqual(trace, ["other", "first", "second"]);
    assert.ok(retained);
    await assert.rejects(retained.inspect(), /expired/);
    await assert.rejects(
      client.session(scope, async () => {
        throw new Error("probe callback");
      }),
      /probe callback/,
    );
    const failed = service.directory().sessions.find((entry) => entry.channel === scope.channel);
    assert.equal(failed?.phase, "failed");
    await client.session(scope, async (scoped) => {
      await assert.rejects(
        scoped.session(other, async () => {}),
        /cross-scope/,
      );
      await attached.close();
    });
    assert.ok(service.directory().instances.every((entry) => entry.phase === "retired"));
    await service.close();

    const faultRoot = join(root, "fault"),
      endpoint = join(faultRoot, "manager.sock");
    const authority = "slim-session-test-authority";
    const manager = await worker(
      `import {serve} from ${JSON.stringify(sdk)};
      const s=await serve(process.argv[1],undefined,process.argv[2]);console.log('ready');process.stdin.resume();
      process.stdin.on('data',async()=>{try{await s.close();console.log('closed');}catch(e){console.log(e.message);}});`,
      [endpoint, authority],
    );
    children.push(manager);
    const owner = await worker(
      `import {Client} from ${JSON.stringify(sdk)};
      const [endpoint,authority,scope]=process.argv.slice(1);await new Client(endpoint,authority,200).session(JSON.parse(scope),async()=>{
        console.log('entered');process.stdin.resume();await new Promise(()=>{});});`,
      [endpoint, authority, JSON.stringify(scope)],
    );
    children.push(owner);
    const remote = new Client(endpoint, authority);
    const active = await remote.directory(scope.namespace);
    assert.equal(active.sessions[0]?.phase, "active");
    let stolen = false;
    const blocked = assert.rejects(
      remote.session(scope, async () => {
        stolen = true;
      }),
      /interrupted/,
    );
    await remote.session(other, async () => {
      await new Promise((done) => setTimeout(done, 300));
    });
    assert.equal(stolen, false);
    await kill(owner);
    await blocked;
    const interrupted = await remote.directory(scope.namespace);
    assert.equal(interrupted.sessions.find((entry) => entry.channel === scope.channel)?.phase, "interrupted");
    await assert.rejects(
      remote.session(scope, async () => {}),
      /interrupted/,
    );
    await remote.session(other, async () => {});
    const lines = createInterface({ input: manager.stdout as NonNullable<ChildProcess["stdout"]> });
    const closing = new Promise<string>((done) =>
      lines.once("line", (line) => {
        lines.close();
        done(line);
      }),
    );
    manager.stdin?.write("close");
    assert.match(await closing, /recovery required/);
    await kill(manager);
    const offline = await readDirectory(faultRoot);
    assert.equal(offline.manager.phase, "interrupted");
    assert.equal(offline.sessions.find((entry) => entry.channel === scope.channel)?.phase, "interrupted");
    await assert.rejects(serve(join(faultRoot, "blocked.sock")), /recovery required/);
    assert.equal(JSON.stringify(interrupted).includes(authority), false);
    assert.equal(JSON.stringify(interrupted.sessions).includes("token"), false);
    const version = JSON.parse(
      await readFile(join(dirname(dirname(fileURLToPath(sdk))), "package.json"), "utf8"),
    ).version;
    await mkdir("../../.artifacts/control", { recursive: true });
    await writeFile(
      "../../.artifacts/control/sessions.json",
      JSON.stringify(
        {
          result: "passed",
          version,
          resolved: sdk,
          nested,
          trace,
          failed,
          active,
          interrupted,
          offline,
          ownerSignal: owner.signalCode,
          managerSignal: manager.signalCode,
          unqualified: [
            "recovery writes",
            "live-child adoption",
            "instance/resource-use edges",
            "four-unit control-plane convergence",
          ],
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ result: "passed", version, receipt: "../../.artifacts/control/sessions.json" }));
  } finally {
    await Promise.all(children.map(kill));
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
