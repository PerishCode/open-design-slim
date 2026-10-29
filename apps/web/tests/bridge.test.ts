import type { Bridge } from "@perishcode/electron/bridge";
import { expect, it } from "vitest";
import { connect } from "@";

function bridge(): Bridge {
  let state: Record<string, unknown> = { launches: 3 };
  return {
    bootstrap: { generation: "selected", nonce: "attempt", version: "0.1.0" },
    health: async () => ({ generation: "selected", nonce: "attempt" }),
    read: async () => state,
    write: async (value) => {
      state = value;
      return state;
    },
  };
}
it("exercises read/write through the injected interface", async () => {
  const api = bridge();
  expect(await connect(api)).toBe(4);
  expect(await api.read()).toEqual({ launches: 4 });
});
it("rejects a daemon belonging to another activation attempt", async () => {
  const api = bridge();
  api.health = async () => ({ generation: "selected", nonce: "old" });
  await expect(connect(api)).rejects.toThrow("generation mismatch");
});
