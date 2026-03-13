import { parseSource } from "./parse";
import { resolveProgram } from "./resolve";
import { typecheckProgram } from "./typecheck";
export function runFrontend(source) {
    const parsed = parseSource(source);
    const resolved = resolveProgram(parsed.program);
    const typed = typecheckProgram(resolved.program);
    return {
        program: typed.program,
        diagnostics: [...parsed.diagnostics, ...resolved.diagnostics, ...typed.diagnostics],
        typeMap: typed.typeMap,
    };
}
//# sourceMappingURL=pipeline.js.map