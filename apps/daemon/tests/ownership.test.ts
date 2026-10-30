import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it } from "vitest";

const sdk = pathToFileURL(createRequire(import.meta.url).resolve("@perishcode/sidecar")).href;
const worker = `import {serve,Client} from ${JSON.stringify(sdk)};
import {writeFile} from 'node:fs/promises';import {join} from 'node:path';
let service;
try {
  service=await serve(process.argv[2],undefined,undefined,process.argv[1]);
  const client=new Client(service.endpoint,service.authority);
  const data=await client.grant('slim',{kind:'data',name:'probe',scope:'namespace'});
  const staging=await client.grant('slim',{kind:'staging',name:'probe',owner:'attempt',scope:'attempt'});
  const port=await client.grant('slim',{kind:'port',name:'probe',owner:'attempt',scope:'attempt'});
  await writeFile(join(data.value,'probe.json'),JSON.stringify({retained:true}));
  console.log(JSON.stringify({status:'owned',pid:process.pid,data:data.value,staging:staging.value,port:port.value}));
  process.stdin.resume();
  process.stdin.once('data',async()=>{await service.close();process.stdin.destroy();});
} catch(error) {console.log(JSON.stringify({status:'blocked',error:error.message}));}`;
type Reply = { status: string; error?: string; pid: number; data: string; staging: string; port: string };
async function start(root: string, name: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", worker, root, join(root, `${name}.sock`)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const reply = await new Promise<Reply>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ownership worker timeout"));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited before reply: ${code}`));
    });
    lines.once("line", (line) => {
      clearTimeout(timer);
      lines.close();
      done(JSON.parse(line));
    });
  });
  return { child, reply };
}
async function finish(child: ChildProcess, crash = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>((done) => child.once("exit", () => done()));
  if (crash) child.kill("SIGKILL");
  else child.stdin?.end("stop");
  await ended;
}
it("consumes exclusive ownership, normal replacement and interrupted truth from the registry package", async () => {
  const root = await mkdtemp(join(tmpdir(), "slim-owner-"));
  const children: ChildProcess[] = [];
  const cases: string[] = [];
  try {
    const contenders = await Promise.all(Array.from({ length: 3 }, (_, n) => start(root, `m${n}`)));
    children.push(...contenders.map(({ child }) => child));
    const winners = contenders.filter(({ reply }) => reply.status === "owned");
    assert.equal(winners.length, 1);
    assert.equal(contenders.filter(({ reply }) => reply.status === "blocked").length, 2);
    const first = winners[0];
    assert.ok(first);
    const registry = join(root, "namespaces/slim/registry.json");
    const before = await readFile(registry, "utf8");
    const blocked = await start(root, "blocked");
    children.push(blocked.child);
    assert.equal(blocked.reply.status, "blocked");
    assert.equal(await readFile(registry, "utf8"), before);
    cases.push("concurrent real controllers elect one owner; contenders leave resource truth unchanged");
    await finish(first.child);
    const replacement = await start(root, "replacement");
    children.push(replacement.child);
    assert.equal(replacement.reply.status, "owned");
    assert.notEqual(replacement.reply.pid, first.reply.pid);
    assert.equal(replacement.reply.data, first.reply.data);
    await assert.rejects(stat(first.reply.staging), { code: "ENOENT" });
    cases.push("normal drain permits replacement, retains data and retires old attempt paths");
    const interrupted = await readFile(registry, "utf8");
    await finish(replacement.child, true);
    const restart = await start(root, "restart");
    children.push(restart.child);
    assert.equal(restart.reply.status, "blocked");
    assert.match(restart.reply.error ?? "", /interrupted; recovery required/);
    assert.equal(await readFile(registry, "utf8"), interrupted);
    assert.equal((await stat(replacement.reply.staging)).isDirectory(), true);
    assert.deepEqual(JSON.parse(await readFile(join(replacement.reply.data, "probe.json"), "utf8")), {
      retained: true,
    });
    const address = new URL(replacement.reply.port);
    const observer = createServer();
    await new Promise<void>((done, reject) => {
      observer.once("error", reject);
      observer.listen(Number(address.port), address.hostname, done);
    });
    await new Promise<void>((done) => observer.close(() => done()));
    cases.push("SIGKILL releases the OS-held port but preserves interrupted ownership, registry and paths");
    const version = JSON.parse(
      await readFile(join(dirname(dirname(fileURLToPath(sdk))), "package.json"), "utf8"),
    ).version;
    await mkdir("../../.artifacts/control", { recursive: true });
    await writeFile(
      "../../.artifacts/control/ownership.json",
      JSON.stringify(
        {
          result: "passed",
          version,
          resolved: sdk,
          platform: process.platform,
          architecture: process.arch,
          cases,
          contenders: contenders.map(({ reply }) => ({ status: reply.status, pid: reply.pid, error: reply.error })),
          first: first.reply,
          replacement: replacement.reply,
          restart: { status: restart.reply.status, error: restart.reply.error },
          firstExit: first.child.exitCode,
          interruptedSignal: replacement.child.signalCode,
          registryBeforeRestart: createHash("sha256").update(interrupted).digest("hex"),
          registryAfterRestart: createHash("sha256")
            .update(await readFile(registry))
            .digest("hex"),
          observedPortReusable: true,
          dataRetained: true,
          unqualified: [
            "automatic interrupted adoption",
            "surviving managed child takeover",
            "four-unit runtime convergence",
          ],
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ result: "passed", receipt: "../../.artifacts/control/ownership.json", version, cases }),
    );
  } finally {
    await Promise.all(children.map((child) => finish(child, true)));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
