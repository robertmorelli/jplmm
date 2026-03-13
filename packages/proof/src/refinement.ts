import type { Cmd, Param, Type } from "@jplmm/ast";
import type { IRExpr, IRFunction, IRProgram } from "@jplmm/ir";
import { executeProgram, type RuntimeValue } from "@jplmm/optimize";
import {
  INT32_MAX,
  INT32_MIN,
  buildJplInt32Prelude as buildIntPrelude,
  buildJplScalarPrelude,
  checkSat,
  sanitizeSymbol as sanitize,
} from "@jplmm/smt";

import {
  type IntRefineExpr,
  collectCalls,
  collectSummaryVars,
  emitIntExpr,
  formatIntAssignments,
  isSupportedIntBuiltin,
  queryIntCounterexample,
  queryIntValues,
  renderIntExpr,
  substituteIntExpr,
} from "./int";
import {
  analyzeIrFunction,
  buildCanonicalProgram,
  functionsAlphaEquivalent,
  hasRec,
  type IrFunctionAnalysis,
} from "./ir";
import {
  buildMeasureCounterexampleQuery,
  collectValueVars,
  emitScalarWithOverrides,
  emitValueEquality,
  extendSymbolicSubstitution,
  queryCounterexample,
  renderScalarExpr as renderSharedScalarExpr,
  renderValueExpr,
  scalarExprType,
  substituteScalar as substituteSharedScalar,
  substituteValue,
  symbolizeParamValue,
  type ScalarExpr,
  type SymValue,
} from "./scalar";

export type IntFunctionSummary = {
  paramNames: string[];
  expr: IntRefineExpr;
};

export type RefinementMethod =
  | "canonical"
  | "exact_zero_arity"
  | "scalar_int_smt"
  | "scalar_int_recursive_induction";

export type RefinementCheck =
  | { ok: true; method: RefinementMethod; detail: string; equivalence?: string }
  | { ok: false; code: "REF_MISMATCH" | "REF_UNPROVEN"; message: string };

type SummaryResult =
  | { ok: true; summary: IntFunctionSummary }
  | { ok: false; reason: string };

type RecursiveScalarSite = {
  stmtIndex: number;
  resultSymbol: string;
  currentRes: ScalarExpr;
  argValues: Map<number, SymValue>;
  issues: string[];
};

type RecursiveScalarFunctionSummary = {
  fn: IRFunction;
  analysis: IrFunctionAnalysis;
  expr: ScalarExpr;
  rads: ScalarExpr[];
  hasGas: boolean;
  helperRecCalls: string[];
  structDefs: Map<string, Array<{ name: string; type: Type }>>;
  recSites: RecursiveScalarSite[];
};

export function computeFunctionSummary(
  fnName: string,
  commands: Cmd[],
  typeMap: Map<number, Type>,
  summaries: Map<string, IntFunctionSummary>,
): IntFunctionSummary | null {
  const canonical = buildCanonicalProgram({ commands }, typeMap);
  const fn = canonical.functions.find((candidate) => candidate.name === fnName);
  if (!fn) {
    return null;
  }
  const availableFns = new Map(canonical.functions.map((candidate) => [candidate.name, candidate] as const));
  const env = new Map(summaries);
  env.delete(fnName);
  const summary = summarizeIntFunction(fn, availableFns, env);
  return summary.ok ? summary.summary : null;
}

