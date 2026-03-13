import type { Cmd, Type } from "@jplmm/ast";
import { type IntRefineExpr } from "./int";
export type IntFunctionSummary = {
    paramNames: string[];
    expr: IntRefineExpr;
};
export type RefinementMethod = "canonical" | "exact_zero_arity" | "scalar_int_smt" | "scalar_int_recursive_induction";
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
export declare function computeFunctionSummary(fnName: string, commands: Cmd[], typeMap: Map<number, Type>, summaries: Map<string, IntFunctionSummary>): IntFunctionSummary | null;
export declare function checkFunctionRefinement(fnName: string, baselineCommands: Cmd[], refinedCommands: Cmd[], typeMap: Map<number, Type>, summaries: Map<string, IntFunctionSummary>): RefinementCheck;
//# sourceMappingURL=refinement.d.ts.map