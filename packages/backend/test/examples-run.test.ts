import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { runFrontend } from "@jplmm/frontend";
import { buildIR } from "@jplmm/ir";
import { executeProgram, optimizeProgram } from "@jplmm/optimize";
import { describe, expect, it } from "vitest";

import { compileProgramToNativeRunner } from "../src/native.ts";
import {
  buildWrapperSource,
  collectExampleFiles,
  DEFAULT_EXECUTION_SEEDS as EXECUTION_SEEDS,
  ENTRY_NAME,
  examplesRoot,
} from "./support/examples_common.ts";

describe("examples execution corpus", () => {
  it("compiles and runs every example through runtime and native execution", () => {
    const failures: string[] = [];
    const exampleFiles = collectExampleFiles(examplesRoot);

    for (const file of exampleFiles) {
      const original = readFileSync(file, "utf8");
      const frontend = runFrontend(original);
      if (frontend.diagnostics.length > 0) {
        failures.push(`${relative(examplesRoot, file)} frontend: ${frontend.diagnostics.map((d) => d.code).join(", ")}`);
        continue;
      }

      const wrappedSource = buildWrapperSource(original, frontend.program);
      const wrappedFrontend = runFrontend(wrappedSource);
      if (wrappedFrontend.diagnostics.length > 0) {
        failures.push(
          `${relative(examplesRoot, file)} wrapper frontend: ${wrappedFrontend.diagnostics.map((d) => d.code).join(", ")}`,
        );
        continue;
      }

      try {
        const ir = buildIR(wrappedFrontend.program, wrappedFrontend.typeMap);
        const optimized = optimizeProgram(ir, {
          enableResearchPasses: true,
        });
        const runner = compileProgramToNativeRunner(optimized.program, ENTRY_NAME, {
          artifacts: optimized.artifacts,
          optLevel: "O3",
        });

        try {
          for (const seed of EXECUTION_SEEDS) {
            const runtime = executeProgram(optimized.program, ENTRY_NAME, [seed], {
              artifacts: optimized.artifacts,
            });
            const native = execFileSync(runner.executablePath, ["1", String(seed)], {
              encoding: "utf8",
              stdio: "pipe",
            }).trim();

            expect(typeof runtime.value).toBe("number");
            const runtimeValue = runtime.value as number;
            const nativeValue = Number(native);

            if (!Number.isInteger(nativeValue)) {
              failures.push(`${relative(examplesRoot, file)} seed ${seed}: native output was not an int (${native})`);
              continue;
            }

            if (runtimeValue !== nativeValue) {
              failures.push(
                `${relative(examplesRoot, file)} seed ${seed}: runtime=${runtimeValue}, native=${nativeValue}`,
              );
            }
          }
        } finally {
          runner.cleanup();
        }
      } catch (error) {
        failures.push(`${relative(examplesRoot, file)} execute: ${String(error)}`);
      }
    }

    expect(failures).toEqual([]);
  }, 600_000);
});
