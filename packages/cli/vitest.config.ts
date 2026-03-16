import { fileURLToPath } from "node:url";

import { mergeConfig } from "vitest/config";

import base from "../../vitest.base.config.ts";

export default mergeConfig(base, {
  resolve: {
    alias: {
      "@jplmm/frontend": fileURLToPath(new URL("../frontend/src/index.ts", import.meta.url)),
      "@jplmm/verify":   fileURLToPath(new URL("../verify/src/index.ts",   import.meta.url)),
      "@jplmm/backend":  fileURLToPath(new URL("../backend/src/index.ts",  import.meta.url)),
      "@jplmm/ir":       fileURLToPath(new URL("../ir/src/index.ts",       import.meta.url)),
      "@jplmm/optimize": fileURLToPath(new URL("../optimize/src/index.ts", import.meta.url)),
      "@jplmm/ast":      fileURLToPath(new URL("../ast/src/index.ts",      import.meta.url)),
      "@jplmm/grammar":  fileURLToPath(new URL("../grammar/src/index.ts",  import.meta.url)),
    },
  },
});
