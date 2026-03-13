import { parseSource } from "./parse";
import { refineProgram } from "./refine";
import { resolveProgram } from "./resolve";
import { typecheckProgram } from "./typecheck";
export function runFrontend(source) {
    const parsed = parseSource(source);
    const resolved = resolveProgram(parsed.program);
    const typed = typecheckProgram(resolved.program);
    const hasHardErrors = [...parsed.diagnostics, ...resolved.diagnostics, ...typed.diagnostics]
        .some((diagnostic) => diagnostic.severity === "error");
    const refined = hasHardErrors
        ? { program: typed.program, diagnostics: [], refinements: [] }
        : refineProgram(typed.program, typed.typeMap);
    return {
        program: refined.program,
        diagnostics: [...parsed.diagnostics, ...resolved.diagnostics, ...typed.diagnostics, ...refined.diagnostics],
        typeMap: typed.typeMap,
        refinements: refined.refinements,
    };
}
//# sourceMappingURL=pipeline.js.map