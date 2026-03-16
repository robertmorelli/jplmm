import { type Cmd, type Program, type Type } from "@jplmm/ast";
export type ExecutionReport = {
    output: string[];
    wroteFiles: string[];
};
export type TopLevelCommandTrace = {
    id: number;
    tag: Cmd["tag"] | "implicit_main";
    rendered: string;
    effect: string;
    outputDelta: string[];
    wroteFilesDelta: string[];
};
export type TopLevelExecutionTrace = {
    usedImplicitMain: boolean;
    implicitMainName: string | null;
    commands: TopLevelCommandTrace[];
    finalOutput: string[];
    wroteFiles: string[];
};
export declare function executeTopLevelProgram(program: Program, typeMap: Map<number, Type>, cwd: string): ExecutionReport;
export declare function traceTopLevelProgram(program: Program, typeMap: Map<number, Type>, cwd: string): TopLevelExecutionTrace;
//# sourceMappingURL=run.d.ts.map