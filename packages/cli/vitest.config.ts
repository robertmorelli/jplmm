import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const frontendEntry = fileURLToPath(new URL("../frontend/src/index.ts", import.meta.url));
const verifyEntry = fileURLToPath(new URL("../verify/src/index.ts", import.meta.url));
const backendEntry = fileURLToPath(new URL("../backend/src/index.ts", import.meta.url));
const irEntry = fileURLToPath(new URL("../ir/src/index.ts", import.meta.url));
const optimizeEntry = fileURLToPath(new URL("../optimize/src/index.ts", import.meta.url));
const astEntry = fileURLToPath(new URL("../ast/src/index.ts", import.meta.url));
const grammarEntry = fileURLToPath(new URL("../grammar/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    extensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".json"],
    alias: {
      "@jplmm/backend": backendEntry,
      "@jplmm/frontend": frontendEntry,
      "@jplmm/ir": irEntry,
      "@jplmm/optimize": optimizeEntry,
      "@jplmm/verify": verifyEntry,
      "@jplmm/ast": astEntry,
      "@jplmm/grammar": grammarEntry,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
