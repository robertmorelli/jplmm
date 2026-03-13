import type { Program } from "@jplmm/ast";

import type { Diagnostic } from "./errors";
import { parseSource } from "./parse";
import { refineProgram, type RefinementReport } from "./refine";
import { resolveProgram } from "./resolve";
import { typecheckProgram } from "./typecheck";

export type FrontendResult = {
  program: Program;
  diagnostics: Diagnostic[];
  typeMap: Map<number, import("@jplmm/ast").Type>;
  refinements: RefinementReport[];
};

export function runFrontend(source: string): FrontendResult {
  const parsed = parseSource(source);
  const resolved = resolveProgram(parsed.program);
  const typed = typecheckProgram(resolved.program);
  const hasHardErrors = [...parsed.diagnostics, ...resolved.diagnostics, ...typed.diagnostics]
    .some((diagnostic) => diagnostic.severity === "error");
  const refined = hasHardErrors
    ? { program: typed.program, diagnostics: [] as Diagnostic[], refinements: [] as RefinementReport[] }
    : refineProgram(typed.program, typed.typeMap);
  return {
    program: refined.program,
    diagnostics: [...parsed.diagnostics, ...resolved.diagnostics, ...typed.diagnostics, ...refined.diagnostics],
    typeMap: typed.typeMap,
    refinements: refined.refinements,
  };
}
