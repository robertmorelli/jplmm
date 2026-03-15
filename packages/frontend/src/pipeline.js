import { parseSource } from "./parse";
import { refineProgram } from "./refine";
import { resolveProgram } from "./resolve";
import { typecheckProgram } from "./typecheck";
const DEFAULT_PROOF_TIMEOUT_MS = 2000;
export function runFrontend(source, options = {}) {
    const parsed = parseSource(source);
    const resolved = resolveProgram(parsed.program);
    const typed = typecheckProgram(resolved.program);
    const proofTimeoutMs = resolveProofTimeoutMs(options.proofTimeoutMs);
    const hasHardErrors = [...parsed.diagnostics, ...resolved.diagnostics, ...typed.diagnostics]
        .some((diagnostic) => diagnostic.severity === "error");
    const refined = hasHardErrors
        ? { program: typed.program, diagnostics: [], refinements: [] }
        : refineProgram(typed.program, typed.typeMap, proofTimeoutMs === undefined ? {} : { proofTimeoutMs });
    return {
        program: refined.program,
        diagnostics: [...parsed.diagnostics, ...resolved.diagnostics, ...typed.diagnostics, ...refined.diagnostics],
        typeMap: typed.typeMap,
        refinements: refined.refinements,
    };
}
function resolveProofTimeoutMs(proofTimeoutMs) {
    if (proofTimeoutMs === undefined) {
        return DEFAULT_PROOF_TIMEOUT_MS;
    }
    if (!Number.isFinite(proofTimeoutMs) || proofTimeoutMs <= 0) {
        return DEFAULT_PROOF_TIMEOUT_MS;
    }
    return Math.min(2000, Math.max(1, Math.floor(proofTimeoutMs)));
}
//# sourceMappingURL=pipeline.js.map