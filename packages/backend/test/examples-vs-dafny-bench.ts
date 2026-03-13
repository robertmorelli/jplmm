import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  runDafnyCase,
  probeDafnyTargets,
} from "./support/dafny.ts";
import { buildWrapperSource, collectExampleFiles, ENTRY_NAME, examplesRoot } from "./support/examples_common.ts";

type ExampleBenchResult = {
  example: string;
  category: string;
  comparisonClass: "exact" | "approximate";
  comparisonNote: string;
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
    attemptedTargets: Array<
      | { target: DafnyTarget; ok: true; ms: number; stdout: string }
      | { target: DafnyTarget; ok: false; error: string }
    >;
    fastest: null | { target: DafnyTarget; ms: number; stdout: string };
  };
  nativeVsFastestDafny: number | null;
  wasmVsFastestDafny: number | null;
  fastestOverall: string;
};

const BENCH_SEED = 7;

function categoryFromExample(file: string): string {
  return relative(examplesRoot, file).split("/")[0] ?? "unknown";
}

function iterationsForCategory(category: string): number {
  switch (category) {
    case "image":
      return 180;
    case "matrix":
      return 4;
    case "signal":
      return 3;
    case "sort":
      return 250;
    case "control":
      return 40;
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

async function benchmarkJplExample(file: string, iterations: number) {
  const source = readFileSync(file, "utf8");
  const frontend = runFrontend(source);
  expect(frontend.diagnostics).toEqual([]);

  const wrappedSource = buildWrapperSource(source, frontend.program);
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

function comparisonClassForCategory(category: string): "exact" | "approximate" {
  switch (category) {
    case "image":
    case "sort":
    case "showcase":
      return "exact";
    case "matrix":
    case "signal":
    case "control":
      return "approximate";
    default:
      return "approximate";
  }
}

function comparisonNoteForCategory(category: string): string {
  switch (category) {
    case "image":
    case "sort":
    case "showcase":
      return "JPL and Dafny use the same integer-oriented algorithm family here.";
    case "matrix":
      return "Dafny uses a generated fixed-point integer analogue for JPL float matrix code.";
    case "signal":
      return "Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code.";
    case "control":
      return "Dafny uses a generated fixed-point analogue for JPL float control code.";
    default:
      return "Comparison shape is approximate rather than exact.";
  }
}

function compareMarkdown(
  title: string,
  results: ExampleBenchResult[],
  targetProbes: DafnyTargetProbe[],
): string {
  const generatedAt = new Date().toISOString();
  const fastestCounts = new Map<string, number>();
  let exactCount = 0;
  let approximateCount = 0;
  let nativeWins = 0;
  let wasmWins = 0;

  for (const result of results) {
    if (result.comparisonClass === "exact") {
      exactCount += 1;
    } else {
      approximateCount += 1;
    }
    fastestCounts.set(result.fastestOverall, (fastestCounts.get(result.fastestOverall) ?? 0) + 1);
    if (result.nativeVsFastestDafny !== null && result.nativeVsFastestDafny > 1) {
      nativeWins += 1;
    }
    if (result.wasmVsFastestDafny !== null && result.wasmVsFastestDafny > 1) {
      wasmWins += 1;
    }
  }

  const summaryLines = [
    title,
    "",
    `Generated at: ${generatedAt}`,
    `Examples benchmarked: ${results.length}`,
    `Available Dafny targets: ${targetProbes.filter((probe) => probe.available).map((probe) => probe.target).join(", ") || "none"}`,
    `Exact-comparison rows: ${exactCount}`,
    `Approximate-analogue rows: ${approximateCount}`,
    "Approximation note: matrix, signal, and control rows use generated fixed-point Dafny analogues instead of the original JPL float semantics.",
    "Timing note: JPL native timings are measured by running the compiled arm64 runner process once per case, so they include one process launch per benchmark case.",
    "",
    "## Summary",
    "",
    `- JPL native faster than the fastest available Dafny target in ${nativeWins}/${results.length} cases`,
    `- JPL wasm faster than the fastest available Dafny target in ${wasmWins}/${results.length} cases`,
    ...Array.from(fastestCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => `- ${label}: ${count} fastest finishes`),
    "",
    "## Results",
    "",
    "| Example | Category | Class | Iterations | JPL Wasm (ms) | JPL Native (ms) | Dafny Target | Dafny (ms) | Fastest | Native vs Dafny | Wasm vs Dafny | Note |",
    "| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | --- |",
  ];

  for (const result of results) {
    const fastestDafny = result.dafny.fastest;
    summaryLines.push(
      `| ${result.example} | ${result.category} | ${result.comparisonClass} | ${result.iterations} | ${formatMs(result.jplWasm.ms)} | ${formatMs(result.jplNativeArm64.ms)} | ${fastestDafny?.target ?? "n/a"} | ${fastestDafny ? formatMs(fastestDafny.ms) : "n/a"} | ${result.fastestOverall} | ${formatRatio(result.nativeVsFastestDafny)} | ${formatRatio(result.wasmVsFastestDafny)} | ${result.comparisonNote} |`,
    );
  }

  return summaryLines.join("\n");
}

function formatMs(ms: number): string {
  return ms.toFixed(3);
}

function formatRatio(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return `${value.toFixed(3)}x`;
}

describe("examples vs Dafny benchmarks", () => {
  it("benchmarks all generated examples across JPL wasm/native and Dafny, then writes reports", async () => {
    const outDir = join(process.cwd(), "benchmarks");
    mkdirSync(outDir, {
      recursive: true,
    });

    const exampleFiles = collectExampleFiles(examplesRoot);
    const cacheRoot = createDafnyCacheRoot("jplmm-examples-dafny-");

    try {
      const targetProbes = probeDafnyTargets(cacheRoot);
      const availableTargets = targetProbes
        .filter((probe): probe is Extract<DafnyTargetProbe, { available: true }> => probe.available)
        .map((probe) => probe.target);

      const results: ExampleBenchResult[] = [];
      const partialJsonPath = join(outDir, "examples-vs-dafny-partial.json");

      for (let index = 0; index < exampleFiles.length; index += 1) {
        const file = exampleFiles[index]!;
        const relativeExample = relative(examplesRoot, file);
        const category = categoryFromExample(file);
        const iterations = iterationsForCategory(category);
        const dafnyFile = resolve(process.cwd(), "examples_dafny", relativeExample.replace(/\.jplmm$/, ".dfy"));

        console.log(`[${index + 1}/${exampleFiles.length}] ${relativeExample}`);

        const jpl = await benchmarkJplExample(file, iterations);
        const attemptedTargets = availableTargets.map((target) =>
          runDafnyCase(dafnyFile, relativeExample.replace(/[^A-Za-z0-9]+/g, "_"), target, cacheRoot),
        );
        const fastestDafny = attemptedTargets
          .filter((result): result is Extract<typeof attemptedTargets[number], { ok: true }> => result.ok)
          .sort((a, b) => a.run.ms - b.run.ms)[0];

        const nativeVsFastestDafny = fastestDafny ? fastestDafny.run.ms / jpl.jplNativeArm64.ms : null;
        const wasmVsFastestDafny = fastestDafny ? fastestDafny.run.ms / jpl.jplWasm.ms : null;
        const fastestEntries = [
          { label: "JPL native arm64", ms: jpl.jplNativeArm64.ms },
          { label: "JPL wasm", ms: jpl.jplWasm.ms },
          ...(fastestDafny ? [{ label: `Dafny ${fastestDafny.target}`, ms: fastestDafny.run.ms }] : []),
        ].sort((a, b) => a.ms - b.ms);
        const comparisonClass = comparisonClassForCategory(category);
        const comparisonNote = comparisonNoteForCategory(category);

        results.push({
          example: relativeExample,
          category,
          comparisonClass,
          comparisonNote,
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
            attemptedTargets: attemptedTargets.map((result) =>
              result.ok
                ? {
                    target: result.target,
                    ok: true,
                    ms: Number(result.run.ms.toFixed(3)),
                    stdout: result.run.stdout,
                  }
                : {
                    target: result.target,
                    ok: false,
                    error: result.error,
                  },
            ),
            fastest: fastestDafny
              ? {
                  target: fastestDafny.target,
                  ms: Number(fastestDafny.run.ms.toFixed(3)),
                  stdout: fastestDafny.run.stdout,
                }
              : null,
          },
          nativeVsFastestDafny: nativeVsFastestDafny === null ? null : Number(nativeVsFastestDafny.toFixed(3)),
          wasmVsFastestDafny: wasmVsFastestDafny === null ? null : Number(wasmVsFastestDafny.toFixed(3)),
          fastestOverall: fastestEntries[0]?.label ?? "n/a",
        });

        writeFileSync(
          partialJsonPath,
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              targetProbes,
              completed: results.length,
              total: exampleFiles.length,
              results,
            },
            null,
            2,
          ),
        );
      }

      const jsonPath = join(outDir, "examples-vs-dafny-latest.json");
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

      const exactResults = results.filter((result) => result.comparisonClass === "exact");
      const legitJsonPath = join(outDir, "examples-vs-dafny-legit.json");
      writeFileSync(
        legitJsonPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            targetProbes,
            results: exactResults,
          },
          null,
          2,
        ),
      );

      const markdown = compareMarkdown("# JPL-- vs Dafny Examples", results, targetProbes);
      const legitMarkdown = compareMarkdown("# JPL-- vs Dafny Examples (Exact-Match Rows Only)", exactResults, targetProbes);
      writeFileSync(join(process.cwd(), "vs_dafny.md"), markdown);
      writeFileSync(join(process.cwd(), "vs_dafny_legit.md"), legitMarkdown);
      rmSync(partialJsonPath, { force: true });

      console.log(markdown);
      console.log(legitMarkdown);
      console.log(`Wrote ${jsonPath}`);
      console.log(`Wrote ${legitJsonPath}`);
      console.log(`Wrote ${join(process.cwd(), "vs_dafny.md")}`);
      console.log(`Wrote ${join(process.cwd(), "vs_dafny_legit.md")}`);

      expect(results).toHaveLength(exampleFiles.length);
      expect(exactResults.length).toBeGreaterThan(0);
      expect(results.every((result) => Number.isInteger(result.jplNativeArm64.value))).toBe(true);
      expect(results.every((result) => Number.isInteger(result.jplWasm.value))).toBe(true);
      expect(results.every((result) => result.dafny.fastest !== null)).toBe(true);
    } finally {
      removeDafnyCacheRoot(cacheRoot);
    }
  }, 1_800_000);
});
