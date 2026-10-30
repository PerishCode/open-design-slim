import { build } from "esbuild";

const marker = process.env.PESUITE_BUILD ?? "skeleton1";
await build({
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.mjs",
  define: { BUILD: JSON.stringify(marker) },
});
