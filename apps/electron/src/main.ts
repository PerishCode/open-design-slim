import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type HostOptions, startElectron } from "@perishcode/electron";
import { app } from "electron";

const here = fileURLToPath(new URL(".", import.meta.url));
const config = JSON.parse(readFileSync(join(here, "host.json"), "utf8")) as Pick<
  HostOptions,
  "carrier" | "namespace" | "manifest"
>;
void startElectron({
  ...config,
  root: process.env.PESUITE_DATA ?? join(app.getPath("appData"), config.manifest.identity.scheme),
  seed: app.isPackaged
    ? join(process.resourcesPath, "seed")
    : fileURLToPath(new URL("../../../.artifacts/seed", import.meta.url)),
  preload: join(here, "preload.cjs"),
  candidate: process.env.PESUITE_CANDIDATE,
  recover: process.env.PESUITE_RECOVER === "1",
  probe: process.env.PESUITE_PROBE === "1",
  receipt: process.env.PESUITE_RECEIPT,
});
