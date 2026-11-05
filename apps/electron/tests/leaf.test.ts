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
import { Authority, writeFeed } from "@perishcode/publish";
import { compose } from "@perishcode/release";
import { readProduct } from "@perishcode/runtime";
import { Sources } from "@perishcode/serve";
import { serve } from "@perishcode/sidecar";
import type { Methods, Status } from "@perishcode/update";
import { it } from "vitest";

it.runIf(process.platform === "darwin" && process.env.PESUITE_LEAF_E2E === "1")(
  "activates compatible leaf units with minimal impact in one installed host",
  async () => {
    const repository = resolve("../.."),
      root = join(repository, `.artifacts/leaf/${Date.now()}`);
    await mkdir(root, { recursive: true });
    const execute = (args: string[]) =>
      promisify(execFile)("pnpm", ["exec", "pesuite", ...args], { cwd: repository, timeout: 90000, encoding: "utf8" });
    await promisify(execFile)("pnpm", ["build"], {
      cwd: repository,
      timeout: 60000,
      env: {
        ...process.env,
        PESUITE_BUILD: "baseline",
        PESUITE_UNIT_VERSION: "0.1.0",
        PESUITE_UNIT_API: "pesuite-probe/1",
      },
    });
    const seed = join(root, "seed");
    await execute([
      "release",
      "--capsule",
      "apps/capsule/dist",
      "--daemon",
      "apps/daemon/dist",
      "--web",
      "apps/web/dist",
      "--blob",
      "probe=apps/capsule/dist/probe.bin",
      "--output",
      seed,
    ]);
    const initial = await readProduct(seed);
    await execute([
      "pack",
      "--carrier",
      "apps/electron/dist",
      "--seed",
      seed,
      "--output",
      join(root, "package"),
      "--receipt",
      join(root, "package.json"),
    ]);
    const packaged = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const app = join(root, "installed", basename(packaged.app));
    await cp(packaged.app, app, { recursive: true, verbatimSymlinks: true });
    async function fingerprint(path: string): Promise<string> {
      const hash = createHash("sha256");
      async function walk(directory: string) {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          const p = join(directory, entry.name);
          hash.update(p.slice(path.length));
          if (entry.isSymbolicLink()) hash.update(await readlink(p));
          else if (entry.isDirectory()) await walk(p);
          else {
            hash.update(String((await stat(p)).mode));
            hash.update(await readFile(p));
          }
        }
      }
      await walk(path);
      return hash.digest("hex");
    }
    const physical = await fingerprint(app),
      data = join(root, "data"),
      content = join(root, "feed");
    await mkdir(content);
    const pair = generateKeyPairSync("ed25519"),
      publickey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const authority = await Authority.open({
      root: join(root, "publication"),
      privatekey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });
    const lane = initial.manifest.channel,
      scope = { channel: lane, namespace: namespace("slim") };
    await authority.publish(lane, 0, initial.envelope, initial.assets);
    await writeFeed(authority, lane, content);
    const sources = await Sources.open({
      data: join(root, "sources"),
      scope,
      sources: { feed: { directory: content } },
    });
    const controller = await serve(join(tmpdir(), `slim-leaf-${process.pid}.sock`), { root: join(root, "controller") });
    const factory = controller.factory({ ...scope, namespace: namespace("validation") });
    let lease: Awaited<ReturnType<typeof factory.start>> | undefined;
    const observed: Status[] = [];
    const start = (recover = false, target = initial.envelope.digest) =>
      factory.start({
        command: join(app, "Contents/MacOS", initial.manifest.identity.scheme),
        service: "host",
        generation: target,
        ready: `inspect-ready:${target}`,
        timeout: 20000,
        env: {
          PESUITE_DATA: data,
          PESUITE_CONTENT_RETENTION: "0",
          PESUITE_RECOVER: recover ? "1" : "0",
          PESUITE_LEAF_ACTIVATE: "1",
          PESUITE_PROBE: "0",
          PESUITE_AUTOMATION: "1",
          PESUITE_INSPECT: "1",
          PESUITE_RECEIPT: join(root, "host.json"),
          PESUITE_FEED: sources.endpoints[0]?.url ?? "",
          PESUITE_FEED_KEY: publickey,
          PESUITE_FEED_INTERVAL: "100",
          PESUITE_FEED_TIMEOUT: "1500",
        },
      });
    try {
      lease = await start();
      const inspector = await Inspector.open(data, scope),
        updates = await inspector.target<Methods>("updates", initial.envelope.digest);
      const host = await inspector.target<{
        content: { input: "status" | "collect"; output: State | string[] };
        status: { input: unknown; output: HostReceipt };
        read: { input: unknown; output: Record<string, unknown> };
        write: { input: Record<string, unknown>; output: Record<string, unknown> };
      }>("host", initial.envelope.digest);
      const before = await inspector.factory.binding(),
        receipt = await host.call("status", null);
      assert.equal(receipt.automation.shown, false);
      assert.equal(receipt.automation.focused, false);
      const wait = async (accept: (value: Status) => boolean) => {
        const end = Date.now() + 20000;
        let last: Status | undefined;
        while (Date.now() < end) {
          const value = await updates.call("status", null);
          last = value;
          if (accept(value)) {
            observed.push(value);
            return value;
          }
          await new Promise((done) => setTimeout(done, 25));
        }
        throw new Error(`installed activation condition timeout: ${JSON.stringify(last)}`);
      };
      await wait((s) => s.phase === "idle" && s.revision === 1);
      const snapshots: HostReceipt[] = [receipt];
      const resourceSnapshots: { status: HostReceipt; state: State }[] = [];
      const resources = async (status: HostReceipt, value: Awaited<ReturnType<typeof readProduct>>) => {
        const state = (await host.call("content", "status")) as State;
        for (const kind of ["capsule", "web", "daemon"] as const) {
          const entry = state.entries[resourceKey({ type: "directory", artifact: value.envelope.generation[kind] })]!;
          assert.equal(entry.uses.length, 1);
          const subject = status.directory.instances.find(
            (i) => i.service === (kind === "daemon" ? "daemon" : "electron"),
          )!;
          assert.equal(entry.uses[0]!.owner.incarnation, subject.incarnation);
          if (kind === "web") assert.equal(entry.uses[0]!.owner.epoch, `web:${status.units.web.nonce}`);
        }
        resourceSnapshots.push({ status, state });
      };
      await resources(receipt, initial);
      await host.call("write", { ...(await host.call("read", null)), preserved: "factory-data" });
      let revision = 1;
      let web = join(root, "web-baseline"),
        daemon = join(root, "daemon-baseline");
      await cp(join(repository, "apps/web/dist"), web, { recursive: true });
      await cp(join(repository, "apps/daemon/dist"), daemon, { recursive: true });
      const buildUnit = async (kind: "web" | "daemon", version: string, api = "pesuite-probe/1", broken = false) => {
        await promisify(execFile)("pnpm", ["--filter", `@perishcode/slim-${kind}`, "build"], {
          cwd: repository,
          env: {
            ...process.env,
            PESUITE_BUILD: `${kind}-${version}`,
            PESUITE_UNIT_VERSION: version,
            PESUITE_UNIT_API: api,
          },
          timeout: 30000,
        });
        const path = join(root, `${kind}-${version}-${api.replaceAll("/", "-")}`);
        await cp(join(repository, `apps/${kind}/dist`), path, { recursive: true });
        if (broken) await writeFile(join(path, "index.js"), 'throw new Error("injected renderer failure");');
        return path;
      };
      const product = () =>
        compose(initial.manifest, {
          capsule: join(repository, "apps/capsule/dist"),
          web,
          daemon,
          carrier: 1,
          blobs: [{ slot: "probe", path: join(repository, "apps/capsule/dist/probe.bin") }],
        });
      const publish = async () => {
        const value = await product();
        assert.equal(value.envelope.generation.capsule.digest, initial.envelope.generation.capsule.digest);
        await authority.publish(lane, revision++, value.envelope, value.assets);
        await writeFeed(authority, lane, content);
        return value;
      };
      const activated = async (value: Awaited<ReturnType<typeof product>>) => {
        await wait((s) => s.current === value.envelope.digest && s.phase === "idle");
        const status = await host.call("status", null);
        assert.equal(status.generation, value.envelope.digest);
        assert.equal(status.pid, receipt.pid);
        assert.equal(status.phase, "ready");
        assert.equal(status.capsule, receipt.capsule);
        assert.equal(status.automation.shown, false);
        assert.equal(status.automation.focused, false);
        assert.equal((await inspector.factory.binding()).state.current, value.envelope.digest);
        assert.equal((await host.call("read", null)).preserved, "factory-data");
        await resources(status, value);
        snapshots.push(status);
        await writeFile(join(root, "snapshots.json"), JSON.stringify(snapshots, null, 2));
        return status;
      };
      web = await buildUnit("web", "0.2.0");
      const webCandidate = await publish();
      const a = await activated(webCandidate);
      assert.equal(a.daemon.pid, receipt.daemon.pid);
      assert.equal(a.daemon.nonce, receipt.daemon.nonce);
      assert.equal(a.counts.daemon, receipt.counts.daemon);
      assert.equal(a.counts.document, receipt.counts.document + 1);
      assert.equal(a.units.web.version, "0.2.0");
      assert.ok(a.renderer.includes("web-0.2.0"));
      assert.notEqual(a.units.web.nonce, receipt.units.web.nonce);
      daemon = await buildUnit("daemon", "0.2.0");
      const daemonCandidate = await publish();
      const b = await activated(daemonCandidate);
      assert.notEqual(b.daemon.pid, a.daemon.pid);
      assert.notEqual(b.daemon.nonce, a.daemon.nonce);
      assert.equal(b.counts.daemon, a.counts.daemon + 1);
      assert.equal(b.counts.document, a.counts.document);
      assert.equal(b.units.web.nonce, a.units.web.nonce);
      assert.equal(b.renderer, a.renderer);
      assert.ok(String(b.daemon.witness).includes("daemon-0.2.0"));
      web = await buildUnit("web", "0.3.0", "pesuite-probe/2");
      daemon = await buildUnit("daemon", "0.3.0", "pesuite-probe/2");
      const coordinated = await publish();
      const c = await activated(coordinated);
      assert.equal(c.counts.daemon, b.counts.daemon + 1);
      assert.equal(c.counts.document, b.counts.document + 1);
      assert.ok(c.renderer.includes("web-0.3.0"));
      assert.ok(String(c.daemon.witness).includes("daemon-0.3.0"));
      const obsoleteUnits = [initial.envelope.generation.web, initial.envelope.generation.daemon].map((artifact) =>
        resourceKey({ type: "directory", artifact }),
      );
      const collected = (await host.call("content", "collect")) as string[];
      assert.deepEqual(collected.sort(), obsoleteUnits.sort());
      for (const key of obsoleteUnits)
        await assert.rejects(stat(resourceSnapshots[0]!.state.entries[key]!.uses[0]!.path), /ENOENT/);
      const committed = await inspector.factory.binding();
      web = await buildUnit("web", "0.4.0", "pesuite-probe/3");
      const incompatible = await publish();
      await wait((s) => s.phase === "failed" && (s.error?.includes("incompatible") ?? false));
      assert.deepEqual(await inspector.factory.binding(), committed);
      assert.deepEqual((await host.call("status", null)).counts, c.counts);
      web = await buildUnit("web", "0.5.0", "pesuite-probe/2", true);
      const broken = await publish();
      await wait((s) => s.phase === "failed" && (s.error?.includes("baseline restored=true") ?? false));
      const failed = await host.call("status", null);
      snapshots.push(failed);
      assert.equal(failed.phase, "failed");
      assert.equal(failed.generation, coordinated.envelope.digest);
      assert.equal(failed.units.web.version, "0.3.0");
      assert.equal(failed.daemon.pid, c.daemon.pid);
      assert.equal((await inspector.factory.binding()).state.attempt?.status, "failed");
      assert.equal((await host.call("read", null)).preserved, "factory-data");
      assert.equal(await fingerprint(app), physical);
      await host.stop();
      await waitGone(lease.pid);
      await waitGone(Number(failed.daemon.pid));
      await factory.release(lease);
      lease = undefined;
      await assert.rejects(start(false, coordinated.envelope.digest), /blocked/);
      await authority.publish(lane, revision++, coordinated.envelope, coordinated.assets);
      await writeFeed(authority, lane, content);
      lease = await start(true, coordinated.envelope.digest);
      const restoredInspector = await Inspector.open(data, scope);
      const restoredHost = await restoredInspector.target<{
        content: { input: "status" | "collect"; output: State | string[] };
        status: { input: unknown; output: HostReceipt };
        read: { input: unknown; output: Record<string, unknown> };
      }>("host", coordinated.envelope.digest);
      const restored = await restoredHost.call("status", null);
      snapshots.push(restored);
      assert.equal(restored.generation, coordinated.envelope.digest);
      assert.equal(restored.units.web.version, "0.3.0");
      assert.equal(restored.units.daemon.version, "0.3.0");
      assert.equal((await restoredHost.call("read", null)).preserved, "factory-data");
      assert.ok(!(await restoredInspector.factory.binding()).state.attempt);
      const restoredResources = (await restoredHost.call("content", "status")) as State;
      const collectedCold = (await restoredHost.call("content", "collect")) as string[];
      const discarded = [incompatible.envelope.generation.web, broken.envelope.generation.web].map((artifact) =>
        resourceKey({ type: "directory", artifact }),
      );
      assert.deepEqual(collectedCold.sort(), discarded.sort());
      await restoredHost.stop();
      await waitGone(lease.pid);
      await waitGone(Number(restored.daemon.pid));
      await writeFile(
        join(root, "receipt.json"),
        JSON.stringify(
          {
            result: "passed",
            initial: initial.envelope.digest,
            physical,
            before,
            snapshots,
            resources: { resourceSnapshots, collected, restoredResources, collectedCold },
            observed,
            scope:
              "unsigned macOS; leaf activation and explicit normal recovery; no commit-crash/adoption/fullscreen claim",
          },
          null,
          2,
        ),
      );
      process.stdout.write(`${JSON.stringify({ result: "passed", receipt: join(root, "receipt.json") })}\n`);
    } finally {
      if (lease) await factory.release(lease);
      await sources.close();
      await controller.close();
    }
  },
  180000,
);
