import type { Program } from "@jplmm/ast";
import { type Diagnostic } from "./errors";
type ResolveResult = {
    program: Program;
    diagnostics: Diagnostic[];
};
export declare function resolveProgram(program: Program): ResolveResult;
export {};
//# sourceMappingURL=resolve.d.ts.map