export function checkFunctionRefinement(
  fnName: string,
  baselineCommands: Cmd[],
  refinedCommands: Cmd[],
  typeMap: Map<number, Type>,
  summaries: Map<string, IntFunctionSummary>,
): RefinementCheck {
  const baselineCanonical = buildCanonicalProgram({ commands: baselineCommands }, typeMap);
  const refinedCanonical = buildCanonicalProgram({ commands: refinedCommands }, typeMap);
  const baselineFn = baselineCanonical.functions.find((candidate) => candidate.name === fnName);
  const refinedFn = refinedCanonical.functions.find((candidate) => candidate.name === fnName);

  if (!baselineFn || !refinedFn) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' could not be analyzed because one implementation disappeared during canonical lowering`,
    };
  }

  if (functionsAlphaEquivalent(baselineFn, refinedFn)) {
    return {
      ok: true,
      method: "canonical",
      detail: "canonical semantics are alpha-equivalent after lowering",
    };
  }

  if (!hasRec(baselineFn) && !hasRec(refinedFn) && baselineFn.params.length === 0 && refinedFn.params.length === 0) {
    const baselineValue = executeProgram(baselineCanonical, fnName, []).value;
    const refinedValue = executeProgram(refinedCanonical, fnName, []).value;
    if (runtimeValueEquals(baselineValue, refinedValue)) {
      return {
        ok: true,
        method: "exact_zero_arity",
        detail: `zero-argument execution matched exactly: ${renderRuntimeValue(baselineValue)}`,
      };
    }
    return {
      ok: false,
      code: "REF_MISMATCH",
      message: `ref '${fnName}' changes zero-argument behavior: baseline=${renderRuntimeValue(baselineValue)}, ref=${renderRuntimeValue(refinedValue)}`,
    };
  }

  const priorSummaries = new Map(summaries);
  priorSummaries.delete(fnName);
  const baselineFunctions = new Map(baselineCanonical.functions.map((candidate) => [candidate.name, candidate] as const));
  const refinedFunctions = new Map(refinedCanonical.functions.map((candidate) => [candidate.name, candidate] as const));
  const baselineHasRec = hasRec(baselineFn);
  const refinedHasRec = hasRec(refinedFn);

  if (!baselineHasRec && !refinedHasRec) {
    const baselineSummary = summarizeIntFunction(baselineFn, baselineFunctions, priorSummaries);
    const refinedSummary = summarizeIntFunction(refinedFn, refinedFunctions, priorSummaries);
    if (baselineSummary.ok && refinedSummary.ok) {
      return proveIntSummaryEquivalence(fnName, baselineSummary.summary, refinedSummary.summary);
    }

    const reasons = [
      baselineSummary.ok ? null : `baseline: ${baselineSummary.reason}`,
      refinedSummary.ok ? null : `ref: ${refinedSummary.reason}`,
    ].filter((reason): reason is string => reason !== null);

    return {
      ok: false,
      code: "REF_UNPROVEN",
      message:
        reasons.length > 0
          ? `ref '${fnName}' could not be proven equivalent: ${reasons.join("; ")}`
          : `ref '${fnName}' could not be proven equivalent with the current refinement checker`,
    };
  }

  const baselineSummary = summarizeRecursiveScalarFunction(
    baselineFn,
    baselineFunctions,
    baselineCanonical.structs,
  );
  const refinedSummary = summarizeRecursiveScalarFunction(
    refinedFn,
    refinedFunctions,
    refinedCanonical.structs,
  );
  if (baselineSummary.ok && refinedSummary.ok) {
    return proveRecursiveScalarSummaryEquivalence(
      fnName,
      baselineCanonical,
      refinedCanonical,
      baselineSummary.summary,
      alignRecursiveScalarSummary(refinedSummary.summary, baselineSummary.summary.fn.params),
    );
  }

  const reasons = [
    baselineSummary.ok ? null : `baseline: ${baselineSummary.reason}`,
    refinedSummary.ok ? null : `ref: ${refinedSummary.reason}`,
  ].filter((reason): reason is string => reason !== null);

  return {
    ok: false,
    code: "REF_UNPROVEN",
    message:
      reasons.length > 0
        ? `ref '${fnName}' could not be proven equivalent: ${reasons.join("; ")}`
        : `ref '${fnName}' could not be proven equivalent with the current refinement checker`,
  };
}

