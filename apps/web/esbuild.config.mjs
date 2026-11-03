import { cp } from "node:fs/promises";
import { emitBuildUnit } from "@perishcode/release";
import { build } from "esbuild";

const marker = process.env.PESUITE_BUILD ?? "skeleton1";
await build({
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome146",
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  define: { BUILD: JSON.stringify(marker) },
});
await cp("src/index.html", "dist/index.html");

await emitBuildUnit("dist", { kind: "web", baseVersion: "0.1.0", api: "pesuite-probe/1" });
