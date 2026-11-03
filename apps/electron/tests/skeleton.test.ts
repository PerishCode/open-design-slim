import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { type CaseReceipt, Observer, runElectron, waitGone } from "@perishcode/automation";
import type { HostReceipt as Receipt } from "@perishcode/electron";
import { Inspector } from "@perishcode/inspect";
import { namespace } from "@perishcode/protocol";
import { compose } from "@perishcode/release";
import { readProduct, writeProduct } from "@perishcode/runtime";
import { Sources } from "@perishcode/serve";
import { readDirectory, serve } from "@perishcode/sidecar";
import { it } from "vitest";

it.runIf(process.platform === "darwin" && process.env.PESUITE_E2E === "1")(
  "validates the installed skeleton lifecycle",
  async () => {
    const repository = resolve("../..");
    const raw = promisify(execFile);
    const execute = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}) =>
      raw(file, args, { ...options, cwd: repository, encoding: "utf8" });
    const root = resolve(repository, ".artifacts/skeleton");
    await mkdir(root, { recursive: true });
    const state = join(root, `state-${Date.now()}`);
    const cases: unknown[] = [];
    const steps: { name: string; milliseconds: number }[] = [];
    const step = async <T>(name: string, run: () => Promise<T>) => {
      const start = performance.now();
      const result = await run();
      steps.push({ name, milliseconds: performance.now() - start });
      return result;
    };
    const releaseArgs = [
      "exec",
      "pesuite",
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
      ".artifacts/seed",
    ];
    const build = async (marker: string) => {
      await execute("pnpm", ["build"], { env: { ...process.env, PESUITE_BUILD: marker } });
      await execute("pnpm", releaseArgs);
    };
    await step("build skeleton1", () => build("skeleton1"));
    const first = await readProduct(join(repository, ".artifacts/seed"));
    await step("package once", () =>
      execute("pnpm", [
        "exec",
        "pesuite",
        "pack",
        "--carrier",
        "apps/electron/dist",
        "--seed",
        ".artifacts/seed",
        "--output",
        ".artifacts/package",
        "--receipt",
        ".artifacts/package.json",
      ]),
    );
    const packaged = JSON.parse(await readFile(join(repository, ".artifacts/package.json"), "utf8"));
    const app = join(root, `installed-${Date.now()}`, basename(packaged.app));
    await cp(packaged.app, app, { recursive: true, verbatimSymlinks: true });
    const executable = join(app, "Contents/MacOS", first.manifest.identity.scheme);

    async function fingerprint(path: string) {
      const hash = createHash("sha256");
      async function walk(directory: string) {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          const file = join(directory, entry.name);
          const record: { path: string; kind: string; target?: string; mode?: number; sha256?: string } = {
            path: file.slice(path.length),
            kind: "file",
          };
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
    const desktopCases: CaseReceipt[] = [];
    const desktop =
      process.env.PESUITE_DESKTOP === "1"
        ? await Observer.open({
            directory: join(root, `desktop-${Date.now()}`),
            bundle: first.manifest.identity.appid,
            requireFullscreen: true,
          })
        : undefined;
    try {
      function launch(name: string, extra?: NodeJS.ProcessEnv): Promise<Receipt>;
      function launch(
        name: string,
        extra: NodeJS.ProcessEnv,
        expected: number,
        message?: string,
      ): Promise<Receipt | undefined>;
      async function launch(
        name: string,
        extra: NodeJS.ProcessEnv = {},
        expected = 0,
        message?: string,
      ): Promise<Receipt | undefined> {
        const launched = await runElectron<Receipt>({
          name,
          mode: expected === 0 ? "exit" : "failure",
          executable,
          cwd: repository,
          receipt: join(root, `${name}.json`),
          observer: desktop,
          message,
          env: { PESUITE_DATA: state, ...extra },
        });
        cases.push({
          name,
          expectedExit: expected,
          pid: launched.pid,
          exit: launched.exit,
          stdout: launched.stdout,
          stderr: launched.stderr,
        });
        if (launched.desktop) desktopCases.push(launched.desktop);
        if (expected !== 0) return;
        const result = launched.observed;
        assert.ok(result);
        assert.equal(result.generation, result.daemon.generation);
        assert.equal(result.nonce, result.daemon.nonce);
        assert.equal(result.factory.channel, first.manifest.channel);
        assert.ok(
          result.directory.instances.some(
            (instance: Receipt["directory"]["instances"][number]) =>
              instance.kind === "process" &&
              instance.service === "daemon" &&
              instance.phase === "ready" &&
              instance.pid === result.daemon.pid &&
              instance.channel === result.factory.channel &&
              instance.namespace === result.factory.namespace &&
              instance.generation === result.units.daemon.digest,
          ),
        );
        await waitGone(result.daemon.pid);
        return result;
      }
      const initial = await step("installed initial", () => launch("initial"));
      assert.equal(initial.generation, first.envelope.digest);
      assert.equal(initial.capsule, "capsule:skeleton1:blob:skeleton1");
      assert.equal(initial.renderer, "web:skeleton1:launch1");
      const cold = await step("cold start", () => launch("cold"));
      assert.equal(cold.renderer, "web:skeleton1:launch2");

      await step("build skeleton2 without repackaging host", () => build("skeleton2"));
      const second = await readProduct(join(repository, ".artifacts/seed"));
      for (const key of ["capsule", "daemon", "web"] as const)
        assert.notEqual(first.envelope.generation[key].digest, second.envelope.generation[key].digest);
      assert.notEqual(first.envelope.generation.blobs[0]?.digest, second.envelope.generation.blobs[0]?.digest);
      const update = await step("activate four new contents", () =>
        launch("update", { PESUITE_CANDIDATE: resolve(repository, ".artifacts/seed") }),
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
        capsule: join(repository, "apps/capsule/dist"),
        daemon: join(repository, "apps/daemon/dist"),
        web: join(repository, "apps/web/dist"),
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
        daemon: join(repository, "apps/daemon/dist"),
        web: join(repository, "apps/web/dist"),
      });
      await writeProduct(join(root, "failed"), failed);
      await launch("failed", { PESUITE_CANDIDATE: join(root, "failed") }, 1, "injected capsule failure");
      await launch("blocked", {}, 1, "capsule startup is blocked");
      const recovered = await launch("recovered", { PESUITE_RECOVER: "1" });
      assert.equal(recovered.generation, second.envelope.digest);

      const killed = await runElectron<Receipt>({
        name: "post-ready-sigkill",
        mode: "kill",
        executable,
        cwd: repository,
        receipt: join(root, "crash.json"),
        env: { PESUITE_DATA: state },
        observer: desktop,
      });
      const crash = killed.observed;
      assert.ok(crash);
      if (killed.desktop) desktopCases.push(killed.desktop);
      await waitGone(crash.daemon.pid);
      const resourceTruth = async () => ({
        manager: createHash("sha256")
          .update(await readFile(join(state, "manager.sqlite")))
          .digest("hex"),
        factories: await fingerprint(join(state, "factories")),
      });
      const interruptedBefore = await resourceTruth();
      const interrupted = await readDirectory(state);
      assert.equal(interrupted.manager.phase, "interrupted");
      assert.ok(
        interrupted.instances.some((instance) => instance.pid === crash.daemon.pid && instance.phase === "ready"),
      );
      await launch("after-crash-blocked", {}, 1, "recovery required");
      assert.deepEqual(await resourceTruth(), interruptedBefore, "blocked reopen rewrote interrupted resource truth");
      assert.deepEqual(await readDirectory(state), interrupted);
      const inspection: unknown[] = [];
      if (process.env.PESUITE_INSPECT_E2E === "1") {
        assert.ok(!desktop, "inspect lifecycle and fullscreen acceptance use separate explicit runs");
        const validation = join(root, `inspect-${Date.now()}`);
        const controller = await serve(
          join(tmpdir(), `slim-inspect-${process.pid}.sock`),
          undefined,
          undefined,
          join(validation, "controller"),
        );
        const scope = { channel: first.manifest.channel, namespace: namespace("slim") };
        const factory = controller.factory({ ...scope, namespace: namespace("validation") });
        const sources = await Sources.open({
          data: join(validation, "sources"),
          scope,
          sources: {
            web: { directory: join(repository, "apps/web/dist") },
            seed: { directory: join(repository, ".artifacts/seed") },
          },
        });
        try {
          const source = sources.endpoints.find((s) => s.service === "seed");
          assert.ok(source);
          const index = await fetch(`${source.url}/release.json`);
          assert.equal(index.status, 200);
          assert.equal((await index.json()).channel, scope.channel);
          const sourceInspector = await Inspector.open(join(validation, "sources"), scope);
          assert.ok((await sourceInspector.list()).some((i) => i.service === "web"));
          for (const mode of ["development", "installed"] as const) {
            const data = join(validation, mode);
            const expected = mode === "installed" ? first.envelope.digest : second.envelope.digest;
            const start = () =>
              factory.start({
                command: mode === "installed" ? executable : createRequire(import.meta.url)("electron"),
                args: mode === "installed" ? [] : [join(repository, "apps/electron/dist/main.mjs")],
                slot: mode,
                generation: expected,
                ready: `inspect-ready:${expected}`,
                timeout: 20000,
                env: {
                  PESUITE_DATA: data,
                  PESUITE_INSPECT: "1",
                  PESUITE_PROBE: "0",
                  PESUITE_AUTOMATION: "1",
                  PESUITE_RECEIPT: join(validation, `${mode}.json`),
                },
              });
            let lease = await start();
            try {
              const inspector = await Inspector.open(data, scope);
              const host = (await inspector.list()).find((i) => i.service === "host");
              assert.ok(host);
              assert.ok((await inspector.list()).some((i) => i.service === "daemon" && i.kind === "process"));
              const peer = await inspector.target<{
                status: { input: unknown; output: Receipt };
                echo: { input: unknown; output: { input: unknown } };
              }>("host", expected, host.incarnation);
              const status = await peer.call("status", null);
              assert.equal(status.generation, expected);
              assert.equal(status.daemon.generation, expected);
              assert.ok(status.capsule);
              assert.ok(status.renderer);
              assert.equal(status.pid, lease.pid);
              assert.equal(status.automation.shown, false);
              assert.equal(status.automation.focused, false);
              assert.deepEqual((await peer.call("echo", { mode, nonce: "caller-owned" })).input, {
                mode,
                nonce: "caller-owned",
              });
              const cli = [
                "exec",
                "pesuite",
                "inspect",
                "call",
                "--data",
                data,
                "--channel",
                scope.channel,
                "--namespace",
                scope.namespace,
                "--service",
                "host",
                "--generation",
                expected,
                "--incarnation",
                host.incarnation,
                "--method",
                "status",
              ];
              const reply = JSON.parse((await execute("pnpm", cli, { timeout: 10000 })).stdout);
              assert.equal(reply.result.value.pid, lease.pid);
              assert.ok(!JSON.stringify(reply).includes('"authority"'));
              await peer.stop();
              await waitGone(lease.pid);
              await waitGone(Number(status.daemon.pid));
              await factory.release(lease);
              assert.equal((await readDirectory(data)).manager.phase, "closed");
              lease = await start();
              const reopened = await Inspector.open(data, scope);
              assert.notEqual(reopened.manager, inspector.manager);
              await assert.rejects(reopened.target("host", expected, host.incarnation), /stale/);
              await assert.rejects(peer.probe());
              const current = (await reopened.list()).find((i) => i.service === "host");
              assert.ok(current);
              await execute(
                "pnpm",
                [
                  "exec",
                  "pesuite",
                  "inspect",
                  "stop",
                  "--data",
                  data,
                  "--channel",
                  scope.channel,
                  "--namespace",
                  scope.namespace,
                  "--service",
                  "host",
                  "--generation",
                  expected,
                  "--incarnation",
                  current.incarnation,
                ],
                { timeout: 10000 },
              );
              await waitGone(lease.pid);
              inspection.push({
                mode,
                status,
                old: host.incarnation,
                current: current.incarnation,
                oldManager: inspector.manager,
                manager: reopened.manager,
                cli: reply.ok,
                result: "passed",
              });
            } finally {
              await factory.release(lease);
            }
          }
        } finally {
          await sources.close();
          await controller.close();
        }
        await writeFile(
          join(root, "inspect.json"),
          JSON.stringify({ result: "passed", inspection, sources: sources.endpoints }, null, 2),
        );
      }
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
        interrupted,
        reopenBlocked: true,
        crash,
        cases,
        inspection,
        desktop: { requested: !!desktop, observer: desktop?.directory, cases: desktopCases },
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
    } finally {
      await desktop?.close();
    }
  },
  180000,
);
