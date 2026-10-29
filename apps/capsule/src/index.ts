import { readFile } from "node:fs/promises";
import type { Context, Payload } from "@perishcode/runtime";

declare const BUILD: string;
const build = typeof BUILD === "undefined" ? "test" : BUILD;

export async function activate(context: Context): Promise<Payload> {
  const path = context.blobs.probe;
  if (!path) throw new Error("probe resource is required");
  const resource = await readFile(path, "utf8");
  return { title: "Open Design Slim — Skeleton", witness: `capsule:${build}:${resource}` };
}