function summarizeRecursiveScalarFunction(
  fn: IRFunction,
  availableFns: Map<string, IRFunction>,
  structs: IRProgram["structs"],
): { ok: true; summary: RecursiveScalarFunctionSummary } | { ok: false; reason: string } {
  if (fn.retType.tag !== "int") {
    return { ok: false, reason: "only scalar int refinements have an exact recursive checker today" };
  }

  const structDefs = new Map(structs.map((struct) => [struct.name, struct.fields] as const));
  const helperRecCalls = collectDirectRecursiveHelperCalls(fn, availableFns);
  if (helperRecCalls.length > 0) {
    return {
      ok: false,
      reason: helperRecCalls.length === 1
        ? `call to recursive helper '${helperRecCalls[0]}' needs a relational refinement proof beyond the current direct-recursion checker`
        : `calls to recursive helpers ${helperRecCalls.map((name) => `'${name}'`).join(", ")} need a relational refinement proof beyond the current direct-recursion checker`,
    };
  }

  const analysis = analyzeIrFunction(fn, structDefs);
  if (!analysis.result || analysis.result.kind !== "scalar" || scalarExprType(analysis.result.expr) !== "int") {
    return { ok: false, reason: "only scalar int return values are supported by the recursive refinement checker" };
  }

  const recSites: RecursiveScalarSite[] = [];
  for (const site of analysis.recSites) {
    if (!site.resultSymbol) {
      return { ok: false, reason: "opaque recursive results are not yet supported in recursive refinement proofs" };
    }
    if (!site.currentRes || site.currentRes.kind !== "scalar" || scalarExprType(site.currentRes.expr) !== "int") {
      return { ok: false, reason: "recursive collapse currently requires an int-valued res at each rec site" };
    }
    recSites.push({
      stmtIndex: site.stmtIndex,
      resultSymbol: site.resultSymbol,
      currentRes: site.currentRes.expr,
      argValues: site.argValues,
      issues: site.issues,
    });
  }

  return {
    ok: true,
    summary: {
      fn,
      analysis,
      expr: analysis.result.expr,
      rads: analysis.radSites
        .map((rad) => rad.measure)
        .filter((measure) => scalarExprType(measure) === "int"),
      hasGas: fn.body.some((stmt) => stmt.tag === "gas"),
      helperRecCalls,
      structDefs,
      recSites,
    },
  };
}

function alignRecursiveScalarSummary(
  summary: RecursiveScalarFunctionSummary,
  params: Param[],
): RecursiveScalarFunctionSummary {
  const callSigs = new Map(summary.analysis.callSigs);
  const substitution = new Map<string, SymValue>();
  const paramValues = new Map<string, SymValue>();
  const alignedParams = summary.fn.params.map((param, index) => ({
    ...param,
    name: params[index]?.name ?? param.name,
  }));

  for (let i = 0; i < summary.fn.params.length; i += 1) {
    const original = summary.fn.params[i]!;
    const aligned = alignedParams[i]!;
    const value = symbolizeParamValue(aligned, callSigs, summary.structDefs);
    substitution.set(original.name, value);
    paramValues.set(aligned.name, value);
  }

  const alignedResult = { kind: "scalar" as const, expr: substituteSharedScalar(summary.expr, substitution) };
  return {
    ...summary,
    fn: {
      ...summary.fn,
      params: alignedParams,
    },
    analysis: {
      ...summary.analysis,
      paramValues,
      result: alignedResult,
      callSigs,
    },
    expr: alignedResult.expr,
    rads: summary.rads.map((rad) => substituteSharedScalar(rad, substitution)),
    recSites: summary.recSites.map((site) => ({
      ...site,
      currentRes: substituteSharedScalar(site.currentRes, substitution),
      argValues: new Map(
        [...site.argValues.entries()].map(([index, value]) => [index, substituteValue(value, substitution)]),
      ),
    })),
  };
}

function proveRecursiveScalarSummaryEquivalence(
  fnName: string,
  baselineProgram: IRProgram,
  refinedProgram: IRProgram,
  baseline: RecursiveScalarFunctionSummary,
  refined: RecursiveScalarFunctionSummary,
): RefinementCheck {
  if (baseline.hasGas || refined.hasGas) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' could not be proven equivalent: gas-based recursive refinements are not supported yet`,
    };
  }

  const candidateMeasures = uniqueScalarMeasures([...baseline.rads, ...refined.rads]);
  if (candidateMeasures.length === 0) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' could not be proven equivalent: no shared scalar-int rad candidate was available for recursive refinement proof`,
    };
  }

  const reasons: string[] = [];
  for (const measure of candidateMeasures) {
    const decrease = proveSharedRecursiveScalarMeasureDecreases(fnName, baseline, refined, measure);
    if (!decrease.ok) {
      reasons.push(decrease.message);
      continue;
    }

    const step = proveRecursiveScalarStepEquivalence(
      fnName,
      baselineProgram,
      refinedProgram,
      baseline,
      refined,
      measure,
    );
    if (step.ok || step.code === "REF_MISMATCH") {
      return step;
    }
    reasons.push(step.message);
  }

  return {
    ok: false,
    code: "REF_UNPROVEN",
    message: `ref '${fnName}' could not be proven equivalent for recursive scalar-int bodies: ${uniqueStrings(reasons).join("; ")}`,
  };
}

