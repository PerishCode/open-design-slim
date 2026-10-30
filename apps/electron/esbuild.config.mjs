import { cp, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const marker = process.env.PESUITE_BUILD ?? "skeleton1";

import { createRequire } from "node:module";
import { settings } from "@perishcode/runtime/settings";

await build({
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.mjs",
  define: { BUILD: JSON.stringify(marker) },
  external: ["electron"],
});
const config = await settings("../../pesuite.yaml");
await writeFile("dist/host.json", JSON.stringify(config));
await cp(createRequire(import.meta.url).resolve("@perishcode/electron/preload"), "dist/preload.cjs");
