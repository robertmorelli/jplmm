import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@jplmm/ast": resolve(__dirname, "packages/ast/src/index.ts"),
      "@jplmm/backend": resolve(__dirname, "packages/backend/src/index.ts"),
      "@jplmm/frontend": resolve(__dirname, "packages/frontend/src/index.ts"),
      "@jplmm/grammar": resolve(__dirname, "packages/grammar/src/index.ts"),
      "@jplmm/ir": resolve(__dirname, "packages/ir/src/index.ts"),
      "@jplmm/lsp": resolve(__dirname, "packages/lsp/src/index.ts"),
      "@jplmm/optimize": resolve(__dirname, "packages/optimize/src/index.ts"),
      "@jplmm/verify": resolve(__dirname, "packages/verify/src/index.ts"),
    },
    extensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".json"],
  },
  test: {
    include: ["packages/backend/test/research-bench.ts"],
  },
});
