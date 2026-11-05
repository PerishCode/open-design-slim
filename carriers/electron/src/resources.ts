import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Consumer, type Library, type Reference, type Resource, source, type Use } from "@perishcode/blob";
import { canonical } from "@perishcode/protocol";
import { bundleDestination } from "@perishcode/release";
import type { Session } from "@perishcode/runtime";
import type { Context } from "@perishcode/sidecar";

export type ResourceRequest =
  | { op: "status" | "collect" }
  | { op: "acquire" | "prefetch"; resource: Resource; url: string; epoch?: string }
  | { op: "release"; use: Use }
  | { op: "retain"; kind: Reference["kind"]; name: string; resources: Resource[] }
  | { op: "unretain"; kind: Reference["kind"]; name: string }
  | { op: "read"; use: Use; file?: string };

export function resourceProbe(session: Session) {
  let library: Library | undefined, context: Context | undefined;
  return {
    initialize: async (owner: Context) => {
      if (process.env.PESUITE_BLOB_PROBE !== "1") return;
      context = owner;
      library = await session.blobLibrary(owner, {
        retentionMs: Number(process.env.PESUITE_BLOB_RETENTION ?? 1000),
        onCheckpoint: async (event) => {
          if (event.phase !== process.env.PESUITE_BLOB_PAUSE) return;
          await writeFile(
            join(owner.roots.logs, `blob-${event.phase}.json`),
            JSON.stringify({ ...event, pid: process.pid }),
            { flush: true },
          );
          await new Promise<void>(() => {});
        },
      });
    },
    quiesce: async () => {
      await library?.close();
    },
    call: async (input: ResourceRequest): Promise<unknown> => {
      if (!library || !context) throw Error("blob probe is disabled");
      switch (input.op) {
        case "status":
          return {
            pid: process.pid,
            state: await library.status(),
            owner: { identity: context.identity, incarnation: context.incarnation, logs: context.roots.logs },
          };
        case "collect":
          return library.collect();
        case "retain":
          return library.retain(input.kind, input.name, input.resources);
        case "unretain":
          return library.unretain(input.kind, input.name);
        case "release":
          return library.release(input.use);
        case "acquire": {
          const consumer: Consumer = {
            service: context.identity.service,
            generation: context.identity.generation,
            incarnation: context.incarnation,
            ...(input.epoch ? { epoch: input.epoch } : {}),
          };
          return library.acquire(input.resource, source(input.url, input.resource), consumer);
        }
        case "prefetch":
          return library.prefetch(input.resource, source(input.url, input.resource));
        case "read": {
          const entry = (await library.status()).entries[input.use.key],
            use = entry?.uses.find((u) => u.id === input.use.id);
          if (!use || canonical(use) !== canonical(input.use)) throw Error("blob read requires a current use");
          const path = entry!.resource.type === "directory" ? bundleDestination(use.path, input.file ?? "") : use.path;
          return { pid: process.pid, type: entry!.resource.type, value: await readFile(path, "utf8") };
        }
        default:
          throw Error("unknown blob probe operation");
      }
    },
  };
}
