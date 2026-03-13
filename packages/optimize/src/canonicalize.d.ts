import type { IRProgram } from "@jplmm/ir";
export type CanonicalPass = "total_arithmetic" | "saturating_arithmetic";
export type CanonicalizeStats = {
    totalDivInserted: number;
    totalModInserted: number;
    nanToZeroInserted: number;
    satAddInserted: number;
    satSubInserted: number;
    satMulInserted: number;
    satNegInserted: number;
    zeroDivisorConstantFolded: number;
};
export type CanonicalizeResult = {
    program: IRProgram;
    passOrder: CanonicalPass[];
    stats: CanonicalizeStats;
};
export declare function canonicalizeProgram(program: IRProgram): CanonicalizeResult;
export declare function isNaNlessCanonical(program: IRProgram): boolean;
//# sourceMappingURL=canonicalize.d.ts.map