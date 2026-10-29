import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { compose } from "@perishcode/release";
import { readProduct, writeProduct } from "@perishcode/runtime";

if (process.platform !== "darwin") throw new Error("this acceptance requires macOS and an available desktop session");
const execute = promisify(execFile);
const root = resolve(".artifacts/skeleton");
await mkdir(root, { recursive: true });
const state = join(root, `state-${Date.now()}`);
const cases = [];
const steps = [];
const step = async (name, run) => {
  const start = performance.now();
  const result = await run();
  steps.push({ name, milliseconds: performance.now() - start });
  return result;
};
const build = (marker) => execute("pnpm", ["build"], { env: { ...process.env, PESUITE_BUILD: marker } });
await step("build skeleton1", () => build("skeleton1"));
const first = await readProduct(".artifacts/seed");
await step("package once", () => execute("pnpm", ["package"]));
const packaged = JSON.parse(await readFile(".artifacts/package.json", "utf8"));
const app = join(root, `installed-${Date.now()}`, basename(packaged.app));
await cp(packaged.app, app, { recursive: true, verbatimSymlinks: true });
const executable = join(app, "Contents/MacOS", first.manifest.identity.scheme);

async function fingerprint(path) {
  const hash = createHash("sha256");
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(directory, entry.name);
      const record = { path: file.slice(path.length), kind: "file" };
      if (entry.isSymbolicLink()) {
        record.kind = "symlink";
        record.target = await readlink(file);
      } else {
        record.mode = (await stat(file)).mode;
        if (entry.isDirectory()) record.kind = "directory";
        else
          record.sha256 = createHash("sha256")
            .update(await readFile(file))
            .digest("hex");
      }
      hash.update(`${JSON.stringify(record)}\n`);
      if (entry.isDirectory()) await walk(file);
    }
  }
  await walk(path);
  return hash.digest("hex");
}
const physicalBefore = await fingerprint(app);

async function launch(name, extra = {}, expected = 0, message) {
  const receipt = join(root, `${name}.json`);
  await rm(receipt, { force: true });
  await rm(`${receipt}.stop.json`, { force: true });
  const execution = execute(executable, [], {
    timeout: 30000,
    env: { ...process.env, PESUITE_DATA: state, PESUITE_PROBE: "1", PESUITE_RECEIPT: receipt, ...extra },
  });
  const { stdout, stderr } = await execution.then(
    (value) => {
      assert.equal(expected, 0, `${name} unexpectedly passed`);
      return value;
    },
    (error) => {
      if (expected === 0) throw error;
      assert.equal(error.code, expected);
      return error;
    },
  );
  cases.push({ name, expectedExit: expected, stdout, stderr });
  if (message) assert.ok(stderr.includes(message), `${name}: unexpected failure: ${stderr}`);
  if (expected !== 0) return;
  const result = JSON.parse(await readFile(receipt, "utf8"));
  assert.equal(result.pid, execution.child.pid, "receipt belongs to a different host process");
  const stop = JSON.parse(await readFile(`${receipt}.stop.json`, "utf8"));
  assert.equal(result.generation, result.daemon.generation);
  assert.equal(result.nonce, result.daemon.nonce);
  assert.equal(stop.status, "stopped");
  assert.deepEqual(stop.survivors, []);
  assert.equal(alive(result.daemon.pid), false);
  assert.equal(alive(result.pid), false);
  return result;
}
const initial = await step("installed initial", () => launch("initial"));
assert.equal(initial.generation, first.envelope.digest);
assert.equal(initial.capsule, "capsule:skeleton1:blob:skeleton1");
assert.equal(initial.renderer, "web:skeleton1:launch1");
const cold = await step("cold start", () => launch("cold"));
assert.equal(cold.renderer, "web:skeleton1:launch2");

