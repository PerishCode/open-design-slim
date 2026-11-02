import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as path } from "node:path";
import { compose, releaseChannel, resolve } from "@perishcode/release";
import { type Receipt, Session, writeProduct } from "@perishcode/runtime";
import { readDirectory } from "@perishcode/sidecar";
import { it } from "vitest";

it("consumes factory-bound SDK with same-root channel isolation and version data continuity", async () => {
  const root = await mkdtemp(join(tmpdir(), "slim-runtime-"));
  const receipts: Receipt[] = [];
  let active: Session | undefined;
  try {
    const run = async (lane: string, version: string, expected: unknown, value: string) => {
      const manifest = resolve(
        {},
        { channel: releaseChannel(lane), version },
        {
          appid: "io.perish.opendesignslim",
          name: "Open Design Slim",
          scheme: "opendesignslim",
        },
      );
      const product = await compose(manifest, {
        capsule: path("../capsule/dist"),
        daemon: path("../daemon/dist"),
        web: path("../web/dist"),
        carrier: 1,
        blobs: [{ slot: "probe", path: path("../capsule/dist/probe.bin") }],
      });
      const seed = join(root, version);
      await writeProduct(seed, product);
      active = await Session.open({
        root: join(root, "state"),
        namespace: "slim",
        manifest,
        seed,
        candidate: seed,
        carrier: 1,
        executable: process.execPath,
      });
      const payload = await active.activate();
      await active.start();
      assert.deepEqual(await active.request("read"), expected);
      await active.request("write", { value });
      const receipt = await active.confirm(payload, "node-probe");
      assert.deepEqual(receipt.factory, { channel: lane, namespace: "slim" });
      assert.ok(
        receipt.directory.instances.some(
          (i) =>
            i.kind === "process" &&
            i.service === "daemon" &&
            i.phase === "ready" &&
            i.pid === receipt.daemon.pid &&
            i.channel === lane &&
            i.namespace === "slim",
        ),
      );
      receipts.push(receipt);
      assert.deepEqual(await active.close(), { status: "stopped", survivors: [] });
      active = undefined;
    };
    await run("stable", "1.0.0", {}, "stable1");
    await run("beta", "1.0.0-beta.1", {}, "beta1");
    await run("stable", "2.0.0", { value: "stable1" }, "stable2");
    await run("beta", "1.0.0-beta.1", { value: "beta1" }, "beta2");
    const directory = await readDirectory(join(root, "state"));
    assert.equal(directory.manager.phase, "closed");
    assert.equal(directory.factories.length, 2);
    assert.ok(directory.factories.every((f) => f.phase === "closed"));
    assert.ok(directory.instances.every((i) => i.phase === "retired"));
    await mkdir("../../.artifacts/runtime", { recursive: true });
    await writeFile(
      "../../.artifacts/runtime/factory.json",
      JSON.stringify(
        {
          result: "passed",
          receipts,
          directory,
          unqualified: ["renderer execution", "interrupted manager recovery", "legacy data migration"],
        },
        null,
        2,
      ),
    );
  } finally {
    await active?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
