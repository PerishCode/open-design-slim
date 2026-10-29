import { cp, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { compose } from "@perishcode/release";
import { writeProduct } from "@perishcode/runtime";
import { settings } from "@perishcode/runtime/settings";
import { build } from "esbuild";

const config = await settings("pesuite.yaml");
const marker = process.env.PESUITE_BUILD ?? "skeleton1";
const common = {
  bundle: true,
  target: "node24",
  format: "esm",
  platform: "node",
  define: { BUILD: JSON.stringify(marker) },
};
await Promise.all([
  build({
    ...common,
    entryPoints: ["apps/electron/src/main.ts"],
    outfile: "apps/electron/dist/main.mjs",
    external: ["electron"],
  }),
  build({ ...common, entryPoints: ["apps/capsule/src/index.ts"], outfile: "apps/capsule/dist/index.mjs" }),
  build({ ...common, entryPoints: ["apps/daemon/src/main.ts"], outfile: "apps/daemon/dist/main.mjs" }),
  build({
    ...common,
    entryPoints: ["apps/web/src/index.ts"],
    outfile: "apps/web/dist/index.js",
    platform: "browser",
    target: "chrome146",
  }),
]);
await cp("apps/web/src/index.html", "apps/web/dist/index.html");
// Resolve the published preload through the Electron module's declared dependency.
const require = createRequire(new URL("../apps/electron/package.json", import.meta.url));
await cp(require.resolve("@perishcode/electron/preload"), "apps/electron/dist/preload.cjs");
await writeFile("apps/electron/dist/host.json", JSON.stringify(config));
await mkdir(".artifacts", { recursive: true });
await writeFile(".artifacts/probe.bin", `blob:${marker}`);
const product = await compose(config.manifest, {
  carrier: config.carrier,
  capsule: "apps/capsule/dist",
  daemon: "apps/daemon/dist",
  web: "apps/web/dist",
  blobs: [{ path: ".artifacts/probe.bin", slot: "probe" }],
});
await writeProduct(join(".artifacts", "seed"), product);
process.stdout.write(`${JSON.stringify({ generation: product.envelope.digest, marker })}\n`);
