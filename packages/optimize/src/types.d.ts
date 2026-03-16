import type { Type } from "@jplmm/ast";
import type { IRExpr, IRProgram } from "@jplmm/ir";
import type { CanonicalizeResult } from "./canonicalize";
export type Interval = {
    lo: number;
    hi: number;
};
export type ParameterRangeHints = Record<string, Interval[]>;
export type CardinalityInfo = {
    parameterRanges: Interval[];
    cardinality: number | "inf";
};
export type ClosedFormImplementation = {
    tag: "closed_form_linear_countdown";
    paramIndex: number;
    baseValue: number;
    stepValue: number;
    decrement: number;
};
export type LutImplementation = {
    tag: "lut";
    parameterRanges: Interval[];
    table: number[];
    resultType: Type;
};
export type AitkenImplementation = {
    tag: "aitken_scalar_tail";
    stateParamIndex: number;
    afterIterations: number;
    invariantParamIndices: number[];
    targetParamIndex: number | null;
};
export type LinearSpeculationImplementation = {
    tag: "linear_speculation";
    varyingParamIndex: number;
    fixedPoint: number;
    stride: number;
    direction: "up" | "down";
    invariantParamIndices: number[];
};
export type FunctionImplementation = ClosedFormImplementation | LutImplementation | AitkenImplementation | LinearSpeculationImplementation;
export type ResearchCandidate = {
    pass: "aitken" | "linear_speculation";
    reason: string;
    applied?: boolean;
    blockedByDefinition?: boolean;
};
export type OptimizeArtifacts = {
    rangeMap: Map<number, Interval>;
    cardinalityMap: Map<string, CardinalityInfo>;
    implementations: Map<string, FunctionImplementation>;
    researchCandidates: Map<string, ResearchCandidate[]>;
};
export type OptimizePassName = "canonicalize" | "range_analysis" | "guard_elimination" | "closed_form" | "lut_tabulation" | "aitken" | "linear_speculation";
export type OptimizePassReport = {
    name: OptimizePassName;
    changed: boolean;
    details: string[];
    experimental?: boolean;
};
export type OptimizeOptions = {
    parameterRangeHints?: ParameterRangeHints;
    enableResearchPasses?: boolean;
    lutThreshold?: number;
    disabledPasses?: DisableablePassName[];
    proofGateCertificates?: boolean;
};
export type DisableablePassName = "guard_elimination" | "closed_form" | "lut_tabulation" | "aitken" | "linear_speculation";
export type OptimizeResult = {
    program: IRProgram;
    artifacts: OptimizeArtifacts;
    reports: OptimizePassReport[];
    stages: OptimizeStages;
    certificates: OptimizeCertificates;
    provenance: OptimizeProvenance;
};
export type OptimizeCertificates = {
    canonicalize: {
        passOrder: CanonicalizeResult["passOrder"];
        stats: CanonicalizeResult["stats"];
    };
    rangeAnalysis: {
        exprIds: number[];
        consumedExprIds: number[];
    };
    guardElimination: {
        usedRangeExprIds: number[];
        removed: {
            nanToZero: number;
            totalDiv: number;
            totalMod: number;
        };
    };
    finalIdentity: {
        reason: string;
    };
    closedForm: {
        matches: Array<{
            fnName: string;
            implementation: ClosedFormImplementation;
            assumptions: string[];
        }>;
    };
    lut: {
        entries: Array<{
            fnName: string;
            parameterRanges: Array<{
                lo: number;
                hi: number;
            }>;
            tableLength: number;
            fallback: "final_optimized_ir";
        }>;
    };
};
export type OptimizeStages = {
    rawProgram: IRProgram;
    canonical: CanonicalizeResult;
    canonicalRanges: RangeAnalysisResult;
    guardElided: GuardEliminationResult;
    finalRanges: RangeAnalysisResult;
};
export type ExprProvenance = {
    byOutputExprId: Map<number, {
        sourceExprIds: number[];
        status: "preserved" | "rewritten" | "generated";
        rule: string | null;
    }>;
};
export type SerializedExprProvenance = {
    byOutputExprId: Record<string, {
        sourceExprIds: number[];
        status: "preserved" | "rewritten" | "generated";
        rule: string | null;
    }>;
};
export type ProvenanceStage = "ast_lowering" | "canonicalize" | "guard_elimination" | "identity";
export type OptimizeProvenance = {
    rawToCanonical: ExprProvenance;
    canonicalToGuardElided: ExprProvenance;
    guardElidedToFinalOptimized: ExprProvenance;
};
export type ExecuteOptions = {
    artifacts?: OptimizeArtifacts;
};
export type RuntimeStructValue = {
    kind: "struct";
    typeName: string;
    fields: RuntimeValue[];
};
export type RuntimeArrayValue = {
    kind: "array";
    elementType: Type;
    dims: number[];
    values: RuntimeValue[];
};
export type RuntimeValue = number | RuntimeStructValue | RuntimeArrayValue;
export type ExecuteStats = {
    exprEvaluations: number;
    functionCalls: number;
    recCalls: number;
    recCollapses: number;
    tailRecTransitions: number;
    gasExhaustions: number;
    iterations: number;
    maxCallDepth: number;
    implementationHits: Record<string, number>;
};
export type ExecuteResult = {
    value: RuntimeValue;
    stats: ExecuteStats;
};
export type EvaluateContext = {
    program: IRProgram;
    artifacts?: OptimizeArtifacts;
};
export type ClosedFormMatch = {
    fnName: string;
    implementation: ClosedFormImplementation;
};
export type AitkenMatch = {
    fnName: string;
    implementation: AitkenImplementation;
};
export type LinearSpeculationMatch = {
    fnName: string;
    implementation: LinearSpeculationImplementation;
    candidate: ResearchCandidate;
};
export type TabulatedFunction = {
    fnName: string;
    implementation: LutImplementation;
};
export type GuardEliminationResult = {
    program: IRProgram;
    changed: boolean;
    removedNanToZero: number;
    removedTotalDiv: number;
    removedTotalMod: number;
    usedRangeExprIds: number[];
};
export type RangeAnalysisResult = {
    rangeMap: Map<number, Interval>;
    cardinalityMap: Map<string, CardinalityInfo>;
};
export type ExprMatcher = (expr: IRExpr) => boolean;
//# sourceMappingURL=types.d.ts.map