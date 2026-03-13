export type CliMode = "parse" | "typecheck" | "verify" | "optimize" | "wat";
export type CliOptions = {
    experimental?: boolean;
};
export type CliReport = {
    mode: CliMode;
    diagnostics: string[];
    proofSummary: string[];
    optimizeSummary: string[];
    implementationSummary: string[];
    wat: string | undefined;
    ok: boolean;
};
export declare function runOnSource(source: string, mode: CliMode, options?: CliOptions): CliReport;
export declare function runOnFile(filepath: string, mode: CliMode, options?: CliOptions): CliReport;
export declare function main(argv: string[]): number;
//# sourceMappingURL=index.d.ts.map