function proveSharedRecursiveScalarMeasureDecreases(
  fnName: string,
  baseline: RecursiveScalarFunctionSummary,
  refined: RecursiveScalarFunctionSummary,
  measure: ScalarExpr,
): { ok: true } | { ok: false; message: string } {
  const sites = [
    ...baseline.recSites.map((site, index) => ({
      label: `baseline site ${index + 1}`,
      summary: baseline,
      site,
    })),
    ...refined.recSites.map((site, index) => ({
      label: `ref site ${index + 1}`,
      summary: refined,
      site,
    })),
  ];

  for (const entry of sites) {
    const query = buildRecursiveMeasureQuery(entry.summary, entry.site, measure);
    if (!query.ok) {
      return {
        ok: false,
        message: `ref '${fnName}' could not prove recursive rad '${renderSharedScalarExpr(measure)}' at ${entry.label}: ${query.reason}`,
      };
    }

    const result = checkSat(query.query.baseLines);
    if (!result.ok) {
      return {
        ok: false,
        message: `ref '${fnName}' could not invoke z3 while checking recursive rad '${renderSharedScalarExpr(measure)}': ${result.error}`,
      };
    }
    if (result.status === "unsat") {
      continue;
    }
    if (result.status === "sat") {
      const witness = queryCounterexample(query.query);
      return {
        ok: false,
        message: `rad '${renderSharedScalarExpr(measure)}' does not decrease at ${entry.label}${witness ? `: ${witness}` : ""}`,
      };
    }
    return {
      ok: false,
      message: `z3 returned '${result.output || "unknown"}' while checking recursive rad '${renderSharedScalarExpr(measure)}'`,
    };
  }

  return { ok: true };
}

function buildRecursiveMeasureQuery(
  summary: RecursiveScalarFunctionSummary,
  site: RecursiveScalarSite,
  measure: ScalarExpr,
): ReturnType<typeof buildMeasureCounterexampleQuery> {
  if (site.issues.length > 0) {
    return {
      ok: false,
      reason: site.issues.join("; "),
    };
  }

  const substitution = new Map<string, SymValue>();
  for (let i = 0; i < summary.fn.params.length; i += 1) {
    const param = summary.fn.params[i]!;
    const next = site.argValues.get(i);
    if (!next) {
      return {
        ok: false,
        reason: `rec site is missing argument '${param.name}'`,
      };
    }
    substitution.set(param.name, next);
    const current = summary.analysis.paramValues.get(param.name);
    if (current) {
      extendSymbolicSubstitution(current, next, substitution);
    }
  }

  const nextMeasure = substituteSharedScalar(measure, substitution);
  return buildMeasureCounterexampleQuery(
    summary.fn.params,
    measure,
    nextMeasure,
    substitution,
    summary.analysis.callSigs,
    summary.analysis.paramValues,
  );
}