await step("build skeleton2 without repackaging host", () => build("skeleton2"));
const second = await readProduct(".artifacts/seed");
for (const key of ["capsule", "daemon", "web"])
  assert.notEqual(first.envelope.generation[key].digest, second.envelope.generation[key].digest);
assert.notEqual(first.envelope.generation.blobs[0].digest, second.envelope.generation.blobs[0].digest);
const update = await step("activate four new contents", () =>
  launch("update", { PESUITE_CANDIDATE: resolve(".artifacts/seed") }),
);
assert.equal(update.generation, second.envelope.digest);
assert.equal(update.capsule, "capsule:skeleton2:blob:skeleton2");
assert.equal(update.daemon.witness, "daemon:skeleton2");
assert.equal(update.renderer, "web:skeleton2:launch3");
const selected = await launch("updated-cold");
assert.equal(selected.generation, second.envelope.digest);
assert.equal(selected.renderer, "web:skeleton2:launch4");

const incompatible = await compose(second.manifest, {
  carrier: 999,
  capsule: "apps/capsule/dist",
  daemon: "apps/daemon/dist",
  web: "apps/web/dist",
});
await writeProduct(join(root, "incompatible"), incompatible);
await launch("incompatible", { PESUITE_CANDIDATE: join(root, "incompatible") }, 1, "incompatible carrier ABI");
const afterCompatibility = await launch("after-compatibility");
assert.equal(afterCompatibility.generation, second.envelope.digest);

const broken = join(root, "broken-capsule");
await mkdir(broken, { recursive: true });
await writeFile(
  join(broken, "index.mjs"),
  'export async function activate() { throw new Error("injected capsule failure") }',
);
const failed = await compose(second.manifest, {
  carrier: 1,
  capsule: broken,
  daemon: "apps/daemon/dist",
  web: "apps/web/dist",
});
await writeProduct(join(root, "failed"), failed);
await launch("failed", { PESUITE_CANDIDATE: join(root, "failed") }, 1, "injected capsule failure");
await launch("blocked", {}, 1, "capsule startup is blocked");
const recovered = await launch("recovered", { PESUITE_RECOVER: "1" });
assert.equal(recovered.generation, second.envelope.digest);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}
// A real SIGKILL, after readiness, exercises the daemon's parent-pipe lifeline.
const crashReceipt = join(root, "crash.json");
await rm(crashReceipt, { force: true });
const child = spawn(executable, [], {
  env: { ...process.env, PESUITE_DATA: state, PESUITE_RECEIPT: crashReceipt },
  stdio: "ignore",
});
const exited = new Promise((done) => child.once("exit", done));
let crash;
try {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      crash = JSON.parse(await readFile(crashReceipt, "utf8"));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.ok(crash, "interactive host never reached readiness");
  assert.equal(crash.pid, child.pid);
} finally {
  child.kill("SIGKILL");
  await exited;
}
const deadline = Date.now() + 5000;
while (alive(crash.daemon.pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
assert.equal(alive(crash.daemon.pid), false, "daemon survived parent SIGKILL");
const afterCrash = await launch("after-crash");
assert.equal(afterCrash.generation, second.envelope.digest);
const physicalAfter = await fingerprint(app);
assert.equal(physicalAfter, physicalBefore, "installed host bytes changed during content activation");
const receipt = {
  schema: 1,
  result: "passed",
  platform: process.platform,
  architecture: process.arch,
  app,
  state,
  executable,
  physicalBefore,
  physicalAfter,
  first: first.envelope,
  second: second.envelope,
  initial,
  update,
  recovered,
  afterCrash,
  crash,
  cases,
  steps,
  scope: "four-unit skeleton only; local content feed; unsigned macOS; no OpenDesign features",
  unqualified: [
    "signed installers",
    "remote authenticated feed",
    "Windows/Linux process trees",
    "system-wide helper census",
    "crash during commit",
  ],
};
await writeFile(join(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ result: receipt.result, receipt: join(root, "receipt.json"), app })}\n`);
