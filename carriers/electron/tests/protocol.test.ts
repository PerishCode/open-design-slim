import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { waitGone } from "@perishcode/automation";
import type { HostReceipt } from "@perishcode/electron";
import { Inspector } from "@perishcode/inspect";
import { namespace } from "@perishcode/protocol";
import { it } from "vitest";

it.runIf(process.platform === "darwin" && process.env.PESUITE_PROTOCOL_E2E === "1")(
  "delivers OS cold and warm channel URLs to the Capsule adapter in the installed host",
  async () => {
    const repository = resolve("../.."),
      baseline = JSON.parse(await readFile(join(repository, ".artifacts/skeleton/receipt.json"), "utf8"));
    const root = join(repository, `.artifacts/protocol/${Date.now()}`),
      data = join(root, "state");
    await mkdir(root, { recursive: true });
    const open = async (value: string) =>
      promisify(execFile)(
        "/usr/bin/open",
        [
          "-g",
          "-a",
          baseline.app,
          "--env",
          "PESUITE_AUTOMATION=1",
          "--env",
          "PESUITE_INSPECT=1",
          "--env",
          `PESUITE_DATA=${data}`,
          "--env",
          `PESUITE_RECEIPT=${join(root, "host.json")}`,
          `od-stable://probe?value=${value}`,
        ],
        { timeout: 10000 },
      );
    let inspector: Inspector | undefined, pid: number | undefined, daemon: number | undefined;
    const scope = { channel: baseline.initial.factory.channel, namespace: namespace("slim") };
    const snapshots: HostReceipt[] = [];
    try {
      await open("cold");
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        try {
          inspector = await Inspector.open(data, scope);
          const target = await inspector.target<{ status: { input: null; output: HostReceipt } }>(
            "host",
            baseline.initial.generation,
          );
          const status = await target.call("status", null);
          pid = status.pid;
          daemon = Number(status.daemon.pid);
          if (status.adapter.links.handled === 1) {
            assert.equal((status.adapter.links.result as { value: string }).value, "cold");
            snapshots.push(status);
            break;
          }
        } catch {}
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.equal(snapshots.length, 1, "cold URL delivery must complete");
      await open("warm");
      const target = await inspector!.target<{ status: { input: null; output: HostReceipt } }>(
        "host",
        baseline.initial.generation,
      );
      const warmUntil = Date.now() + 10000;
      while (Date.now() < warmUntil) {
        const status = await target.call("status", null);
        if (status.adapter.links.handled === 2) {
          snapshots.push(status);
          break;
        }
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.equal(snapshots.length, 2);
      assert.equal(snapshots[1]!.pid, snapshots[0]!.pid);
      assert.equal((snapshots[1]!.adapter.links.result as { value: string }).value, "warm");
      assert.ok(
        snapshots.every(
          (s) =>
            s.directory.instances.every((i) => i.service !== "capsule") && !s.automation.shown && !s.automation.focused,
        ),
      );
      await target.stop();
      await waitGone(pid!, 5000);
      await waitGone(daemon!, 5000);
      await writeFile(
        join(root, "receipt.json"),
        JSON.stringify(
          {
            result: "passed",
            app: baseline.app,
            snapshots,
            scope:
              "actual macOS open -g -a URL delivery; explicit installed application selection; default global resolver/channel coexistence remains separate",
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ result: "passed", receipt: join(root, "receipt.json") }));
    } finally {
      if (inspector && pid) {
        try {
          await (await inspector.target("host", baseline.initial.generation)).stop();
        } catch {}
        await waitGone(pid, 5000);
      }
    }
  },
  45000,
);
