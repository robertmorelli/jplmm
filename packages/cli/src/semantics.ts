import type { WatModuleSemantics } from "@jplmm/backend";
import type { FrontendResult, RefinementReport } from "@jplmm/frontend";
import {
  serializeExprSemantics,
  serializeSymValue,
  type SemanticsCompilerRecord,
  type SerializedIrFunctionAnalysis,
  type SerializedSymValue,
} from "@jplmm/proof";
import type { ProofResult, VerificationFunctionTrace, VerificationOutput } from "@jplmm/verify";
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

type SemanticsRefinementRecord = Omit<
  RefinementReport,
  "baselineSemantics" | "refSemantics" | "baselineSemanticsData" | "refSemanticsData"
> & {
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
      structural: { ok: boolean; reason: string };
      smt:
        | { ok: true; method: "smt"; details: string }
        | { ok: false; reasons: string[] };
    }>;
  }>;
};

export function buildSemanticsDebugData(
  frontend: FrontendResult,
  verification: VerificationOutput,
  backend: SemanticsBackendRecord | null = null,
  compiler: SemanticsCompilerOrNull = null,
): SemanticsDebugData {
  const metrics = analyzeProgramMetrics(frontend.program);
  return {
    kind: "jplmm_semantics_debug",
    diagnostics: {
      frontend: frontend.diagnostics,
      verification: verification.diagnostics,
    },
    refinements: frontend.refinements.map(serializeRefinement),
    canonicalProgram: verification.canonicalProgram ?? null,
    compiler,
    backend,
    functions: verification.canonicalProgram.functions.map((fn) => {
      const trace = verification.traceMap.get(fn.name);
      return {
        name: fn.name,
        canonical: fn,
        proof: verification.proofMap.get(fn.name) ?? null,
        metrics: metrics.get(fn.name) ?? null,
        analysis: serializeVerificationAnalysis(trace),
      };
    }),
  };
}

export function renderSemanticsDebugData(data: SemanticsDebugData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function serializeRefinement(refinement: RefinementReport): SemanticsRefinementRecord {
  const {
    baselineSemantics: _baselineSemantics,
    refSemantics: _refSemantics,
    baselineSemanticsData,
    refSemanticsData,
    ...rest
  } = refinement;
  return {
    ...rest,
    baselineSemanticsData: baselineSemanticsData ?? null,
    refSemanticsData: refSemanticsData ?? null,
  };
}

function serializeVerificationAnalysis(
  trace: VerificationFunctionTrace | null | undefined,
): SerializedVerificationAnalysis {
  return {
    hasRec: trace?.hasRec ?? false,
    params: [...(trace?.paramValues ?? new Map()).entries()].map(([name, value]) => ({
      name,
      value: serializeSymValue(value),
    })),
    exprSemantics: serializeExprSemantics(
      trace?.canonical.body.filter((stmt) => stmt.tag !== "gas").map((stmt) => stmt.expr) ?? [],
      trace?.exprSemantics ?? new Map(),
    ),
    statementSemantics: (trace?.stmtSemantics ?? []).map((entry) => ({
      stmtIndex: entry.stmtIndex,
      stmtTag: entry.stmtTag,
      rendered: entry.rendered,
      value: entry.value ? serializeSymValue(entry.value) : null,
    })),
    radSites: (trace?.radSites ?? []).map((rad) => ({
      stmtIndex: rad.stmtIndex,
      rendered: rad.rendered,
      source: rad.source,
    })),
    recSites: (trace?.proofSites ?? []).map((siteTrace) => ({
      stmtIndex: siteTrace.site.stmtIndex,
      args: siteTrace.site.args,
      argValues: [...siteTrace.site.argValues.entries()].map(([index, value]) => ({
        index,
        value: serializeSymValue(value),
      })),
      issues: [...siteTrace.site.issues],
      obligations: siteTrace.obligations.map((obligation) => ({
        rad: obligation.rad.rendered,
        structural: obligation.structural,
        smt: obligation.smt ?? {
          ok: true as const,
          method: "smt" as const,
          details: "not needed because structural proof succeeded",
        },
      })),
    })),
    callSigs: Object.fromEntries(
      [...(trace?.callSigs ?? new Map()).entries()].map(([name, sig]) => [
        name,
        {
          args: [...sig.args],
          ret: sig.ret,
        },
      ]),
    ),
  };
}
