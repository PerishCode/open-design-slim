import { writeFile } from "node:fs/promises";
import { pack } from "@perishcode/pack";
import { settings } from "@perishcode/runtime/settings";

const config = await settings("pesuite.yaml");
const result = await pack({
  carrier: "apps/electron/dist",
  daemon: "apps/daemon/dist",
  web: "apps/web/dist",
  seed: ".artifacts/seed",
  manifest: config.manifest,
  output: ".artifacts/package",
});
await writeFile(".artifacts/package.json", JSON.stringify(result));
process.stdout.write(`${JSON.stringify(result)}\n`);
