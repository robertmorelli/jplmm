import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

export type TimedRun = {
  ms: number;
  stdout: string;
};

export type DafnyTarget = "go" | "cs";

export type DafnyTargetProbe =
  | {
      target: DafnyTarget;
      available: true;
    }
  | {
      target: DafnyTarget;
      available: false;
      error: string;
    };

export type DafnyTargetResult =
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

export const DAFNY_BUILD_TIMEOUT_MS = 120_000;
export const DAFNY_RUN_TIMEOUT_MS = 120_000;

export function createDafnyCacheRoot(prefix = "jplmm-dafny-cache-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDafnyCacheRoot(root: string): void {
  rmSync(root, {
    recursive: true,
    force: true,
  });
}

export function probeDafnyTargets(cacheRoot: string): DafnyTargetProbe[] {
  const out: DafnyTargetProbe[] = [];
  if (hasCommand("dafny") && hasCommand("go") && hasCommand("goimports")) {
    out.push(probeDafnyTarget("go", cacheRoot));
  }
  if (hasCommand("dafny") && hasCommand("dotnet")) {
    out.push(probeDafnyTarget("cs", cacheRoot));
  }
  return out;
}

export function runDafnyCase(
  dafnyFile: string,
  caseName: string,
  target: DafnyTarget,
  cacheRoot: string,
): DafnyTargetResult {
  const root = mkdtempSync(join(cacheRoot, `${caseName}-${target}-`));
  const outputPath = join(root, `${caseName}-${target}`);
  const env = dafnyEnv(cacheRoot);

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

export function timeCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeout = DAFNY_RUN_TIMEOUT_MS,
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
  };
}

function probeDafnyTarget(target: DafnyTarget, cacheRoot: string): DafnyTargetProbe {
  const root = mkdtempSync(join(cacheRoot, `probe-${target}-`));
  const sourcePath = join(root, "probe.dfy");
  const outputPath = join(root, `probe-${target}`);
  const env = dafnyEnv(cacheRoot);

  try {
    writeFileSync(sourcePath, `method {:main} Main() {\n  print 1, "\\n";\n}\n`);
    execFileSync("dafny", ["build", "--target", target, "--no-verify", "--output", outputPath, sourcePath], {
      cwd: root,
      env,
      stdio: "pipe",
      timeout: DAFNY_BUILD_TIMEOUT_MS,
    });
    const runner = resolveDafnyRunner(outputPath, root, target);
    const run = timeCommand(runner.command, runner.args, env, DAFNY_RUN_TIMEOUT_MS);
    if (run.stdout !== "1") {
      throw new Error(`Probe for target '${target}' returned '${run.stdout}'`);
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

function dafnyEnv(cacheRoot: string): NodeJS.ProcessEnv {
  const actualHome = process.env.HOME ?? cacheRoot;
  const localBin = join(actualHome, ".local", "bin");
  return {
    ...process.env,
    HOME: cacheRoot,
    DOTNET_CLI_HOME: join(cacheRoot, "dotnet-home"),
    NUGET_PACKAGES: join(cacheRoot, "nuget"),
    XDG_CACHE_HOME: join(cacheRoot, "cache"),
    GOCACHE: join(cacheRoot, "gocache"),
    GOPATH: join(cacheRoot, "gopath"),
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
      if (statSync(candidate).isFile()) {
        if (candidate.endsWith(".dll")) {
          return {
            command: "dotnet",
            args: [candidate],
          };
        }
        return {
          command: candidate,
          args: [],
        };
      }
    } catch {
      // skip
    }
  }

  const generatedDirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));

  for (const dir of generatedDirs) {
    const files = readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      const full = join(dir, file.name);
      if (!file.isFile()) {
        continue;
      }
      if (file.name.endsWith(".dll")) {
        return {
          command: "dotnet",
          args: [full],
        };
      }
      try {
        if (statSync(full).mode & 0o111) {
          return {
            command: full,
            args: [],
          };
        }
      } catch {
        // skip
      }
    }
  }

  throw new Error(`Unable to find runnable output for Dafny target '${target}' at ${outputPath}`);
}

function formatExecError(error: unknown): string {
  if (error instanceof Error) {
    const anyError = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
    const stderr = anyError.stderr ? String(anyError.stderr).trim() : "";
    const stdout = anyError.stdout ? String(anyError.stdout).trim() : "";
    return stderr || stdout || error.message;
  }
  return String(error);
}
