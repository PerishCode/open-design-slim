import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cp, mkdir, readdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { waitGone } from "@perishcode/automation";
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

it.runIf(process.platform === "darwin" && process.env.PESUITE_DISCOVERY_E2E === "1")(
  "prepares remote leaf candidates without activating them in the installed host",
  async () => {
    const repository = resolve("../.."),
      root = join(repository, `.artifacts/discovery/${Date.now()}`);
    await mkdir(root, { recursive: true });
    const execute = (args: string[]) =>
      promisify(execFile)("pnpm", ["exec", "pesuite", ...args], { cwd: repository, timeout: 90000, encoding: "utf8" });
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
    const controller = await serve(join(tmpdir(), `slim-discovery-${process.pid}.sock`), {
      root: join(root, "controller"),
    });
    const factory = controller.factory({ ...scope, namespace: namespace("validation") });
    let lease: Awaited<ReturnType<typeof factory.start>> | undefined;
    const observed: Status[] = [];
    try {
      lease = await factory.start({
        command: join(app, "Contents/MacOS", initial.manifest.identity.scheme),
        service: "host",
        generation: initial.envelope.digest,
        ready: `inspect-ready:${initial.envelope.digest}`,
        timeout: 20000,
        env: {
          PESUITE_DATA: data,
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
      const inspector = await Inspector.open(data, scope),
        updates = await inspector.target<Methods>("updates", initial.envelope.digest);
      const host = await inspector.target<{ status: { input: unknown; output: HostReceipt } }>(
        "host",
        initial.envelope.digest,
      );
      const before = await inspector.factory.binding(),
        receipt = await host.call("status", null);
      assert.equal(receipt.automation.shown, false);
      assert.equal(receipt.automation.focused, false);
      const wait = async (accept: (value: Status) => boolean) => {
        const end = Date.now() + 10000;
        while (Date.now() < end) {
          const value = await updates.call("status", null);
          if (accept(value)) {
            observed.push(value);
            return value;
          }
          await new Promise((done) => setTimeout(done, 25));
        }
        throw new Error("installed discovery condition timeout");
      };
      await wait((s) => s.phase === "idle" && s.revision === 1);
      let revision = 1;
      const candidate = async (marker: string, kind: "web" | "daemon" = "web") => {
        const path = join(root, `candidate-${marker}`);
        await cp(join(repository, `apps/${kind}/dist`), path, { recursive: true });
        await writeFile(join(path, "candidate.txt"), marker);
        const product = await compose(initial.manifest, {
          capsule: join(repository, "apps/capsule/dist"),
          daemon: kind === "daemon" ? path : join(repository, "apps/daemon/dist"),
          web: kind === "web" ? path : join(repository, "apps/web/dist"),
          carrier: 1,
          blobs: [{ slot: "probe", path: join(repository, "apps/capsule/dist/probe.bin") }],
        });
        assert.equal(product.envelope.generation.capsule.digest, initial.envelope.generation.capsule.digest);
        return product;
      };
      const publish = async (product: Awaited<ReturnType<typeof candidate>>) => {
        await authority.publish(lane, revision++, product.envelope, product.assets);
        await writeFeed(authority, lane, content);
      };
      for (const kind of ["web", "daemon"] as const) {
        const product = await candidate(kind, kind);
        await publish(product);
        assert.deepEqual(
          (await wait((s) => s.phase === "prepared" && s.prepared?.target === product.envelope.digest)).prepared
            ?.changed,
          [kind],
        );
      }
      for (const mode of ["missing", "corrupt", "truncate"] as const) {
        const product = await candidate(mode);
        await sources.fault("feed", { path: `/objects/${product.envelope.generation.web.digest.slice(7)}`, mode });
        await publish(product);
        await wait((s) => s.phase === "failed" && s.revision === revision);
        assert.deepEqual(await inspector.factory.binding(), before);
        await sources.fault("feed", null);
        await wait((s) => s.phase === "prepared" && s.prepared?.target === product.envelope.digest);
      }
      const stalled = await candidate("stall");
      await sources.fault("feed", {
        path: `/objects/${stalled.envelope.generation.web.digest.slice(7)}`,
        mode: "stall",
      });
      await publish(stalled);
      await wait((s) => s.phase === "checking" && s.revision === revision);
      const began = Date.now();
      await updates.stop();
      assert.ok(Date.now() - began < 1000);
      assert.deepEqual(await inspector.factory.binding(), before);
      const live = await host.call("status", null);
      assert.equal(live.generation, receipt.generation);
      assert.deepEqual(live.daemon, receipt.daemon);
      assert.deepEqual(live.counts, receipt.counts);
      assert.deepEqual(live.units, receipt.units);
      assert.equal(await fingerprint(app), physical);
      assert.equal(receipt.pid, lease.pid);
      assert.equal(receipt.generation, initial.envelope.digest);
      await host.stop();
      await waitGone(lease.pid);
      await waitGone(Number(receipt.daemon.pid));
      await writeFile(
        join(root, "receipt.json"),
        JSON.stringify(
          {
            result: "passed",
            source: initial.envelope.digest,
            physical,
            observed,
            receipt,
            bindingUnchanged: true,
            activation: "not attempted",
            interval: 100,
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
