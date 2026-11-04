import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type HostOptions, startElectron } from "@perishcode/electron";
import { app, BrowserWindow } from "electron";

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
  automation: process.env.PESUITE_AUTOMATION === "1",
  receipt: process.env.PESUITE_RECEIPT,
  onActivation:
    process.env.PESUITE_ACTIVATION_PAUSE && process.env.PESUITE_RECEIPT
      ? async (checkpoint) => {
          if (checkpoint.stage !== process.env.PESUITE_ACTIVATION_PAUSE) return;
          await writeFile(`${process.env.PESUITE_RECEIPT}.activation.json`, JSON.stringify(checkpoint));
          await new Promise<void>(() => {});
        }
      : undefined,
  distribution: process.env.PESUITE_DISTRIBUTION
    ? {
        endpoint: process.env.PESUITE_DISTRIBUTION,
        publickey: process.env.PESUITE_FEED_KEY ?? "",
        product: "io.perish.opendesignslim",
      }
    : undefined,
  updates: process.env.PESUITE_FEED
    ? {
        endpoint: process.env.PESUITE_FEED,
        publickey: process.env.PESUITE_FEED_KEY ?? "",
        intervalMs: Number(process.env.PESUITE_FEED_INTERVAL ?? 5000),
        timeoutMs: Number(process.env.PESUITE_FEED_TIMEOUT ?? 10000),
        activate: process.env.PESUITE_LEAF_ACTIVATE === "1",
        capsule: process.env.PESUITE_CAPSULE_ACTIVATE === "1",
      }
    : undefined,
  inspect:
    process.env.PESUITE_INSPECT === "1" || process.env.PESUITE_FEED
      ? async (session, receipt, quit, snapshot) => {
          await session.expose<{
            native: { input: null; output: unknown };
            status: { input: unknown; output: unknown };
            echo: { input: unknown; output: unknown };
            read: { input: unknown; output: unknown };
            write: { input: unknown; output: unknown };
            adapter: { input: { method: string; value: unknown }; output: unknown };
          }>("host", {
            handlers: {
              native: async () => {
                if (process.env.PESUITE_DISTRIBUTION_PROBE !== "1") throw new Error("native probe is disabled");
                const window = BrowserWindow.getAllWindows().find((w) =>
                  w.webContents.getURL().startsWith("data:text/html"),
                );
                if (!window) throw new Error("native blocking window missing");
                return window.webContents.executeJavaScript(
                  `document.querySelector('a[href="pesuite-update://retry"]')?.click(); "clicked"`,
                );
              },
              status: snapshot,
              adapter: (input) => session.call(input.method, input.value),
              echo: (input, context) => ({ input, identity: context.identity, incarnation: context.incarnation }),
              read: () => session.request("read"),
              write: (value) => session.request("write", value),
            },
            lifecycle: {
              initialize: async () => {},
              stop: async () => {
                setImmediate(quit);
              },
            },
          });
          process.stdout.write(`inspect-ready:${receipt.generation}\n`);
        }
      : undefined,
});
