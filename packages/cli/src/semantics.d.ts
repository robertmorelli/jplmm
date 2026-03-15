import type { Type } from "@jplmm/ast";
import type { WatModuleSemantics } from "@jplmm/backend";
import type { FrontendResult, RefinementReport } from "@jplmm/frontend";
import type { IRProgram } from "@jplmm/ir";
import { type OptimizeResult } from "@jplmm/optimize";
import { type Z3RunOptions } from "@jplmm/smt";
import type { ProofResult, VerificationOutput } from "@jplmm/verify";
import { analyzeProgramMetrics } from "@jplmm/verify";
export type SemanticsDebugData = {
    kind: "jplmm_semantics_debug";
    diagnostics: {
        frontend: FrontendResult["diagnostics"];
        verification: VerificationOutput["diagnostics"];
    };
    refinements: SemanticsRefinementRecord[];
    canonicalProgram: VerificationOutput["canonicalProgram"] | null;
    compiler: SemanticsCompilerRecord | null;
    backend: SemanticsBackendRecord | null;
    functions: SemanticsFunctionRecord[];
};
export type SemanticsBackendRecord = {
    optimizeSummary: string[];
    implementationSummary: string[];
    optimizedProgram: IRProgram;
    wasm: WatModuleSemantics;
};
export type SemanticsCompilerRecord = {
    floors: {
        raw: SemanticsIrFloorRecord;
        canonical: SemanticsIrFloorRecord;
        guardElided: SemanticsIrFloorRecord;
        finalOptimized: SemanticsIrFloorRecord;
        closedFormImpl: SemanticsIrFloorRecord | null;
    };
    implementationFloors: {
        lut: SemanticsLutFloorRecord | null;
    };
    analyses: {
        canonicalRanges: SerializedRangeAnalysis;
        finalRanges: SerializedRangeAnalysis;
        guardConsumedExprIds: number[];
        implementations: Array<{
            fnName: string;
            implementation: OptimizeResult["artifacts"]["implementations"] extends Map<string, infer T> ? T : never;
        }>;
        reports: OptimizeResult["reports"];
    };
    edges: SemanticsEdgeRecord[];
};
type SemanticsBackendOrNull = SemanticsBackendRecord | null;
type SemanticsCompilerOrNull = SemanticsCompilerRecord | null;
type SemanticsRefinementRecord = Omit<RefinementReport, "baselineSemantics" | "refSemantics" | "baselineSemanticsData" | "refSemanticsData"> & {
    baselineSemanticsData: Exclude<RefinementReport["baselineSemanticsData"], undefined> | null;
    refSemanticsData: Exclude<RefinementReport["refSemanticsData"], undefined> | null;
};
type SemanticsFunctionRecord = {
    name: string;
    canonical: VerificationOutput["canonicalProgram"]["functions"][number];
    proof: ProofResult | null;
    metrics: ReturnType<typeof analyzeProgramMetrics> extends Map<string, infer T> ? T | null : never;
    analysis: SerializedVerificationAnalysis;
};
type SemanticsIrFloorRecord = {
    label: "raw_ir" | "canonical_ir" | "guard_elided_ir" | "final_optimized_ir" | "closed_form_impl_ir";
    program: IRProgram;
    globals: Array<{
        name: string;
        rendered: string;
    }>;
    functions: Array<{
        name: string;
        rendered: string[];
        result: SerializedSymValue | null;
        analysis: SerializedIrFunctionAnalysis;
    }>;
};
type SemanticsLutFloorRecord = {
    label: "lut_impl_semantics";
    functions: Array<{
        name: string;
        parameterRanges: Array<{
            lo: number;
            hi: number;
        }>;
        table: number[];
        resultType: Type;
        fallback: "final_optimized_ir";
        semantics: string[];
    }>;
};
type SemanticsEdgeRecord = {
    from: SemanticsIrFloorRecord["label"] | SemanticsLutFloorRecord["label"] | "canonical_range_facts";
    to: SemanticsIrFloorRecord["label"] | SemanticsLutFloorRecord["label"] | "canonical_range_facts";
    kind: "ir_refinement" | "implementation_refinement" | "analysis_soundness";
    ok: boolean;
    summary: {
        equivalent: number;
        mismatch: number;
        unproven: number;
    };
    functions: Array<{
        name: string;
        status: "equivalent" | "mismatch" | "unproven";
        method?: string;
        detail: string;
        equivalence?: string;
    }>;
};
type SerializedIrFunctionAnalysis = {
    hasRec: boolean;
    params: Array<{
        name: string;
        value: SerializedSymValue;
    }>;
    statementSemantics: Array<{
        stmtIndex: number;
        stmtTag: string;
        rendered: string;
        value: SerializedSymValue | null;
    }>;
    radSites: Array<{
        stmtIndex: number;
        rendered: string;
        source: unknown;
    }>;
    recSites: Array<{
        stmtIndex: number;
        args: unknown[];
        argValues: Array<{
            index: number;
            value: SerializedSymValue;
        }>;
        issues: string[];
    }>;
    callSigs: Record<string, {
        args: string[];
        ret: string;
    }>;
};
type SerializedVerificationAnalysis = Omit<SerializedIrFunctionAnalysis, "recSites"> & {
    recSites: Array<{
        stmtIndex: number;
        args: unknown[];
        argValues: Array<{
            index: number;
            value: SerializedSymValue;
        }>;
        issues: string[];
        obligations: Array<{
            rad: string;
            structural: {
                ok: boolean;
                reason: string;
            };
            smt: {
                ok: true;
                method: "smt";
                details: string;
            } | {
                ok: false;
                reasons: string[];
            };
        }>;
    }>;
};
type SerializedRangeAnalysis = {
    exprRanges: Record<string, {
        lo: number;
        hi: number;
    }>;
    cardinalities: Record<string, {
        parameterRanges: Array<{
            lo: number;
            hi: number;
        }>;
        cardinality: number | "inf";
    }>;
};
type SerializedSymValue = {
    kind: "scalar";
    expr: unknown;
} | {
    kind: "array";
    array: unknown;
} | {
    kind: "struct";
    typeName: string;
    fields: Array<{
        name: string;
        type: unknown;
        value: SerializedSymValue;
    }>;
} | {
    kind: "void";
    type: unknown;
} | {
    kind: "opaque";
    type: unknown;
    label: string;
};
export declare function buildSemanticsDebugData(frontend: FrontendResult, verification: VerificationOutput, backend?: SemanticsBackendOrNull, compiler?: SemanticsCompilerOrNull): SemanticsDebugData;
export declare function buildCompilerSemantics(rawProgram: IRProgram, optimized: OptimizeResult, solverOptions?: Z3RunOptions): SemanticsCompilerRecord;
export declare function renderSemanticsDebugData(data: SemanticsDebugData): string;
export {};
//# sourceMappingURL=semantics.d.ts.map