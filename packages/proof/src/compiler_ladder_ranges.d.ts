import type { IRProgram } from "@jplmm/ir";
import type { RangeAnalysisResult } from "@jplmm/optimize";
import { type Z3RunOptions } from "@jplmm/smt";
import type { SemanticsCertificateRecord, SemanticsEdgeRecord, SerializedRangeAnalysis } from "./compiler_ladder";
export declare function serializeRangeAnalysis(result: RangeAnalysisResult): SerializedRangeAnalysis;
export declare function deserializeRangeAnalysis(result: SerializedRangeAnalysis): RangeAnalysisResult;
export declare function serializeRangeFacts(program: IRProgram, analysis: RangeAnalysisResult, exprIds: number[]): Array<{
    owner: string;
    exprId: number;
    rendered: string;
    range: {
        lo: number;
        hi: number;
    } | null;
}>;
export declare function buildCanonicalRangeSoundnessEdgeRecord(program: IRProgram, analysis: RangeAnalysisResult, exprIds: number[], solverOptions: Z3RunOptions, certificate?: SemanticsCertificateRecord | null): SemanticsEdgeRecord;
//# sourceMappingURL=compiler_ladder_ranges.d.ts.map