import type { Program, Type } from "@jplmm/ast";
import type { Diagnostic } from "./errors";
import { type RefinementReport } from "./refine";
export type FrontendResult = {
    program: Program;
    diagnostics: Diagnostic[];
    typeMap: Map<number, Type>;
    refinements: RefinementReport[];
};
export type FrontendOptions = {
    proofTimeoutMs?: number;
};
export declare function runFrontend(source: string, options?: FrontendOptions): FrontendResult;
//# sourceMappingURL=pipeline.d.ts.map