function proveRecursiveScalarStepEquivalence(
  fnName: string,
  baselineProgram: IRProgram,
  refinedProgram: IRProgram,
  baseline: RecursiveScalarFunctionSummary,
  refined: RecursiveScalarFunctionSummary,
  measure: ScalarExpr,
): RefinementCheck {
  const lines = buildJplScalarPrelude();

  const callSigs = new Map([...baseline.analysis.callSigs, ...refined.analysis.callSigs]);
  for (const [name, sig] of callSigs) {
    const domain = sig.args.map((arg) => (arg === "int" ? "Int" : "Real")).join(" ");
    const sort = sig.ret === "int" ? "Int" : "Real";
    lines.push(`(declare-fun ${sanitize(name)} (${domain}) ${sort})`);
  }

  const placeholderNames = new Set([
    ...baseline.recSites.map((site) => site.resultSymbol),
    ...refined.recSites.map((site) => site.resultSymbol),
  ]);

  const vars = new Map<string, "int" | "float">();
  collectValueVars({ kind: "scalar", expr: baseline.expr }, vars);
  collectValueVars({ kind: "scalar", expr: refined.expr }, vars);
  collectValueVars({ kind: "scalar", expr: measure }, vars);
  for (const value of baseline.analysis.paramValues.values()) {
    collectValueVars(value, vars);
  }
  for (const value of refined.analysis.paramValues.values()) {
    collectValueVars(value, vars);
  }
  for (const site of [...baseline.recSites, ...refined.recSites]) {
    collectValueVars({ kind: "scalar", expr: site.currentRes }, vars);
    for (const value of site.argValues.values()) {
      collectValueVars(value, vars);
    }
  }
  for (const name of placeholderNames) {
    vars.delete(name);
  }

  for (const [name, tag] of vars) {
    lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
    if (tag === "int") {
      lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
      lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
    }
  }

  const hypotheses = new Map<string, string>();
  let hypothesisIndex = 0;
  for (const key of collectRecursivePatternKeys(baseline, refined)) {
    const symbol = `jplmm_h_${hypothesisIndex}`;
    hypothesisIndex += 1;
    hypotheses.set(key, symbol);
    lines.push(`(declare-const ${symbol} Int)`);
    lines.push(`(assert (<= ${INT32_MIN} ${symbol}))`);
    lines.push(`(assert (<= ${symbol} ${INT32_MAX}))`);
  }

  const baselineBindings = buildRecursiveScalarBindings(baseline, hypotheses);
  if (!baselineBindings.ok) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' could not be proven equivalent: baseline: ${baselineBindings.reason}`,
    };
  }
  const refinedBindings = buildRecursiveScalarBindings(refined, hypotheses);
  if (!refinedBindings.ok) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' could not be proven equivalent: ref: ${refinedBindings.reason}`,
    };
  }

  lines.push(
    `(assert (not (= ${emitRecursiveScalarExpr(baseline.expr, baselineBindings.bindings)} ${emitRecursiveScalarExpr(refined.expr, refinedBindings.bindings)})))`,
  );

  const result = checkSat(lines);
  if (!result.ok) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' could not invoke z3 for recursive refinement proof: ${result.error}`,
    };
  }
  if (result.status === "unsat") {
    return {
      ok: true,
      method: "scalar_int_recursive_induction",
      detail: `proved recursive scalar-int equivalence by induction on rad '${renderSharedScalarExpr(measure)}'`,
      equivalence: `shared rad '${renderSharedScalarExpr(measure)}' closes all recursive sites and aligns the inductive step`,
    };
  }
  if (result.status === "sat") {
    if (baseline.fn.params.every((param) => param.type.tag === "int")) {
      const values = queryIntValues(lines, baseline.fn.params.map((param) => param.name));
      const runtimeCounterexample = values
        ? tryRuntimeRecursiveCounterexample(
            fnName,
            baselineProgram,
            refinedProgram,
            baseline.fn.params.map((param) => param.name),
            values,
          )
        : null;
      if (runtimeCounterexample) {
        return {
          ok: false,
          code: "REF_MISMATCH",
          message: `ref '${fnName}' is not equivalent: ${runtimeCounterexample}`,
        };
      }
      const witness = values
        ? formatIntAssignments(baseline.fn.params.map((param) => param.name), values)
        : queryIntCounterexample(lines, baseline.fn.params.map((param) => param.name));
      return {
        ok: false,
        code: "REF_UNPROVEN",
        message: `ref '${fnName}' did not admit an inductive proof for rad '${renderSharedScalarExpr(measure)}'${witness ? `; witness: ${witness}` : ""}`,
      };
    }
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' did not admit an inductive proof for rad '${renderSharedScalarExpr(measure)}'`,
    };
  }
  return {
    ok: false,
    code: "REF_UNPROVEN",
    message: `ref '${fnName}' could not be proven equivalent: z3 returned '${result.output || "unknown"}' for the recursive inductive step`,
  };
}

function buildRecursiveScalarBindings(
  summary: RecursiveScalarFunctionSummary,
  hypotheses: Map<string, string>,
): { ok: true; bindings: Map<string, string> } | { ok: false; reason: string } {
  const sites = new Map(summary.recSites.map((site) => [site.resultSymbol, site] as const));
  const cache = new Map<string, string>();
  const active = new Set<string>();

  const renderSite = (symbol: string): string | null => {
    if (cache.has(symbol)) {
      return cache.get(symbol)!;
    }
    if (active.has(symbol)) {
      return null;
    }
    const site = sites.get(symbol);
    if (!site) {
      return null;
    }
    const collapse = emitRecursiveCollapse(summary, site);
    if (!collapse) {
      return null;
    }
    const hypothesis = hypotheses.get(recursivePatternKey(summary.fn.name, site.argValues));
    if (!hypothesis) {
      return null;
    }
    active.add(symbol);
    const currentRes = emitRecursiveScalarExpr(site.currentRes, cache, renderSite);
    active.delete(symbol);
    const rendered = `(ite ${collapse} ${currentRes} ${hypothesis})`;
    cache.set(symbol, rendered);
    return rendered;
  };

  for (const site of summary.recSites) {
    if (!renderSite(site.resultSymbol)) {
      return {
        ok: false,
        reason: `could not build recursive hypothesis for site ${site.stmtIndex + 1}`,
      };
    }
  }

  return { ok: true, bindings: cache };
}

