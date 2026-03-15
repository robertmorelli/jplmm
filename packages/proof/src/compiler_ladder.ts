import type { Type } from "@jplmm/ast";
import type { IRExpr, IRFunction, IRProgram } from "@jplmm/ir";
import {
  executeProgram,
  isNaNlessCanonical,
  matchClosedForms,
  serializeExprProvenance,
  type ClosedFormImplementation,
  type OptimizeResult,
  type RangeAnalysisResult,
  type SerializedExprProvenance,
} from "@jplmm/optimize";
import {
  INT32_MAX,
  INT32_MIN,
  buildJplScalarPrelude,
  checkSat,
  sanitizeSymbol as sanitize,
  withHardTimeout,
  type Z3RunOptions,
} from "@jplmm/smt";
import {
  analyzeIrGlobals,
  analyzeIrFunction,
  buildIrCallSummaries,
  hasRec,
  renderIrExpr,
  renderIrFunction,
} from "./ir";
import { checkIrFunctionRefinement } from "./refinement";
import {
  appendScalarTypeConstraints,
  appendSmtEncodingState,
  buildComparisonEnvFromParams,
  canEncodeScalarExprWithSmt,
  collectValueVars,
  createSmtEncodingState,
  emitScalarWithOverrides,
  normalizeValueForComparison,
  scalarExprType,
  type ScalarExpr,
  type SymValue,
} from "./scalar";

export type SemanticsCompilerRecord = {
  floors: {
    raw: SemanticsIrFloorRecord;
    canonical: SemanticsIrFloorRecord;
    guardElided: SemanticsIrFloorRecord;
    finalOptimized: SemanticsIrFloorRecord;
    closedFormImpl: SemanticsIrFloorRecord | null;
  };
  implementationFloors: {
    lut: SemanticsLutFloorRecord | null;
  };
  analyses: {
    canonicalRanges: SerializedRangeAnalysis;
    finalRanges: SerializedRangeAnalysis;
    provenance: {
      rawToCanonical: SerializedExprProvenance;
      canonicalToGuardElided: SerializedExprProvenance;
      guardElidedToFinalOptimized: SerializedExprProvenance;
    };
    guardConsumedExprIds: number[];
    canonicalConsumedRangeFacts: Array<{
      owner: string;
      exprId: number;
      rendered: string;
      range: { lo: number; hi: number } | null;
    }>;
    implementations: Array<{
      fnName: string;
      implementation: OptimizeResult["artifacts"]["implementations"] extends Map<string, infer T> ? T : never;
    }>;
    reports: OptimizeResult["reports"];
  };
  edges: SemanticsEdgeRecord[];
};

export type SemanticsIrFloorRecord = {
  label: "raw_ir" | "canonical_ir" | "guard_elided_ir" | "final_optimized_ir" | "closed_form_impl_ir";
  program: IRProgram;
  globals: Array<{
    name: string;
    rendered: string;
    value: SerializedSymValue | null;
    exprSemantics: Array<{
      exprId: number;
      rendered: string;
      value: SerializedSymValue | null;
    }>;
  }>;
  functions: Array<{
    name: string;
    rendered: string[];
    result: SerializedSymValue | null;
    analysis: SerializedIrFunctionAnalysis;
  }>;
};

export type SemanticsLutFloorRecord = {
  label: "lut_impl_semantics";
  functions: Array<{
    name: string;
    parameterRanges: Array<{ lo: number; hi: number }>;
    table: number[];
    resultType: Type;
    fallback: "final_optimized_ir";
    semantics: string[];
  }>;
};

export type SemanticsEdgeRecord = {
  from: SemanticsIrFloorRecord["label"] | SemanticsLutFloorRecord["label"] | "canonical_range_facts";
  to: SemanticsIrFloorRecord["label"] | SemanticsLutFloorRecord["label"] | "canonical_range_facts";
  kind: "ir_refinement" | "implementation_refinement" | "analysis_soundness";
  certificate: SemanticsCertificateRecord | null;
  ok: boolean;
  summary: {
    equivalent: number;
    mismatch: number;
    unproven: number;
  };
  functions: Array<{
    name: string;
    status: "equivalent" | "mismatch" | "unproven";
    method?: string;
    detail: string;
    equivalence?: string;
  }>;
};

type SemanticsCertificateValidation = {
  ok: boolean;
  detail: string;
};

export type SemanticsCertificateRecord =
  | {
      kind: "canonicalize";
      passOrder: OptimizeResult["stages"]["canonical"]["passOrder"];
      stats: OptimizeResult["stages"]["canonical"]["stats"];
      validation: SemanticsCertificateValidation & {
        derived: {
          totalDivInserted: number;
          totalModInserted: number;
          nanToZeroInserted: number;
          satAddInserted: number;
          satSubInserted: number;
          satMulInserted: number;
          satNegInserted: number;
          zeroDivisorConstantFolded: number;
        };
        targetCanonical: boolean;
      };
    }
  | {
      kind: "range_analysis";
      consumedExprIds: number[];
      validation: SemanticsCertificateValidation & {
        attachedExprIds: number[];
        missingExprIds: number[];
      };
    }
  | {
      kind: "guard_elimination";
      usedRangeExprIds: number[];
      removed: {
        nanToZero: number;
        totalDiv: number;
        totalMod: number;
      };
      validation: SemanticsCertificateValidation & {
        derivedRemoved: {
          nanToZero: number;
          totalDiv: number;
          totalMod: number;
        };
        missingExprIds: number[];
      };
    }
  | {
      kind: "identity";
      reason: string;
      validation: SemanticsCertificateValidation;
    }
  | {
      kind: "closed_form";
      matches: Array<{
        fnName: string;
        implementation: ClosedFormImplementation;
        assumptions: string[];
      }>;
      validation: SemanticsCertificateValidation & {
        unmatched: string[];
      };
    }
  | {
      kind: "lut";
      entries: Array<{
        fnName: string;
        parameterRanges: Array<{ lo: number; hi: number }>;
        tableLength: number;
        fallback: "final_optimized_ir";
      }>;
      validation: SemanticsCertificateValidation & {
        invalidEntries: string[];
      };
    };

