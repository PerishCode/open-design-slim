import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channel, digest, namespace } from "@perishcode/protocol";
import { serve } from "@perishcode/sidecar";
import { expect, it } from "vitest";
import { create } from "@/capsule/index.js";

it("initializes its composition with managed resources and explicitly drains", async () => {
  const root = await mkdtemp(join(tmpdir(), "slim-capsule-"));
  const host = await serve(join(root, "manager.sock"));
  const path = join(root, "probe");
  await writeFile(path, "blob:test");
  const body = create();
  let data = "";
  try {
    const factory = host.factory({ channel: channel("stable"), namespace: namespace("test") });
    const attachment = await factory.expose<Record<string, { input: unknown; output: unknown }>>({
      identity: { service: "electron", generation: digest("test") },
      handlers: {},
      lifecycle: {
        initialize: async (resources) => {
          data = resources.roots.data;
          expect(
            (
              await body.initialize({
                blobs: { probe: path },
                generation: digest("test"),
                nonce: "test",
                version: "0.1.0",
                resources,
                protocols: { internal: "od", external: "od-stable", origin: "od://carrier" },
                daemon: { request: async () => ({}) },
                updates: { start: async () => {}, stop: async () => {} },
              })
            ).witness,
          ).toBe("capsule:test:blob:test");
        },
        stop: () => body.stop(),
      },
    });
    await attachment.close();
    expect(await readFile(join(data, "launches"), "utf8")).toBe("1");
    expect(await readFile(join(data, "stopped"), "utf8")).toBe(attachment.context.incarnation);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
