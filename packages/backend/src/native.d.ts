import type { IRProgram } from "@jplmm/ir";
import type { OptimizeArtifacts } from "@jplmm/optimize";
export type EmitNativeCOptions = {
    artifacts?: OptimizeArtifacts;
};
export type CompileNativeOptions = EmitNativeCOptions & {
    arch?: "arm64";
    clangPath?: string;
    optLevel?: "O0" | "O1" | "O2" | "O3";
};
export type NativeRunner = {
    executablePath: string;
    source: string;
    sourcePath: string;
    workdir: string;
    cleanup: () => void;
};
export type RunNativeOptions = CompileNativeOptions & {
    iterations?: number;
};
export declare function emitNativeCModule(program: IRProgram, options?: EmitNativeCOptions): string;
export declare function emitNativeRunnerSource(program: IRProgram, fnName: string, options?: EmitNativeCOptions): string;
export declare function compileNativeRunner(source: string, options?: CompileNativeOptions): NativeRunner;
export declare function compileProgramToNativeRunner(program: IRProgram, fnName: string, options?: CompileNativeOptions): NativeRunner;
export declare function runNativeFunction(program: IRProgram, fnName: string, args: number[], options?: RunNativeOptions): NativeRunner & {
    stdout: string;
    value: number;
};
//# sourceMappingURL=native.d.ts.map