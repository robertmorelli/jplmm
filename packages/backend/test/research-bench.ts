import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { runFrontend } from "@jplmm/frontend";
import { buildIR } from "@jplmm/ir";
import { executeProgram, optimizeProgram } from "@jplmm/optimize";

import { compileProgramToNativeRunner } from "../src/native.ts";
import { RESEARCH_BENCH_CASES } from "./bench_cases.ts";

type TimedResult = {
  iterations: number;
  ms: number;
  stdout?: string;
};

describe("research benchmarks", () => {
  it("runs evaluator and native arm64 benchmark passes and writes a report", () => {
    const outDir = join(process.cwd(), "benchmarks");
    mkdirSync(outDir, {
      recursive: true,
    });

    const results = RESEARCH_BENCH_CASES.map((benchCase) => {
      const ir = compile(benchCase.source);
      const optimized = optimizeProgram(ir, benchCase.optimizeOptions);
      const implementation = optimized.artifacts.implementations.get(benchCase.fnName)?.tag ?? "none";

      const runtimeBaseline = timeLoop(() => {
        executeProgram(optimized.program, benchCase.fnName, benchCase.args);
      }, benchCase.runtimeIterations);
      const runtimeOptimized = timeLoop(() => {
        executeProgram(optimized.program, benchCase.fnName, benchCase.args, {
          artifacts: optimized.artifacts,
        });
      }, benchCase.runtimeIterations);

      const nativeBaselineRunner = compileProgramToNativeRunner(optimized.program, benchCase.fnName, {
        optLevel: "O3",
      });
      const nativeOptimizedRunner = compileProgramToNativeRunner(optimized.program, benchCase.fnName, {
        artifacts: optimized.artifacts,
        optLevel: "O3",
      });

      try {
        const nativeBaseline = timeNativeRunner(
          nativeBaselineRunner.executablePath,
          benchCase.nativeIterations,
          benchCase.args,
        );
        const nativeOptimized = timeNativeRunner(
          nativeOptimizedRunner.executablePath,
          benchCase.nativeIterations,
          benchCase.args,
        );

        return {
          name: benchCase.name,
          fnName: benchCase.fnName,
          implementation,
          value: nativeOptimized.stdout ?? "",
          runtime: summarizePair(runtimeBaseline, runtimeOptimized),
          nativeArm64: summarizePair(nativeBaseline, nativeOptimized),
        };
      } finally {
        nativeBaselineRunner.cleanup();
        nativeOptimizedRunner.cleanup();
      }
    });

    const payload = {
      generatedAt: new Date().toISOString(),
      results,
    };
    const jsonPath = join(outDir, "research-latest.json");
    writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

    console.log(markdownTable(results));
    console.log(`Wrote ${jsonPath}`);

    expect(results).toHaveLength(RESEARCH_BENCH_CASES.length);
    expect(results.every((result) => Number(result.value) === Number(result.value))).toBe(true);
  }, 120_000);
});

function compile(source: string) {
  const frontend = runFrontend(source);
  expect(frontend.diagnostics).toEqual([]);
  return buildIR(frontend.program, frontend.typeMap);
}

function timeLoop(fn: () => void, iterations: number): TimedResult {
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    fn();
  }
  return {
    iterations,
    ms: performance.now() - started,
  };
}

function timeNativeRunner(executablePath: string, iterations: number, args: number[]): TimedResult {
  const started = performance.now();
  const stdout = execFileSync(
    executablePath,
    [String(iterations), ...args.map((arg) => String(arg))],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  ).trim();
  return {
    iterations,
    ms: performance.now() - started,
    stdout,
  };
}

function summarizePair(baseline: TimedResult, optimized: TimedResult) {
  return {
    baselineMs: Number(baseline.ms.toFixed(3)),
    optimizedMs: Number(optimized.ms.toFixed(3)),
    speedup: Number((baseline.ms / optimized.ms).toFixed(3)),
    baselineIterations: baseline.iterations,
    optimizedIterations: optimized.iterations,
  };
}

function markdownTable(
  results: Array<{
    name: string;
    implementation: string;
    value: string;
    runtime: { speedup: number };
    nativeArm64: { speedup: number };
  }>,
): string {
  const lines = [
    "| Case | Impl | Runtime Speedup | Native arm64 Speedup | Value |",
    "| --- | --- | ---: | ---: | --- |",
  ];
  for (const result of results) {
    lines.push(
      `| ${result.name} | ${result.implementation} | ${result.runtime.speedup}x | ${result.nativeArm64.speedup}x | ${result.value} |`,
    );
  }
  return lines.join("\n");
}
