import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { waitGone } from "@perishcode/automation";
import type { HostReceipt } from "@perishcode/electron";
import { Inspector } from "@perishcode/inspect";
import { namespace } from "@perishcode/protocol";
import { Authority, writeFeed } from "@perishcode/publish";
import { compose } from "@perishcode/release";
import { type ActivationCheckpoint, readProduct } from "@perishcode/runtime";
import { Sources } from "@perishcode/serve";
import { readBinding, serve } from "@perishcode/sidecar";
import { it } from "vitest";

it.runIf(process.platform === "darwin" && process.env.PESUITE_INTERRUPTION_E2E === "1")(
  "observes real installed SIGKILL across activation boundaries without adopting interrupted authority",
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
    const candidate = await compose(initial.manifest, {
      capsule: join(repository, "apps/capsule/dist"),
      web: join(repository, "apps/web/dist"),
      daemon: join(repository, "apps/daemon/dist"),
      carrier: 1,
      blobs: [{ slot: "probe", path: join(repository, "apps/capsule/dist/probe.bin") }],
    });
    const scope = { channel: initial.manifest.channel, namespace: namespace("slim") };
    const controller = await serve(
      join(tmpdir(), `slim-interruption-${process.pid}.sock`),
      undefined,
      undefined,
      join(root, "controller"),
    );
    const factory = controller.factory({ ...scope, namespace: namespace("validation") });
    const receipts = [];
    try {
      for (const point of ["prepared", "daemon-stopped", "ready", "committed"] as const) {
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
          PESUITE_AUTOMATION: "1",
          PESUITE_INSPECT: "1",
          PESUITE_RECEIPT: receipt,
          PESUITE_ACTIVATION_PAUSE: point,
          PESUITE_LEAF_ACTIVATE: "1",
          PESUITE_FEED: sources.endpoints[0]?.url ?? "",
          PESUITE_FEED_KEY: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
          PESUITE_FEED_INTERVAL: "100",
        };
        const start = (recover: boolean) =>
          factory.start({
            command: join(app, "Contents/MacOS", initial.manifest.identity.scheme),
            slot: "host",
            generation: initial.envelope.digest,
            ready: `inspect-ready:${initial.envelope.digest}`,
            timeout: 15000,
            env: { ...env, PESUITE_RECOVER: recover ? "1" : "0" },
          });
        let lease: Awaited<ReturnType<typeof start>> | undefined;
        try {
          lease = await start(false);
          const inspector = await Inspector.open(data, scope);
          const host = await inspector.target<{
            status: { input: unknown; output: HostReceipt };
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
          receipts.push({
            point,
            checkpoint,
            baseline,
            active,
            observed,
            trackedPids: pids,
            survivors: [],
            result: "passed",
            recovery: "blocked; not recovered",
          });
          await writeFile(
            join(root, "receipt.json"),
            JSON.stringify(
              {
                receipts,
                scope:
                  "unsigned macOS registry; tracked host/Daemon only; no recovery/adoption/power-loss/fullscreen claim",
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