function emitRecursiveCollapse(summary: RecursiveScalarFunctionSummary, site: RecursiveScalarSite): string | null {
  const clauses: string[] = [];
  for (let i = 0; i < summary.fn.params.length; i += 1) {
    const param = summary.fn.params[i]!;
    const current = summary.analysis.paramValues.get(param.name);
    const next = site.argValues.get(i);
    if (!current || !next) {
      return null;
    }
    const equality = emitValueEquality(current, next, param.type);
    if (!equality) {
      return null;
    }
    clauses.push(equality);
  }
  if (clauses.length === 0) {
    return "true";
  }
  return clauses.length === 1 ? clauses[0]! : `(and ${clauses.join(" ")})`;
}

function emitRecursiveScalarExpr(
  expr: ScalarExpr,
  bindings: Map<string, string>,
  resolver: ((symbol: string) => string | null) | null = null,
): string {
  return emitScalarWithOverrides(expr, {
    onVar: (variable) => {
      const bound = bindings.get(variable.name) ?? resolver?.(variable.name) ?? null;
      return bound;
    },
  });
}

function collectRecursivePatternKeys(
  baseline: RecursiveScalarFunctionSummary,
  refined: RecursiveScalarFunctionSummary,
): string[] {
  return uniqueStrings([
    ...baseline.recSites.map((site) => recursivePatternKey(baseline.fn.name, site.argValues)),
    ...refined.recSites.map((site) => recursivePatternKey(refined.fn.name, site.argValues)),
  ]);
}

function recursivePatternKey(
  relationName: string,
  argValues: Map<number, SymValue>,
): string {
  const ordered = [...argValues.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => renderValueExpr(value));
  return `${relationName}::${ordered.join("||")}`;
}

function uniqueScalarMeasures(exprs: ScalarExpr[]): ScalarExpr[] {
  const out: ScalarExpr[] = [];
  const seen = new Set<string>();
  for (const expr of exprs) {
    const key = renderSharedScalarExpr(expr);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(expr);
    }
  }
  return out;
}

function collectDirectRecursiveHelperCalls(
  fn: IRFunction,
  availableFns: Map<string, IRFunction>,
): string[] {
  const found = new Set<string>();

  const visit = (expr: IRExpr): void => {
    switch (expr.tag) {
      case "call": {
        const callee = availableFns.get(expr.name);
        if (callee && hasRec(callee)) {
          found.add(expr.name);
        }
        for (const arg of expr.args) {
          visit(arg);
        }
        return;
      }
      case "unop":
      case "sat_neg":
        visit(expr.tag === "unop" ? expr.operand : expr.operand);
        return;
      case "binop":
      case "sat_add":
      case "sat_sub":
      case "sat_mul":
      case "total_div":
      case "total_mod":
        visit(expr.left);
        visit(expr.right);
        return;
      case "nan_to_zero":
        visit(expr.value);
        return;
      case "index":
        visit(expr.array);
        for (const index of expr.indices) {
          visit(index);
        }
        return;
      case "field":
        visit(expr.target);
        return;
      case "struct_cons":
        for (const field of expr.fields) {
          visit(field);
        }
        return;
      case "array_cons":
        for (const element of expr.elements) {
          visit(element);
        }
        return;
      case "array_expr":
      case "sum_expr":
        for (const binding of expr.bindings) {
          visit(binding.expr);
        }
        visit(expr.body);
        return;
      case "rec":
        for (const arg of expr.args) {
          visit(arg);
        }
        return;
      default:
        return;
    }
  };

  for (const stmt of fn.body) {
    if (stmt.tag === "let" || stmt.tag === "ret" || stmt.tag === "rad") {
      visit(stmt.expr);
    }
  }

  return [...found];
}

