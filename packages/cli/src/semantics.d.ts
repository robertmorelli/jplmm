import type { WatModuleSemantics } from "@jplmm/backend";
import type { FrontendResult, RefinementReport } from "@jplmm/frontend";
import type { IRProgram } from "@jplmm/ir";
import type { ProofResult, VerificationOutput } from "@jplmm/verify";
import { analyzeProgramMetrics } from "@jplmm/verify";
export type SemanticsDebugData = {
    kind: "jplmm_semantics_debug";
    diagnostics: {
        frontend: FrontendResult["diagnostics"];
        verification: VerificationOutput["diagnostics"];
    };
    refinements: SemanticsRefinementRecord[];
    canonicalProgram: VerificationOutput["canonicalProgram"] | null;
    backend: SemanticsBackendRecord | null;
    functions: SemanticsFunctionRecord[];
};
type SemanticsBackendRecord = {
    optimizeSummary: string[];
    implementationSummary: string[];
    optimizedProgram: IRProgram;
    wasm: WatModuleSemantics;
};
type SemanticsRefinementRecord = Omit<RefinementReport, "baselineSemantics" | "refSemantics" | "baselineSemanticsData" | "refSemanticsData"> & {
    baselineSemanticsData: Exclude<RefinementReport["baselineSemanticsData"], undefined> | null;
    refSemanticsData: Exclude<RefinementReport["refSemanticsData"], undefined> | null;
};
type SemanticsFunctionRecord = {
    name: string;
    canonical: VerificationOutput["canonicalProgram"]["functions"][number];
    proof: ProofResult | null;
    metrics: ReturnType<typeof analyzeProgramMetrics> extends Map<string, infer T> ? T | null : never;
    analysis: {
        hasRec: boolean;
        params: Array<{
            name: string;
            value: SerializedSymValue;
        }>;
        statementSemantics: Array<{
            stmtIndex: number;
            stmtTag: string;
            rendered: string;
            value: SerializedSymValue | null;
        }>;
        radSites: Array<{
            stmtIndex: number;
            rendered: string;
            source: unknown;
        }>;
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
        callSigs: Record<string, {
            args: string[];
            ret: string;
        }>;
    };
};
type SerializedSymValue = {
    kind: "scalar";
    expr: unknown;
} | {
    kind: "array";
    array: unknown;
} | {
    kind: "struct";
    typeName: string;
    fields: Array<{
        name: string;
        type: unknown;
        value: SerializedSymValue;
    }>;
} | {
    kind: "void";
    type: unknown;
} | {
    kind: "opaque";
    type: unknown;
    label: string;
};
export declare function buildSemanticsDebugData(frontend: FrontendResult, verification: VerificationOutput, backend?: SemanticsBackendRecord | null): SemanticsDebugData;
export declare function renderSemanticsDebugData(data: SemanticsDebugData): string;
export {};
//# sourceMappingURL=semantics.d.ts.map