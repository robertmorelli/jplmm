export type DiagnosticSeverity = "error" | "warning";
export type Diagnostic = {
    message: string;
    start: number;
    end: number;
    severity: DiagnosticSeverity;
    code?: string;
};
export declare class FrontendError extends Error {
    readonly diagnostics: Diagnostic[];
    constructor(diagnostics: Diagnostic[]);
}
export declare function error(message: string, start: number, end: number, code?: string): Diagnostic;
export declare function warning(message: string, start: number, end: number, code?: string): Diagnostic;
export declare function nodeError(node: {
    start?: number;
    end?: number;
} | null | undefined, message: string, code?: string): Diagnostic;
export declare function nodeWarning(node: {
    start?: number;
    end?: number;
} | null | undefined, message: string, code?: string): Diagnostic;
//# sourceMappingURL=errors.d.ts.map