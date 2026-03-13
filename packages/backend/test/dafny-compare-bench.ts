import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { runFrontend } from "@jplmm/frontend";
import { buildIR } from "@jplmm/ir";
import { optimizeProgram } from "@jplmm/optimize";

import { compileProgramToNativeRunner } from "../src/native.ts";
import { RESEARCH_BENCH_CASES } from "./bench_cases.ts";

type TimedRun = {
  ms: number;
  stdout: string;
  value: number;
};

type DafnyTarget = "go" | "cs";

type DafnyTargetResult =
  | {
      target: DafnyTarget;
      ok: true;
      run: TimedRun;
    }
  | {
      target: DafnyTarget;
      ok: false;
      error: string;
    };

type DafnyTargetProbe =
  | {
      target: DafnyTarget;
      available: true;
    }
  | {
      target: DafnyTarget;
      available: false;
      error: string;
    };

const DAFNY_BUILD_TIMEOUT_MS = 20_000;
const DAFNY_RUN_TIMEOUT_MS = 20_000;

describe("dafny codegen comparison benchmarks", () => {
  it("writes Dafny-vs-JPL native codegen comparison results", () => {
    const outDir = join(process.cwd(), "benchmarks");
    mkdirSync(outDir, {
      recursive: true,
    });

    const casesDir = resolve(process.cwd(), "benchmarks", "dafny", "cases");
    const targetProbes = probeDafnyTargets();
    const availableTargets = targetProbes
      .filter((probe): probe is Extract<DafnyTargetProbe, { available: true }> => probe.available)
      .map((probe) => probe.target);

    const results = RESEARCH_BENCH_CASES.map((benchCase) => {
      const ir = compile(benchCase.source);
      const optimized = optimizeProgram(ir, benchCase.optimizeOptions);
      const nativeRunner = compileProgramToNativeRunner(optimized.program, benchCase.fnName, {
        artifacts: optimized.artifacts,
        optLevel: "O3",
      });

      let jplRun: TimedRun;
      try {
        jplRun = timeCommand(nativeRunner.executablePath, [String(benchCase.nativeIterations), ...benchCase.args.map(String)]);
      } finally {
        nativeRunner.cleanup();
      }

      const dafnyFile = join(casesDir, benchCase.dafnyFile);
      const dafnyTargets = availableTargets.map((target) => runDafnyCase(dafnyFile, benchCase.name, target));
      const fastestDafny = dafnyTargets
        .filter((result): result is Extract<DafnyTargetResult, { ok: true }> => result.ok)
        .sort((a, b) => a.run.ms - b.run.ms)[0];

      return {
        name: benchCase.name,
        jplImplementation: optimized.artifacts.implementations.get(benchCase.fnName)?.tag ?? "none",
        expectedValue: benchCase.expectedValue,
        jplNativeArm64: {
          ms: Number(jplRun.ms.toFixed(3)),
          value: jplRun.value,
        },
        dafny: {
          file: dafnyFile,
          attemptedTargets: dafnyTargets,
          fastest: fastestDafny
            ? {
                target: fastestDafny.target,
                ms: Number(fastestDafny.run.ms.toFixed(3)),
                value: fastestDafny.run.value,
              }
            : null,
        },
        jplVsFastestDafnySpeedup:
          fastestDafny === undefined ? null : Number((fastestDafny.run.ms / jplRun.ms).toFixed(3)),
      };
    });

    const jsonPath = join(outDir, "dafny-compare-latest.json");
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          availableTargets,
          targetProbes,
          results,
        },
        null,
        2,
      ),
    );

    console.log(compareMarkdown(results));
    console.log(`Wrote ${jsonPath}`);

    expect(results).toHaveLength(RESEARCH_BENCH_CASES.length);
    expect(results.every((result) => result.jplNativeArm64.value === result.expectedValue)).toBe(true);
  }, 180_000);
});

function compile(source: string) {
  const frontend = runFrontend(source);
  expect(frontend.diagnostics).toEqual([]);
  return buildIR(frontend.program, frontend.typeMap);
}

function probeDafnyTargets(): DafnyTargetProbe[] {
  const out: DafnyTargetProbe[] = [];
  if (hasCommand("dafny") && hasCommand("go") && hasCommand("goimports")) {
    out.push(probeDafnyTarget("go"));
  }
  if (hasCommand("dafny") && hasCommand("dotnet")) {
    out.push(probeDafnyTarget("cs"));
  }
  return out;
}

