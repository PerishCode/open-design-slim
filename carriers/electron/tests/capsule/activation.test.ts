import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cp, mkdir, readdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { waitGone } from "@perishcode/automation";
import { resourceKey, type State } from "@perishcode/blob";
import type { HostReceipt } from "@perishcode/electron";
import { Inspector } from "@perishcode/inspect";
import { namespace } from "@perishcode/protocol";
import { Authority, type Release, writeFeed } from "@perishcode/publish";
import { compose } from "@perishcode/release";
import { readProduct } from "@perishcode/runtime";
import { Sources } from "@perishcode/serve";
import { serve } from "@perishcode/sidecar";
import type { Methods, Status } from "@perishcode/update";
import { it } from "vitest";

it.runIf(process.platform === "darwin" && process.env.PESUITE_CAPSULE_E2E === "1")(
  "automatically replaces actual Capsule code and coordinated leaves in one installed Electron",
  async () => {
    const repository = resolve("../.."),
      root = join(repository, `.artifacts/capsule/${Date.now()}`);
    await mkdir(root, { recursive: true });
    const run = (args: string[], env: Record<string, string> = {}) =>
      promisify(execFile)("pnpm", args, {
        cwd: repository,
        env: { ...process.env, ...env },
        timeout: 90000,
        encoding: "utf8",
      });
    await run(["build"], {
      PESUITE_BUILD: "baseline",
      PESUITE_UNIT_VERSION: "0.1.0",
      PESUITE_UNIT_API: "pesuite-probe/1",
    });
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
    const initial = await readProduct(seed),
      blob = join(root, "probe.bin");
    await writeFile(blob, initial.assets.find((a) => a.artifact.kind === "blob")!.bytes);
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
    const packed = JSON.parse(await readFile(join(root, "package.json"), "utf8")),
      app = join(root, "installed", basename(packed.app));
    await cp(packed.app, app, { recursive: true, verbatimSymlinks: true });
    const fingerprint = async () => {
      const hash = createHash("sha256");
      const walk = async (path: string): Promise<void> => {
        for (const e of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const file = join(path, e.name);
          hash.update(file.slice(app.length));
          if (e.isSymbolicLink()) hash.update(await readlink(file));
          else if (e.isDirectory()) await walk(file);
          else {
            hash.update(String((await stat(file)).mode));
            hash.update(await readFile(file));
          }
        }
      };
      await walk(app);
      return hash.digest("hex");
    };
    const physical = await fingerprint(),
      data = join(root, "data"),
      content = join(root, "feed");
    await mkdir(content);
    const keys = generateKeyPairSync("ed25519"),
      publickey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const authority = await Authority.open({
      root: join(root, "publication"),
      privatekey: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });
    const scope = { channel: initial.manifest.channel, namespace: namespace("slim") };
    let revision = 0;
    const publish = async (value: Release) => {
      await authority.publish(scope.channel, revision++, value.envelope, value.assets);
      await writeFeed(authority, scope.channel, content);
    };
    await publish(initial);
    const sources = await Sources.open({
      data: join(root, "source"),
      scope,
      sources: { feed: { directory: content } },
    });
    const controller = await serve(join(tmpdir(), `capsule-e2e-${process.pid}.sock`), {
        root: join(root, "controller"),
      }),
      factory = controller.factory({ ...scope, namespace: namespace("validation") });
    const start = (target = initial.envelope.digest, recover = false) =>
      factory.start({
        command: join(app, "Contents/MacOS", initial.manifest.identity.scheme),
        service: "host",
        generation: target,
        ready: `inspect-ready:${target}`,
        timeout: 20000,
        env: {
          PESUITE_DATA: data,
          PESUITE_INSPECT: "1",
          PESUITE_AUTOMATION: "1",
          PESUITE_PROBE: "0",
          PESUITE_CAPSULE_ACTIVATE: "1",
          PESUITE_CONTENT_RETENTION: "0",
          PESUITE_LEAF_ACTIVATE: "1",
          PESUITE_RECOVER: recover ? "1" : "0",
          PESUITE_FEED: sources.endpoints[0]!.url,
          PESUITE_FEED_KEY: publickey,
          PESUITE_FEED_INTERVAL: "100",
        },
      });
    let lease: Awaited<ReturnType<typeof start>> | undefined = await start();
    const observed: Status[] = [],
      snapshots: HostReceipt[] = [];
    try {
      const inspector = await Inspector.open(data, scope),
        updates = await inspector.target<Methods>("bootstrapupdates", initial.envelope.digest),
        oldLeaf = await inspector.target<Methods>("updates", initial.envelope.digest);
      const host = await inspector.target<{
        content: { input: "status" | "collect"; output: State | string[] };
        status: { input: null; output: HostReceipt };
        adapter: { input: { method: string; value: unknown }; output: Record<string, unknown> };
        read: { input: null; output: Record<string, unknown> };
        write: { input: Record<string, unknown>; output: unknown };
      }>("host", initial.envelope.digest);
      const wait = async (accept: (s: Status) => boolean) => {
        const until = Date.now() + 20000;
        let last: Status | undefined;
        while (Date.now() < until) {
          last = await updates.call("status", null);
          if (accept(last)) {
            observed.push(last);
            return last;
          }
          await new Promise((done) => setTimeout(done, 25));
        }
        throw Error(`Capsule wait timeout: ${JSON.stringify(last)}`);
      };
      await wait((s) => s.phase === "idle" && s.revision === 1);
      const baseline = await host.call("status", null);
      const resource = () => host.call("adapter", { method: "resource", value: null });
      const originalResource = await resource();
      assert.equal(originalResource.value, "blob:baseline");
      assert.equal(originalResource.pid, baseline.pid);
      const resourceSnapshots: unknown[] = [];
      snapshots.push(baseline);
      await host.call("write", { ...(await host.call("read", null)), retained: "capsule-data" });
      let web = join(root, "web-baseline"),
        daemon = join(root, "daemon-baseline");
      await cp(join(repository, "apps/web/dist"), web, { recursive: true });
      await cp(join(repository, "apps/daemon/dist"), daemon, { recursive: true });
      const candidate = async (version: string, marker: string, carrier = 1, broken = false) => {
        await run(["--filter", "@perishcode/slim-electron", "build"], { PESUITE_BUILD: marker });
        const capsule = join(root, marker);
        await cp(join(repository, "carriers/electron/dist/capsule"), capsule, { recursive: true });
        if (broken)
          await writeFile(
            join(capsule, "index.mjs"),
            "export function create(){return {handlers:{},initialize:async()=>{throw Error('injected capsule initialize failure')},ready:async()=>{},stop:async()=>{}}}",
          );
        await writeFile(blob, `blob:${marker}`);
        return compose(
          { ...initial.manifest, identity: { ...initial.manifest.identity, version } },
          { carrier, capsule, web, daemon, blobs: [{ slot: "probe", path: blob }] },
        );
      };
      const verify = async (value: Release, version: string, marker: string) => {
        await wait((s) => s.phase === "idle" && s.current === value.envelope.digest);
        const status = await host.call("status", null);
        assert.equal(status.pid, baseline.pid);
        assert.equal(status.product?.version, version);
        assert.equal(status.product?.artifact, value.envelope.generation.capsule.digest);
        assert.equal(status.capsule, `capsule:${marker}:blob:${marker}`);
        assert.equal(status.adapter.title, `Open Design Slim — ${marker}`);
        assert.equal(status.adapter.loading, `Loading Open Design Slim ${marker}`);
        assert.equal(status.phase, "ready");
        assert.equal((await host.call("adapter", { method: "echo", value: null })).build, marker);
        assert.equal((await host.call("read", null)).retained, "capsule-data");
        assert.ok(status.directory.instances.every((i) => i.service !== "capsule"));
        assert.equal(status.automation.shown, false);
        assert.equal(status.automation.focused, false);
        const actual = await resource();
        assert.equal(actual.value, `blob:${marker}`);
        assert.equal(actual.pid, baseline.pid);
        const state = (await host.call("content", "status")) as State;
        const spec = { type: "file" as const, artifact: value.envelope.generation.blobs[0]! };
        const entry = state.entries[resourceKey(spec)]!;
        assert.equal(entry.uses.length, 1);
        assert.equal(entry.uses[0]!.owner.service, "electron");
        assert.equal(entry.uses[0]!.path, actual.path);
        for (const kind of ["capsule", "web", "daemon"] as const) {
          const key = resourceKey({ type: "directory", artifact: value.envelope.generation[kind] });
          const uses = state.entries[key]!.uses;
          assert.equal(uses.length, 1);
          const subject = status.directory.instances.find(
            (i) => i.service === (kind === "daemon" ? "daemon" : "electron"),
          )!;
          assert.equal(uses[0]!.owner.service, subject.service);
          assert.equal(uses[0]!.owner.incarnation, subject.incarnation);
          assert.equal(uses[0]!.owner.generation, subject.generation);
          if (kind === "web") assert.equal(uses[0]!.owner.epoch, `web:${status.units.web.nonce}`);
        }
        resourceSnapshots.push({ state, actual });
        snapshots.push(status);
        return status;
      };
      const one = await candidate("0.2.0", "capsule2");
      await publish(one);
      const first = await verify(one, "0.2.0", "capsule2");
      assert.equal(first.daemon.pid, baseline.daemon.pid);
      assert.equal(first.counts.daemon, baseline.counts.daemon);
      assert.equal(first.counts.document, baseline.counts.document + 1);
      assert.notEqual(first.units.web.nonce, baseline.units.web.nonce);
      await assert.rejects(oldLeaf.call("status", null));
      assert.deepEqual(await host.call("content", "collect"), []);
      assert.equal(await readFile(String(originalResource.path), "utf8"), "blob:baseline");
      for (const kind of ["web", "daemon"] as const) {
        await run(["--filter", `@perishcode/slim-${kind}`, "build"], {
          PESUITE_BUILD: `${kind}-0.2.0`,
          PESUITE_UNIT_VERSION: "0.2.0",
          PESUITE_UNIT_API: "pesuite-probe/2",
        });
        const path = join(root, `${kind}-0.2.0`);
        await cp(join(repository, `apps/${kind}/dist`), path, { recursive: true });
        if (kind === "web") web = path;
        else daemon = path;
      }
      const combined = await candidate("0.3.0", "capsule3");
      await publish(combined);
      const second = await verify(combined, "0.3.0", "capsule3");
      assert.notEqual(second.daemon.pid, first.daemon.pid);
      assert.equal(second.units.web.version, "0.2.0");
      assert.equal(second.units.daemon.version, "0.2.0");
      const removed = (await host.call("content", "collect")) as string[];
      assert.equal(removed.length, 2);
      await assert.rejects(readFile(String(originalResource.path)), /ENOENT/);
      const protectedState = (await host.call("content", "status")) as State;
      assert.deepEqual(protectedState.references.map((r) => r.kind).sort(), ["current", "recovery"]);
      const incompatible = await candidate("0.4.0", "abi", 999);
      await publish(incompatible);
      await wait((s) => s.phase === "failed" && !!s.error?.includes("incompatible"));
      assert.equal((await host.call("status", null)).generation, combined.envelope.digest);
      const broken = await candidate("0.5.0", "broken", 1, true);
      await publish(broken);
      await wait((s) => s.phase === "failed" && !!s.error?.includes("baseline restored=true"));
      const failed = await host.call("status", null);
      assert.equal(failed.generation, combined.envelope.digest);
      assert.equal(failed.product?.version, "0.3.0");
      assert.equal((await resource()).value, "blob:capsule3");
      const failureResources = (await host.call("content", "status")) as State;
      assert.ok(failureResources.references.some((r) => r.kind === "prepared" && r.name === broken.envelope.digest));
      const obsolete = (await host.call("content", "collect")) as string[];
      const invalidKeys = [
        resourceKey({ type: "directory", artifact: incompatible.envelope.generation.capsule }),
        resourceKey({ type: "file", artifact: incompatible.envelope.generation.blobs[0]! }),
      ];
      assert.deepEqual(obsolete.sort(), invalidKeys.sort());
      await host.stop();
      await waitGone(lease.pid, 5000);
      await factory.release(lease);
      lease = undefined;
      await publish(combined);
      lease = await start(combined.envelope.digest, true);
      const reopened = await Inspector.open(data, scope),
        fresh = await reopened.target<{
          status: { input: null; output: HostReceipt };
          read: { input: null; output: Record<string, unknown> };
          content: { input: "status" | "collect"; output: State | string[] };
          adapter: { input: { method: string; value: unknown }; output: Record<string, unknown> };
        }>("host", combined.envelope.digest);
      const cold = await fresh.call("status", null);
      assert.equal(cold.product?.version, "0.3.0");
      assert.equal((await fresh.call("read", null)).retained, "capsule-data");
      assert.equal((await fresh.call("adapter", { method: "resource", value: null })).value, "blob:capsule3");
      const coldResources = (await fresh.call("content", "status")) as State;
      assert.ok(coldResources.references.every((r) => r.kind !== "prepared"));
      assert.equal(((await fresh.call("content", "collect")) as string[]).length, 2);
      await assert.rejects(host.probe());
      await fresh.stop();
      await waitGone(lease.pid, 5000);
      await factory.release(lease);
      lease = undefined;
      assert.equal(await fingerprint(), physical);
      await writeFile(
        join(root, "receipt.json"),
        JSON.stringify(
          {
            result: "passed",
            app,
            physical,
            baseline,
            snapshots,
            resources: {
              originalResource,
              resourceSnapshots,
              removed,
              protectedState,
              failureResources,
              coldResources,
            },
            failed,
            cold,
            observed,
            scope:
              "actual signed loopback feed; fixed unsigned macOS Electron; Capsule-only/coordinated code execution and explicit failure recovery; no Capsule sidecar identity",
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ result: "passed", receipt: join(root, "receipt.json") }));
    } finally {
      if (lease) await factory.release(lease);
      await sources.close();
      await controller.close();
    }
  },
  180000,
);
