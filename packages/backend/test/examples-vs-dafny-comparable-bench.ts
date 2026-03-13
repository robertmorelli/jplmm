import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { runFrontend } from "@jplmm/frontend";
import { buildIR } from "@jplmm/ir";
import { optimizeProgram } from "@jplmm/optimize";

import { compileProgramToInstance } from "../src/index.ts";
import { compileProgramToNativeRunner } from "../src/native.ts";
import {
  createDafnyCacheRoot,
  type DafnyTarget,
  type DafnyTargetProbe,
  removeDafnyCacheRoot,
  probeDafnyTargets,
  runDafnyCase,
} from "./support/dafny.ts";
import { collectExampleFiles, ENTRY_NAME, examplesRoot } from "./support/examples_common.ts";
import { buildComparableWrapperSource } from "./support/examples_comparable.ts";

type ComparableBenchResult = {
  example: string;
  category: string;
  iterations: number;
  jplImplementation: string;
  jplWasm: {
    ms: number;
    value: number;
  };
  jplNativeArm64: {
    ms: number;
    value: number;
  };
  dafny: {
    target: DafnyTarget;
    ms: number;
    stdout: string;
    value: number;
  };
  nativeVsDafny: number;
  wasmVsDafny: number;
  fastestOverall: string;
};

const BENCH_SEED = 7;
const COMPARABLE_CATEGORIES = new Set(["image", "sort", "showcase"]);
const UINT32_MASK = (1n << 32n) - 1n;

function categoryFromExample(file: string): string {
  return relative(examplesRoot, file).split("/")[0] ?? "unknown";
}

function iterationsForCategory(category: string): number {
  switch (category) {
    case "image":
      return 180;
    case "sort":
      return 250;
    case "showcase":
      return 120;
    default:
      return 64;
  }
}

function exportedFunction<T extends (...args: number[]) => number | void>(
  instance: WebAssembly.Instance,
  name: string,
): T {
  const value = instance.exports[name];
  expect(typeof value).toBe("function");
  return value as T;
}

function repeatedBv32Value(value: number, iterations: number): number {
  return Number((BigInt(value >>> 0) * BigInt(iterations)) & UINT32_MASK);
}

