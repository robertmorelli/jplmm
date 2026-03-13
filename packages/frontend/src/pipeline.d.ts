import type { Program } from "@jplmm/ast";
import type { Diagnostic } from "./errors";
export type FrontendResult = {
    program: Program;
    diagnostics: Diagnostic[];
    typeMap: Map<number, import("@jplmm/ast").Type>;
};
export declare function runFrontend(source: string): FrontendResult;
//# sourceMappingURL=pipeline.d.ts.map