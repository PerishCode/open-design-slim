import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { channel, digest, namespace } from "@perishcode/protocol";
import { Client, type Directory, readDirectory, type Service, serve } from "@perishcode/sidecar";
import { it } from "vitest";

const identity = {
  namespace: namespace("slim"),
  channel: channel("stable"),
  generation: digest("directory probe"),
  service: "probe",
};
const options = { identity, handlers: {}, lifecycle: { initialize: async () => {}, stop: async () => {} } };
const sdk = pathToFileURL(createRequire(import.meta.url).resolve("@perishcode/sidecar")).href;
const worker = `import {serve} from ${JSON.stringify(sdk)};
const [root,identity]=process.argv.slice(1);const service=await serve(root+'/crash.sock');
const attached=await service.expose({identity:JSON.parse(identity),handlers:{},lifecycle:{initialize:async(context)=>{
  await context.allocate({kind:'lock',name:'probe'});
},stop:async()=>{}}});
console.log(JSON.stringify({view:service.directory(),data:attached.context.roots.data}));
process.stdin.resume();process.once('SIGTERM',async()=>{await service.close();process.stdin.destroy();});`;
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
it("keeps namespace inventory and reads committed instances after an interrupted manager", async () => {
  const root = await mkdtemp(join(tmpdir(), "slim-directory-"));
  const services: Service[] = [];
  let child: ChildProcess | undefined;
  try {
    const server = await serve(join(root, "first.sock"));
    services.push(server);
    const client = new Client(server.endpoint, server.authority);
    const attached = await server.expose(options);
    await writeFile(join(attached.context.roots.data, "probe.json"), JSON.stringify({ retained: true }));
    const lease = await client.start({
      namespace: identity.namespace,
      channel: identity.channel,
      generation: identity.generation,
      slot: "daemon",
      command: process.execPath,
      args: ["-e", "process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
      ready: "ready",
      grace: 100,
    });
    const ready = await client.directory(identity.namespace);
    assert.equal(ready.instances.find((entry) => entry.kind === "process")?.pid, lease.pid);
    assert.equal(ready.instances.find((entry) => entry.kind === "hosted")?.incarnation, attached.context.incarnation);
    assert.equal(ready.namespaces[0]?.phase, "ready");
    assert.ok(ready.namespaces[0]?.incarnation);
    assert.equal(JSON.stringify(ready).includes(lease.capability), false);
    assert.equal(JSON.stringify(ready).includes(server.authority), false);
    await assert.rejects(readDirectory(root), /held/);
    await client.release(lease);
    await attached.close();
    await server.close();
    const closed = await readDirectory(root, identity.namespace);
    assert.equal(closed.manager.phase, "closed");
    assert.ok(closed.instances.every((entry) => entry.phase === "retired"));
    const next = await serve(join(root, "next.sock"));
    services.push(next);
    const carried = next.directory(identity.namespace);
    assert.notEqual(carried.manager.incarnation, closed.manager.incarnation);
    assert.deepEqual(carried.namespaces, closed.namespaces);
    assert.deepEqual(carried.instances, closed.instances);
    const replacement = await next.expose({
      ...options,
      identity: { ...identity, generation: digest("next directory probe") },
    });
    assert.equal(replacement.context.roots.data, attached.context.roots.data);
    await attached.close();
    await server.close();
    assert.equal(next.directory().instances.find((entry) => entry.kind === "hosted")?.phase, "ready");
    await replacement.close();
    await next.close();
    child = spawn(process.execPath, ["--input-type=module", "-e", worker, root, JSON.stringify(identity)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.ok(child.stdout);
    const lines = createInterface({ input: child.stdout });
    const published = await new Promise<{ view: Directory; data: string }>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("directory worker timeout")), 5000);
      child?.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child?.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("directory worker exited"));
      });
      lines.once("line", (line) => {
        clearTimeout(timer);
        lines.close();
        done(JSON.parse(line));
      });
    });
    const managerFile = join(root, "manager.sqlite");
    const registryFile = join(root, "namespaces/slim/registry.json");
    const managerBefore = hash(await readFile(managerFile));
    const registryBefore = hash(await readFile(registryFile));
    const exited = new Promise<void>((done) => child?.once("exit", () => done()));
    child.kill("SIGKILL");
    await exited;
    const interrupted = await readDirectory(root, identity.namespace);
    assert.equal(interrupted.manager.phase, "interrupted");
    assert.equal(interrupted.revision, published.view.revision);
    assert.deepEqual(interrupted.instances, published.view.instances);
    assert.deepEqual(interrupted.namespaces, published.view.namespaces);
    assert.equal(hash(await readFile(managerFile)), managerBefore);
    assert.equal(hash(await readFile(registryFile)), registryBefore);
    assert.deepEqual(JSON.parse(await readFile(join(published.data, "probe.json"), "utf8")), { retained: true });
    await assert.rejects(serve(join(root, "blocked.sock")), /recovery required/);
    const version = JSON.parse(
      await readFile(join(dirname(dirname(fileURLToPath(sdk))), "package.json"), "utf8"),
    ).version;
    await mkdir("../../.artifacts/control", { recursive: true });
    await writeFile(
      "../../.artifacts/control/directory.json",
      JSON.stringify(
        {
          result: "passed",
          version,
          resolved: sdk,
          ready,
          closed,
          carried,
          published: published.view,
          interrupted,
          managerBefore,
          managerAfter: hash(await readFile(managerFile)),
          registryBefore,
          registryAfter: hash(await readFile(registryFile)),
          interruptedSignal: child.signalCode,
          dataRetained: true,
          unqualified: [
            "recovery writes",
            "live-child adoption",
            "lifecycle sessions",
            "four-unit control-plane convergence",
          ],
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ result: "passed", version, receipt: "../../.artifacts/control/directory.json" }));
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) => child?.once("exit", () => done()));
      child.kill("SIGTERM");
      await exited;
    }
    await Promise.all(services.map((service) => service.close()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
