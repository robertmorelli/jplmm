import { type DisableablePassName } from "@jplmm/optimize";
export type CliMode = "parse" | "typecheck" | "verify" | "optimize" | "wat" | "native" | "run" | "semantics";
export type CliOptions = {
    experimental?: boolean;
    safe?: boolean;
    disablePasses?: DisableablePassName[];
    cwd?: string;
    verifyBeforeRun?: boolean;
    proofTimeoutMs?: number;
};
export type CliReport = {
    mode: CliMode;
    diagnostics: string[];
    proofSummary: string[];
    analysisSummary: string[];
    optimizeSummary: string[];
    implementationSummary: string[];
    semantics: string | undefined;
    wat: string | undefined;
    nativeC: string | undefined;
    output: string[];
    wroteFiles: string[];
    ok: boolean;
};
export declare function runOnSource(source: string, mode: CliMode, options?: CliOptions): CliReport;
export declare function runOnFile(filepath: string, mode: CliMode, options?: CliOptions): CliReport;
export declare function main(argv: string[]): number;
//# sourceMappingURL=index.d.ts.map