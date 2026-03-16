import {
  renderType,
  unwrapTimedDefinition,
  type Cmd,
  type Expr,
  type Program,
  type Stmt,
  type Type,
} from "@jplmm/ast";
import { buildIR, type IRExpr, type IRFunction, type IRProgram } from "@jplmm/ir";
import {
  buildExprProvenance,
  executeProgram,
  matchClosedForms,
  serializeExprProvenance,
  type ClosedFormImplementation,
  type OptimizeResult,
  type SerializedExprProvenance,
} from "@jplmm/optimize";
import { type Z3RunOptions } from "@jplmm/smt";
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
  type SymValue,
} from "./scalar";
import {
  revalidateCertificate,
  validateCanonicalizeCertificate,
  validateClosedFormCertificate,
  validateGuardEliminationCertificate,
  validateIdentityCertificate,
  validateLutCertificate,
  validateRangeAnalysisCertificate,
} from "./compiler_ladder_certificates";
import {
  buildCanonicalRangeSoundnessEdgeRecord,
  deserializeRangeAnalysis,
  serializeRangeAnalysis,
  serializeRangeFacts,
} from "./compiler_ladder_ranges";

export type SemanticsCompilerRecord = {
  schemaVersion: 1;
  floors: {
    typedAst: SemanticsAstFloorRecord | null;
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
    canonicalRangeFacts: Array<{
      owner: string;
      exprId: number;
      rendered: string;
      range: { lo: number; hi: number } | null;
    }>;
    provenance: {
      astToRaw: SerializedExprProvenance | null;
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

export type SemanticsAstFloorRecord = {
  label: "typed_source_ast";
  program: Program;
  typeMap: Record<string, Type>;
  commands: Array<{
    id: number;
    tag: Cmd["tag"];
    rendered: string;
    semantics: string;
    exprSemantics: Array<{
      exprId: number;
      rendered: string;
      value: SerializedSymValue | null;
      loweredExprId: number | null;
    }>;
  }>;
  globals: Array<{
    name: string;
    rendered: string;
    value: SerializedSymValue | null;
    exprSemantics: Array<{
      exprId: number;
      rendered: string;
      value: SerializedSymValue | null;
      loweredExprId: number | null;
    }>;
  }>;
  functions: Array<{
    name: string;
    keyword: string;
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
  from: SemanticsAstFloorRecord["label"] | SemanticsIrFloorRecord["label"] | SemanticsLutFloorRecord["label"] | "canonical_range_facts";
  to: SemanticsAstFloorRecord["label"] | SemanticsIrFloorRecord["label"] | SemanticsLutFloorRecord["label"] | "canonical_range_facts";
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
      kind: "ast_lowering";
      validation: SemanticsCertificateValidation & {
        rebuiltMatchesRaw: boolean;
      };
    }
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
      exprIds: number[];
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

export type CompilerAstSource = {
  program: Program;
  typeMap: Map<number, Type>;
};

export type CompilerSemanticsCheckRecord = {
  ok: boolean;
  summary: {
    equivalent: number;
    mismatch: number;
    unproven: number;
  };
  edges: SemanticsEdgeRecord[];
};

export function buildCompilerSemantics(
  rawProgram: IRProgram,
  optimized: OptimizeResult,
  solverOptions: Z3RunOptions = {},
  source: CompilerAstSource | null = null,
): SemanticsCompilerRecord {
  const typedAst = source ? buildAstFloorRecord(source.program, source.typeMap, rawProgram) : null;
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
    schemaVersion: 1,
    floors: {
      typedAst,
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
      canonicalRangeFacts: serializeRangeFacts(
        optimized.stages.canonical.program,
        optimized.stages.canonicalRanges,
        optimized.certificates.rangeAnalysis.exprIds,
      ),
      provenance: {
        astToRaw: source
          ? serializeExprProvenance(buildExprProvenance(buildIR(source.program, source.typeMap), rawProgram, "ast_lowering"))
          : null,
        rawToCanonical: serializeExprProvenance(optimized.provenance.rawToCanonical),
        canonicalToGuardElided: serializeExprProvenance(optimized.provenance.canonicalToGuardElided),
        guardElidedToFinalOptimized: serializeExprProvenance(optimized.provenance.guardElidedToFinalOptimized),
      },
      guardConsumedExprIds: [...optimized.stages.guardElided.usedRangeExprIds],
      canonicalConsumedRangeFacts: serializeRangeFacts(
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
      ...(typedAst
        ? [buildAstToRawEdgeRecord(typedAst, rawProgram)]
        : []),
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
        optimized.certificates.rangeAnalysis.exprIds,
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

export function checkCompilerSemanticsRecord(
  record: SemanticsCompilerRecord,
  solverOptions: Z3RunOptions = {},
): CompilerSemanticsCheckRecord {
  if (record.schemaVersion !== 1) {
    return {
      ok: false,
      summary: {
        equivalent: 0,
        mismatch: 0,
        unproven: 0,
      },
      edges: [],
    };
  }
  const implementations = new Map(record.analyses.implementations.map((entry) => [entry.fnName, entry.implementation] as const));
  const closedFormOverrides = buildClosedFormEdgeOverrides(record.floors.finalOptimized.program, implementations);
  const edges: SemanticsEdgeRecord[] = [];

  if (record.floors.typedAst) {
    edges.push(buildAstToRawEdgeRecord(record.floors.typedAst, record.floors.raw.program));
  }

  edges.push(buildIrEdgeRecord(
    "raw_ir",
    "canonical_ir",
    record.floors.raw.program,
    record.floors.canonical.program,
    solverOptions,
    new Map(),
    revalidateCertificate(record.edges, "raw_ir", "canonical_ir", record.floors.raw.program, record.floors.canonical.program),
  ));

  edges.push(buildCanonicalRangeSoundnessEdgeRecord(
    record.floors.canonical.program,
    deserializeRangeAnalysis(record.analyses.canonicalRanges),
    Object.keys(record.analyses.canonicalRanges.exprRanges).map(Number),
    solverOptions,
    revalidateCertificate(record.edges, "canonical_ir", "canonical_range_facts", record.floors.canonical.program, null, record.analyses.canonicalRanges),
  ));

  edges.push(buildIrEdgeRecord(
    "canonical_ir",
    "guard_elided_ir",
    record.floors.canonical.program,
    record.floors.guardElided.program,
    solverOptions,
    new Map(),
    revalidateCertificate(record.edges, "canonical_ir", "guard_elided_ir", record.floors.canonical.program, record.floors.guardElided.program),
  ));

  edges.push(buildIrEdgeRecord(
    "guard_elided_ir",
    "final_optimized_ir",
    record.floors.guardElided.program,
    record.floors.finalOptimized.program,
    solverOptions,
    new Map(),
    revalidateCertificate(record.edges, "guard_elided_ir", "final_optimized_ir", record.floors.guardElided.program, record.floors.finalOptimized.program),
  ));

  if (record.floors.closedFormImpl) {
    edges.push(buildIrEdgeRecord(
      "final_optimized_ir",
      "closed_form_impl_ir",
      record.floors.finalOptimized.program,
      record.floors.closedFormImpl.program,
      solverOptions,
      closedFormOverrides,
      revalidateCertificate(record.edges, "final_optimized_ir", "closed_form_impl_ir", record.floors.finalOptimized.program, record.floors.closedFormImpl.program),
    ));
  }

  if (record.implementationFloors.lut) {
    const lutEdge = buildLutImplementationEdgeRecord(
      record.floors.finalOptimized.program,
      implementations,
      revalidateCertificate(record.edges, "final_optimized_ir", "lut_impl_semantics", record.floors.finalOptimized.program, null),
    );
    if (lutEdge) {
      edges.push(lutEdge);
    }
  }

  const summary = edges.reduce(
    (current, edge) => ({
      equivalent: current.equivalent + edge.summary.equivalent,
      mismatch: current.mismatch + edge.summary.mismatch,
      unproven: current.unproven + edge.summary.unproven,
    }),
    { equivalent: 0, mismatch: 0, unproven: 0 },
  );

  return {
    ok: edges.every((edge) => edge.ok),
    summary,
    edges,
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

function serializeAstFunctionAnalysis(
  body: Stmt[],
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
    | null,
): SerializedIrFunctionAnalysis {
  const base = serializePlainIrAnalysis(trace, []);
  return {
    ...base,
    exprSemantics: serializeAstExprSemantics(
      body.filter((stmt) => stmt.tag !== "gas").map((stmt) => stmt.expr),
      trace?.exprSemantics ?? new Map(),
    ),
    statementSemantics: (trace?.stmtSemantics ?? []).map((entry) => ({
      stmtIndex: entry.stmtIndex,
      stmtTag: entry.stmtTag,
      rendered: renderAstStmt(body[entry.stmtIndex] ?? null),
      value: entry.value ? serializeSymValue(entry.value) : null,
    })),
  };
}

function serializeAstExprSemantics(
  roots: Expr[],
  exprSemantics: Map<number, SymValue>,
): Array<{
  exprId: number;
  rendered: string;
  value: SerializedSymValue | null;
  loweredExprId: number | null;
}> {
  const orderedExprs = new Map<number, Expr>();
  for (const root of roots) {
    collectAstExprNodes(root, orderedExprs);
  }
  return [...orderedExprs.values()].map((expr) => ({
    exprId: expr.id,
    rendered: renderAstExpr(expr),
    value: serializeOptionalSymValue(exprSemantics.get(expr.id)),
    loweredExprId: exprSemantics.has(expr.id) ? expr.id : null,
  }));
}

function serializeTypeMap(typeMap: Map<number, Type>): Record<string, Type> {
  return Object.fromEntries(
    [...typeMap.entries()]
      .sort(([left], [right]) => left - right)
      .map(([id, type]) => [String(id), type]),
  );
}

function deserializeTypeMap(typeMap: Record<string, Type>): Map<number, Type> {
  return new Map(
    Object.entries(typeMap)
      .map(([id, type]) => [Number(id), type] as const)
      .sort(([left], [right]) => left - right),
  );
}

function renderAstFunction(fn: Extract<Cmd, { tag: "fn_def" }>): string[] {
  const params = fn.params.map((param) => `${param.name}:${renderType(param.type)}`).join(", ");
  return [
    `${fn.keyword} ${fn.name}(${params}): ${renderType(fn.retType)} {`,
    ...fn.body.map((stmt) => `  ${renderAstStmt(stmt)}`),
    "}",
  ];
}

function renderAstCmd(cmd: Cmd): string {
  switch (cmd.tag) {
    case "fn_def":
      return renderAstFunction(cmd).join("\n");
    case "let_cmd":
      return `let ${renderAstLValue(cmd.lvalue)} = ${renderAstExpr(cmd.expr)}`;
    case "struct_def":
      return `struct ${cmd.name} { ${cmd.fields.map((field) => `${field.name}:${renderType(field.type)}`).join(", ")} }`;
    case "read_image":
      return `read image "${cmd.filename}" -> ${renderAstArgument(cmd.target)}`;
    case "write_image":
      return `write image ${renderAstExpr(cmd.expr)} -> "${cmd.filename}"`;
    case "print":
      return `print "${cmd.message}"`;
    case "show":
      return `show ${renderAstExpr(cmd.expr)}`;
    case "time":
      return `time ${renderAstCmd(cmd.cmd)}`;
    default: {
      const _never: never = cmd;
      return _never;
    }
  }
}

function renderAstStmt(stmt: Stmt | null): string {
  if (!stmt) {
    return "<missing stmt>";
  }
  switch (stmt.tag) {
    case "let":
      return `let ${renderAstLValue(stmt.lvalue)} = ${renderAstExpr(stmt.expr)}`;
    case "ret":
      return `ret ${renderAstExpr(stmt.expr)}`;
    case "rad":
      return `rad ${renderAstExpr(stmt.expr)}`;
    case "gas":
      return `gas ${stmt.limit}`;
    default: {
      const _never: never = stmt;
      return _never;
    }
  }
}

function renderAstExpr(expr: Expr): string {
  switch (expr.tag) {
    case "int_lit":
    case "float_lit":
      return String(expr.value);
    case "void_lit":
      return "void";
    case "var":
      return expr.name;
    case "binop":
      return `${renderAstExpr(expr.left)} ${expr.op} ${renderAstExpr(expr.right)}`;
    case "unop":
      return `${expr.op}${renderAstExpr(expr.operand)}`;
    case "call":
      return `${expr.name}(${expr.args.map((arg) => renderAstExpr(arg)).join(", ")})`;
    case "index":
      return `${renderAstExpr(expr.array)}[${expr.indices.map((index) => renderAstExpr(index)).join(", ")}]`;
    case "field":
      return `${renderAstExpr(expr.target)}.${expr.field}`;
    case "struct_cons":
      return `${expr.name}(${expr.fields.map((field) => renderAstExpr(field)).join(", ")})`;
    case "array_cons":
      return `[${expr.elements.map((element) => renderAstExpr(element)).join(", ")}]`;
    case "array_expr":
      return `array[${expr.bindings.map((binding) => `${binding.name}:${renderAstExpr(binding.expr)}`).join(", ")}] ${renderAstExpr(expr.body)}`;
    case "sum_expr":
      return `sum[${expr.bindings.map((binding) => `${binding.name}:${renderAstExpr(binding.expr)}`).join(", ")}] ${renderAstExpr(expr.body)}`;
    case "res":
      return "res";
    case "rec":
      return `rec(${expr.args.map((arg) => renderAstExpr(arg)).join(", ")})`;
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}

function renderAstLValue(lvalue: Extract<Stmt, { tag: "let" }>["lvalue"] | Extract<Cmd, { tag: "let_cmd" }>["lvalue"]): string {
  switch (lvalue.tag) {
    case "var":
      return lvalue.name;
    case "field":
      return `${lvalue.base}.${lvalue.field}`;
    case "tuple":
      return `(${lvalue.items.map((item) => renderAstLValue(item)).join(", ")})`;
    default: {
      const _never: never = lvalue;
      return _never;
    }
  }
}

function renderAstArgument(argument: Extract<Cmd, { tag: "read_image" }>["target"]): string {
  switch (argument.tag) {
    case "var":
      return argument.name;
    case "tuple":
      return `(${argument.items.map((item) => renderAstArgument(item)).join(", ")})`;
    default: {
      const _never: never = argument;
      return _never;
    }
  }
}

function collectAstExprNodes(expr: Expr, out: Map<number, Expr>): void {
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
      collectAstExprNodes(expr.operand, out);
      return;
    case "binop":
      collectAstExprNodes(expr.left, out);
      collectAstExprNodes(expr.right, out);
      return;
    case "call":
      for (const arg of expr.args) {
        collectAstExprNodes(arg, out);
      }
      return;
    case "index":
      collectAstExprNodes(expr.array, out);
      for (const index of expr.indices) {
        collectAstExprNodes(index, out);
      }
      return;
    case "field":
      collectAstExprNodes(expr.target, out);
      return;
    case "struct_cons":
      for (const field of expr.fields) {
        collectAstExprNodes(field, out);
      }
      return;
    case "array_cons":
      for (const element of expr.elements) {
        collectAstExprNodes(element, out);
      }
      return;
    case "array_expr":
    case "sum_expr":
      for (const binding of expr.bindings) {
        collectAstExprNodes(binding.expr, out);
      }
      collectAstExprNodes(expr.body, out);
      return;
    case "rec":
      for (const arg of expr.args) {
        collectAstExprNodes(arg, out);
      }
      return;
    default: {
      const _never: never = expr;
      return _never;
    }
  }
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

function buildAstFloorRecord(
  program: Program,
  typeMap: Map<number, Type>,
  rawProgram: IRProgram,
): SemanticsAstFloorRecord {
  const structDefs = new Map(rawProgram.structs.map((struct) => [struct.name, struct.fields] as const));
  const callSummaries = buildIrCallSummaries(rawProgram, structDefs, "ast_call_");
  const globalAnalysis = analyzeIrGlobals(rawProgram, structDefs, "ast_globals_", { callSummaries });
  const rawFunctionsByName = new Map(rawProgram.functions.map((fn) => [fn.name, fn] as const));
  const rawGlobalsByName = new Map(rawProgram.globals.map((global) => [global.name, global] as const));

  return {
    label: "typed_source_ast",
    program,
    typeMap: serializeTypeMap(typeMap),
    commands: program.commands.map((cmd) => ({
      id: cmd.id,
      tag: cmd.tag,
      rendered: renderAstCmd(cmd),
      semantics: describeAstCmdSemantics(cmd),
      exprSemantics: serializeAstCmdExprSemantics(cmd, globalAnalysis.exprSemantics),
    })),
    globals: program.commands.flatMap((cmd) => {
      if (cmd.tag !== "let_cmd" || cmd.lvalue.tag !== "var") {
        return [];
      }
      const rawGlobal = rawGlobalsByName.get(cmd.lvalue.name);
      return [{
        name: cmd.lvalue.name,
        rendered: renderAstCmd(cmd),
        value: rawGlobal ? serializeOptionalSymValue(globalAnalysis.values.get(rawGlobal.name)) : null,
        exprSemantics: serializeAstExprSemantics([cmd.expr], globalAnalysis.exprSemantics),
      }];
    }),
    functions: program.commands
      .map((cmd) => unwrapTimedDefinition(cmd, "fn_def"))
      .filter((fn): fn is Exclude<typeof fn, null> => fn !== null)
      .map((fn) => {
        const rawFn = rawFunctionsByName.get(fn.name);
        const analysis = rawFn
          ? analyzeIrFunction(rawFn, structDefs, `ast_${fn.name}_`, { callSummaries })
          : null;
        return {
          name: fn.name,
          keyword: fn.keyword,
          rendered: renderAstFunction(fn),
          result: analysis?.result ? serializeSymValue(analysis.result) : null,
          analysis: serializeAstFunctionAnalysis(
            fn.body,
            analysis ? { ...analysis, hasRec: hasRec(rawFn!) } : null,
          ),
        };
      }),
  };
}

function describeAstCmdSemantics(cmd: Cmd): string {
  switch (cmd.tag) {
    case "fn_def":
      return "declares a typed function definition that lowers into raw IR";
    case "struct_def":
      return "declares a typed struct shape for field projection and construction";
    case "let_cmd":
      return "evaluates a top-level expression and binds its normalized runtime value";
    case "read_image":
      return "loads an image file and binds its dimensions and/or pixel array";
    case "write_image":
      return "evaluates an expression and writes an image file";
    case "print":
      return "emits a literal string at top level";
    case "show":
      return "evaluates an expression and emits its formatted value at top level";
    case "time":
      return "executes the nested command and emits an elapsed-time report";
    default: {
      const _never: never = cmd;
      return `${_never}`;
    }
  }
}

function serializeAstCmdExprSemantics(
  cmd: Cmd,
  exprSemantics: Map<number, SymValue>,
): Array<{
  exprId: number;
  rendered: string;
  value: SerializedSymValue | null;
  loweredExprId: number | null;
}> {
  switch (cmd.tag) {
    case "let_cmd":
    case "show":
    case "write_image":
      return serializeAstExprSemantics([cmd.expr], exprSemantics);
    case "time":
      return serializeAstCmdExprSemantics(cmd.cmd, exprSemantics);
    default:
      return [];
  }
}

function buildAstToRawEdgeRecord(
  ast: SemanticsAstFloorRecord,
  rawProgram: IRProgram,
): SemanticsEdgeRecord {
  const rebuilt = buildIR(ast.program, deserializeTypeMap(ast.typeMap));
  const rebuiltMatchesRaw = JSON.stringify(rebuilt) === JSON.stringify(rawProgram);
  const names = [...new Set([
    ...rawProgram.functions.map((fn) => fn.name),
    ...rebuilt.functions.map((fn) => fn.name),
  ])].sort((left, right) => left.localeCompare(right));
  const globals = [...new Set([
    ...rawProgram.globals.map((global) => global.name),
    ...rebuilt.globals.map((global) => global.name),
  ])].sort((left, right) => left.localeCompare(right));
  const functions: SemanticsEdgeRecord["functions"] = [
    ...names.map((name) => ({
      name,
      status: rebuiltMatchesRaw ? "equivalent" as const : "mismatch" as const,
      ...(rebuiltMatchesRaw ? { method: "ast_lowering_identity" } : {}),
      detail: rebuiltMatchesRaw
        ? "typed AST lowering rebuilds the same raw IR function"
        : "rebuilding raw IR from the typed AST did not reproduce the stored raw IR function floor",
    })),
    ...globals.map((name) => ({
      name: `<global:${name}>`,
      status: rebuiltMatchesRaw ? "equivalent" as const : "mismatch" as const,
      ...(rebuiltMatchesRaw ? { method: "ast_lowering_identity" } : {}),
      detail: rebuiltMatchesRaw
        ? "typed AST lowering rebuilds the same raw IR global"
        : "rebuilding raw IR from the typed AST did not reproduce the stored raw IR global floor",
    })),
  ];

  const summary = functions.reduce(
    (current, fn) => ({
      equivalent: current.equivalent + (fn.status === "equivalent" ? 1 : 0),
      mismatch: current.mismatch + (fn.status === "mismatch" ? 1 : 0),
      unproven: current.unproven,
    }),
    { equivalent: 0, mismatch: 0, unproven: 0 },
  );

  return {
    from: "typed_source_ast",
    to: "raw_ir",
    kind: "ir_refinement",
    certificate: {
      kind: "ast_lowering",
      validation: {
        ok: rebuiltMatchesRaw,
        detail: rebuiltMatchesRaw
          ? "rebuilding raw IR from the typed AST reproduces the stored raw floor"
          : "rebuilding raw IR from the typed AST does not reproduce the stored raw floor",
        rebuiltMatchesRaw,
      },
    },
    ok: rebuiltMatchesRaw,
    summary,
    functions,
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
