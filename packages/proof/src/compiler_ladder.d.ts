import type { Type } from "@jplmm/ast";
import type { IRExpr, IRProgram } from "@jplmm/ir";
import { type ClosedFormImplementation, type OptimizeResult, type RangeAnalysisResult, type SerializedExprProvenance } from "@jplmm/optimize";
import { type Z3RunOptions } from "@jplmm/smt";
import { type SymValue } from "./scalar";
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
        provenance: {
            rawToCanonical: SerializedExprProvenance;
            canonicalToGuardElided: SerializedExprProvenance;
            guardElidedToFinalOptimized: SerializedExprProvenance;
        };
        guardConsumedExprIds: number[];
        canonicalConsumedRangeFacts: Array<{
            owner: string;
            exprId: number;
            rendered: string;
            range: {
                lo: number;
                hi: number;
            } | null;
        }>;
        implementations: Array<{
            fnName: string;
            implementation: OptimizeResult["artifacts"]["implementations"] extends Map<string, infer T> ? T : never;
        }>;
        reports: OptimizeResult["reports"];
    };
    edges: SemanticsEdgeRecord[];
};
export type SemanticsIrFloorRecord = {
    label: "raw_ir" | "canonical_ir" | "guard_elided_ir" | "final_optimized_ir" | "closed_form_impl_ir";
    program: IRProgram;
    globals: Array<{
        name: string;
        rendered: string;
        value: SerializedSymValue | null;
        exprSemantics: Array<{
            exprId: number;
            rendered: string;
            value: SerializedSymValue | null;
        }>;
    }>;
    functions: Array<{
        name: string;
        rendered: string[];
        result: SerializedSymValue | null;
        analysis: SerializedIrFunctionAnalysis;
    }>;
};
export type SemanticsLutFloorRecord = {
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
export type SemanticsEdgeRecord = {
    from: SemanticsIrFloorRecord["label"] | SemanticsLutFloorRecord["label"] | "canonical_range_facts";
    to: SemanticsIrFloorRecord["label"] | SemanticsLutFloorRecord["label"] | "canonical_range_facts";
    kind: "ir_refinement" | "implementation_refinement" | "analysis_soundness";
    certificate: SemanticsCertificateRecord | null;
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
type SemanticsCertificateValidation = {
    ok: boolean;
    detail: string;
};
export type SemanticsCertificateRecord = {
    kind: "canonicalize";
    passOrder: OptimizeResult["stages"]["canonical"]["passOrder"];
    stats: OptimizeResult["stages"]["canonical"]["stats"];
    validation: SemanticsCertificateValidation & {
        derived: {
            totalDivInserted: number;
            totalModInserted: number;
            nanToZeroInserted: number;
            satAddInserted: number;
            satSubInserted: number;
            satMulInserted: number;
            satNegInserted: number;
            zeroDivisorConstantFolded: number;
        };
        targetCanonical: boolean;
    };
} | {
    kind: "range_analysis";
    consumedExprIds: number[];
    validation: SemanticsCertificateValidation & {
        attachedExprIds: number[];
        missingExprIds: number[];
    };
} | {
    kind: "guard_elimination";
    usedRangeExprIds: number[];
    removed: {
        nanToZero: number;
        totalDiv: number;
        totalMod: number;
    };
    validation: SemanticsCertificateValidation & {
        derivedRemoved: {
            nanToZero: number;
            totalDiv: number;
            totalMod: number;
        };
        missingExprIds: number[];
    };
} | {
    kind: "identity";
    reason: string;
    validation: SemanticsCertificateValidation;
} | {
    kind: "closed_form";
    matches: Array<{
        fnName: string;
        implementation: ClosedFormImplementation;
        assumptions: string[];
    }>;
    validation: SemanticsCertificateValidation & {
        unmatched: string[];
    };
} | {
    kind: "lut";
    entries: Array<{
        fnName: string;
        parameterRanges: Array<{
            lo: number;
            hi: number;
        }>;
        tableLength: number;
        fallback: "final_optimized_ir";
    }>;
    validation: SemanticsCertificateValidation & {
        invalidEntries: string[];
    };
};
export type SerializedIrFunctionAnalysis = {
    hasRec: boolean;
    params: Array<{
        name: string;
        value: SerializedSymValue;
    }>;
    exprSemantics: Array<{
        exprId: number;
        rendered: string;
        value: SerializedSymValue | null;
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
export type SerializedRangeAnalysis = {
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
export type SerializedSymValue = {
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
export declare function buildCompilerSemantics(rawProgram: IRProgram, optimized: OptimizeResult, solverOptions?: Z3RunOptions): SemanticsCompilerRecord;
export declare function serializeRangeAnalysis(result: RangeAnalysisResult): SerializedRangeAnalysis;
export declare function serializePlainIrAnalysis(trace: {
    hasRec: boolean;
    paramValues: Map<string, SymValue>;
    exprSemantics: Map<number, SymValue>;
    result: SymValue | null;
    stmtSemantics: Array<{
        stmtIndex: number;
        stmtTag: string;
        rendered: string;
        value: SymValue | null;
    }>;
    radSites: Array<{
        stmtIndex: number;
        rendered: string;
        source: unknown;
    }>;
    recSites: Array<{
        stmtIndex: number;
        args: unknown[];
        argValues: Map<number, SymValue>;
        issues: string[];
    }>;
    callSigs: Map<string, {
        args: string[];
        ret: string;
    } | {
        args: Array<"int" | "float">;
        ret: "int" | "float";
    }>;
} | null | undefined, exprRoots?: IRExpr[]): SerializedIrFunctionAnalysis;
export declare function serializeSymValue(value: SymValue): SerializedSymValue;
export declare function serializeOptionalSymValue(value: SymValue | undefined): SerializedSymValue | null;
export declare function serializeExprSemantics(roots: IRExpr[], exprSemantics: Map<number, SymValue>): Array<{
    exprId: number;
    rendered: string;
    value: SerializedSymValue | null;
}>;
export {};
//# sourceMappingURL=compiler_ladder.d.ts.map