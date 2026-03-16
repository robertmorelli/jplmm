import { fileURLToPath } from "node:url";

import { mergeConfig } from "vitest/config";

import base from "../../vitest.base.config.ts";

export default mergeConfig(base, {
  resolve: {
    alias: {
      "@jplmm/ast":      fileURLToPath(new URL("../ast/src/index.ts",      import.meta.url)),
      "@jplmm/grammar":  fileURLToPath(new URL("../grammar/src/index.ts",  import.meta.url)),
      "@jplmm/frontend": fileURLToPath(new URL("../frontend/src/index.ts", import.meta.url)),
    },
  },
});