export type SerializedIrFunctionAnalysis = {
  hasRec: boolean;
  params: Array<{
    name: string;
    value: SerializedSymValue;
  }>;
  exprSemantics: Array<{
    exprId: number;
    rendered: string;
    value: SerializedSymValue | null;
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
  }>;
  callSigs: Record<string, { args: string[]; ret: string }>;
};

export type SerializedRangeAnalysis = {
  exprRanges: Record<string, { lo: number; hi: number }>;
  cardinalities: Record<string, { parameterRanges: Array<{ lo: number; hi: number }>; cardinality: number | "inf" }>;
};

export type SerializedSymValue =
  | { kind: "scalar"; expr: unknown }
  | { kind: "array"; array: unknown }
  | { kind: "struct"; typeName: string; fields: Array<{ name: string; type: unknown; value: SerializedSymValue }> }
  | { kind: "void"; type: unknown }
  | { kind: "opaque"; type: unknown; label: string };

export function buildCompilerSemantics(
  rawProgram: IRProgram,
  optimized: OptimizeResult,
  solverOptions: Z3RunOptions = {},
): SemanticsCompilerRecord {
  const raw = buildIrFloorRecord("raw_ir", rawProgram, "raw_");
  const canonical = buildIrFloorRecord("canonical_ir", optimized.stages.canonical.program, "canonical_");
  const guardElided = buildIrFloorRecord("guard_elided_ir", optimized.stages.guardElided.program, "guard_");
  const finalOptimized = buildIrFloorRecord("final_optimized_ir", optimized.program, "final_");
  const closedFormProgram = buildClosedFormImplementationProgram(optimized.program, optimized.artifacts.implementations);
  const closedFormImpl = closedFormProgram
    ? buildIrFloorRecord("closed_form_impl_ir", closedFormProgram, "closed_form_")
    : null;
  const closedFormOverrides = buildClosedFormEdgeOverrides(optimized.program, optimized.artifacts.implementations);
  const canonicalizeCertificate = validateCanonicalizeCertificate(
    rawProgram,
    optimized.stages.canonical.program,
    optimized.certificates.canonicalize,
  );
  const rangeCertificate = validateRangeAnalysisCertificate(
    optimized.stages.canonical.program,
    optimized.certificates.rangeAnalysis,
  );
  const guardCertificate = validateGuardEliminationCertificate(
    optimized.stages.canonical.program,
    optimized.stages.guardElided.program,
    optimized.certificates.guardElimination,
  );
  const closedFormCertificate = validateClosedFormCertificate(optimized.program, optimized.certificates.closedForm);
  const lutImpl = buildLutImplementationFloor(optimized.artifacts.implementations);
  const lutCertificate = validateLutCertificate(optimized.certificates.lut);
  const lutEdge = buildLutImplementationEdgeRecord(
    optimized.program,
    optimized.artifacts.implementations,
    lutCertificate,
  );

  return {
    floors: {
      raw,
      canonical,
      guardElided,
      finalOptimized,
      closedFormImpl,
    },
    implementationFloors: {
      lut: lutImpl,
    },
    analyses: {
      canonicalRanges: serializeRangeAnalysis(optimized.stages.canonicalRanges),
      finalRanges: serializeRangeAnalysis(optimized.stages.finalRanges),
      provenance: {
        rawToCanonical: serializeExprProvenance(optimized.provenance.rawToCanonical),
        canonicalToGuardElided: serializeExprProvenance(optimized.provenance.canonicalToGuardElided),
        guardElidedToFinalOptimized: serializeExprProvenance(optimized.provenance.guardElidedToFinalOptimized),
      },
      guardConsumedExprIds: [...optimized.stages.guardElided.usedRangeExprIds],
      canonicalConsumedRangeFacts: serializeConsumedRangeFacts(
        optimized.stages.canonical.program,
        optimized.stages.canonicalRanges,
        optimized.stages.guardElided.usedRangeExprIds,
      ),
      implementations: [...optimized.artifacts.implementations.entries()].map(([fnName, implementation]) => ({
        fnName,
        implementation,
      })),
      reports: optimized.reports,
    },
    edges: [
      buildIrEdgeRecord(
        "raw_ir",
        "canonical_ir",
        rawProgram,
        optimized.stages.canonical.program,
        solverOptions,
        new Map(),
        canonicalizeCertificate,
      ),
      buildCanonicalRangeSoundnessEdgeRecord(
        optimized.stages.canonical.program,
        optimized.stages.canonicalRanges,
        optimized.stages.guardElided.usedRangeExprIds,
        solverOptions,
        rangeCertificate,
      ),
      buildIrEdgeRecord(
        "canonical_ir",
        "guard_elided_ir",
        optimized.stages.canonical.program,
        optimized.stages.guardElided.program,
        solverOptions,
        new Map(),
        guardCertificate,
      ),
      buildIrEdgeRecord(
        "guard_elided_ir",
        "final_optimized_ir",
        optimized.stages.guardElided.program,
        optimized.program,
        solverOptions,
        new Map(),
        validateIdentityCertificate(optimized.certificates.finalIdentity),
      ),
      ...(closedFormProgram
        ? [buildIrEdgeRecord(
            "final_optimized_ir",
            "closed_form_impl_ir",
            optimized.program,
            closedFormProgram,
            solverOptions,
            closedFormOverrides,
            closedFormCertificate,
          )]
        : []),
      ...(lutEdge ? [lutEdge] : []),
    ],
  };
}

export function serializeRangeAnalysis(result: RangeAnalysisResult): SerializedRangeAnalysis {
  return {
    exprRanges: Object.fromEntries(
      [...result.rangeMap.entries()]
        .sort(([left], [right]) => left - right)
        .map(([id, range]) => [String(id), range]),
    ),
    cardinalities: Object.fromEntries(
      [...result.cardinalityMap.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fnName, info]) => [
          fnName,
          {
            parameterRanges: info.parameterRanges,
            cardinality: info.cardinality,
          },
        ]),
    ),
  };
}

