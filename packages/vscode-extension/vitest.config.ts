import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const grammarEntry = fileURLToPath(new URL("../grammar/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    extensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".json"],
    alias: {
      "@jplmm/grammar": grammarEntry,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
