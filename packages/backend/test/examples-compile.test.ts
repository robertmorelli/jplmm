import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runFrontend } from "@jplmm/frontend";
import { buildIR } from "@jplmm/ir";
import { optimizeProgram } from "@jplmm/optimize";

import { compileWatToWasm, emitNativeCModule, emitWatModule } from "../src/index.ts";

const examplesRoot = fileURLToPath(new URL("../../../examples", import.meta.url));

function collectExampleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectExampleFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jplmm")) {
      out.push(full);
    }
  }
  return out.sort();
}

const exampleFiles = collectExampleFiles(examplesRoot);

describe("examples backend smoke", () => {
  it("compiles the whole examples corpus to wasm and native C text", () => {
    const failures: string[] = [];

    for (const file of exampleFiles) {
      const source = readFileSync(file, "utf8");
      const frontend = runFrontend(source);
      if (frontend.diagnostics.length > 0) {
        failures.push(`${relative(examplesRoot, file)} frontend: ${frontend.diagnostics.map((d) => d.code).join(", ")}`);
        continue;
      }

      try {
        const ir = buildIR(frontend.program, frontend.typeMap);
        const optimized = optimizeProgram(ir, {
          enableResearchPasses: true,
        });
        const wat = emitWatModule(optimized.program, {
          artifacts: optimized.artifacts,
          exportFunctions: true,
          tailCalls: false,
        });
        compileWatToWasm(wat, {
          tailCalls: false,
        });
        const nativeC = emitNativeCModule(optimized.program, {
          artifacts: optimized.artifacts,
        });
        expect(wat.length).toBeGreaterThan(0);
        expect(nativeC.length).toBeGreaterThan(0);
      } catch (error) {
        failures.push(`${relative(examplesRoot, file)} backend: ${String(error)}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
