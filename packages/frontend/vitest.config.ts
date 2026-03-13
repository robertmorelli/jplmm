import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const astEntry = fileURLToPath(new URL("../ast/src/index.ts", import.meta.url));
const grammarEntry = fileURLToPath(new URL("../grammar/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    extensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".json"],
    alias: {
      "@jplmm/ast": astEntry,
      "@jplmm/grammar": grammarEntry,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
