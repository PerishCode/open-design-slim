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
      health: (_input, c) => c.daemon.request("health"),
      read: (_input, c) => c.daemon.request("read"),
      write: (input, c) => c.daemon.request("write", input),
      echo: (input) => ({ input, source: "capsule-ipc", build }),
      open: (input, c) => {
        if (typeof input !== "string") throw new Error("invalid external URL");
        const url = new URL(input);
        if (url.protocol !== `${c.protocols.external}:` || url.hostname !== "probe")
          throw new Error("unsupported external action");
        return { channel: c.protocols.external, value: url.searchParams.get("value") };
      },
      lifecycle: () => ({
        build,
        version: context?.version,
        launches,
        owner: context?.resources.incarnation,
        service: context?.resources.identity.service,
        data: context?.resources.roots.data,
        runtime: context?.resources.roots.runtime,
      }),
    },
    initialize: async (injected) => {
      context = injected;
      const path = context.blobs.probe;
      if (!path) throw new Error("probe resource is required");
      const resource = await readFile(path, "utf8");
      await context.resources.allocate({ kind: "lock", name: "adapter" });
      const counter = join(context.resources.roots.data, "launches");
      try {
        launches = Number(await readFile(counter, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      launches++;
      await writeFile(counter, String(launches));
      await writeFile(join(context.resources.roots.runtime, "active"), context.resources.incarnation);
      return {
        loading: `Loading Open Design Slim ${build}`,
        window: { title: `Open Design Slim — ${build}` },
        witness: `capsule:${build}:${resource}`,
      };
    },
    ready: async () => {
      await context?.updates.start();
    },
    stop: async () => {
      await context?.updates.stop();
      if (context) await writeFile(join(context.resources.roots.data, "stopped"), context.resources.incarnation);
    },
  };
}
