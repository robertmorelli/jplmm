import type { IRProgram } from "@jplmm/ir";
import type { OptimizeArtifacts } from "@jplmm/optimize";
export * from "./native";
export type EmitWatOptions = {
    tailCalls?: boolean;
    artifacts?: OptimizeArtifacts;
    exportFunctions?: boolean;
    exportMemory?: boolean;
};
export type CompileWatOptions = {
    tailCalls?: boolean;
    wat2wasmPath?: string;
};
export type InstantiateWatOptions = CompileWatOptions & {
    imports?: WebAssembly.Imports;
};
export declare function emitWatModule(program: IRProgram, options?: EmitWatOptions): string;
export declare const packageName = "@jplmm/backend";
export declare function compileWatToWasm(wat: string, options?: CompileWatOptions): Uint8Array;
export declare function instantiateWatModule(wat: string, options?: InstantiateWatOptions): Promise<{
    wasm: Uint8Array;
    module: WebAssembly.Module;
    instance: WebAssembly.Instance;
}>;
export declare function compileProgramToInstance(program: IRProgram, options?: EmitWatOptions & InstantiateWatOptions): Promise<{
    wat: string;
    wasm: Uint8Array;
    module: WebAssembly.Module;
    instance: WebAssembly.Instance;
}>;
//# sourceMappingURL=index.d.ts.map