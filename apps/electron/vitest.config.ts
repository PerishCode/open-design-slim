import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    fileParallelism: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
