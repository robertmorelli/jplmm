import { type Type } from "@jplmm/ast";
import type { IRExpr, IRProgram, IRStmt } from "@jplmm/ir";
import type { LutImplementation, OptimizeArtifacts } from "@jplmm/optimize";
export * from "./native";
export type EmitWatOptions = {
    tailCalls?: boolean;
    artifacts?: OptimizeArtifacts;
    exportFunctions?: boolean;
    exportMemory?: boolean;
    moduleComments?: string[];
};
export type WatImplementationTag = "plain" | "closed_form_linear_countdown" | "lut" | "aitken_scalar_tail" | "linear_speculation";
export type WatHelperSemantic = {
    name: string;
    semantics: string;
};
export type WatExprSemantics = {
    tag: IRExpr["tag"];
    resultType: Type;
    lowering: {
        kind: string;
        semantics: string;
        helper: string | null;
        helpers: string[];
        rawOps: string[];
        notes: string[];
    };
    children: WatExprSemantics[];
};
export type WatStmtSemantics = {
    stmtIndex: number;
    tag: IRStmt["tag"];
    lowering: string;
    target: string | null;
    expr: WatExprSemantics | null;
};
export type WatRecursionSemantics = {
    hasTailRec: boolean;
    hasNonTailRec: boolean;
    tailStrategy: "none" | "return_call" | "loop_branch";
    fuel: {
        kind: "none" | "local" | "param";
        limit: number | null;
    };
    collapse: Array<{
        param: string;
        type: Type;
        equality: string;
        helper: string | null;
    }>;
    aitken: boolean;
};
export type WatFallbackSemantics = {
    wasmName: string;
    helpers: WatHelperSemantic[];
    recursion: WatRecursionSemantics;
    statements: WatStmtSemantics[];
};
export type WatFunctionSemantics = {
    name: string;
    entryWasmName: string;
    bodyWasmName: string;
    exportName: string | null;
    implementation: {
        tag: WatImplementationTag;
        loweredAs: "plain" | "gas_tail_wrapper" | "closed_form" | "lut_wrapper";
        fallbackWasmName: string | null;
        notes: string[];
    };
    helpers: WatHelperSemantic[];
    recursion: WatRecursionSemantics;
    statements: WatStmtSemantics[];
    fallback: WatFallbackSemantics | null;
};
export type WatModuleSemantics = {
    kind: "jplmm_wasm_semantics";
    options: {
        tailCalls: boolean;
        exportFunctions: boolean;
        exportMemory: boolean;
    };
    memory: {
        heapBase: number;
        initialPages: number;
        luts: Array<{
            fnName: string;
            offset: number;
            cells: number;
            resultType: Type;
            parameterRanges: LutImplementation["parameterRanges"];
        }>;
    };
    helperSemantics: Record<string, string>;
    functions: WatFunctionSemantics[];
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
export declare function buildWatSemantics(program: IRProgram, options?: EmitWatOptions): WatModuleSemantics;
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