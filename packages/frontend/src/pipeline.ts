import type { Program } from "@jplmm/ast";

import type { Diagnostic } from "./errors";
import { parseSource } from "./parse";
import { resolveProgram } from "./resolve";
import { typecheckProgram } from "./typecheck";

export type FrontendResult = {
  program: Program;
  diagnostics: Diagnostic[];
  typeMap: Map<number, import("@jplmm/ast").Type>;
};

export function runFrontend(source: string): FrontendResult {
  const parsed = parseSource(source);
  const resolved = resolveProgram(parsed.program);
  const typed = typecheckProgram(resolved.program);
  return {
    program: typed.program,
    diagnostics: [...parsed.diagnostics, ...resolved.diagnostics, ...typed.diagnostics],
    typeMap: typed.typeMap,
  };
}

