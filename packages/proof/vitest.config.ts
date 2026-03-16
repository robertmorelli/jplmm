import { fileURLToPath } from "node:url";

import { mergeConfig } from "vitest/config";

import base from "../../vitest.base.config.ts";

export default mergeConfig(base, {
  resolve: {
    alias: {
      "@jplmm/ast":      fileURLToPath(new URL("../ast/src/index.ts",      import.meta.url)),
      "@jplmm/ir":       fileURLToPath(new URL("../ir/src/index.ts",       import.meta.url)),
      "@jplmm/optimize": fileURLToPath(new URL("../optimize/src/index.ts", import.meta.url)),
      "@jplmm/smt":      fileURLToPath(new URL("../smt/src/index.ts",      import.meta.url)),
    },
  },
});
