import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { emitNativeCModule, emitWatModule } from "@jplmm/backend";
import { runFrontend } from "@jplmm/frontend";
import { buildIR } from "@jplmm/ir";
import { optimizeProgram } from "@jplmm/optimize";
import { verifyProgram } from "@jplmm/verify";

import { executeTopLevelProgram } from "./run";

export type CliMode = "parse" | "typecheck" | "verify" | "optimize" | "wat" | "native" | "run";

export type CliOptions = {
  experimental?: boolean;
  cwd?: string;
};

export type CliReport = {
  mode: CliMode;
  diagnostics: string[];
  proofSummary: string[];
  optimizeSummary: string[];
  implementationSummary: string[];
  wat: string | undefined;
  nativeC: string | undefined;
  output: string[];
  wroteFiles: string[];
  ok: boolean;
};

export function runOnSource(source: string, mode: CliMode, options: CliOptions = {}): CliReport {
  const frontend = runFrontend(source);
  const diagnostics = frontend.diagnostics.map((d) => `${d.severity.toUpperCase()}: ${d.message}`);

  let proofSummary: string[] = [];
  let optimizeSummary: string[] = [];
  let implementationSummary: string[] = [];
  let wat: string | undefined;
  let nativeC: string | undefined;
  let output: string[] = [];
  let wroteFiles: string[] = [];

  if (mode === "verify") {
    const verify = verifyProgram(frontend.program);
    diagnostics.push(...verify.diagnostics.map((d) => `${d.severity.toUpperCase()}: ${d.message}`));
    proofSummary = [...verify.proofMap.entries()].map(
      ([fnName, p]) => `${fnName}: ${p.status} (${p.method}) - ${p.details}`,
    );
  }

  const hasErrors = diagnostics.some((d) => d.startsWith("ERROR:"));
  if (!hasErrors && (mode === "optimize" || mode === "wat" || mode === "native")) {
    const ir = buildIR(frontend.program, frontend.typeMap);
    const optimizeOptions = options.experimental ? { enableResearchPasses: true } : {};
    const optimized = optimizeProgram(ir, optimizeOptions);
    optimizeSummary = optimized.reports.map((report) => {
      const prefix = report.experimental ? "[experimental] " : "";
      const detail = report.details.length > 0 ? ` ${report.details.join("; ")}` : "";
      return `${prefix}${report.name}:${detail}`;
    });
    implementationSummary = [...optimized.artifacts.implementations.entries()].map(
      ([fnName, impl]) => `${fnName}: ${impl.tag}`,
    );
    if (mode === "wat") {
      wat = emitWatModule(optimized.program, {
        artifacts: optimized.artifacts,
        tailCalls: true,
        exportFunctions: true,
      });
    }
    if (mode === "native") {
      nativeC = emitNativeCModule(optimized.program, {
        artifacts: optimized.artifacts,
      });
    }
  }

  if (!hasErrors && mode === "run") {
    const execution = executeTopLevelProgram(frontend.program, frontend.typeMap, options.cwd ?? process.cwd());
    output = execution.output;
    wroteFiles = execution.wroteFiles;
  }

  const ok = diagnostics.every((d) => !d.startsWith("ERROR:"));
  return {
    mode,
    diagnostics,
    proofSummary,
    optimizeSummary,
    implementationSummary,
    wat,
    nativeC,
    output,
    wroteFiles,
    ok,
  };
}

export function runOnFile(filepath: string, mode: CliMode, options: CliOptions = {}): CliReport {
  const source = readFileSync(resolve(filepath), "utf8");
  return runOnSource(source, mode, {
    ...options,
    cwd: options.cwd ?? dirname(resolve(filepath)),
  });
}

export function main(argv: string[]): number {
  const args = [...argv];
  const experimental = args.includes("--experimental");
  const filtered = args.filter((arg) => arg !== "--experimental");
  const modeArg = filtered[0];
  const fileArg = filtered[1];

  const mode: CliMode =
    modeArg === "-p"
      ? "parse"
      : modeArg === "-t"
        ? "typecheck"
        : modeArg === "-v"
          ? "verify"
          : modeArg === "-i"
            ? "optimize"
            : modeArg === "-s"
              ? "wat"
              : modeArg === "-a"
                ? "native"
                : modeArg === "-r"
                  ? "run"
                : "verify";
  const file = modeArg?.startsWith("-") ? fileArg : modeArg;

  if (!file) {
    // eslint-disable-next-line no-console
    console.error("Usage: jplmm [-p|-t|-v|-i|-s|-a|-r] [--experimental] <file.jplmm>");
    return 2;
  }

  const report = runOnFile(file, mode, { experimental });
  for (const d of report.diagnostics) {
    // eslint-disable-next-line no-console
    console.log(d);
  }
  for (const p of report.proofSummary) {
    // eslint-disable-next-line no-console
    console.log(p);
  }
  for (const p of report.optimizeSummary) {
    // eslint-disable-next-line no-console
    console.log(p);
  }
  for (const impl of report.implementationSummary) {
    // eslint-disable-next-line no-console
    console.log(impl);
  }
  if (report.wat) {
    // eslint-disable-next-line no-console
    console.log(report.wat);
  }
  if (report.nativeC) {
    // eslint-disable-next-line no-console
    console.log(report.nativeC);
  }
  for (const line of report.output) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  return report.ok ? 0 : 1;
}
