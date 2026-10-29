import type { Bridge } from "@perishcode/electron/bridge";

declare const BUILD: string;
declare global {
  var pesuite: Bridge;
}

export async function connect(bridge: Bridge): Promise<number> {
  const health = await bridge.health();
  if (health.generation !== bridge.bootstrap.generation || health.nonce !== bridge.bootstrap.nonce) {
    throw new Error("daemon generation mismatch");
  }
  const previous = await bridge.read();
  const launches = typeof previous.launches === "number" ? previous.launches + 1 : 1;
  await bridge.write({ launches });
  return launches;
}

if (typeof document !== "undefined") {
  const status = document.querySelector("output");
  if (!status) throw new Error("skeleton status element required");
  void connect(globalThis.pesuite)
    .then((launches) => {
      status.setAttribute("data-witness", `web:${BUILD}:launch${launches}`);
      status.textContent = "ready";
    })
    .catch((error: Error) => {
      status.textContent = error.message;
    });
}
