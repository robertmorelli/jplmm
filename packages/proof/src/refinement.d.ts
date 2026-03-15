import { type Cmd, type Type } from "@jplmm/ast";
import type { IRProgram } from "@jplmm/ir";
import { type Z3RunOptions } from "@jplmm/smt";
export type RefinementMethod = "canonical" | "exact_zero_arity" | "symbolic_value_alpha" | "symbolic_value_smt" | "symbolic_recursive_induction";
export type RefinementCheck = {
    ok: true;
    method: RefinementMethod;
    detail: string;
    equivalence?: string;
} | {
    ok: false;
    code: "REF_MISMATCH" | "REF_UNPROVEN";
    message: string;
};
export declare function checkFunctionRefinement(fnName: string, baselineCommands: Cmd[], refinedCommands: Cmd[], typeMap: Map<number, Type>, solverOptions?: Z3RunOptions): RefinementCheck;
export declare function checkIrFunctionRefinement(fnName: string, baselineProgram: IRProgram, refinedProgram: IRProgram, solverOptions?: Z3RunOptions, boundaryLabel?: string): RefinementCheck;
//# sourceMappingURL=refinement.d.ts.map