function probeDafnyTarget(target: DafnyTarget): DafnyTargetProbe {
  const root = mkdtempSync(join(process.cwd(), `.dafny-probe-${target}-`));
  const sourcePath = join(root, "probe.dfy");
  const outputPath = join(root, `probe-${target}`);
  const env = dafnyEnv(root);

  writeFileSync(
    sourcePath,
    `method {:main} Main() {\n  print 1, "\\n";\n}\n`,
  );

  try {
    execFileSync("dafny", ["build", "--target", target, "--no-verify", "--output", outputPath, sourcePath], {
      cwd: root,
      env,
      stdio: "pipe",
      timeout: DAFNY_BUILD_TIMEOUT_MS,
    });
    const runner = resolveDafnyRunner(outputPath, root, target);
    const run = timeCommand(runner.command, runner.args, env, DAFNY_RUN_TIMEOUT_MS);
    if (run.value !== 1) {
      throw new Error(`Probe for target '${target}' returned ${run.stdout}`);
    }
    return {
      target,
      available: true,
    };
  } catch (error) {
    return {
      target,
      available: false,
      error: formatExecError(error),
    };
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}

function hasCommand(command: string): boolean {
  try {
    execFileSync("zsh", ["-lc", `command -v ${command}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function runDafnyCase(dafnyFile: string, caseName: string, target: DafnyTarget): DafnyTargetResult {
  const root = mkdtempSync(join(process.cwd(), `.dafny-${caseName}-${target}-`));
  const outputPath = join(root, `${caseName}-${target}`);
  const env = dafnyEnv(root);

  try {
    execFileSync(
      "dafny",
      ["build", "--target", target, "--no-verify", "--output", outputPath, dafnyFile],
      {
        cwd: root,
        env,
        stdio: "pipe",
        timeout: DAFNY_BUILD_TIMEOUT_MS,
      },
    );
    const runner = resolveDafnyRunner(outputPath, root, target);
    const run = timeCommand(runner.command, runner.args, env, DAFNY_RUN_TIMEOUT_MS);
    return {
      target,
      ok: true,
      run,
    };
  } catch (error) {
    return {
      target,
      ok: false,
      error: formatExecError(error),
    };
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}

function dafnyEnv(root: string): NodeJS.ProcessEnv {
  const actualHome = process.env.HOME ?? root;
  const localBin = join(actualHome, ".local", "bin");
  return {
    ...process.env,
    HOME: root,
    DOTNET_CLI_HOME: join(root, "dotnet-home"),
    NUGET_PACKAGES: join(root, "nuget"),
    XDG_CACHE_HOME: join(root, "cache"),
    GOCACHE: join(root, "gocache"),
    GOPATH: join(root, "gopath"),
    GOENV: "off",
    PATH: `${localBin}:${process.env.PATH ?? ""}`,
  };
}

function resolveDafnyRunner(
  outputPath: string,
  root: string,
  target: DafnyTarget,
): { command: string; args: string[] } {
  const directCandidates = [outputPath, `${outputPath}.exe`, `${outputPath}.dll`];
  for (const candidate of directCandidates) {
    try {
      const stats = statSync(candidate);
      if (!stats.isFile()) {
        continue;
      }
      if (candidate.endsWith(".dll")) {
        return { command: "dotnet", args: [candidate] };
      }
      return { command: candidate, args: [] };
    } catch {
      // Continue scanning.
    }
  }

  const files = walkFiles(root);
  const match = files.find((file) => {
    if (file.endsWith(".dll")) {
      return true;
    }
    if (file.endsWith(".exe")) {
      return true;
    }
    return (statSync(file).mode & 0o111) !== 0 && !file.endsWith(".dfy") && !file.endsWith(".go");
  });

  if (!match) {
    throw new Error(`No runnable artifact found for Dafny target '${target}' in ${root}`);
  }
  return match.endsWith(".dll") ? { command: "dotnet", args: [match] } : { command: match, args: [] };
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(root, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out.sort();
}

function timeCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeout: number | undefined = undefined,
): TimedRun {
  const started = performance.now();
  const stdout = execFileSync(command, args, {
    encoding: "utf8",
    env,
    stdio: "pipe",
    timeout,
  }).trim();
  return {
    ms: performance.now() - started,
    stdout,
    value: Number(stdout),
  };
}

function formatExecError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const stderr = "stderr" in error ? String((error as { stderr?: Buffer | string }).stderr ?? "") : "";
  const stdout = "stdout" in error ? String((error as { stdout?: Buffer | string }).stdout ?? "") : "";
  return [error.message, stderr, stdout].filter(Boolean).join("\n").trim();
}

function compareMarkdown(
  results: Array<{
    name: string;
    jplImplementation: string;
    jplNativeArm64: { ms: number; value: number };
    dafny: {
      fastest: null | { target: string; ms: number; value: number };
    };
    jplVsFastestDafnySpeedup: number | null;
  }>,
): string {
  const lines = [
    "| Case | JPL Impl | JPL arm64 ms | Fastest Dafny | Dafny ms | JPL vs Dafny |",
    "| --- | --- | ---: | --- | ---: | ---: |",
  ];
  for (const result of results) {
    lines.push(
      `| ${result.name} | ${result.jplImplementation} | ${result.jplNativeArm64.ms} | ${result.dafny.fastest?.target ?? "none"} | ${result.dafny.fastest?.ms ?? "n/a"} | ${result.jplVsFastestDafnySpeedup ?? "n/a"}x |`,
    );
  }
  return lines.join("\n");
}
