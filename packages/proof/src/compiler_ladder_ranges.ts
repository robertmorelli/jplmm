import type { IRExpr, IRFunction, IRProgram } from "@jplmm/ir";
import type { RangeAnalysisResult } from "@jplmm/optimize";
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
  analyzeIrFunction,
  analyzeIrGlobals,
  buildIrCallSummaries,
  renderIrExpr,
} from "./ir";
import type {
  SemanticsCertificateRecord,
  SemanticsEdgeRecord,
  SerializedRangeAnalysis,
} from "./compiler_ladder";
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

export function deserializeRangeAnalysis(result: SerializedRangeAnalysis): RangeAnalysisResult {
  return {
    rangeMap: new Map(
      Object.entries(result.exprRanges)
        .map(([id, range]) => [Number(id), range] as const)
        .sort(([left], [right]) => left - right),
    ),
    cardinalityMap: new Map(
      Object.entries(result.cardinalities)
        .map(([fnName, info]) => [fnName, info] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function serializeRangeFacts(
  program: IRProgram,
  analysis: RangeAnalysisResult,
  exprIds: number[],
): Array<{
  owner: string;
  exprId: number;
  rendered: string;
  range: { lo: number; hi: number } | null;
}> {
  const renderings = collectProgramExprRenderings(program);
  return [...new Set(exprIds)]
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

export function buildCanonicalRangeSoundnessEdgeRecord(
  program: IRProgram,
  analysis: RangeAnalysisResult,
  exprIds: number[],
  solverOptions: Z3RunOptions,
  certificate: SemanticsCertificateRecord | null = null,
): SemanticsEdgeRecord {
  const edgeSolverOptions = withHardTimeout(solverOptions);
  const targetExprIds = new Set(exprIds);
  const seen = new Set<number>();
  const structDefs = new Map(program.structs.map((struct) => [struct.name, struct.fields] as const));
  const callSummaries = buildIrCallSummaries(program, structDefs, "range_call_");
  const globalAnalysis = analyzeIrGlobals(program, structDefs, "range_globals_", { callSummaries });

  const verifyExprIds = (
    owner: string,
    fn: IRFunction | null,
    relevantExprIds: number[],
    exprSemantics: Map<number, SymValue>,
    callSigs: Map<string, { args: Array<"int" | "float">; ret: "int" | "float" }>,
    comparisonEnv: ReturnType<typeof buildComparisonEnvFromParams>,
    vacuousDetail: string,
  ): SemanticsEdgeRecord["functions"][number] => {
    for (const exprId of relevantExprIds) {
      seen.add(exprId);
    }

    if (relevantExprIds.length === 0) {
      return {
        name: owner,
        status: "equivalent" as const,
        method: "range_fact_vacuous",
        detail: vacuousDetail,
      };
    }

    const failures: Array<{ status: "mismatch" | "unproven"; detail: string }> = [];
    let proved = 0;
    for (const exprId of relevantExprIds) {
      const exprRange = analysis.rangeMap.get(exprId);
      const exprValue = exprSemantics.get(exprId);
      if (!exprRange) {
        failures.push({
          status: "unproven",
          detail: `range fact for expr #${exprId} is missing from the canonical range map`,
        });
        continue;
      }
      if (!exprValue) {
        failures.push({
          status: "unproven",
          detail: `range fact for expr #${exprId} is missing symbolic semantics`,
        });
        continue;
      }
      const normalizedValue = normalizeValueForComparison(exprValue, comparisonEnv);
      if (normalizedValue.kind !== "scalar") {
        failures.push({
          status: "unproven",
          detail: `range fact for expr #${exprId} has non-scalar semantics (${normalizedValue.kind})`,
        });
        continue;
      }
      const verdict = proveScalarRangeFact(
        fn ?? {
          name: owner,
          keyword: "fun",
          params: [],
          retType: { tag: "void" },
          body: [],
          id: -1,
        },
        callSigs,
        normalizedValue.expr,
        exprRange,
        comparisonEnv,
        edgeSolverOptions,
      );
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
        name: owner,
        status: "mismatch" as const,
        detail: mismatch.detail,
      };
    }
    if (failures.length > 0) {
      return {
        name: owner,
        status: "unproven" as const,
        detail: failures.map((entry) => entry.detail).join("; "),
      };
    }
    return {
      name: owner,
      status: "equivalent" as const,
      method: "range_fact_smt",
      detail: `proved ${proved} canonical range fact${proved === 1 ? "" : "s"} with shared symbolic SMT`,
    };
  };

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
        .filter((exprId) => targetExprIds.has(exprId))
        .sort((left, right) => left - right);
      return verifyExprIds(
        fn.name,
        fn,
        relevantExprIds,
        fnAnalysis.exprSemantics,
        fnAnalysis.callSigs,
        comparisonEnv,
        "no canonical range facts were attached to this function",
      );
    });

  const globalComparisonEnv = new Map<string, { lo: number; hi: number; exact: boolean }>();
  const globalExprIds = [...globalAnalysis.exprSemantics.keys()]
    .filter((exprId) => targetExprIds.has(exprId))
    .sort((left, right) => left - right);
  if (program.globals.length > 0 || globalExprIds.length > 0) {
    functions.push(
      verifyExprIds(
        "<globals>",
        null,
        globalExprIds,
        globalAnalysis.exprSemantics,
        globalAnalysis.callSigs,
        globalComparisonEnv,
        "no canonical range facts were attached to globals",
      ),
    );
  }

  const unseen = [...targetExprIds].filter((exprId) => !seen.has(exprId)).sort((left, right) => left - right);
  if (unseen.length > 0) {
    functions.push({
      name: "<globals>",
      status: "unproven",
      detail: `canonical range facts are not yet attached to function or global semantics for expr ids: ${unseen.join(", ")}`,
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
  comparisonEnv: Map<string, { lo: number; hi: number; exact: boolean }>,
  solverOptions: Z3RunOptions,
): { ok: true } | { ok: false; status: "mismatch" | "unproven"; detail: string } {
  const derivedRange = deriveScalarInterval(expr, comparisonEnv);
  if (derivedRange && intervalContainedBy(derivedRange, range)) {
    return { ok: true };
  }

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

function deriveScalarInterval(
  expr: ScalarExpr,
  comparisonEnv: Map<string, { lo: number; hi: number; exact: boolean }>,
): { lo: number; hi: number } | null {
  switch (expr.tag) {
    case "int_lit":
    case "float_lit":
      return { lo: expr.value, hi: expr.value };
    case "var":
      return comparisonEnv.get(expr.name) ?? null;
    case "positive_extent": {
      const inner = deriveScalarInterval(expr.value, comparisonEnv);
      if (!inner) {
        return { lo: 1, hi: INT32_MAX };
      }
      return {
        lo: 1,
        hi: Number.isFinite(inner.hi) ? Math.max(1, Math.trunc(inner.hi)) : INT32_MAX,
      };
    }
    case "clamp_index": {
      const dim = deriveScalarInterval(expr.dim, comparisonEnv);
      if (!dim) {
        return { lo: 0, hi: INT32_MAX };
      }
      const hi = Number.isFinite(dim.hi) ? Math.max(0, Math.trunc(dim.hi) - 1) : INT32_MAX;
      return { lo: 0, hi };
    }
    case "unop": {
      const operand = deriveScalarInterval(expr.operand, comparisonEnv);
      return operand ? { lo: -operand.hi, hi: -operand.lo } : null;
    }
    case "nan_to_zero": {
      const inner = deriveScalarInterval(expr.value, comparisonEnv);
      if (!inner) {
        return null;
      }
      return {
        lo: Math.min(inner.lo, 0),
        hi: Math.max(inner.hi, 0),
      };
    }
    case "binop":
      return deriveBinaryInterval(expr.op, expr.left, expr.right, comparisonEnv, expr.valueType === "int");
    case "sat_add":
      return clampIntInterval(
        deriveBinaryInterval("+", expr.left, expr.right, comparisonEnv, true),
      );
    case "sat_sub":
      return clampIntInterval(
        deriveBinaryInterval("-", expr.left, expr.right, comparisonEnv, true),
      );
    case "sat_mul":
      return clampIntInterval(
        deriveBinaryInterval("*", expr.left, expr.right, comparisonEnv, true),
      );
    case "sat_neg": {
      const operand = deriveScalarInterval(expr.operand, comparisonEnv);
      return operand ? clampIntInterval({ lo: -operand.hi, hi: -operand.lo }) : null;
    }
    case "call":
      return deriveCallInterval(expr, comparisonEnv);
    default:
      return null;
  }
}

function deriveBinaryInterval(
  op: "+" | "-" | "*" | "/" | "%",
  leftExpr: ScalarExpr,
  rightExpr: ScalarExpr,
  comparisonEnv: Map<string, { lo: number; hi: number; exact: boolean }>,
  integer: boolean,
): { lo: number; hi: number } | null {
  const left = deriveScalarInterval(leftExpr, comparisonEnv);
  const right = deriveScalarInterval(rightExpr, comparisonEnv);
  if (!left || !right) {
    return null;
  }
  switch (op) {
    case "+":
      return {
        lo: left.lo + right.lo,
        hi: left.hi + right.hi,
      };
    case "-":
      return {
        lo: left.lo - right.hi,
        hi: left.hi - right.lo,
      };
    case "*": {
      const products = [
        left.lo * right.lo,
        left.lo * right.hi,
        left.hi * right.lo,
        left.hi * right.hi,
      ];
      return {
        lo: Math.min(...products),
        hi: Math.max(...products),
      };
    }
    case "/":
    case "%":
      if (right.lo <= 0 && right.hi >= 0) {
        return null;
      }
      if (op === "%") {
        const bound = Math.max(Math.abs(right.lo), Math.abs(right.hi));
        return integer
          ? { lo: -bound + 1, hi: bound - 1 }
          : null;
      }
      return null;
    default:
      return null;
  }
}

function deriveCallInterval(
  expr: Extract<ScalarExpr, { tag: "call" }>,
  comparisonEnv: Map<string, { lo: number; hi: number; exact: boolean }>,
): { lo: number; hi: number } | null {
  const args = expr.args.map((arg) => deriveScalarInterval(arg, comparisonEnv));
  if (args.some((arg) => arg === null)) {
    return null;
  }
  const resolved = args as Array<{ lo: number; hi: number }>;
  switch (expr.name) {
    case "sqrt":
      return resolved[0]!.lo >= 0
        ? {
            lo: Math.sqrt(resolved[0]!.lo),
            hi: Number.isFinite(resolved[0]!.hi) ? Math.sqrt(resolved[0]!.hi) : Number.POSITIVE_INFINITY,
          }
        : null;
    case "abs": {
      const arg = resolved[0]!;
      return {
        lo: 0,
        hi: Math.max(Math.abs(arg.lo), Math.abs(arg.hi)),
      };
    }
    case "max":
      return {
        lo: Math.max(resolved[0]!.lo, resolved[1]!.lo),
        hi: Math.max(resolved[0]!.hi, resolved[1]!.hi),
      };
    case "min":
      return {
        lo: Math.min(resolved[0]!.lo, resolved[1]!.lo),
        hi: Math.min(resolved[0]!.hi, resolved[1]!.hi),
      };
    case "clamp":
      return {
        lo: Math.max(resolved[0]!.lo, resolved[1]!.lo),
        hi: Math.min(resolved[0]!.hi, resolved[2]!.hi),
      };
    case "to_float":
      return resolved[0]!;
    case "to_int":
      return {
        lo: Math.trunc(resolved[0]!.lo),
        hi: Math.trunc(resolved[0]!.hi),
      };
    default:
      return null;
  }
}

function clampIntInterval(
  interval: { lo: number; hi: number } | null,
): { lo: number; hi: number } | null {
  if (!interval) {
    return null;
  }
  return {
    lo: Math.max(INT32_MIN, Math.trunc(interval.lo)),
    hi: Math.min(INT32_MAX, Math.trunc(interval.hi)),
  };
}

function intervalContainedBy(
  derived: { lo: number; hi: number },
  expected: { lo: number; hi: number },
): boolean {
  const lowerOk = !Number.isFinite(expected.lo) || derived.lo >= expected.lo;
  const upperOk = !Number.isFinite(expected.hi) || derived.hi <= expected.hi;
  return lowerOk && upperOk;
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
