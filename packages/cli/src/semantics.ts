import type { WatModuleSemantics } from "@jplmm/backend";
import type { FrontendResult, RefinementReport } from "@jplmm/frontend";
import {
  checkCompilerSemanticsRecord,
  serializeExprSemantics,
  serializeSymValue,
  type CompilerSemanticsCheckRecord,
  type SemanticsCompilerRecord,
  type SerializedIrFunctionAnalysis,
  type SerializedSymValue,
} from "@jplmm/proof";
import type { Z3RunOptions } from "@jplmm/smt";
import type { ProofResult, VerificationFunctionTrace, VerificationOutput } from "@jplmm/verify";
import { analyzeProgramMetrics } from "@jplmm/verify";

export { buildCompilerSemantics } from "@jplmm/proof";
export type { SemanticsCompilerRecord } from "@jplmm/proof";

export const SEMANTICS_DEBUG_SCHEMA_VERSION = 1;

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
  source: SemanticsSourceRecord | null = null,
): SemanticsDebugData {
  const metrics = analyzeProgramMetrics(frontend.program);
  return {
    kind: "jplmm_semantics_debug",
    schemaVersion: SEMANTICS_DEBUG_SCHEMA_VERSION,
    diagnostics: {
      frontend: frontend.diagnostics,
      verification: verification.diagnostics,
    },
    refinements: frontend.refinements.map(serializeRefinement),
    source,
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

export function checkSemanticsDebugDataBundle(
  serialized: string,
  solverOptions: Z3RunOptions = {},
): SemanticsBundleCheckReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    return {
      ok: false,
      compiler: null,
      message: `invalid semantics JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isSemanticsDebugData(parsed) || !parsed.compiler) {
    return {
      ok: false,
      compiler: null,
      message: "semantics bundle does not contain a compiler ladder record",
    };
  }
  if (parsed.schemaVersion !== SEMANTICS_DEBUG_SCHEMA_VERSION) {
    return {
      ok: false,
      compiler: null,
      message: `unsupported semantics bundle schema version ${String(parsed.schemaVersion)}`,
    };
  }
  const compiler = checkCompilerSemanticsRecord(parsed.compiler, solverOptions);
  return {
    ok: compiler.ok,
    compiler,
    message: compiler.ok
      ? "compiler ladder revalidated successfully"
      : "compiler ladder revalidation found mismatches or unproven edges",
  };
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

function isSemanticsDebugData(value: unknown): value is SemanticsDebugData {
  return typeof value === "object"
    && value !== null
    && (value as { kind?: unknown }).kind === "jplmm_semantics_debug"
    && typeof (value as { schemaVersion?: unknown }).schemaVersion === "number";
}