function summarizeIntFunction(
  fn: IRFunction,
  availableFns: Map<string, IRFunction>,
  summaries: Map<string, IntFunctionSummary>,
): SummaryResult {
  if (fn.retType.tag !== "int") {
    return { ok: false, reason: "only scalar int refinements have an exact SMT checker today" };
  }
  if (fn.params.some((param) => param.type.tag !== "int")) {
    return { ok: false, reason: "only scalar int parameters are supported by the exact SMT refinement checker" };
  }
  if (hasRec(fn)) {
    return { ok: false, reason: "recursive refinements need a dedicated relational/CHC proof path and are not enabled yet" };
  }

  const env = new Map<string, IntRefineExpr>();
  for (const param of fn.params) {
    env.set(param.name, { tag: "var", name: param.name });
  }

  let currentRes: IntRefineExpr | null = null;
  for (const stmt of fn.body) {
    if (stmt.tag === "rad" || stmt.tag === "gas") {
      continue;
    }
    if (stmt.tag === "let") {
      const expr = summarizeIntExpr(stmt.expr, env, currentRes, availableFns, summaries);
      if (!expr.ok) {
        return expr;
      }
      env.set(stmt.name, expr.expr);
      continue;
    }
    if (stmt.tag === "ret") {
      const expr = summarizeIntExpr(stmt.expr, env, currentRes, availableFns, summaries);
      if (!expr.ok) {
        return expr;
      }
      currentRes = expr.expr;
    }
  }

  return {
    ok: true,
    summary: {
      paramNames: fn.params.map((param) => param.name),
      expr: currentRes ?? { tag: "int_lit", value: 0 },
    },
  };
}

function summarizeIntExpr(
  expr: IRExpr,
  env: Map<string, IntRefineExpr>,
  currentRes: IntRefineExpr | null,
  availableFns: Map<string, IRFunction>,
  summaries: Map<string, IntFunctionSummary>,
): { ok: true; expr: IntRefineExpr } | { ok: false; reason: string } {
  switch (expr.tag) {
    case "int_lit":
      return { ok: true, expr: { tag: "int_lit", value: expr.value } };
    case "var": {
      const value = env.get(expr.name);
      if (!value) {
        return { ok: false, reason: `free variable '${expr.name}' is not supported in refinement summaries` };
      }
      return { ok: true, expr: value };
    }
    case "res":
      if (!currentRes) {
        return { ok: false, reason: "res was not available while building the refinement summary" };
      }
      return { ok: true, expr: currentRes };
    case "sat_add":
    case "sat_sub":
    case "sat_mul":
    case "total_div":
    case "total_mod": {
      const left = summarizeIntExpr(expr.left, env, currentRes, availableFns, summaries);
      if (!left.ok) {
        return left;
      }
      const right = summarizeIntExpr(expr.right, env, currentRes, availableFns, summaries);
      if (!right.ok) {
        return right;
      }
      return {
        ok: true,
        expr: {
          tag: expr.tag,
          left: left.expr,
          right: right.expr,
        },
      };
    }
    case "sat_neg": {
      const operand = summarizeIntExpr(expr.operand, env, currentRes, availableFns, summaries);
      if (!operand.ok) {
        return operand;
      }
      return { ok: true, expr: { tag: "sat_neg", operand: operand.expr } };
    }
    case "call": {
      const args: IntRefineExpr[] = [];
      for (const arg of expr.args) {
        const summarized = summarizeIntExpr(arg, env, currentRes, availableFns, summaries);
        if (!summarized.ok) {
          return summarized;
        }
        args.push(summarized.expr);
      }

      if (isSupportedIntBuiltin(expr.name, args.length)) {
        return { ok: true, expr: { tag: "call", name: expr.name, args, interpreted: true } };
      }

      const summary = summaries.get(expr.name);
      if (summary) {
        return {
          ok: true,
          expr: substituteIntExpr(
            summary.expr,
            new Map(summary.paramNames.map((name, index) => [name, args[index]!] as const)),
          ),
        };
      }

      const callee = availableFns.get(expr.name);
      if (!callee) {
        return { ok: false, reason: `call to unknown function '${expr.name}' cannot be summarized` };
      }
      if (callee.retType.tag !== "int" || callee.params.some((param) => param.type.tag !== "int")) {
        return { ok: false, reason: `call to '${expr.name}' leaves the scalar-int refinement subset` };
      }
      return { ok: true, expr: { tag: "call", name: expr.name, args, interpreted: false } };
    }
    default:
      return { ok: false, reason: `IR node '${expr.tag}' leaves the exact scalar-int refinement subset` };
  }
}

