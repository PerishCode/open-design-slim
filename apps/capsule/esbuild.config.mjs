import { writeFile } from "node:fs/promises";
import { build } from "esbuild";

const marker = process.env.PESUITE_BUILD ?? "skeleton1";
await build({
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs",
  define: { BUILD: JSON.stringify(marker) },
});
await writeFile("dist/probe.bin", `blob:${marker}`);
