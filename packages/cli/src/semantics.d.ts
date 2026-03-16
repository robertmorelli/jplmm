import type { WatModuleSemantics } from "@jplmm/backend";
import type { FrontendResult, RefinementReport } from "@jplmm/frontend";
import { type CompilerSemanticsCheckRecord, type SemanticsCompilerRecord, type SerializedIrFunctionAnalysis, type SerializedSymValue } from "@jplmm/proof";
import type { Z3RunOptions } from "@jplmm/smt";
import type { ProofResult, VerificationOutput } from "@jplmm/verify";
import { analyzeProgramMetrics } from "@jplmm/verify";
export { buildCompilerSemantics } from "@jplmm/proof";
export type { SemanticsCompilerRecord } from "@jplmm/proof";
export declare const SEMANTICS_DEBUG_SCHEMA_VERSION = 1;
export type SemanticsDebugData = {
    kind: "jplmm_semantics_debug";
    schemaVersion: typeof SEMANTICS_DEBUG_SCHEMA_VERSION;
    diagnostics: {
        frontend: FrontendResult["diagnostics"];
        verification: VerificationOutput["diagnostics"];
    };
    refinements: SemanticsRefinementRecord[];
    source: SemanticsSourceRecord | null;
    canonicalProgram: VerificationOutput["canonicalProgram"] | null;
    compiler: SemanticsCompilerRecord | null;
    backend: SemanticsBackendRecord | null;
    functions: SemanticsFunctionRecord[];
};
export type SemanticsBackendRecord = {
    optimizeSummary: string[];
    implementationSummary: string[];
    optimizedProgram: VerificationOutput["canonicalProgram"];
    wasm: WatModuleSemantics;
};
export type SemanticsBundleCheckReport = {
    ok: boolean;
    compiler: CompilerSemanticsCheckRecord | null;
    message: string;
};
export type SemanticsSourceRecord = {
    usedImplicitMain: boolean;
    implicitMainName: string | null;
    commands: Array<{
        id: number;
        tag: string;
        rendered: string;
        effect: string;
        outputDelta: string[];
        wroteFilesDelta: string[];
    }>;
    finalOutput: string[];
    wroteFiles: string[];
};
type SemanticsCompilerOrNull = SemanticsCompilerRecord | null;
type SemanticsRefinementRecord = Omit<RefinementReport, "baselineSemantics" | "refSemantics" | "baselineSemanticsData" | "refSemanticsData"> & {
    baselineSemanticsData: Exclude<RefinementReport["baselineSemanticsData"], undefined> | null;
    refSemanticsData: Exclude<RefinementReport["refSemanticsData"], undefined> | null;
};
type SemanticsFunctionRecord = {
    name: string;
    canonical: VerificationOutput["canonicalProgram"]["functions"][number];
    proof: ProofResult | null;
    metrics: ReturnType<typeof analyzeProgramMetrics> extends Map<string, infer T> ? T | null : never;
    analysis: SerializedVerificationAnalysis;
};
type SerializedVerificationAnalysis = Omit<SerializedIrFunctionAnalysis, "recSites"> & {
    recSites: Array<{
        stmtIndex: number;
        args: unknown[];
        argValues: Array<{
            index: number;
            value: SerializedSymValue;
        }>;
        issues: string[];
        obligations: Array<{
            rad: string;
            structural: {
                ok: boolean;
                reason: string;
            };
            smt: {
                ok: true;
                method: "smt";
                details: string;
            } | {
                ok: false;
                reasons: string[];
            };
        }>;
    }>;
};
export declare function buildSemanticsDebugData(frontend: FrontendResult, verification: VerificationOutput, backend?: SemanticsBackendRecord | null, compiler?: SemanticsCompilerOrNull, source?: SemanticsSourceRecord | null): SemanticsDebugData;
export declare function renderSemanticsDebugData(data: SemanticsDebugData): string;
export declare function checkSemanticsDebugDataBundle(serialized: string, solverOptions?: Z3RunOptions): SemanticsBundleCheckReport;
//# sourceMappingURL=semantics.d.ts.map