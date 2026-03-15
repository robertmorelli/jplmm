import type { WatModuleSemantics } from "@jplmm/backend";
import type { FrontendResult, RefinementReport } from "@jplmm/frontend";
import { type SemanticsCompilerRecord, type SerializedIrFunctionAnalysis, type SerializedSymValue } from "@jplmm/proof";
import type { ProofResult, VerificationOutput } from "@jplmm/verify";
import { analyzeProgramMetrics } from "@jplmm/verify";
export { buildCompilerSemantics } from "@jplmm/proof";
export type { SemanticsCompilerRecord } from "@jplmm/proof";
export type SemanticsDebugData = {
    kind: "jplmm_semantics_debug";
    diagnostics: {
        frontend: FrontendResult["diagnostics"];
        verification: VerificationOutput["diagnostics"];
    };
    refinements: SemanticsRefinementRecord[];
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
export declare function buildSemanticsDebugData(frontend: FrontendResult, verification: VerificationOutput, backend?: SemanticsBackendRecord | null, compiler?: SemanticsCompilerOrNull): SemanticsDebugData;
export declare function renderSemanticsDebugData(data: SemanticsDebugData): string;
//# sourceMappingURL=semantics.d.ts.map