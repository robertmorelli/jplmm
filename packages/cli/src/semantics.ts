import type { WatModuleSemantics } from "@jplmm/backend";
import type { FrontendResult, RefinementReport } from "@jplmm/frontend";
import type { IRProgram } from "@jplmm/ir";
import type { SymValue } from "@jplmm/proof";
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
        structural: { ok: boolean; reason: string };
        smt:
          | { ok: true; method: "smt"; details: string }
          | { ok: false; reasons: string[] };
      }>;
    }>;
    callSigs: Record<string, { args: string[]; ret: string }>;
  };
};

type SerializedSymValue =
  | { kind: "scalar"; expr: unknown }
  | { kind: "array"; array: unknown }
  | { kind: "struct"; typeName: string; fields: Array<{ name: string; type: unknown; value: SerializedSymValue }> }
  | { kind: "void"; type: unknown }
  | { kind: "opaque"; type: unknown; label: string };

export function buildSemanticsDebugData(
  frontend: FrontendResult,
  verification: VerificationOutput,
  backend: SemanticsBackendRecord | null = null,
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
    backend,
    functions: verification.canonicalProgram.functions.map((fn) => {
      const trace = verification.traceMap.get(fn.name);
      return {
        name: fn.name,
        canonical: fn,
        proof: verification.proofMap.get(fn.name) ?? null,
        metrics: metrics.get(fn.name) ?? null,
        analysis: {
          hasRec: trace?.hasRec ?? false,
          params: [...(trace?.paramValues ?? new Map()).entries()].map(([name, value]) => ({
            name,
            value: serializeSymValue(value),
          })),
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
            obligations: siteTrace.obligations.map((obligation) => {
              const smt = obligation.smt ?? {
                ok: true as const,
                method: "smt" as const,
                details: "not needed because structural proof succeeded",
              };
              return {
                rad: obligation.rad.rendered,
                structural: obligation.structural,
                smt,
              };
            }),
          })),
          callSigs: Object.fromEntries(
            [...(trace?.callSigs ?? new Map()).entries()].map(([name, sig]) => [
              name,
              {
                args: sig.args,
                ret: sig.ret,
              },
            ]),
          ),
        },
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

function serializeSymValue(value: SymValue): SerializedSymValue {
  switch (value.kind) {
    case "scalar":
      return { kind: "scalar", expr: value.expr };
    case "array":
      return { kind: "array", array: value.array };
    case "struct":
      return {
        kind: "struct",
        typeName: value.typeName,
        fields: value.fields.map((field) => ({
          name: field.name,
          type: field.type,
          value: serializeSymValue(field.value),
        })),
      };
    case "void":
      return { kind: "void", type: value.type };
    case "opaque":
      return { kind: "opaque", type: value.type, label: value.label };
    default: {
      const _never: never = value;
      return _never;
    }
  }
}
