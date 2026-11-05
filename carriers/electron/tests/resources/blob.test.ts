import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { waitGone } from "@perishcode/automation";
import { type Resource, resourceKey, type State, type Use } from "@perishcode/blob";
import type { HostReceipt } from "@perishcode/electron";
import { Inspector } from "@perishcode/inspect";
import { digest, namespace } from "@perishcode/protocol";
import { bundle } from "@perishcode/release";
import { readProduct } from "@perishcode/runtime";
import { Sources } from "@perishcode/serve";
import { inspectRecovery, observeProcesses, recover, serve } from "@perishcode/sidecar";
import { it } from "vitest";
import type { ResourceRequest } from "../../src/resources.js";

type BlobStatus = {
  pid: number;
  state: State;
  owner: { identity: { service: string }; incarnation: string; logs: string };
};
const resource = (bytes: Uint8Array, type: Resource["type"] = "file"): Resource => ({
  type,
  artifact: { kind: "blob", slot: "dynamic", digest: digest(bytes), bytes: bytes.length },
});
it.runIf(process.platform === "darwin" && process.env.PESUITE_BLOB_E2E === "1")(
  "loads file/directory resources in a real installed Electron and reconciles interrupted load/GC",
  async () => {
    const repository = resolve("../.."),
      root = join(repository, `.artifacts/blob/${Date.now()}`);
    await mkdir(root, { recursive: true });
    const run = (args: string[]) =>
      promisify(execFile)("pnpm", args, { cwd: repository, timeout: 120000, encoding: "utf8" });
    await run(["build"]);
    const seed = join(root, "seed");
    await run([
      "exec",
      "pesuite",
      "release",
      "--capsule",
      "carriers/electron/dist/capsule",
      "--web",
      "apps/web/dist",
      "--daemon",
      "apps/daemon/dist",
      "--blob",
      "probe=carriers/electron/dist/capsule/probe.bin",
      "--output",
      seed,
    ]);
    const product = await readProduct(seed);
    await run([
      "exec",
      "pesuite",
      "pack",
      "--carrier",
      "carriers/electron/dist",
      "--seed",
      seed,
      "--output",
      join(root, "package"),
      "--receipt",
      join(root, "package.json"),
    ]);
    const installed = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const fixtures = join(root, "fixtures"),
      tree = join(root, "tree");
    await mkdir(fixtures);
    await mkdir(join(tree, "nested"), { recursive: true });
    const bytes = Buffer.from("actual dynamic file");
    await writeFile(join(fixtures, "file.bin"), bytes);
    await writeFile(join(tree, "nested/value.txt"), "actual directory member");
    const directory = await bundle(tree);
    await writeFile(join(fixtures, "directory.bin"), directory);
    const file = resource(bytes),
      archive = resource(directory, "directory"),
      scope = { channel: product.manifest.channel, namespace: namespace("slim") };
    const sources = await Sources.open({
        data: join(root, "serve"),
        scope,
        sources: { blobs: { directory: fixtures } },
      }),
      endpoint = sources.endpoints[0]!.url;
    const controller = await serve(join(tmpdir(), `blob-e2e-${process.pid}.sock`), { root: join(root, "controller") }),
      factory = controller.factory({ ...scope, namespace: namespace("validation") });
    const results: unknown[] = [];
    const start = async (name: string, data: string, pause = "none") => {
      const receipt = join(root, name + ".json");
      const lease = await factory.start({
        service: name,
        generation: product.envelope.digest,
        command: join(installed.app, "Contents/MacOS/od"),
        ready: `inspect-ready:${product.envelope.digest}`,
        timeout: 25000,
        env: {
          PESUITE_DATA: data,
          PESUITE_AUTOMATION: "1",
          PESUITE_PROBE: "0",
          PESUITE_INSPECT: "1",
          PESUITE_BLOB_PROBE: "1",
          PESUITE_BLOB_PAUSE: pause,
          PESUITE_BLOB_RETENTION: pause === "none" ? "1000" : "0",
          PESUITE_RECEIPT: receipt,
        },
      });
      const inspector = await Inspector.open(data, scope, 60000),
        peer = await inspector.target<{
          blobs: { input: ResourceRequest; output: unknown };
          status: { input: null; output: HostReceipt };
          read: { input: null; output: Record<string, unknown> };
          write: { input: unknown; output: unknown };
        }>("host", product.envelope.digest);
      return { lease, peer, call: <T>(request: ResourceRequest) => peer.call("blobs", request) as Promise<T>, receipt };
    };
    const record = async () =>
      writeFile(
        join(root, "receipt.json"),
        JSON.stringify(
          {
            result: "passed",
            installed: installed.app,
            source: endpoint,
            results,
            scope:
              "unsigned macOS arm64 installed Electron, managed static transport, typed library references/occupancy/grace/GC and explicit root recovery",
          },
          null,
          2,
        ),
      );
    try {
      const data = join(root, "normal"),
        normal = await start("normal", data);
      await normal.peer.call("write", { retained: "user data survives GC" });
      for (const kind of ["current", "prepared", "recovery"] as const)
        await normal.call({ op: "retain", kind, name: "generation1", resources: [file, archive] });
      await normal.call({ op: "prefetch", resource: file, url: endpoint + "/file.bin" });
      await sources.fault("blobs", { mode: "missing", path: "/file.bin" });
      const uses = await Promise.all([
        normal.call<Use>({ op: "acquire", resource: file, url: endpoint + "/file.bin", epoch: "document1" }),
        normal.call<Use>({ op: "acquire", resource: file, url: endpoint + "/file.bin", epoch: "document2" }),
        normal.call<Use>({ op: "acquire", resource: archive, url: endpoint + "/directory.bin" }),
      ]);
      assert.equal(uses[0]!.path, uses[1]!.path);
      const a = await normal.call<{ pid: number; value: string }>({ op: "read", use: uses[0]! }),
        b = await normal.call<{ pid: number; value: string }>({ op: "read", use: uses[2]!, file: "nested/value.txt" });
      assert.equal(a.pid, normal.lease.pid);
      assert.equal(a.value, bytes.toString());
      assert.equal(b.value, "actual directory member");
      assert.deepEqual(await normal.call({ op: "collect" }), []);
      for (const kind of ["current", "prepared", "recovery"] as const)
        await normal.call({ op: "unretain", kind, name: "generation1" });
      assert.deepEqual(await normal.call({ op: "collect" }), []);
      for (const use of uses) await normal.call({ op: "release", use });
      assert.deepEqual(await normal.call({ op: "collect" }), []);
      await new Promise((done) => setTimeout(done, 1100));
      const removed = await normal.call<string[]>({ op: "collect" });
      assert.equal(removed.length, 2);
      for (const use of uses) await assert.rejects(readFile(use.path), /ENOENT/);
      assert.equal((await normal.peer.call("read", null)).retained, "user data survives GC");
      const status = await normal.call<BlobStatus>({ op: "status" });
      assert.deepEqual(status.state.entries, {});
      assert.equal(status.owner.identity.service, "host");
      const running = await normal.peer.call("status", null);
      assert.equal(running.automation.shown, false);
      assert.equal(running.automation.focused, false);
      assert.ok(running.directory.instances.every((i) => i.service !== "capsule"));
      await normal.peer.stop();
      await waitGone(normal.lease.pid, 10000);
      await factory.release(normal.lease);
      assert.equal(JSON.parse(await readFile(normal.receipt + ".stop.json", "utf8")).status, "stopped");
      await sources.fault("blobs", null);
      results.push({ scenario: "normal", a, b, removed, running, result: "passed" });
      await record();
      for (const phase of ["loading", "materialized", "deleting"] as const) {
        const data = join(root, phase),
          active = await start(phase, data, phase),
          before = await active.call<BlobStatus>({ op: "status" });
        await active.peer.call("write", { retained: phase });
        const pending = (async () => {
          const use = await active.call<Use>({ op: "acquire", resource: file, url: endpoint + "/file.bin" });
          await active.call({ op: "release", use });
          await active.call({ op: "collect" });
        })();
        void pending.catch(() => {});
        const marker = join(before.owner.logs, `blob-${phase}.json`);
        let seen: unknown;
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          try {
            seen = JSON.parse(await readFile(marker, "utf8"));
            break;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          await new Promise((done) => setTimeout(done, 30));
        }
        assert.ok(seen, "checkpoint missing");
        process.kill(active.lease.pid, "SIGKILL");
        await waitGone(active.lease.pid, 10000);
        await factory.release(active.lease);
        await assert.rejects(pending);
        const drained = Date.now() + 10000;
        while ((await observeProcesses(data, scope)).length) {
          if (Date.now() > drained) throw Error("old managed processes remain");
          await new Promise((done) => setTimeout(done, 30));
        }
        const rejected = await runFailedStart(phase, data, start);
        const recovery = await inspectRecovery(data);
        assert.equal(recovery.phase, "ready");
        await recover(data, { expected: recovery.fingerprint });
        const fresh = await start(phase + "restored", data),
          state = await fresh.call<BlobStatus>({ op: "status" }),
          entry = state.state.entries[resourceKey(file)];
        if (phase === "deleting") assert.equal(entry, undefined);
        else {
          assert.equal(entry?.phase, "failed");
          assert.equal(entry?.uses.length, 0);
          assert.equal(entry?.operation, undefined);
        }
        if (phase === "materialized") await sources.fault("blobs", { mode: "missing", path: "/file.bin" });
        const use = await fresh.call<Use>({ op: "acquire", resource: file, url: endpoint + "/file.bin" }),
          read = await fresh.call<{ pid: number; value: string }>({ op: "read", use });
        assert.equal(read.pid, fresh.lease.pid);
        assert.equal(read.value, bytes.toString());
        assert.equal((await fresh.peer.call("read", null)).retained, phase);
        await fresh.call({ op: "release", use });
        await new Promise((done) => setTimeout(done, 1100));
        assert.deepEqual(await fresh.call({ op: "collect" }), [resourceKey(file)]);
        await fresh.peer.stop();
        await waitGone(fresh.lease.pid, 10000);
        await factory.release(fresh.lease);
        assert.equal(JSON.parse(await readFile(fresh.receipt + ".stop.json", "utf8")).status, "stopped");
        await sources.fault("blobs", null);
        results.push({
          scenario: phase,
          checkpoint: seen,
          rejected,
          recovery,
          read,
          before: before.state,
          after: state.state,
          oldPid: active.lease.pid,
          newPid: fresh.lease.pid,
          result: "passed",
        });
        await record();
      }
    } finally {
      await controller.close();
      await sources.close();
    }
  },
  240000,
);
async function runFailedStart(phase: string, data: string, start: (name: string, data: string) => Promise<unknown>) {
  let rejection = "";
  await assert.rejects(async () => {
    try {
      return await start(phase + "blocked", data);
    } catch (error) {
      rejection = String(error);
      throw error;
    }
  }, /interrupted|recovery/);
  return rejection;
}
