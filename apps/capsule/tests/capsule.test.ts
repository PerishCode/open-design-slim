import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { activate } from "@";

it("loads its injected resource and refuses an incomplete product composition", async () => {
  const root = await mkdtemp(join(tmpdir(), "slim-capsule-"));
  try {
    const path = join(root, "probe");
    await writeFile(path, "blob:test");
    const context = { blobs: { probe: path }, generation: "sha256:test" as const, nonce: "test" };
    expect((await activate(context)).witness).toBe("capsule:test:blob:test");
    await expect(activate({ ...context, blobs: {} })).rejects.toThrow("resource");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
