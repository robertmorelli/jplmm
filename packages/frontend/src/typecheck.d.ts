import type { Program, Type } from "@jplmm/ast";
import { type Diagnostic } from "./errors";
type TypecheckResult = {
    program: Program;
    typeMap: Map<number, Type>;
    diagnostics: Diagnostic[];
};
export declare function typecheckProgram(program: Program): TypecheckResult;
export {};
//# sourceMappingURL=typecheck.d.ts.map