function proveIntSummaryEquivalence(
  fnName: string,
  baseline: IntFunctionSummary,
  refined: IntFunctionSummary,
): RefinementCheck {
  const alignedRefinedExpr = substituteIntExpr(
    refined.expr,
    new Map(
      refined.paramNames.map((name, index) => [
        name,
        { tag: "var", name: baseline.paramNames[index] ?? name } satisfies IntRefineExpr,
      ]),
    ),
  );
  const vars = collectSummaryVars(baseline.paramNames, baseline.expr, alignedRefinedExpr);
  const lines = buildIntPrelude();

  const calls = new Map<string, number>();
  collectCalls(baseline.expr, calls);
  collectCalls(alignedRefinedExpr, calls);
  for (const [name, arity] of calls) {
    lines.push(`(declare-fun ${sanitize(name)} (${new Array(arity).fill("Int").join(" ")}) Int)`);
  }

  for (const name of vars) {
    lines.push(`(declare-const ${sanitize(name)} Int)`);
    lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
    lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
  }

  lines.push(`(assert (not (= ${emitIntExpr(baseline.expr)} ${emitIntExpr(alignedRefinedExpr)})))`);

  const result = checkSat(lines);
  if (!result.ok) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' could not invoke z3: ${result.error}`,
    };
  }
  if (result.status === "unsat") {
    return {
      ok: true,
      method: "scalar_int_smt",
      detail: "proved scalar-int equivalence with Z3",
      equivalence: `${renderIntExpr(baseline.expr)} == ${renderIntExpr(alignedRefinedExpr)}`,
    };
  }
  if (result.status === "sat") {
    const counterexample = queryIntCounterexample(lines, vars);
    return {
      ok: false,
      code: "REF_MISMATCH",
      message: counterexample
        ? `ref '${fnName}' is not equivalent: ${counterexample}`
        : `ref '${fnName}' is not equivalent: z3 found an integer counterexample`,
    };
  }
  return {
    ok: false,
    code: "REF_UNPROVEN",
    message: `ref '${fnName}' could not be proven equivalent: z3 returned '${result.output || "unknown"}'`,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function tryRuntimeRecursiveCounterexample(
  fnName: string,
  baselineProgram: IRProgram,
  refinedProgram: IRProgram,
  paramNames: string[],
  values: Map<string, number>,
): string | null {
  const args = paramNames.map((name) => values.get(name) ?? 0);
  const baselineValue = executeProgram(baselineProgram, fnName, args).value;
  const refinedValue = executeProgram(refinedProgram, fnName, args).value;
  if (!runtimeValueEquals(baselineValue, refinedValue)) {
    return `${formatIntAssignments(paramNames, values) ?? "counterexample"}; baseline=${renderRuntimeValue(baselineValue)}, ref=${renderRuntimeValue(refinedValue)}`;
  }
  return null;
}

function runtimeValueEquals(left: RuntimeValue, right: RuntimeValue): boolean {
  if (typeof left === "number" || typeof right === "number") {
    return typeof left === "number" && typeof right === "number" && Object.is(left, right);
  }
  if (left.kind === "struct" && right.kind === "struct") {
    return left.typeName === right.typeName
      && left.fields.length === right.fields.length
      && left.fields.every((field, index) => runtimeValueEquals(field, right.fields[index]!));
  }
  if (left.kind === "array" && right.kind === "array") {
    return left.elementType.tag === right.elementType.tag
      && left.dims.length === right.dims.length
      && left.dims.every((dim, index) => dim === right.dims[index])
      && left.values.length === right.values.length
      && left.values.every((value, index) => runtimeValueEquals(value, right.values[index]!));
  }
  return false;
}

function renderRuntimeValue(value: RuntimeValue): string {
  if (typeof value === "number") {
    return `${value}`;
  }
  if (value.kind === "struct") {
    return `${value.typeName} { ${value.fields.map((field) => renderRuntimeValue(field)).join(", ")} }`;
  }
  return `[${value.values.map((item) => renderRuntimeValue(item)).join(", ")}]`;
}
