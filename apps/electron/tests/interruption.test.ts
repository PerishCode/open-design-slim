import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { waitGone } from "@perishcode/automation";
import { resourceKey, type State } from "@perishcode/blob";
import type { HostReceipt } from "@perishcode/electron";
import { Inspector } from "@perishcode/inspect";
import { namespace } from "@perishcode/protocol";
import { Authority, writeFeed } from "@perishcode/publish";
import { compose } from "@perishcode/release";
import { type ActivationCheckpoint, readProduct } from "@perishcode/runtime";
import { Sources } from "@perishcode/serve";
import { observeProcesses, type RecoveryPlan, readBinding, serve } from "@perishcode/sidecar";
import { it } from "vitest";

const capsuleMode = process.env.PESUITE_CAPSULE_INTERRUPTION_E2E === "1";
it.runIf(process.platform === "darwin" && (process.env.PESUITE_INTERRUPTION_E2E === "1" || capsuleMode))(
  "recovers real installed activation interruptions through root-wide explicit recovery",
  async () => {
    const repository = resolve("../.."),
      root = join(repository, `.artifacts/interruption/${Date.now()}`);
    await mkdir(root, { recursive: true });
    const run = (args: string[], env: Record<string, string> = {}) =>
      promisify(execFile)("pnpm", args, {
        cwd: repository,
        timeout: 90000,
        env: { ...process.env, ...env },
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
      "apps/capsule/dist",
      "--web",
      "apps/web/dist",
      "--daemon",
      "apps/daemon/dist",
      "--blob",
      "probe=apps/capsule/dist/probe.bin",
      "--output",
      seed,
    ]);
    const initial = await readProduct(seed);
    await run([
      "exec",
      "pesuite",
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
    await run(["--filter", "@perishcode/slim-web", "build"], {
      PESUITE_BUILD: "web-0.2.0",
      PESUITE_UNIT_VERSION: "0.2.0",
    });
    await run(["--filter", "@perishcode/slim-daemon", "build"], {
      PESUITE_BUILD: "daemon-0.2.0",
      PESUITE_UNIT_VERSION: "0.2.0",
    });
    const blob = join(root, "baseline-probe.bin");
    await writeFile(blob, initial.assets.find((a) => a.artifact.kind === "blob")!.bytes);
    if (capsuleMode) await writeFile(blob, "blob:interrupted-candidate");
    if (capsuleMode) await run(["--filter", "@perishcode/slim-capsule", "build"], { PESUITE_BUILD: "capsule-0.2.0" });
    const candidate = await compose(
      capsuleMode
        ? { ...initial.manifest, identity: { ...initial.manifest.identity, version: "0.2.0" } }
        : initial.manifest,
      {
        capsule: join(repository, "apps/capsule/dist"),
        web: join(repository, "apps/web/dist"),
        daemon: join(repository, "apps/daemon/dist"),
        carrier: 1,
        blobs: [{ slot: "probe", path: blob }],
      },
    );
    const scope = { channel: initial.manifest.channel, namespace: namespace("slim") };
    const controller = await serve(join(tmpdir(), `slim-interruption-${process.pid}.sock`), {
      root: join(root, "controller"),
    });
    const factory = controller.factory({ ...scope, namespace: namespace("validation") });
    const receipts = [];
    try {
      for (const point of capsuleMode
        ? (["prepared", "capsule-stopped", "daemon-stopped", "ready", "committed"] as const)
        : (["prepared", "daemon-stopped", "ready", "committed"] as const)) {
        const directory = join(root, point),
          data = join(directory, "data"),
          receipt = join(directory, "host.json");
        await mkdir(directory);
        const pair = generateKeyPairSync("ed25519");
        const authority = await Authority.open({
          root: join(directory, "publication"),
          privatekey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        });
        await authority.publish(scope.channel, 0, initial.envelope, initial.assets);
        const content = join(directory, "feed");
        await writeFeed(authority, scope.channel, content);
        const sources = await Sources.open({
          data: join(directory, "sources"),
          scope,
          sources: { feed: { directory: content } },
        });
        const env = {
          PESUITE_DATA: data,
          PESUITE_PROBE: "0",
          PESUITE_CONTENT_RETENTION: "0",
          PESUITE_AUTOMATION: "1",
          PESUITE_INSPECT: "1",
          PESUITE_RECEIPT: receipt,
          PESUITE_ACTIVATION_PAUSE: point,
          PESUITE_LEAF_ACTIVATE: "1",
          PESUITE_CAPSULE_ACTIVATE: capsuleMode ? "1" : "0",
          PESUITE_FEED: sources.endpoints[0]?.url ?? "",
          PESUITE_FEED_KEY: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
          PESUITE_FEED_INTERVAL: "100",
        };
        const start = (recover: boolean, resume = false, selected = initial.envelope.digest) => {
          const runtimeEnv: Record<string, string> = { ...env, PESUITE_RECOVER: recover ? "1" : "0" };
          if (resume) {
            delete runtimeEnv.PESUITE_ACTIVATION_PAUSE;
            runtimeEnv.PESUITE_LEAF_ACTIVATE = "0";
            runtimeEnv.PESUITE_CAPSULE_ACTIVATE = "0";
          }
          return factory.start({
            command: join(app, "Contents/MacOS", initial.manifest.identity.scheme),
            service: "host",
            generation: selected,
            ready: `inspect-ready:${selected}`,
            timeout: 15000,
            env: runtimeEnv,
          });
        };
        let lease: Awaited<ReturnType<typeof start>> | undefined;
        try {
          lease = await start(false);
          const inspector = await Inspector.open(data, scope);
          const host = await inspector.target<{
            status: { input: unknown; output: HostReceipt };
            content: { input: "status" | "collect"; output: State | string[] };
            adapter: { input: { method: string; value: unknown }; output: Record<string, unknown> };
            read: { input: unknown; output: Record<string, unknown> };
            write: { input: Record<string, unknown>; output: unknown };
          }>("host", initial.envelope.digest);
          const baseline = await host.call("status", null);
          await host.call("write", { ...(await host.call("read", null)), retained: "factory-data" });
          // Record the actual sidecar-issued data root, without deriving private management paths.
          const resources = await inspector.factory.resources();
          const persistent = resources.grants.find((x) => x.kind === "data" && x.name === "daemon");
          assert.ok(persistent);
          await authority.publish(scope.channel, 1, candidate.envelope, candidate.assets);
          await writeFeed(authority, scope.channel, content);
          let checkpoint: ActivationCheckpoint | undefined;
          const end = Date.now() + 20000;
          while (Date.now() < end) {
            try {
              checkpoint = JSON.parse(await readFile(`${receipt}.activation.json`, "utf8"));
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            await new Promise((done) => setTimeout(done, 25));
          }
          assert.equal(checkpoint?.stage, point);
          const active = await host.call("status", null);
          assert.equal(active.automation.shown, false);
          assert.equal(active.automation.focused, false);
          if (point === "prepared") assert.equal(active.daemon.pid, baseline.daemon.pid);
          if (point === "daemon-stopped") assert.equal(active.units.daemon.pid, undefined);
          if (point === "ready" || point === "committed") {
            assert.ok(active.renderer.includes("web-0.2.0"));
            assert.ok(String(active.daemon.witness).includes("daemon-0.2.0"));
          }
          const osBefore = await observeProcesses(data, scope);
          if (point === "daemon-stopped") assert.equal(osBefore.length, 0);
          else {
            assert.equal(osBefore.length, 1);
            assert.ok(osBefore[0]?.processes.some((p) => p.pid === active.daemon.pid));
            assert.notEqual(osBefore[0]?.supervisor.pid, active.daemon.pid);
          }
          process.kill(lease.pid, "SIGKILL");
          await waitGone(lease.pid, 5000);
          const observed = await readBinding(data, scope);
          assert.equal(observed.directory.manager.phase, "interrupted");
          assert.equal(
            observed.journal.state.current,
            point === "committed" ? candidate.envelope.digest : initial.envelope.digest,
          );
          if (point === "committed") assert.equal(observed.journal.state.attempt, undefined);
          else {
            assert.equal(observed.journal.state.attempt?.nonce, checkpoint?.nonce);
            assert.equal(observed.journal.state.attempt?.status, "running");
          }
          const pids = [
            ...new Set(
              [
                baseline.daemon.pid,
                ...observed.directory.instances.filter((x) => x.kind === "process").map((x) => x.pid),
              ].filter((pid): pid is number => typeof pid === "number"),
            ),
          ];
          for (const pid of pids) await waitGone(pid, 5000);
          const osEnd = Date.now() + 5000;
          while ((await observeProcesses(data, scope)).length && Date.now() < osEnd)
            await new Promise((done) => setTimeout(done, 25));
          const osAfter = await observeProcesses(data, scope);
          assert.deepEqual(osAfter, []);
          const before = await readBinding(data, scope);
          const authorityFiles = [
            "manager.sqlite",
            "factories/stable/slim/registry.json",
            "factories/stable/slim/binding.json",
          ];
          const bytes = await Promise.all(authorityFiles.map((file) => readFile(join(data, file))));
          await factory.release(lease);
          lease = undefined;
          for (const recover of [false, true]) await assert.rejects(start(recover), /interrupted; recovery required/);
          assert.deepEqual(await Promise.all(authorityFiles.map((file) => readFile(join(data, file)))), bytes);
          assert.deepEqual(await readBinding(data, scope), before);
          assert.equal(
            JSON.parse(await readFile(join(persistent.value, "state.json"), "utf8")).retained,
            "factory-data",
          );
          const inspectPlan = async () =>
            JSON.parse((await run(["exec", "pesuite", "recover", "inspect", "--data", data])).stdout)
              .result as RecoveryPlan;
          const recoveryPlan = await inspectPlan();
          assert.equal(recoveryPlan.phase, "ready");
          assert.deepEqual(await Promise.all(authorityFiles.map((file) => readFile(join(data, file)))), bytes);
          let interruptedRecovery = false;
          if (point === "ready") {
            const entry = pathToFileURL(createRequire(import.meta.url).resolve("@perishcode/sidecar")).href;
            const body = `import{recover}from ${JSON.stringify(entry)};await recover(process.argv[1],{expected:process.argv[2],onCheckpoint:async c=>{if(c.stage==='prepared'){console.log('recovery-paused');await new Promise(()=>{});}}});`;
            const actor = await factory.start({
              command: process.execPath,
              args: ["--input-type=module", "-e", body, data, recoveryPlan.fingerprint],
              service: "recovery",
              generation: recoveryPlan.fingerprint as typeof initial.envelope.digest,
              ready: "recovery-paused",
              timeout: 15000,
            });
            process.kill(actor.pid, "SIGKILL");
            await waitGone(actor.pid, 5000);
            await factory.release(actor);
            const resumed = await inspectPlan();
            assert.equal(resumed.phase, "recovering");
            assert.equal(resumed.fingerprint, recoveryPlan.fingerprint);
            interruptedRecovery = true;
          }
          const recovered = JSON.parse(
            (await run(["exec", "pesuite", "recover", "apply", "--data", data, "--expected", recoveryPlan.fingerprint]))
              .stdout,
          ).result as RecoveryPlan;
          assert.equal(recovered.phase, "complete");
          const closed = await readBinding(data, scope);
          assert.equal(closed.directory.manager.phase, "closed");
          assert.equal(closed.journal.state.current, before.journal.state.current);
          if (point !== "committed") assert.equal(closed.journal.state.attempt?.status, "failed");
          const selected = point === "committed" ? candidate.envelope.digest : initial.envelope.digest;
          lease = await start(point !== "committed", true, selected);
          const fresh = await Inspector.open(data, scope);
          const restoredHost = await fresh.target<{
            status: { input: unknown; output: HostReceipt };
            content: { input: "status" | "collect"; output: State | string[] };
            adapter: { input: { method: string; value: unknown }; output: Record<string, unknown> };
            read: { input: unknown; output: Record<string, unknown> };
          }>("host", selected);
          const restored = await restoredHost.call("status", null);
          assert.equal(restored.generation, selected);
          assert.equal(restored.product?.version, capsuleMode && point === "committed" ? "0.2.0" : "0.1.0");
          assert.equal(restored.units.web.version, point === "committed" ? "0.2.0" : "0.1.0");
          assert.equal(restored.units.daemon.version, point === "committed" ? "0.2.0" : "0.1.0");
          assert.equal((await restoredHost.call("read", null)).retained, "factory-data");
          assert.notEqual(restored.directory.manager.incarnation, before.directory.manager.incarnation);
          assert.ok(!(await fresh.factory.binding()).state.attempt);
          await assert.rejects(host.call("status", null));
          let resourceEvidence: unknown;
          if (capsuleMode) {
            const actual = await restoredHost.call("adapter", { method: "resource", value: null });
            assert.equal(actual.pid, restored.pid);
            assert.equal(actual.value, point === "committed" ? "blob:interrupted-candidate" : "blob:baseline");
            const state = (await restoredHost.call("content", "status")) as State;
            const selectedProduct = point === "committed" ? candidate : initial;
            const key = resourceKey({ type: "file", artifact: selectedProduct.envelope.generation.blobs[0]! });
            assert.equal(state.entries[key]!.uses.length, 1);
            assert.equal(state.entries[key]!.uses[0]!.owner.service, "electron");
            assert.ok(state.references.some((r) => r.kind === "current" && r.keys.includes(key)));
            assert.ok(state.references.every((r) => r.kind !== "prepared"));
            if (point === "committed")
              assert.ok(state.references.some((r) => r.kind === "recovery" && r.name === initial.envelope.digest));
            const removed = (await restoredHost.call("content", "collect")) as string[];
            assert.equal(removed.length, point === "committed" ? 0 : 1);
            resourceEvidence = { actual, state, removed };
          }
          await restoredHost.stop();
          await waitGone(lease.pid, 5000);
          await waitGone(Number(restored.daemon.pid), 5000);
          await factory.release(lease);
          lease = undefined;
          receipts.push({
            point,
            checkpoint,
            baseline,
            active,
            observed,
            trackedPids: pids,
            osBefore,
            osAfter,
            survivors: [],
            result: "passed",
            recovery: "explicit root recovery and cold launch passed",
            recoveryPlan,
            recovered,
            restored,
            resourceEvidence,
            interruptedRecovery,
          });
          await writeFile(
            join(root, "receipt.json"),
            JSON.stringify(
              {
                level: capsuleMode ? "capsule" : "leaf",
                receipts,
                scope:
                  "unsigned macOS registry; explicit dead-owner recovery, retained current/data and cold launch; no live adoption/power-loss/fullscreen claim",
              },
              null,
              2,
            ),
          );
        } finally {
          if (lease) await factory.release(lease);
          await sources.close();
        }
      }
      process.stdout.write(`${JSON.stringify({ result: "passed", receipt: join(root, "receipt.json") })}\n`);
    } finally {
      await controller.close();
    }
  },
  180000,
);
