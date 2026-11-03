import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Capsule, CapsuleContext } from "@perishcode/runtime";

declare const BUILD: string;
const build = typeof BUILD === "undefined" ? "test" : BUILD;

export function create(): Capsule {
  let context: CapsuleContext | undefined;
  let launches = 0;
  return {
    handlers: {
      lifecycle: () => ({
        build,
        launches,
        incarnation: context?.resources.incarnation,
        data: context?.resources.roots.data,
        runtime: context?.resources.roots.runtime,
      }),
    },
    initialize: async (injected) => {
      context = injected;
      const path = context.blobs.probe;
      if (!path) throw new Error("probe resource is required");
      const resource = await readFile(path, "utf8");
      await context.resources.allocate({ kind: "lock", name: "capsule" });
      const counter = join(context.resources.roots.data, "launches");
      try {
        launches = Number(await readFile(counter, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      launches++;
      await writeFile(counter, String(launches));
      await writeFile(join(context.resources.roots.runtime, "active"), context.resources.incarnation);
      return { window: { title: "Open Design Slim — Skeleton" }, witness: `capsule:${build}:${resource}` };
    },
    stop: async () => {
      if (context) await writeFile(join(context.resources.roots.data, "stopped"), context.resources.incarnation);
    },
  };
}