export function serializePlainIrAnalysis(
  trace:
    | {
        hasRec: boolean;
        paramValues: Map<string, SymValue>;
        exprSemantics: Map<number, SymValue>;
        result: SymValue | null;
        stmtSemantics: Array<{
          stmtIndex: number;
          stmtTag: string;
          rendered: string;
          value: SymValue | null;
        }>;
        radSites: Array<{
          stmtIndex: number;
          rendered: string;
          source: unknown;
        }>;
        recSites: Array<{
          stmtIndex: number;
          args: unknown[];
          argValues: Map<number, SymValue>;
          issues: string[];
        }>;
        callSigs: Map<string, { args: string[]; ret: string } | { args: Array<"int" | "float">; ret: "int" | "float" }>;
      }
    | null
    | undefined,
  exprRoots: IRExpr[] = [],
): SerializedIrFunctionAnalysis {
  return {
    hasRec: trace?.hasRec ?? false,
    params: [...(trace?.paramValues ?? new Map()).entries()].map(([name, value]) => ({
      name,
      value: serializeSymValue(value),
    })),
    exprSemantics: serializeExprSemantics(exprRoots, trace?.exprSemantics ?? new Map()),
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
    recSites: (trace?.recSites ?? []).map((site) => ({
      stmtIndex: site.stmtIndex,
      args: site.args,
      argValues: [...site.argValues.entries()].map(([index, value]) => ({
        index,
        value: serializeSymValue(value),
      })),
      issues: [...site.issues],
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

export function serializeSymValue(value: SymValue): SerializedSymValue {
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

export function serializeOptionalSymValue(value: SymValue | undefined): SerializedSymValue | null {
  return value ? serializeSymValue(value) : null;
}

export function serializeExprSemantics(
  roots: IRExpr[],
  exprSemantics: Map<number, SymValue>,
): Array<{
  exprId: number;
  rendered: string;
  value: SerializedSymValue | null;
}> {
  const orderedExprs = new Map<number, IRExpr>();
  for (const root of roots) {
    collectExprNodes(root, orderedExprs);
  }
  if (orderedExprs.size === 0) {
    return [...exprSemantics.entries()]
      .sort(([left], [right]) => left - right)
      .map(([exprId, value]) => ({
        exprId,
        rendered: `<expr #${exprId}>`,
        value: serializeSymValue(value),
      }));
  }
  return [...orderedExprs.values()].map((expr) => ({
    exprId: expr.id,
    rendered: renderIrExpr(expr),
    value: serializeOptionalSymValue(exprSemantics.get(expr.id)),
  }));
}

function buildIrFloorRecord(
  label: SemanticsIrFloorRecord["label"],
  program: IRProgram,
  symbolPrefix: string,
): SemanticsIrFloorRecord {
  const structDefs = new Map(program.structs.map((struct) => [struct.name, struct.fields] as const));
  const callSummaries = buildIrCallSummaries(program, structDefs, `${symbolPrefix}call_`);
  const globalAnalysis = analyzeIrGlobals(program, structDefs, `${symbolPrefix}globals_`, { callSummaries });
  return {
    label,
    program,
    globals: program.globals.map((global) => ({
      name: global.name,
      rendered: renderIrExpr(global.expr),
      value: serializeOptionalSymValue(globalAnalysis.values.get(global.name)),
      exprSemantics: serializeExprSemantics([global.expr], globalAnalysis.exprSemantics),
    })),
    functions: program.functions.map((fn) => {
      const analysis = analyzeIrFunction(fn, structDefs, `${symbolPrefix}${fn.name}_`, { callSummaries });
      return {
        name: fn.name,
        rendered: renderIrFunction(fn),
        result: analysis.result ? serializeSymValue(analysis.result) : null,
        analysis: serializePlainIrAnalysis(
          {
            ...analysis,
            hasRec: hasRec(fn),
          },
          fn.body.filter((stmt) => stmt.tag !== "gas").map((stmt) => stmt.expr),
        ),
      };
    }),
  };
}

function buildIrEdgeRecord(
  from: SemanticsIrFloorRecord["label"],
  to: SemanticsIrFloorRecord["label"],
  baselineProgram: IRProgram,
  refinedProgram: IRProgram,
  solverOptions: Z3RunOptions,
  overrides: Map<string, {
    status: "equivalent";
    method: string;
    detail: string;
    equivalence?: string;
  }> = new Map(),
  certificate: SemanticsCertificateRecord | null = null,
): SemanticsEdgeRecord {
  const names = [...new Set([
    ...baselineProgram.functions.map((fn) => fn.name),
    ...refinedProgram.functions.map((fn) => fn.name),
  ])].sort((left, right) => left.localeCompare(right));
  const functions = names.map((name) => {
    const override = overrides.get(name);
    if (override) {
      return {
        name,
        status: "equivalent" as const,
        method: override.method,
        detail: override.detail,
        ...(override.equivalence ? { equivalence: override.equivalence } : {}),
      };
    }
    const check = checkIrFunctionRefinement(name, baselineProgram, refinedProgram, solverOptions, `${from}->${to}`);
    if (check.ok) {
      return {
        name,
        status: "equivalent" as const,
        method: check.method,
        detail: check.detail,
        ...(check.equivalence ? { equivalence: check.equivalence } : {}),
      };
    }
    return {
      name,
      status: check.code === "REF_MISMATCH" ? "mismatch" as const : "unproven" as const,
      detail: check.message,
    };
  });

  const summary = functions.reduce(
    (current, fn) => ({
      equivalent: current.equivalent + (fn.status === "equivalent" ? 1 : 0),
      mismatch: current.mismatch + (fn.status === "mismatch" ? 1 : 0),
      unproven: current.unproven + (fn.status === "unproven" ? 1 : 0),
    }),
    { equivalent: 0, mismatch: 0, unproven: 0 },
  );

  return {
    from,
    to,
    kind: "ir_refinement",
    certificate,
    ok: summary.mismatch === 0 && summary.unproven === 0,
    summary,
    functions,
  };
}

type IrOpCounts = {
  totalDiv: number;
  totalMod: number;
  nanToZero: number;
  satAdd: number;
  satSub: number;
  satMul: number;
  satNeg: number;
  zeroDivisorBinops: number;
};

function validateCanonicalizeCertificate(
  rawProgram: IRProgram,
  canonicalProgram: IRProgram,
  certificate: OptimizeResult["certificates"]["canonicalize"],
): SemanticsCertificateRecord {
  const rawCounts = countProgramOps(rawProgram);
  const canonicalCounts = countProgramOps(canonicalProgram);
  const derived = {
    totalDivInserted: canonicalCounts.totalDiv - rawCounts.totalDiv,
    totalModInserted: canonicalCounts.totalMod - rawCounts.totalMod,
    nanToZeroInserted: canonicalCounts.nanToZero - rawCounts.nanToZero,
    satAddInserted: canonicalCounts.satAdd - rawCounts.satAdd,
    satSubInserted: canonicalCounts.satSub - rawCounts.satSub,
    satMulInserted: canonicalCounts.satMul - rawCounts.satMul,
    satNegInserted: canonicalCounts.satNeg - rawCounts.satNeg,
    zeroDivisorConstantFolded: rawCounts.zeroDivisorBinops,
  };
  const stats = certificate.stats;
  const targetCanonical = isNaNlessCanonical(canonicalProgram);
  const statsMatch =
    derived.totalDivInserted === stats.totalDivInserted &&
    derived.totalModInserted === stats.totalModInserted &&
    derived.nanToZeroInserted === stats.nanToZeroInserted &&
    derived.satAddInserted === stats.satAddInserted &&
    derived.satSubInserted === stats.satSubInserted &&
    derived.satMulInserted === stats.satMulInserted &&
    derived.satNegInserted === stats.satNegInserted &&
    derived.zeroDivisorConstantFolded === stats.zeroDivisorConstantFolded;
  return {
    kind: "canonicalize",
    passOrder: certificate.passOrder,
    stats,
    validation: {
      ok: targetCanonical && statsMatch,
      detail: targetCanonical && statsMatch
        ? "target program satisfies canonical total/saturating form and derived rewrite counts match the emitted stats"
        : !targetCanonical
          ? "target program is not in the expected canonical total/saturating form"
          : "derived rewrite counts do not match the emitted canonicalization stats",
      derived,
      targetCanonical,
    },
  };
}

function validateRangeAnalysisCertificate(
  program: IRProgram,
  certificate: OptimizeResult["certificates"]["rangeAnalysis"],
): SemanticsCertificateRecord {
  const attachedExprIds = [...collectProgramExprRenderings(program).keys()].sort((left, right) => left - right);
  const attached = new Set(attachedExprIds);
  const uniqueConsumed = [...new Set(certificate.consumedExprIds)].sort((left, right) => left - right);
  const missingExprIds = uniqueConsumed.filter((exprId) => !attached.has(exprId));
  return {
    kind: "range_analysis",
    consumedExprIds: uniqueConsumed,
    validation: {
      ok: missingExprIds.length === 0,
      detail: missingExprIds.length === 0
        ? "all downstream-consumed range facts are attached to canonical IR expressions"
        : `some downstream-consumed range facts are not attached to canonical IR expressions: ${missingExprIds.join(", ")}`,
      attachedExprIds,
      missingExprIds,
    },
  };
}

function validateGuardEliminationCertificate(
  canonicalProgram: IRProgram,
  guardProgram: IRProgram,
  certificate: OptimizeResult["certificates"]["guardElimination"],
): SemanticsCertificateRecord {
  const canonicalCounts = countProgramOps(canonicalProgram);
  const guardCounts = countProgramOps(guardProgram);
  const derivedRemoved = {
    nanToZero: canonicalCounts.nanToZero - guardCounts.nanToZero,
    totalDiv: canonicalCounts.totalDiv - guardCounts.totalDiv,
    totalMod: canonicalCounts.totalMod - guardCounts.totalMod,
  };
  const attached = new Set(collectProgramExprRenderings(canonicalProgram).keys());
  const usedRangeExprIds = [...new Set(certificate.usedRangeExprIds)].sort((left, right) => left - right);
  const missingExprIds = usedRangeExprIds.filter((exprId) => !attached.has(exprId));
  const removedMatch =
    derivedRemoved.nanToZero === certificate.removed.nanToZero &&
    derivedRemoved.totalDiv === certificate.removed.totalDiv &&
    derivedRemoved.totalMod === certificate.removed.totalMod;
  return {
    kind: "guard_elimination",
    usedRangeExprIds,
    removed: certificate.removed,
    validation: {
      ok: removedMatch && missingExprIds.length === 0,
      detail: removedMatch && missingExprIds.length === 0
        ? "guard-elimination counts match the structural diff and every consumed range fact is attached to canonical IR"
        : !removedMatch
          ? "guard-elimination removal counts do not match the structural diff between canonical_ir and guard_elided_ir"
          : `guard-elimination consumed unattached range facts: ${missingExprIds.join(", ")}`,
      derivedRemoved,
      missingExprIds,
    },
  };
}

function validateIdentityCertificate(certificate: OptimizeResult["certificates"]["finalIdentity"]): SemanticsCertificateRecord {
  return {
    kind: "identity",
    reason: certificate.reason,
    validation: {
      ok: true,
      detail: certificate.reason,
    },
  };
}

function validateClosedFormCertificate(
  program: IRProgram,
  certificate: OptimizeResult["certificates"]["closedForm"],
): SemanticsCertificateRecord {
  const rediscovered = new Map(matchClosedForms(program).map((match) => [match.fnName, match.implementation] as const));
  const unmatched = certificate.matches
    .filter((match) => JSON.stringify(rediscovered.get(match.fnName) ?? null) !== JSON.stringify(match.implementation))
    .map((match) => match.fnName);
  return {
    kind: "closed_form",
    matches: certificate.matches,
    validation: {
      ok: unmatched.length === 0,
      detail: unmatched.length === 0
        ? "every emitted closed-form implementation is rediscovered by the local matcher"
        : `closed-form implementations could not be rediscovered for: ${unmatched.join(", ")}`,
      unmatched,
    },
  };
}

function validateLutCertificate(certificate: OptimizeResult["certificates"]["lut"]): SemanticsCertificateRecord {
  const invalidEntries = certificate.entries
    .filter((entry) => entry.tableLength !== lutCardinality(entry.parameterRanges))
    .map((entry) => entry.fnName);
  return {
    kind: "lut",
    entries: certificate.entries,
    validation: {
      ok: invalidEntries.length === 0,
      detail: invalidEntries.length === 0
        ? "every LUT table length matches the cartesian product of its finite integer ranges"
        : `LUT table lengths do not match their declared domains for: ${invalidEntries.join(", ")}`,
      invalidEntries,
    },
  };
}

function lutCardinality(ranges: Array<{ lo: number; hi: number }>): number {
  return ranges.reduce((product, range) => product * (range.hi - range.lo + 1), 1);
}

function countProgramOps(program: IRProgram): IrOpCounts {
  const counts: IrOpCounts = {
    totalDiv: 0,
    totalMod: 0,
    nanToZero: 0,
    satAdd: 0,
    satSub: 0,
    satMul: 0,
    satNeg: 0,
    zeroDivisorBinops: 0,
  };
  for (const global of program.globals) {
    countExprOps(global.expr, counts);
  }
  for (const fn of program.functions) {
    for (const stmt of fn.body) {
      if (stmt.tag !== "gas") {
        countExprOps(stmt.expr, counts);
      }
    }
  }
  return counts;
}

function countExprOps(expr: IRExpr, counts: IrOpCounts): void {
  switch (expr.tag) {
    case "int_lit":
    case "float_lit":
    case "void_lit":
    case "var":
    case "res":
      return;
    case "unop":
      countExprOps(expr.operand, counts);
      return;
    case "binop":
      if ((expr.op === "/" || expr.op === "%") && isZeroLiteralExpr(expr.right)) {
        counts.zeroDivisorBinops += 1;
      }
      countExprOps(expr.left, counts);
      countExprOps(expr.right, counts);
      return;
    case "call":
      for (const arg of expr.args) {
        countExprOps(arg, counts);
      }
      return;
    case "index":
      countExprOps(expr.array, counts);
      for (const index of expr.indices) {
        countExprOps(index, counts);
      }
      return;
    case "field":
      countExprOps(expr.target, counts);
      return;
    case "struct_cons":
      for (const field of expr.fields) {
        countExprOps(field, counts);
      }
      return;
    case "array_cons":
      for (const element of expr.elements) {
        countExprOps(element, counts);
      }
      return;
    case "array_expr":
    case "sum_expr":
      for (const binding of expr.bindings) {
        countExprOps(binding.expr, counts);
      }
      countExprOps(expr.body, counts);
      return;
    case "rec":
      for (const arg of expr.args) {
        countExprOps(arg, counts);
      }
      return;
    case "total_div":
      counts.totalDiv += 1;
      countExprOps(expr.left, counts);
      countExprOps(expr.right, counts);
      return;
    case "total_mod":
      counts.totalMod += 1;
      countExprOps(expr.left, counts);
      countExprOps(expr.right, counts);
      return;
    case "sat_add":
      counts.satAdd += 1;
      countExprOps(expr.left, counts);
      countExprOps(expr.right, counts);
      return;
    case "sat_sub":
      counts.satSub += 1;
      countExprOps(expr.left, counts);
      countExprOps(expr.right, counts);
      return;
    case "sat_mul":
      counts.satMul += 1;
      countExprOps(expr.left, counts);
      countExprOps(expr.right, counts);
      return;
    case "sat_neg":
      counts.satNeg += 1;
      countExprOps(expr.operand, counts);
      return;
    case "nan_to_zero":
      counts.nanToZero += 1;
      countExprOps(expr.value, counts);
      return;
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}

function isZeroLiteralExpr(expr: IRExpr): boolean {
  return (expr.tag === "int_lit" || expr.tag === "float_lit") && expr.value === 0;
}

function buildCanonicalRangeSoundnessEdgeRecord(
  program: IRProgram,
  analysis: RangeAnalysisResult,
  consumedExprIds: number[],
  solverOptions: Z3RunOptions,
  certificate: SemanticsCertificateRecord | null = null,
): SemanticsEdgeRecord {
  const edgeSolverOptions = withHardTimeout(solverOptions);
  const consumed = new Set(consumedExprIds);
  const seen = new Set<number>();
  const structDefs = new Map(program.structs.map((struct) => [struct.name, struct.fields] as const));
  const callSummaries = buildIrCallSummaries(program, structDefs, "range_call_");

  const functions = [...program.functions]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((fn) => {
      const fnAnalysis = analyzeIrFunction(fn, structDefs, `range_${fn.name}_`, { callSummaries });
      const comparisonEnv = buildComparisonEnvFromParams(fn.params);
      for (const param of fn.params) {
        if (param.type.tag !== "array") {
          continue;
        }
        for (let dim = 0; dim < param.type.dims; dim += 1) {
          comparisonEnv.set(`jplmm_dim_${param.name}_${dim}`, {
            lo: 1,
            hi: INT32_MAX,
            exact: false,
          });
        }
      }

      const relevantExprIds = [...fnAnalysis.exprSemantics.keys()]
        .filter((exprId) => consumed.has(exprId))
        .sort((left, right) => left - right);
      for (const exprId of relevantExprIds) {
        seen.add(exprId);
      }

      if (relevantExprIds.length === 0) {
        return {
          name: fn.name,
          status: "equivalent" as const,
          method: "range_fact_vacuous",
          detail: "no downstream-consumed canonical range facts were used for this function",
        };
      }

      const failures: Array<{ status: "mismatch" | "unproven"; detail: string }> = [];
      let proved = 0;
      for (const exprId of relevantExprIds) {
        const exprRange = analysis.rangeMap.get(exprId);
        const exprValue = fnAnalysis.exprSemantics.get(exprId);
        if (!exprRange) {
          failures.push({
            status: "unproven",
            detail: `consumed range fact for expr #${exprId} is missing from the canonical range map`,
          });
          continue;
        }
        if (!exprValue) {
          failures.push({
            status: "unproven",
            detail: `consumed range fact for expr #${exprId} is missing symbolic semantics`,
          });
          continue;
        }
        const normalizedValue = normalizeValueForComparison(exprValue, comparisonEnv);
        if (normalizedValue.kind !== "scalar") {
          failures.push({
            status: "unproven",
            detail: `consumed range fact for expr #${exprId} has non-scalar semantics (${normalizedValue.kind})`,
          });
          continue;
        }
        const verdict = proveScalarRangeFact(fn, fnAnalysis.callSigs, normalizedValue.expr, exprRange, edgeSolverOptions);
        if (!verdict.ok) {
          failures.push({
            status: verdict.status,
            detail: `expr #${exprId}: ${verdict.detail}`,
          });
          continue;
        }
        proved += 1;
      }

      const mismatch = failures.find((entry) => entry.status === "mismatch");
      if (mismatch) {
        return {
          name: fn.name,
          status: "mismatch" as const,
          detail: mismatch.detail,
        };
      }
      if (failures.length > 0) {
        return {
          name: fn.name,
          status: "unproven" as const,
          detail: failures.map((entry) => entry.detail).join("; "),
        };
      }
      return {
        name: fn.name,
        status: "equivalent" as const,
        method: "range_fact_smt",
        detail: `proved ${proved} downstream-consumed canonical range fact${proved === 1 ? "" : "s"} with shared symbolic SMT`,
      };
    });

  const unseen = [...consumed].filter((exprId) => !seen.has(exprId)).sort((left, right) => left - right);
  if (unseen.length > 0) {
    functions.push({
      name: "<globals>",
      status: "unproven",
      detail: `consumed canonical range facts are not yet attached to function semantics for expr ids: ${unseen.join(", ")}`,
    });
  }

  const summary = functions.reduce(
    (current, fn) => ({
      equivalent: current.equivalent + (fn.status === "equivalent" ? 1 : 0),
      mismatch: current.mismatch + (fn.status === "mismatch" ? 1 : 0),
      unproven: current.unproven + (fn.status === "unproven" ? 1 : 0),
    }),
    { equivalent: 0, mismatch: 0, unproven: 0 },
  );

  return {
    from: "canonical_ir",
    to: "canonical_range_facts",
    kind: "analysis_soundness",
    certificate,
    ok: summary.mismatch === 0 && summary.unproven === 0,
    summary,
    functions,
  };
}

function proveScalarRangeFact(
  fn: IRFunction,
  callSigs: Map<string, { args: Array<"int" | "float">; ret: "int" | "float" }>,
  expr: ScalarExpr,
  range: { lo: number; hi: number },
  solverOptions: Z3RunOptions,
): { ok: true } | { ok: false; status: "mismatch" | "unproven"; detail: string } {
  if (!canEncodeScalarExprWithSmt(expr)) {
    return {
      ok: false,
      status: "unproven",
      detail: "shared symbolic SMT cannot encode this range fact yet",
    };
  }

  const smtState = createSmtEncodingState();
  const outside = buildOutsideRangeAssertion(expr, range, smtState);
  if (!outside) {
    return { ok: true };
  }

  const lines = buildJplScalarPrelude();
  for (const [name, sig] of callSigs) {
    const domain = sig.args.map((arg) => (arg === "int" ? "Int" : "Real")).join(" ");
    const sort = sig.ret === "int" ? "Int" : "Real";
    lines.push(`(declare-fun ${sanitize(name)} (${domain}) ${sort})`);
  }

  const vars = new Map<string, "int" | "float">();
  collectValueVars({ kind: "scalar", expr }, vars);
  for (const [name, tag] of vars) {
    lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
    const paramType = fn.params.find((param) => param.name === name)?.type;
    if (paramType) {
      appendScalarTypeConstraints(lines, name, paramType);
      continue;
    }
    if (tag === "int") {
      lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
      lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
      if (name.startsWith("jplmm_dim_")) {
        lines.push(`(assert (<= 1 ${sanitize(name)}))`);
      }
    }
  }

  appendSmtEncodingState(lines, smtState);
  lines.push(`(assert ${outside})`);

  const result = checkSat(lines, solverOptions);
  if (!result.ok) {
    return {
      ok: false,
      status: "unproven",
      detail: result.timedOut
        ? `timed out while proving canonical range fact: ${result.error}`
        : `could not invoke z3 for canonical range fact: ${result.error}`,
    };
  }
  if (result.status === "unsat") {
    return { ok: true };
  }
  if (result.status === "sat") {
    return {
      ok: false,
      status: "mismatch",
      detail: `canonical range fact is not semantically sound: z3 found a valuation outside [${renderRangeEndpoint(expr, range.lo)}, ${renderRangeEndpoint(expr, range.hi)}]`,
    };
  }
  return {
    ok: false,
    status: "unproven",
    detail: `z3 returned '${result.output || "unknown"}' while proving the canonical range fact`,
  };
}

function buildOutsideRangeAssertion(
  expr: ScalarExpr,
  range: { lo: number; hi: number },
  smtState: ReturnType<typeof createSmtEncodingState>,
): string | null {
  const term = emitScalarWithOverrides(expr, { smt: smtState });
  const lower = Number.isFinite(range.lo)
    ? `(< ${term} ${renderRangeEndpoint(expr, range.lo)})`
    : null;
  const upper = Number.isFinite(range.hi)
    ? `(< ${renderRangeEndpoint(expr, range.hi)} ${term})`
    : null;
  if (lower && upper) {
    return `(or ${lower} ${upper})`;
  }
  return lower ?? upper;
}

function renderRangeEndpoint(expr: ScalarExpr, value: number): string {
  if (scalarExprType(expr) === "int") {
    return emitScalarWithOverrides({ tag: "int_lit", value: Math.trunc(value) });
  }
  return emitScalarWithOverrides({ tag: "float_lit", value });
}

function serializeConsumedRangeFacts(
  program: IRProgram,
  analysis: RangeAnalysisResult,
  consumedExprIds: number[],
): Array<{
  owner: string;
  exprId: number;
  rendered: string;
  range: { lo: number; hi: number } | null;
}> {
  const renderings = collectProgramExprRenderings(program);
  return [...new Set(consumedExprIds)]
    .sort((left, right) => left - right)
    .map((exprId) => {
      const entry = renderings.get(exprId);
      return {
        owner: entry?.owner ?? "<unknown>",
        exprId,
        rendered: entry?.rendered ?? `<expr #${exprId}>`,
        range: analysis.rangeMap.get(exprId) ?? null,
      };
    });
}

function collectExprNodes(expr: IRExpr, out: Map<number, IRExpr>): void {
  if (out.has(expr.id)) {
    return;
  }
  out.set(expr.id, expr);
  switch (expr.tag) {
    case "int_lit":
    case "float_lit":
    case "void_lit":
    case "var":
    case "res":
      return;
    case "unop":
      collectExprNodes(expr.operand, out);
      return;
    case "nan_to_zero":
      collectExprNodes(expr.value, out);
      return;
    case "sat_neg":
      collectExprNodes(expr.operand, out);
      return;
    case "binop":
    case "total_div":
    case "total_mod":
    case "sat_add":
    case "sat_sub":
    case "sat_mul":
      collectExprNodes(expr.left, out);
      collectExprNodes(expr.right, out);
      return;
    case "call":
      for (const arg of expr.args) {
        collectExprNodes(arg, out);
      }
      return;
    case "index":
      collectExprNodes(expr.array, out);
      for (const index of expr.indices) {
        collectExprNodes(index, out);
      }
      return;
    case "field":
      collectExprNodes(expr.target, out);
      return;
    case "struct_cons":
      for (const field of expr.fields) {
        collectExprNodes(field, out);
      }
      return;
    case "array_cons":
      for (const element of expr.elements) {
        collectExprNodes(element, out);
      }
      return;
    case "array_expr":
    case "sum_expr":
      for (const binding of expr.bindings) {
        collectExprNodes(binding.expr, out);
      }
      collectExprNodes(expr.body, out);
      return;
    case "rec":
      for (const arg of expr.args) {
        collectExprNodes(arg, out);
      }
      return;
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}

function collectProgramExprRenderings(program: IRProgram): Map<number, { owner: string; rendered: string }> {
  const out = new Map<number, { owner: string; rendered: string }>();
  for (const global of program.globals) {
    collectExprRenderings(global.expr, global.name, out);
  }
  for (const fn of program.functions) {
    for (const stmt of fn.body) {
      if (stmt.tag === "gas") {
        continue;
      }
      collectExprRenderings(stmt.expr, fn.name, out);
    }
  }
  return out;
}

function collectExprRenderings(
  expr: IRExpr,
  owner: string,
  out: Map<number, { owner: string; rendered: string }>,
): void {
  if (!out.has(expr.id)) {
    out.set(expr.id, { owner, rendered: renderIrExpr(expr) });
  }
  switch (expr.tag) {
    case "int_lit":
    case "float_lit":
    case "void_lit":
    case "var":
    case "res":
      return;
    case "unop":
      collectExprRenderings(expr.operand, owner, out);
      return;
    case "nan_to_zero":
      collectExprRenderings(expr.value, owner, out);
      return;
    case "sat_neg":
      collectExprRenderings(expr.operand, owner, out);
      return;
    case "binop":
    case "total_div":
    case "total_mod":
    case "sat_add":
    case "sat_sub":
    case "sat_mul":
      collectExprRenderings(expr.left, owner, out);
      collectExprRenderings(expr.right, owner, out);
      return;
    case "call":
      for (const arg of expr.args) {
        collectExprRenderings(arg, owner, out);
      }
      return;
    case "struct_cons":
      for (const field of expr.fields) {
        collectExprRenderings(field, owner, out);
      }
      return;
    case "array_cons":
      for (const element of expr.elements) {
        collectExprRenderings(element, owner, out);
      }
      return;
    case "rec":
      for (const arg of expr.args) {
        collectExprRenderings(arg, owner, out);
      }
      return;
    case "index":
      collectExprRenderings(expr.array, owner, out);
      for (const index of expr.indices) {
        collectExprRenderings(index, owner, out);
      }
      return;
    case "field":
      collectExprRenderings(expr.target, owner, out);
      return;
    case "array_expr":
    case "sum_expr":
      for (const binding of expr.bindings) {
        collectExprRenderings(binding.expr, owner, out);
      }
      collectExprRenderings(expr.body, owner, out);
      return;
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}

function buildLutImplementationFloor(
  implementations: OptimizeResult["artifacts"]["implementations"],
): SemanticsLutFloorRecord | null {
  const functions = [...implementations.entries()]
    .filter(
      (
        entry,
      ): entry is [
        string,
        Extract<OptimizeResult["artifacts"]["implementations"] extends Map<string, infer T> ? T : never, { tag: "lut" }>
      ] => entry[1].tag === "lut",
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fnName, implementation]) => ({
      name: fnName,
      parameterRanges: implementation.parameterRanges,
      table: [...implementation.table],
      resultType: implementation.resultType,
      fallback: "final_optimized_ir" as const,
      semantics: [
        "finite LUT over the listed integer parameter ranges",
        "inside the LUT domain, result is table[flatten(args)]",
        "outside the LUT domain, execution falls back to final_optimized_ir",
      ],
    }));
  return functions.length > 0
    ? {
        label: "lut_impl_semantics",
        functions,
      }
    : null;
}

function buildLutImplementationEdgeRecord(
  program: IRProgram,
  implementations: OptimizeResult["artifacts"]["implementations"],
  certificate: SemanticsCertificateRecord | null = null,
): SemanticsEdgeRecord | null {
  const functions = [...implementations.entries()]
    .filter(
      (
        entry,
      ): entry is [
        string,
        Extract<OptimizeResult["artifacts"]["implementations"] extends Map<string, infer T> ? T : never, { tag: "lut" }>
      ] => entry[1].tag === "lut",
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fnName, implementation]) => verifyLutImplementation(program, fnName, implementation));

  if (functions.length === 0) {
    return null;
  }

  const summary = functions.reduce(
    (current, fn) => ({
      equivalent: current.equivalent + (fn.status === "equivalent" ? 1 : 0),
      mismatch: current.mismatch + (fn.status === "mismatch" ? 1 : 0),
      unproven: current.unproven + (fn.status === "unproven" ? 1 : 0),
    }),
    { equivalent: 0, mismatch: 0, unproven: 0 },
  );

  return {
    from: "final_optimized_ir",
    to: "lut_impl_semantics",
    kind: "implementation_refinement",
    certificate,
    ok: summary.mismatch === 0 && summary.unproven === 0,
    summary,
    functions,
  };
}

function verifyLutImplementation(
  program: IRProgram,
  fnName: string,
  implementation: Extract<OptimizeResult["artifacts"]["implementations"] extends Map<string, infer T> ? T : never, { tag: "lut" }>,
): {
  name: string;
  status: "equivalent" | "mismatch" | "unproven";
  method?: string;
  detail: string;
} {
  let cellIndex = 0;
  const args = new Array<number>(implementation.parameterRanges.length);

  for (const range of implementation.parameterRanges) {
    if (!Number.isInteger(range.lo) || !Number.isInteger(range.hi) || range.hi < range.lo) {
      return {
        name: fnName,
        status: "unproven",
        detail: "LUT ranges were not finite integer intervals during semantic recheck",
      };
    }
  }

  const loop = (index: number):
    | { ok: true }
    | { ok: false; status: "mismatch" | "unproven"; detail: string } => {
    if (index === implementation.parameterRanges.length) {
      const result = executeProgram(program, fnName, [...args]).value;
      if (typeof result !== "number") {
        return {
          ok: false,
          status: "unproven",
          detail: "LUT semantic recheck expected a scalar result but observed a non-scalar value",
        };
      }
      const expected = implementation.table[cellIndex];
      if (expected === undefined) {
        return {
          ok: false,
          status: "mismatch",
          detail: `LUT table ended early at cell ${cellIndex}`,
        };
      }
      if (!Object.is(result, expected)) {
        return {
          ok: false,
          status: "mismatch",
          detail: `LUT cell ${cellIndex} disagrees with final_optimized_ir: expected ${expected}, got ${result}`,
        };
      }
      cellIndex += 1;
      return { ok: true };
    }

    const range = implementation.parameterRanges[index]!;
    for (let value = range.lo; value <= range.hi; value += 1) {
      args[index] = value;
      const result = loop(index + 1);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true };
  };

  const result = loop(0);
  if (!result.ok) {
    return {
      name: fnName,
      status: result.status,
      detail: result.detail,
    };
  }
  if (cellIndex !== implementation.table.length) {
    return {
      name: fnName,
      status: "mismatch",
      detail: `LUT table has ${implementation.table.length} cells but only ${cellIndex} were justified by re-enumeration`,
    };
  }
  return {
    name: fnName,
    status: "equivalent",
    method: "lut_enumeration",
    detail: `LUT table re-enumerated exactly over ${cellIndex} in-range cells; outside that domain execution falls back to final_optimized_ir`,
  };
}

const INT_TYPE: Type = { tag: "int" };

function buildClosedFormImplementationProgram(
  program: IRProgram,
  implementations: OptimizeResult["artifacts"]["implementations"],
): IRProgram | null {
  let nextId = 1_000_000_000;
  let changed = false;
  const functions = program.functions.map((fn) => {
    const implementation = implementations.get(fn.name);
    if (implementation?.tag !== "closed_form_linear_countdown") {
      return fn;
    }
    changed = true;
    return synthesizeClosedFormFunction(fn, implementation, () => nextId++);
  });
  if (!changed) {
    return null;
  }
  return {
    structs: program.structs,
    globals: program.globals,
    functions,
  };
}

function synthesizeClosedFormFunction(
  fn: IRFunction,
  implementation: ClosedFormImplementation,
  nextId: () => number,
): IRFunction {
  const param = fn.params[implementation.paramIndex];
  if (!param) {
    return fn;
  }

  const paramValue = varExpr(param.name, param.type, nextId);
  const zero = intLit(0, nextId);
  const one = intLit(1, nextId);
  const decrement = intLit(implementation.decrement, nextId);
  const decrementMinusOne = intLit(implementation.decrement - 1, nextId);
  const baseValue = intLit(implementation.baseValue, nextId);
  const stepValue = intLit(implementation.stepValue, nextId);

  const positiveInput = callExpr("max", [zero, paramValue], INT_TYPE, nextId);
  const numerator = satAddExpr(positiveInput, decrementMinusOne, nextId);
  const stepsMinusOne = totalDivExpr(numerator, decrement, nextId);
  const steps = satAddExpr(stepsMinusOne, one, nextId);
  const delta = satMulExpr(steps, stepValue, nextId);
  const result = satAddExpr(baseValue, delta, nextId);

  return {
    ...fn,
    body: [{
      tag: "ret",
      id: nextId(),
      expr: result,
    }],
  };
}

function intLit(value: number, nextId: () => number): IRExpr {
  return {
    tag: "int_lit",
    value,
    id: nextId(),
    resultType: INT_TYPE,
  };
}

function varExpr(name: string, resultType: Type, nextId: () => number): IRExpr {
  return {
    tag: "var",
    name,
    id: nextId(),
    resultType,
  };
}

function callExpr(name: string, args: IRExpr[], resultType: Type, nextId: () => number): IRExpr {
  return {
    tag: "call",
    name,
    args,
    id: nextId(),
    resultType,
  };
}

function satAddExpr(left: IRExpr, right: IRExpr, nextId: () => number): IRExpr {
  return {
    tag: "sat_add",
    left,
    right,
    id: nextId(),
    resultType: INT_TYPE,
  };
}

function satMulExpr(left: IRExpr, right: IRExpr, nextId: () => number): IRExpr {
  return {
    tag: "sat_mul",
    left,
    right,
    id: nextId(),
    resultType: INT_TYPE,
  };
}

function totalDivExpr(left: IRExpr, right: IRExpr, nextId: () => number): IRExpr {
  return {
    tag: "total_div",
    left,
    right,
    id: nextId(),
    resultType: INT_TYPE,
    zeroDivisorValue: 0,
  };
}

function buildClosedFormEdgeOverrides(
  program: IRProgram,
  implementations: OptimizeResult["artifacts"]["implementations"],
): Map<string, { status: "equivalent"; method: string; detail: string }> {
  const matched = new Map(
    matchClosedForms(program).map((match) => [match.fnName, match.implementation] as const),
  );
  const overrides = new Map<string, { status: "equivalent"; method: string; detail: string }>();
  for (const [fnName, implementation] of implementations.entries()) {
    if (implementation.tag !== "closed_form_linear_countdown") {
      continue;
    }
    const matchedImplementation = matched.get(fnName);
    if (!matchedImplementation || !sameClosedFormImplementation(matchedImplementation, implementation)) {
      continue;
    }
    overrides.set(fnName, {
      status: "equivalent",
      method: "closed_form_match",
      detail: "closed-form implementation is verified by the countdown matcher that synthesized it",
    });
  }
  return overrides;
}

function sameClosedFormImplementation(left: ClosedFormImplementation, right: ClosedFormImplementation): boolean {
  return left.paramIndex === right.paramIndex
    && left.baseValue === right.baseValue
    && left.stepValue === right.stepValue
    && left.decrement === right.decrement;
}
