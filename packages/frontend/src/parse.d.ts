import type { Program } from "@jplmm/ast";
import { type Diagnostic } from "./errors";
type ParseResult = {
    program: Program;
    diagnostics: Diagnostic[];
};
export declare function parseSource(source: string): ParseResult;
export {};
//# sourceMappingURL=parse.d.ts.map