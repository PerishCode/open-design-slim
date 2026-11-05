import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CreateBucketCommand, PutBucketPolicyCommand, S3Client } from "@aws-sdk/client-s3";
import { waitGone } from "@perishcode/automation";
import { metadata } from "@perishcode/distribution";
import { publish, Storage } from "@perishcode/distribution/s3";
import type { HostReceipt } from "@perishcode/electron";
import { Inspector } from "@perishcode/inspect";
import { arm, inspect as inspectInstallation, type Journal, location, resume, status } from "@perishcode/installer";
import { inspect, pack } from "@perishcode/pack";
import { digest, namespace } from "@perishcode/protocol";
import { compose } from "@perishcode/release";
import { readProduct } from "@perishcode/runtime";
import { inspectRecovery, managerAlive, readDirectory, recover, serve } from "@perishcode/sidecar";
import { it } from "vitest";

it.runIf(process.platform === "darwin" && process.env.PESUITE_INSTALLATION_E2E === "1")(
  "replaces the same installed macOS application after old namespaces exit and resumes interrupted installation",
  async () => {
    const endpoint = process.env.PESUITE_SILO_ENDPOINT;
    assert.ok(endpoint, "start the declared Compose Silo and supply PESUITE_SILO_ENDPOINT");
    const repository = resolve("../.."),
      root = join(repository, `.artifacts/installation/${Date.now()}`);
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
    const changed: Record<string, string> = {};
    for (const kind of ["web", "daemon"] as const) {
      const directory = join(root, `updated-${kind}`);
      await cp(join(repository, `apps/${kind}/dist`), directory, { recursive: true });
      const contract = JSON.parse(await readFile(join(directory, "unit.json"), "utf8"));
      contract.version = "0.2.0";
      await writeFile(join(directory, "unit.json"), JSON.stringify(contract));
      const entry = kind === "web" ? "index.js" : "main.mjs";
      await writeFile(
        join(directory, entry),
        (await readFile(join(directory, entry), "utf8")).replaceAll("skeleton1", "installed2"),
      );
      changed[kind] = directory;
    }
    const updated = await compose(initial.manifest, {
      carrier: initial.envelope.generation.carrier,
      capsule: join(repository, "carriers/electron/dist/capsule"),
      web: changed.web!,
      daemon: changed.daemon!,
      blobs: [{ slot: "probe", path: join(repository, "carriers/electron/dist/capsule/probe.bin") }],
    });
    assert.notEqual(updated.envelope.digest, initial.envelope.digest);
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

    const receipts: unknown[] = [];
    const controller = await serve(join(tmpdir(), `installation-${process.pid}.sock`), {
      root: join(root, "controller"),
    });
    const factory = controller.factory({ channel: initial.manifest.channel, namespace: namespace("validation") });
    let revision = 1;
    const choices = process.env.PESUITE_INSTALLATION_CASE
      ? [process.env.PESUITE_INSTALLATION_CASE]
      : ["vacated", "confirming", "displaced", "installed", "normal"];
    for (const point of choices)
      assert.ok(["vacated", "confirming", "displaced", "installed", "normal"].includes(point));
    try {
      for (const [index, point] of choices.entries()) {
        const caseRoot = join(root, point);
        await mkdir(caseRoot, { recursive: true });
        const target = index === 0 ? app : join(caseRoot, "installed", basename(old.app));
        if (index !== 0) await cp(old.app, target, { recursive: true, verbatimSymlinks: true });
        const installRoot = location(target, first.product, first.channel);
        if (index !== 0) {
          await publishVersion(
            metadata({ ...first, version: `0.2.${index * 2 - 1}`, revision: revision + 1, minShellVersion: "0.1.0" }),
            revision,
          );
          revision++;
        }
        const before = await inspect(target),
          beforeInfo = digest(await readFile(join(target, "Contents/Info.plist")));
        const runtime = join(caseRoot, "primary"),
          secondary = join(caseRoot, "secondary"),
          receipt = join(caseRoot, "host.json");
        const environment: Record<string, string> = {
          PESUITE_DATA: runtime,
          PESUITE_NAMESPACE: "slim",
          PESUITE_INSTALLATION: "1",
          PESUITE_INSTALLATION_PAUSE: point === "normal" ? "none" : point,
          PESUITE_INSPECT: "1",
          PESUITE_AUTOMATION: "1",
          PESUITE_PROBE: "0",
          PESUITE_DISTRIBUTION: `${endpoint}/${bucket}`,
          PESUITE_FEED: `${endpoint}/${bucket}`,
          PESUITE_FEED_KEY: publickey,
          PESUITE_FEED_INTERVAL: "100",
          PESUITE_RECEIPT: receipt,
        };
        const start = (service: string, env: Record<string, string>, generation = initial.envelope.digest) =>
          factory.start({
            service,
            generation,
            command: join(target, "Contents/MacOS/od"),
            ready: `inspect-ready:${generation}`,
            timeout: 25000,
            env,
          });
        const one = await start(`primary${index}`, environment);
        const primaryScope = { channel: initial.manifest.channel, namespace: namespace("slim") };
        const oldHost = await (await Inspector.open(runtime, primaryScope)).target<{
          write: { input: unknown; output: unknown };
        }>("host", initial.envelope.digest);
        await oldHost.call("write", { retained: "primary-data" });
        const two: Awaited<ReturnType<typeof start>> | undefined =
          index === 0
            ? await start(`secondary${index}`, {
                ...environment,
                PESUITE_DATA: secondary,
                PESUITE_NAMESPACE: "alternate",
                PESUITE_RECEIPT: join(caseRoot, "secondary.json"),
              })
            : undefined;
        if (two) {
          const host = await (
            await Inspector.open(secondary, { channel: initial.manifest.channel, namespace: namespace("alternate") })
          ).target<{ write: { input: unknown; output: unknown } }>("host", initial.envelope.digest);
          await host.call("write", { retained: "secondary-data" });
        }
        const selected = metadata({
          ...first,
          version: `0.2.${index * 2}`,
          revision: revision + 1,
          minShellVersion: "0.2.0",
          content: updated.envelope,
          units: { ...units, web: "0.2.0", daemon: "0.2.0" },
        });
        await publishVersion(selected, revision, updated.assets);
        revision++;
        let handle:
          | { id: string; root: string; target: string; manager: Parameters<typeof managerAlive>[0] }
          | undefined;
        const until = Date.now() + 90000;
        while (Date.now() < until) {
          for (const file of [receipt, ...(two ? [join(caseRoot, "secondary.json")] : [])]) {
            try {
              handle = JSON.parse(await readFile(`${file}.installation.json`, "utf8"));
              break;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            }
          }
          if (handle) break;
          await new Promise((done) => setTimeout(done, 100));
        }
        assert.ok(handle, "installation coordinator did not become ready");
        const installation = await Inspector.open(installRoot, {
          channel: initial.manifest.channel,
          namespace: namespace("installation"),
        });
        const grants = (await installation.factory.resources()).grants;
        const home = join(grants.find((g) => g.kind === "data")!.value, "transactions", handle.id);
        await waitGone(one.pid, 25000);
        if (two) await waitGone(two.pid, 25000);
        for (const file of [receipt, ...(two ? [join(caseRoot, "secondary.json")] : [])]) {
          assert.equal(JSON.parse(await readFile(`${file}.stop.json`, "utf8")).status, "stopped");
          const gate = JSON.parse(await readFile(`${file}.gate.json`, "utf8"));
          assert.equal(gate.minimum, "0.2.0");
          assert.equal(gate.productPreload, false);
          assert.equal(gate.automation.shown, false);
          assert.equal(gate.automation.focused, false);
        }
        assert.equal((await factory.release(one)).status, "stopped");
        if (two) assert.equal((await factory.release(two)).status, "stopped");
        let paused: Journal | undefined;
        if (point !== "normal") {
          const deadline = Date.now() + 90000;
          while (Date.now() < deadline) {
            paused =
              point === "confirming"
                ? await (
                    await (
                      await Inspector.open(installRoot, {
                        channel: initial.manifest.channel,
                        namespace: namespace("installation"),
                      })
                    ).target<{ status: { input: null; output: Journal } }>("installer", digest("installation-domain"))
                  ).call("status", null)
                : await inspectInstallation({
                    root: installRoot,
                    target,
                    product: first.product,
                    channel: first.channel,
                  });
            if (point === "confirming" && paused?.phase === "launched") {
              try {
                if (JSON.parse(await readFile(join(home, "checkpoint.json"), "utf8")).phase === "confirming") break;
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
              }
            } else if (paused?.phase === point) break;
            if (paused?.phase === "failed") throw Error(paused.error);
            await new Promise((done) => setTimeout(done, 100));
          }
          assert.equal(paused?.phase, point === "confirming" ? "launched" : point);
          assert.equal(await managerAlive(handle.manager), true);
          if (point === "vacated") {
            assert.equal((await inspect(target)).version, before.version);
            assert.equal(digest(await readFile(join(target, "Contents/Info.plist"))), beforeInfo);
          }
          if (point === "confirming") assert.ok(paused?.next && (await managerAlive(paused.next)));
          if (point === "displaced") await assert.rejects(readFile(join(target, "Contents/Info.plist")), /ENOENT/);
          if (point === "installed") assert.equal((await inspect(target)).version, "0.2.0");
          process.kill(handle.manager.pid, "SIGKILL");
          await waitGone(handle.manager.pid, 5000);
          if (point === "confirming") {
            await waitGone(paused!.next!.pid, 20000);
            assert.equal((await readDirectory(paused!.next!.root)).manager.phase, "closed");
          }
          await assert.rejects(
            resume({ root: installRoot, target, product: first.product, channel: first.channel }),
            /interrupted|recovery/,
          );
          const recovery = await inspectRecovery(installRoot);
          assert.equal(recovery.phase, "ready");
          await recover(installRoot, { expected: recovery.fingerprint });
          const resumed = await resume({ root: installRoot, target, product: first.product, channel: first.channel });
          await arm(resumed);
          handle = { ...resumed, target };
        }
        let record: Journal | undefined;
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          record = await inspectInstallation({
            root: installRoot,
            target,
            product: first.product,
            channel: first.channel,
          });
          if (record?.phase === "confirmed") break;
          if (record?.phase === "failed") throw Error(record.error);
          await new Promise((done) => setTimeout(done, 100));
        }
        assert.equal(record?.phase, "confirmed");
        assert.ok(record.next);
        if (point === "confirming") assert.notEqual(record.next.pid, paused!.next!.pid);
        await waitGone(handle.manager.pid, 10000);
        assert.equal(await managerAlive(record.next), true);
        assert.equal((await inspect(target)).version, "0.2.0");
        assert.notEqual(digest(await readFile(join(target, "Contents/Info.plist"))), beforeInfo);
        assert.notEqual(record.oldHash, record.newHash);
        assert.equal(record.old.length, two ? 2 : 1);
        const selectedRoot = record.next.root,
          selectedPrimary = selectedRoot === runtime;
        assert.ok(selectedPrimary || (two && selectedRoot === secondary));
        const fresh = await (
          await Inspector.open(selectedRoot, {
            channel: initial.manifest.channel,
            namespace: namespace(selectedPrimary ? "slim" : "alternate"),
          })
        ).target<{
          status: { input: null; output: HostReceipt };
          read: { input: null; output: Record<string, unknown> };
        }>("host", updated.envelope.digest);
        const running = await fresh.call("status", null);
        assert.equal(running.phase, "ready");
        assert.equal(running.pid, record.next.pid);
        assert.equal(running.automation.shown, false);
        assert.equal(running.automation.focused, false);
        assert.equal(running.generation, updated.envelope.digest);
        assert.equal(running.units.web.version, "0.2.0");
        assert.equal(running.units.daemon.version, "0.2.0");
        assert.match(running.renderer, /installed2/);
        assert.match(String(running.daemon.witness), /installed2/);
        assert.equal((await fresh.call("read", null)).retained, selectedPrimary ? "primary-data" : "secondary-data");
        await fresh.stop();
        await waitGone(running.pid, 10000);
        if (two) {
          const reopened = await start(`reopened${index}`, {
            ...environment,
            PESUITE_INSTALLATION_PAUSE: "none",
            PESUITE_LEAF_ACTIVATE: "1",
            PESUITE_DATA: selectedPrimary ? secondary : runtime,
            PESUITE_NAMESPACE: selectedPrimary ? "alternate" : "slim",
            PESUITE_RECEIPT: join(caseRoot, "reopened.json"),
          });
          const restored = await (
            await Inspector.open(selectedPrimary ? secondary : runtime, {
              channel: initial.manifest.channel,
              namespace: namespace(selectedPrimary ? "alternate" : "slim"),
            })
          ).target<{
            read: { input: null; output: Record<string, unknown> };
            status: { input: null; output: HostReceipt };
          }>("host", initial.envelope.digest);
          let reopenedSnapshot: HostReceipt | undefined;
          const settled = Date.now() + 20000;
          while (Date.now() < settled) {
            reopenedSnapshot = await restored.call("status", null);
            if (reopenedSnapshot.generation === updated.envelope.digest && reopenedSnapshot.phase === "ready") break;
            await new Promise((done) => setTimeout(done, 100));
          }
          assert.equal(reopenedSnapshot?.generation, updated.envelope.digest);
          assert.equal(reopenedSnapshot?.units.web.version, "0.2.0");
          assert.equal(reopenedSnapshot?.units.daemon.version, "0.2.0");
          assert.equal(
            (await restored.call("read", null)).retained,
            selectedPrimary ? "secondary-data" : "primary-data",
          );
          await restored.stop();
          await waitGone(reopened.pid, 10000);
          await factory.release(reopened);
        }
        const retainedJob = JSON.parse(await readFile(join(home, "job.json"), "utf8"));
        const retained = [
          join(home, "record.json"),
          join(home, "archive.zip"),
          join(home, "policy"),
          join(home, "content"),
          join(home, "backup", basename(target)),
          retainedJob.executor,
          retainedJob.worker,
        ];
        for (const path of retained) assert.ok(await stat(path));
        receipts.push({
          point,
          retained,
          target,
          before,
          after: await inspect(target),
          beforeInfo,
          record,
          paused,
          running,
          oldPids: [one.pid, ...(two ? [two.pid] : [])],
          newPid: running.pid,
          manager: handle.manager,
          result: "passed",
        });
        await writeFile(
          join(root, "receipt.json"),
          JSON.stringify(
            {
              result: "passed",
              endpoint,
              bucket,
              receipts,
              scope:
                "actual unsigned macOS arm64 Silo, same-path physical replacement, old namespace drain, independent manager survival and explicit SIGKILL recovery",
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await controller.close();
      storage.close();
      admin.destroy();
    }
  },
  600000,
);
