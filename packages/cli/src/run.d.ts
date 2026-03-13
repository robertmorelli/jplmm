import type { Program, Type } from "@jplmm/ast";
export type ExecutionReport = {
    output: string[];
    wroteFiles: string[];
};
export declare function executeTopLevelProgram(program: Program, typeMap: Map<number, Type>, cwd: string): ExecutionReport;
//# sourceMappingURL=run.d.ts.map