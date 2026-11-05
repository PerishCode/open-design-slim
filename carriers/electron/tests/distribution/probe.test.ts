import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CreateBucketCommand, DeleteObjectCommand, PutBucketPolicyCommand, S3Client } from "@aws-sdk/client-s3";
import { waitGone } from "@perishcode/automation";
import { Catalog, metadata } from "@perishcode/distribution";
import { publish, Storage } from "@perishcode/distribution/s3";
import type { HostReceipt } from "@perishcode/electron";
import { Inspector } from "@perishcode/inspect";
import { inspect, pack } from "@perishcode/pack";
import { digest, namespace } from "@perishcode/protocol";
import { compose } from "@perishcode/release";
import { readProduct } from "@perishcode/runtime";
import { serve } from "@perishcode/sidecar";
import { it } from "vitest";

it.runIf(process.platform === "darwin" && process.env.PESUITE_DISTRIBUTION_E2E === "1")(
  "uses actual Silo metadata to block old installed shells and admit a compatible installed shell",
  async () => {
    const endpoint = process.env.PESUITE_SILO_ENDPOINT;
    assert.ok(endpoint, "start the declared Compose Silo and supply PESUITE_SILO_ENDPOINT");
    const repository = resolve("../.."),
      root = join(repository, `.artifacts/distribution/${Date.now()}`);
    await mkdir(root, { recursive: true });
    const run = (args: string[], env: Record<string, string> = {}) =>
      promisify(execFile)("pnpm", args, {
        cwd: repository,
        env: { ...process.env, ...env },
        timeout: 120000,
        encoding: "utf8",
      });
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
    const initial = await readProduct(seed);
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
    const old = JSON.parse(await readFile(join(root, "package.json"), "utf8")),
      app = join(root, "installed", basename(old.app));
    await cp(old.app, app, { recursive: true, verbatimSymlinks: true });
    const carrier = join(root, "carrier-0.2.0");
    await cp(join(repository, "carriers/electron/dist"), carrier, { recursive: true });
    const config = JSON.parse(await readFile(join(carrier, "host.json"), "utf8"));
    config.manifest.identity.version = "0.2.0";
    await writeFile(join(carrier, "host.json"), JSON.stringify(config));
    const next = await pack({
      carrier,
      manifest: config.manifest,
      seed,
      daemon: join(repository, "apps/daemon/dist"),
      web: join(repository, "apps/web/dist"),
      output: join(root, "shell-0.2.0"),
    });
    assert.equal((await inspect(next.app)).version, "0.2.0");
    const archive = join(root, "shell.zip");
    await promisify(execFile)("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", next.app, archive]);
    const bytes = await readFile(archive),
      shell = {
        platform: "mac" as const,
        arch: "arm64" as const,
        version: "0.2.0",
        digest: digest(bytes),
        bytes: bytes.length,
        format: "zip" as const,
      };
    const bucket = `slim-${Date.now()}`,
      s3 = {
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId: "pesuitelocal", secretAccessKey: "pesuite-local-development-only" },
      };
    const admin = new S3Client(s3),
      storage = new Storage(s3, bucket);
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    await admin.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            { Effect: "Allow", Principal: "*", Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::${bucket}/*`] },
          ],
        }),
      }),
    );
    const keys = generateKeyPairSync("ed25519"),
      privatekey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      publickey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const units = {
      capsule: initial.manifest.identity.version,
      web: JSON.parse(await readFile(join(repository, "apps/web/dist/unit.json"), "utf8")).version,
      daemon: JSON.parse(await readFile(join(repository, "apps/daemon/dist/unit.json"), "utf8")).version,
    };
    const first = metadata({
      schema: 1,
      product: initial.manifest.identity.appid,
      channel: "stable",
      version: "0.1.0",
      revision: 1,
      minShellVersion: "0.1.0",
      content: initial.envelope,
      units,
      shells: [shell],
    });
    const publishVersion = (value: typeof first, expected: number, assets = initial.assets) =>
      publish({
        storage,
        metadata: value,
        assets,
        shells: [{ artifact: shell, bytes }],
        privatekey,
        expected,
      });
    await publishVersion(first, 0);
    const data = join(root, "data"),
      source = `${endpoint}/${bucket}`,
      scope = { channel: initial.manifest.channel, namespace: namespace("slim") };
    const controller = await serve(join(tmpdir(), `distribution-${process.pid}.sock`), {
        root: join(root, "controller"),
      }),
      factory = controller.factory({ ...scope, namespace: namespace("validation") });
    const env = {
      PESUITE_DATA: data,
      PESUITE_INSPECT: "1",
      PESUITE_AUTOMATION: "1",
      PESUITE_PROBE: "0",
      PESUITE_LEAF_ACTIVATE: "1",
      PESUITE_DISTRIBUTION: source,
      PESUITE_DISTRIBUTION_PROBE: "1",
      PESUITE_FEED_KEY: publickey,
      PESUITE_FEED: source,
      PESUITE_FEED_INTERVAL: "100",
    };
    const onlineReceipt = join(root, "online.json");
    const start = (location: string, receipt: string, selected = initial.envelope.digest) =>
      factory.start({
        command: join(location, "Contents/MacOS/od"),
        service: "host",
        generation: selected,
        ready: `inspect-ready:${selected}`,
        timeout: 20000,
        env: { ...env, PESUITE_RECEIPT: receipt },
      });
    let lease: Awaited<ReturnType<typeof start>> | undefined;
    const readGate = async (path: string) => {
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        try {
          return JSON.parse(await readFile(`${path}.gate.json`, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((done) => setTimeout(done, 25));
      }
      throw new Error("native blocking evidence timeout");
    };
    try {
      lease = await start(app, onlineReceipt);
      const inspector = await Inspector.open(data, scope),
        host = await inspector.target<{
          native: { input: null; output: unknown };
          status: { input: null; output: HostReceipt };
          write: { input: Record<string, unknown>; output: unknown };
          read: { input: null; output: Record<string, unknown> };
          adapter: { input: { method: string; value: unknown }; output: unknown };
        }>("host", initial.envelope.digest);
      await host.call("write", { retained: "minimum-shell" });
      for (const kind of ["web", "daemon"]) {
        await run(["--filter", `@perishcode/slim-${kind}`, "build"], {
          PESUITE_BUILD: "silo-leaf",
          PESUITE_UNIT_VERSION: "0.2.0",
          PESUITE_UNIT_API: "pesuite-probe/1",
        });
      }
      const leaf = await compose(initial.manifest, {
        carrier: 1,
        capsule: join(repository, "carriers/electron/dist/capsule"),
        web: join(repository, "apps/web/dist"),
        daemon: join(repository, "apps/daemon/dist"),
        blobs: [{ slot: "probe", path: join(repository, "carriers/electron/dist/capsule/probe.bin") }],
      });
      const leafmeta = metadata({
        ...first,
        version: "0.1.1",
        revision: 2,
        content: leaf.envelope,
        units: { ...units, web: "0.2.0", daemon: "0.2.0" },
      });
      await publishVersion(leafmeta, 1, leaf.assets);
      let observedLeaf: HostReceipt | undefined;
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        const status = await host.call("status", null);
        if (status.generation === leaf.envelope.digest) {
          observedLeaf = status;
          break;
        }
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.ok(observedLeaf, "actual Silo leaf activation missing");
      assert.equal(observedLeaf.units.web.version, "0.2.0");
      assert.equal(observedLeaf.units.daemon.version, "0.2.0");
      const required = metadata({ ...leafmeta, version: "0.2.0", revision: 3, minShellVersion: "0.2.0" });
      await publishVersion(required, 2, leaf.assets);
      const online = await readGate(onlineReceipt);
      assert.equal(online.minimum, "0.2.0");
      assert.equal(online.pid, observedLeaf.pid);
      assert.equal(online.runtime.daemon.phase, "stopped");
      await waitGone(online.runtime.daemon.pid, 5000);
      assert.ok(
        online.runtime.directory.instances
          .filter((i: { service: string }) => ["daemon", "updates", "bootstrapupdates"].includes(i.service))
          .every((i: { phase: string }) => i.phase === "retired"),
      );
      assert.equal(online.runtime.phase, "blocked");
      assert.equal(online.productPreload, false);
      assert.equal(online.automation.shown, false);
      assert.equal(online.automation.focused, false);
      await assert.rejects(host.call("adapter", { method: "echo", value: null }), /closed/);
      await host.call("native", null);
      let retried = online;
      const retryUntil = Date.now() + 10000;
      while (Date.now() < retryUntil) {
        try {
          retried = await readGate(onlineReceipt);
          if (retried.retries === 1) break;
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
        }
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.equal(retried.retries, 1);
      assert.equal(retried.minimum, "0.2.0");
      assert.equal(retried.pid, online.pid);
      await host.stop();
      await waitGone(lease.pid, 5000);
      await factory.release(lease);
      lease = undefined;
      const coldReceipt = join(root, "cold.json");
      const cold = async (receipt: string) => {
        await assert.rejects(
          promisify(execFile)(join(app, "Contents/MacOS/od"), [], {
            env: { ...process.env, ...env, PESUITE_INSPECT: "0", PESUITE_PROBE: "1", PESUITE_RECEIPT: receipt },
            timeout: 20000,
          }),
          (e) => (e as { code: number }).code === 1,
        );
        const result = await readGate(receipt);
        assert.equal(result.minimum, "0.2.0");
        assert.equal(result.productInitialized, false);
        await assert.rejects(readFile(receipt), /ENOENT/);
        return result;
      };
      const blocked = await cold(coldReceipt);
      const headpath = `products/${first.product}/channels/stable/head.json`,
        saved = (await storage.get(headpath))!;
      await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: headpath }));
      const unavailable = await cold(join(root, "unavailable.json"));
      await storage.put(headpath, saved.bytes);
      lease = await start(next.app, join(root, "compatible.json"), leaf.envelope.digest);
      const compatible = await (await Inspector.open(data, scope)).target<{
        status: { input: null; output: HostReceipt };
        read: { input: null; output: Record<string, unknown> };
      }>("host", leaf.envelope.digest);
      const accepted = await compatible.call("status", null);
      assert.equal(accepted.phase, "ready");
      assert.equal((await compatible.call("read", null)).retained, "minimum-shell");
      await compatible.stop();
      await waitGone(lease.pid, 5000);
      await factory.release(lease);
      lease = undefined;
      const catalog = new Catalog({
        endpoint: source,
        publickey,
        product: first.product,
        channel: scope.channel,
        shellVersion: "0.2.0",
        platform: "mac",
        arch: "arm64",
        root: join(root, "download"),
      });
      await catalog.head(scope.channel);
      assert.equal(digest(await catalog.shell(shell)), shell.digest);
      await writeFile(
        join(root, "receipt.json"),
        JSON.stringify(
          {
            result: "passed",
            endpoint,
            bucket,
            publickey,
            metadata: required,
            head: JSON.parse(Buffer.from(saved.bytes).toString()),
            app,
            newApp: next.app,
            shell,
            observedLeaf,
            online,
            retried,
            blocked,
            unavailable,
            accepted,
            scope:
              "real unsigned macOS apps and actual Silo; online/cold/cached-floor native blocking and compatible-shell admission; new shell launched separately, physical installation replacement NOT proven",
          },
          null,
          2,
        ),
      );
    } finally {
      if (lease) await factory.release(lease);
      await controller.close();
      storage.close();
      admin.destroy();
    }
  },
  300000,
);