async function benchmarkJplExample(file: string, iterations: number) {
  const source = readFileSync(file, "utf8");
  const frontend = runFrontend(source);
  expect(frontend.diagnostics).toEqual([]);

  const wrappedSource = buildComparableWrapperSource(source, frontend.program, categoryFromExample(file));
  const wrappedFrontend = runFrontend(wrappedSource);
  expect(wrappedFrontend.diagnostics).toEqual([]);

  const ir = buildIR(wrappedFrontend.program, wrappedFrontend.typeMap);
  const optimized = optimizeProgram(ir, {
    enableResearchPasses: true,
  });

  const nativeRunner = compileProgramToNativeRunner(optimized.program, ENTRY_NAME, {
    artifacts: optimized.artifacts,
    optLevel: "O3",
  });

  try {
    const wasmCompiled = await compileProgramToInstance(optimized.program, {
      artifacts: optimized.artifacts,
      exportFunctions: true,
      tailCalls: false,
    });
    const wasmEntry = exportedFunction<(seed: number) => number>(wasmCompiled.instance, ENTRY_NAME);
    const resetHeap = exportedFunction<() => void>(wasmCompiled.instance, "__jplmm_reset_heap");

    resetHeap();
    const wasmValue = wasmEntry(BENCH_SEED);

    const nativeSingle = execFileSync(nativeRunner.executablePath, ["1", String(BENCH_SEED)], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    const nativeValue = Number(nativeSingle);

    expect(Number.isFinite(nativeValue)).toBe(true);
    expect(nativeValue).toBe(wasmValue);

    const nativeStarted = performance.now();
    execFileSync(nativeRunner.executablePath, [String(iterations), String(BENCH_SEED)], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    const nativeMs = performance.now() - nativeStarted;

    let lastWasmValue = wasmValue;
    const wasmStarted = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      resetHeap();
      lastWasmValue = wasmEntry(BENCH_SEED);
    }
    const wasmMs = performance.now() - wasmStarted;

    return {
      implementation: optimized.artifacts.implementations.get(ENTRY_NAME)?.tag ?? "none",
      jplWasm: {
        ms: wasmMs,
        value: lastWasmValue,
      },
      jplNativeArm64: {
        ms: nativeMs,
        value: nativeValue,
      },
    };
  } finally {
    nativeRunner.cleanup();
  }
}

function compareMarkdown(results: ComparableBenchResult[], targetProbes: DafnyTargetProbe[]): string {
  const generatedAt = new Date().toISOString();
  const fastestCounts = new Map<string, number>();
  let nativeWins = 0;
  let wasmWins = 0;

  for (const result of results) {
    fastestCounts.set(result.fastestOverall, (fastestCounts.get(result.fastestOverall) ?? 0) + 1);
    if (result.nativeVsDafny > 1) {
      nativeWins += 1;
    }
    if (result.wasmVsDafny > 1) {
      wasmWins += 1;
    }
  }

  const lines = [
    "# JPL-- vs Dafny (More Comparable Bv32 Corpus)",
    "",
    `Generated at: ${generatedAt}`,
    `Examples benchmarked: ${results.length}`,
    `Available Dafny targets: ${targetProbes.filter((probe) => probe.available).map((probe) => probe.target).join(", ") || "none"}`,
    "Value-match note: every reported row was checked for exact equality between Dafny's looped benchmark digest and the corresponding repeated JPL result.",
    "Dafny codegen note: this corpus uses `bv32` values so Dafny Go lowers hot scalar arithmetic to `uint32` instead of `_dafny.Int`.",
    "Residual difference note: Dafny arrays still lower through `_dafny.Array` and loop counters still use `_dafny.Int`.",
    "Timing note: JPL native and Dafny both include one process launch per benchmark case; JPL wasm runs in-process.",
    "",
    "## Summary",
    "",
    `- JPL native faster than Dafny in ${nativeWins}/${results.length} cases`,
    `- JPL wasm faster than Dafny in ${wasmWins}/${results.length} cases`,
    ...Array.from(fastestCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => `- ${label}: ${count} fastest finishes`),
    "",
    "## Results",
    "",
    "| Example | Category | Iterations | JPL Wasm (ms) | JPL Native (ms) | Dafny Target | Dafny (ms) | Fastest | Native vs Dafny | Wasm vs Dafny |",
    "| --- | --- | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: |",
  ];

  for (const result of results) {
    lines.push(
      `| ${result.example} | ${result.category} | ${result.iterations} | ${result.jplWasm.ms.toFixed(3)} | ${result.jplNativeArm64.ms.toFixed(3)} | ${result.dafny.target} | ${result.dafny.ms.toFixed(3)} | ${result.fastestOverall} | ${result.nativeVsDafny.toFixed(3)}x | ${result.wasmVsDafny.toFixed(3)}x |`,
    );
  }

  return lines.join("\n");
}

describe("examples vs Dafny more-comparable benchmarks", () => {
  it("benchmarks the exact bv32 corpus and writes reports", async () => {
    const outDir = join(process.cwd(), "benchmarks");
    mkdirSync(outDir, { recursive: true });

    const exampleFiles = collectExampleFiles(examplesRoot).filter((file) => COMPARABLE_CATEGORIES.has(categoryFromExample(file)));
    const cacheRoot = createDafnyCacheRoot("jplmm-examples-dafny-bv32-");

    try {
      const targetProbes = probeDafnyTargets(cacheRoot);
      const availableTargets = targetProbes
        .filter((probe): probe is Extract<DafnyTargetProbe, { available: true }> => probe.available)
        .map((probe) => probe.target);

      const results: ComparableBenchResult[] = [];

      for (let index = 0; index < exampleFiles.length; index += 1) {
        const file = exampleFiles[index]!;
        const relativeExample = relative(examplesRoot, file);
        const category = categoryFromExample(file);
        const iterations = iterationsForCategory(category);
        const dafnyFile = resolve(process.cwd(), "examples_dafny_bv32", relativeExample.replace(/\.jplmm$/, ".dfy"));

        console.log(`[${index + 1}/${exampleFiles.length}] ${relativeExample}`);

        const jpl = await benchmarkJplExample(file, iterations);
        const attemptedTargets = availableTargets.map((target) =>
          runDafnyCase(dafnyFile, `bv32_${relativeExample.replace(/[^A-Za-z0-9]+/g, "_")}`, target, cacheRoot),
        );
        const fastestDafny = attemptedTargets
          .filter((result): result is Extract<typeof attemptedTargets[number], { ok: true }> => result.ok)
          .sort((a, b) => a.run.ms - b.run.ms)[0];

        expect(fastestDafny).toBeTruthy();
        const dafnyValue = Number(fastestDafny!.run.stdout);
        const expectedLoopValue = repeatedBv32Value(jpl.jplWasm.value, iterations);
        expect(Number.isFinite(dafnyValue)).toBe(true);
        expect(dafnyValue).toBe(expectedLoopValue);

        const fastestEntries = [
          { label: "JPL native arm64", ms: jpl.jplNativeArm64.ms },
          { label: "JPL wasm", ms: jpl.jplWasm.ms },
          { label: `Dafny ${fastestDafny!.target}`, ms: fastestDafny!.run.ms },
        ].sort((a, b) => a.ms - b.ms);

        results.push({
          example: relativeExample,
          category,
          iterations,
          jplImplementation: jpl.implementation,
          jplWasm: {
            ms: Number(jpl.jplWasm.ms.toFixed(3)),
            value: jpl.jplWasm.value,
          },
          jplNativeArm64: {
            ms: Number(jpl.jplNativeArm64.ms.toFixed(3)),
            value: jpl.jplNativeArm64.value,
          },
          dafny: {
            target: fastestDafny!.target,
            ms: Number(fastestDafny!.run.ms.toFixed(3)),
            stdout: fastestDafny!.run.stdout,
            value: dafnyValue,
          },
          nativeVsDafny: Number((fastestDafny!.run.ms / jpl.jplNativeArm64.ms).toFixed(3)),
          wasmVsDafny: Number((fastestDafny!.run.ms / jpl.jplWasm.ms).toFixed(3)),
          fastestOverall: fastestEntries[0]?.label ?? "n/a",
        });
      }

      const jsonPath = join(outDir, "examples-vs-dafny-comparable-latest.json");
      writeFileSync(
        jsonPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            targetProbes,
            results,
          },
          null,
          2,
        ),
      );

      const markdown = compareMarkdown(results, targetProbes);
      const markdownPath = join(process.cwd(), "vs_dafny_comparable.md");
      writeFileSync(markdownPath, markdown);

      console.log(markdown);
      console.log(`Wrote ${jsonPath}`);
      console.log(`Wrote ${markdownPath}`);

      expect(results).toHaveLength(exampleFiles.length);
      expect(results.every((result) => Number.isInteger(result.jplNativeArm64.value))).toBe(true);
      expect(results.every((result) => Number.isInteger(result.jplWasm.value))).toBe(true);
      expect(results.every((result) => result.dafny.value === repeatedBv32Value(result.jplWasm.value, result.iterations))).toBe(true);
    } finally {
      removeDafnyCacheRoot(cacheRoot);
    }
  }, 1_800_000);
});
