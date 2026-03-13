import type { IRProgram } from "@jplmm/ir";
import type { GuardEliminationResult } from "./types";
export declare function eliminateGuards(program: IRProgram, rangeMap: Map<number, {
    lo: number;
    hi: number;
}>): GuardEliminationResult;
//# sourceMappingURL=guard_elimination.d.ts.map