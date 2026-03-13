import type { Program } from "@jplmm/ast";
export type FunctionMetrics = {
    sourceComplexity: number;
    recSites: number;
    canonicalWitness: string;
    coarseTotalCallBound: string;
};
export declare function analyzeProgramMetrics(program: Program): Map<string, FunctionMetrics>;
//# sourceMappingURL=metrics.d.ts.map