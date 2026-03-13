import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    extensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".json"],
    alias: {
      "@jplmm/ast": resolve(__dirname, "../ast/src/index.ts"),
      "@jplmm/grammar": resolve(__dirname, "../grammar/src/index.ts"),
      "@jplmm/ir": resolve(__dirname, "../ir/src/index.ts"),
      "@jplmm/frontend": resolve(__dirname, "../frontend/src/index.ts"),
    },
  },
});
