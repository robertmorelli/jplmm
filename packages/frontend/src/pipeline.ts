import type { Program } from "@jplmm/ast";

import type { Diagnostic } from "./errors";
import { parseSource } from "./parse";
import { refineProgram, type RefinementReport } from "./refine";
import { resolveProgram } from "./resolve";
import { typecheckProgram } from "./typecheck";

export type FrontendResult = {
  program: Program;
  diagnostics: Diagnostic[];
  typeMap: Map<number, Type>;
  refinements: RefinementReport[];
};

export type FrontendOptions = {
  proofTimeoutMs?: number;
};

const DEFAULT_PROOF_TIMEOUT_MS = 2000;

export function runFrontend(source: string, options: FrontendOptions = {}): FrontendResult {
  const parsed = parseSource(source);
  const resolved = resolveProgram(parsed.program);
  const typed = typecheckProgram(resolved.program);
  const proofTimeoutMs = resolveProofTimeoutMs(options.proofTimeoutMs);
  const hasHardErrors = [...parsed.diagnostics, ...resolved.diagnostics, ...typed.diagnostics]
    .some((diagnostic) => diagnostic.severity === "error");
  const refined = hasHardErrors
    ? { program: typed.program, diagnostics: [] as Diagnostic[], refinements: [] as RefinementReport[] }
    : refineProgram(
      typed.program,
      typed.typeMap,
      proofTimeoutMs === undefined ? {} : { proofTimeoutMs },
    );
  return {
    program: refined.program,
    diagnostics: [...parsed.diagnostics, ...resolved.diagnostics, ...typed.diagnostics, ...refined.diagnostics],
    typeMap: typed.typeMap,
    refinements: refined.refinements,
  };
}

function resolveProofTimeoutMs(proofTimeoutMs: number | undefined): number | undefined {
  if (proofTimeoutMs === undefined) {
    return DEFAULT_PROOF_TIMEOUT_MS;
  }
  if (!Number.isFinite(proofTimeoutMs) || proofTimeoutMs <= 0) {
    return DEFAULT_PROOF_TIMEOUT_MS;
  }
  return Math.min(2000, Math.max(1, Math.floor(proofTimeoutMs)));
}
