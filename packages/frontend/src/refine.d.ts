import { type FunctionKeyword, type Program, type Type } from "@jplmm/ast";
import { buildCanonicalProgram, type RefinementMethod } from "@jplmm/proof";
import { type Diagnostic } from "./errors";
export type RefinementStatus = "equivalent" | "mismatch" | "unproven" | "invalid";
export type CanonicalFunctionSemantics = ReturnType<typeof buildCanonicalProgram>["functions"][number];
export type RefinementReport = {
    fnName: string;
    baselineKeyword: Exclude<FunctionKeyword, "ref"> | null;
    status: RefinementStatus;
    method?: RefinementMethod;
    detail: string;
    equivalence?: string;
    baselineSemantics: string[];
    refSemantics: string[];
    baselineSemanticsData?: CanonicalFunctionSemantics;
    refSemanticsData?: CanonicalFunctionSemantics;
    baselineStart?: number;
    baselineEnd?: number;
    refStart?: number;
    refEnd?: number;
};
export type RefineResult = {
    program: Program;
    diagnostics: Diagnostic[];
    refinements: RefinementReport[];
};
export type RefineOptions = {
    proofTimeoutMs?: number;
};
export declare function refineProgram(program: Program, typeMap: Map<number, Type>, options?: RefineOptions): RefineResult;
//# sourceMappingURL=refine.d.ts.map