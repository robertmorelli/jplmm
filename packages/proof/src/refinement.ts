import { sameType as sameDeclaredType, type Cmd, type Param, type Type } from "@jplmm/ast";
import type { IRExpr, IRFunction, IRProgram } from "@jplmm/ir";
import { executeProgram, type RuntimeValue } from "@jplmm/optimize";
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
  buildIrCallSummaries,
  buildCanonicalProgram,
  functionsAlphaEquivalent,
  hasRec,
  type IrCallSummary,
  type IrFunctionAnalysis,
  type IrRecSite,
} from "./ir";
import {
  appendSmtEncodingState,
  arrayDims,
  appendScalarTypeConstraints,
  buildComparisonEnvFromParams,
  buildMeasureCounterexampleQuery,
  collectValueVars,
  createSmtEncodingState,
  type EmitOverrides,
  emitScalarWithOverrides,
  emitValueSexpr,
  emitValueEquality,
  extendSymbolicSubstitution,
  normalizeValueForComparison,
  normalizeValueForType,
  formatModelAssignments,
  queryCounterexample,
  queryIntModelValues,
  readSymbolicArray,
  renderScalarExpr as renderSharedScalarExpr,
  renderValueExpr,
  substituteScalar as substituteSharedScalar,
  substituteValue,
  symbolizeAbstractValue,
  symbolizeParamValue,
  type ScalarExpr,
  type ScalarTag,
  type SymArray,
  type SymValue,
} from "./scalar";

export type RefinementMethod =
  | "canonical"
  | "exact_zero_arity"
  | "symbolic_value_alpha"
  | "symbolic_value_smt"
  | "symbolic_recursive_induction";

export type RefinementCheck =
  | { ok: true; method: RefinementMethod; detail: string; equivalence?: string }
  | { ok: false; code: "REF_MISMATCH" | "REF_UNPROVEN"; message: string };

type SymbolicFunctionSummary = {
  fn: IRFunction;
  analysis: IrFunctionAnalysis & { result: SymValue };
  structDefs: Map<string, Array<{ name: string; type: Type }>>;
};

export function checkFunctionRefinement(
  fnName: string,
  baselineCommands: Cmd[],
  refinedCommands: Cmd[],
  typeMap: Map<number, Type>,
  solverOptions: Z3RunOptions = {},
): RefinementCheck {
  const baselineCanonical = buildCanonicalProgram({ commands: baselineCommands }, typeMap);
  const refinedCanonical = buildCanonicalProgram({ commands: refinedCommands }, typeMap);
  return checkIrFunctionRefinement(
    fnName,
    baselineCanonical,
    refinedCanonical,
    solverOptions,
    "canonical",
  );
}

export function checkIrFunctionRefinement(
  fnName: string,
  baselineProgram: IRProgram,
  refinedProgram: IRProgram,
  solverOptions: Z3RunOptions = {},
  boundaryLabel = "ir",
): RefinementCheck {
  const proofSolverOptions = withHardTimeout(solverOptions);
  const baselineFn = baselineProgram.functions.find((candidate) => candidate.name === fnName);
  const refinedFn = refinedProgram.functions.find((candidate) => candidate.name === fnName);

  if (!baselineFn || !refinedFn) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `${boundaryLabel} '${fnName}' could not be analyzed because one implementation disappeared during lowering`,
    };
  }

  const signatureProblem = compareIrFunctionSignature(baselineFn, refinedFn);
  if (signatureProblem) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `${boundaryLabel} '${fnName}' changed signature across lowering: ${signatureProblem}`,
    };
  }

  if (functionsAlphaEquivalent(baselineFn, refinedFn)) {
    return {
      ok: true,
      method: "canonical",
      detail: `${boundaryLabel} semantics are alpha-equivalent after lowering`,
    };
  }

  if (!hasRec(baselineFn) && !hasRec(refinedFn) && baselineFn.params.length === 0 && refinedFn.params.length === 0) {
    const baselineValue = executeProgram(baselineProgram, fnName, []).value;
    const refinedValue = executeProgram(refinedProgram, fnName, []).value;
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

  const baselineHasRec = hasRec(baselineFn);
  const refinedHasRec = hasRec(refinedFn);
  const baselineCallSummaries = buildIrCallSummaries(baselineProgram, undefined, "baseline_call_");
  const refinedCallSummaries = buildIrCallSummaries(refinedProgram, undefined, "ref_call_");

  const baselineSummary = summarizeSymbolicFunction(
    baselineFn,
    baselineProgram.structs,
    "baseline_",
    baselineCallSummaries,
  );
  const refinedSummary = summarizeSymbolicFunction(
    refinedFn,
    refinedProgram.structs,
    "ref_",
    refinedCallSummaries,
  );
  if (!baselineSummary.ok || !refinedSummary.ok) {
    const reasons = [
      baselineSummary.ok ? null : `baseline: ${baselineSummary.reason}`,
      refinedSummary.ok ? null : `ref: ${refinedSummary.reason}`,
    ].filter((reason): reason is string => reason !== null);
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message:
        reasons.length > 0
          ? `${boundaryLabel} '${fnName}' could not be proven equivalent: ${reasons.join("; ")}`
          : `${boundaryLabel} '${fnName}' could not be proven equivalent with the current refinement checker`,
    };
  }

  const alignedRefined = alignSymbolicSummary(refinedSummary.summary, baselineSummary.summary.fn.params);

  if (!baselineHasRec && !refinedHasRec) {
    return proveSymbolicSummaryEquivalence(
      fnName,
      baselineSummary.summary,
      alignedRefined,
      proofSolverOptions,
    );
  }
  return proveRecursiveSummaryEquivalence(
    fnName,
    baselineProgram,
    refinedProgram,
    baselineSummary.summary,
    alignedRefined,
    proofSolverOptions,
  );
}

function compareIrFunctionSignature(
  baseline: IRFunction,
  candidate: IRFunction,
): string | null {
  if (baseline.params.length !== candidate.params.length) {
    return "arity differs";
  }
  for (let i = 0; i < baseline.params.length; i += 1) {
    if (!sameDeclaredType(baseline.params[i]!.type, candidate.params[i]!.type)) {
      return `parameter ${i + 1} type differs`;
    }
  }
  if (!sameDeclaredType(baseline.retType, candidate.retType)) {
    return "return type differs";
  }
  return null;
}

function summarizeSymbolicFunction(
  fn: IRFunction,
  structs: IRProgram["structs"],
  symbolPrefix: string,
  callSummaries: Map<string, IrCallSummary> = new Map(),
): { ok: true; summary: SymbolicFunctionSummary } | { ok: false; reason: string } {
  const structDefs = new Map(structs.map((struct) => [struct.name, struct.fields] as const));
  const analysis = analyzeIrFunction(fn, structDefs, symbolPrefix, { callSummaries });
  const result = analysis.result ?? defaultSymbolicResultForType(fn.retType, structDefs);
  if (!result) {
    return {
      ok: false,
      reason: `return type '${fn.retType.tag}' does not yet have a shared symbolic default when no ret has executed`,
    };
  }

  return {
    ok: true,
    summary: {
      fn,
      analysis: {
        ...analysis,
        result,
      },
      structDefs,
    },
  };
}

function alignSymbolicSummary(
  summary: SymbolicFunctionSummary,
  params: Param[],
): SymbolicFunctionSummary {
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

  return {
    ...summary,
    fn: {
      ...summary.fn,
      params: alignedParams,
    },
    analysis: {
      ...summary.analysis,
      paramValues,
      radSites: summary.analysis.radSites.map((rad) => ({
        ...rad,
        measure: substituteSharedScalar(rad.measure, substitution),
        rendered: renderSharedScalarExpr(substituteSharedScalar(rad.measure, substitution)),
      })),
      recSites: summary.analysis.recSites.map((site) => {
        const currentRes = site.currentRes === undefined || site.currentRes === null
          ? site.currentRes
          : substituteValue(site.currentRes, substitution);
        return {
          ...site,
          argValues: new Map(
            [...site.argValues.entries()].map(([index, value]) => [index, substituteValue(value, substitution)]),
          ),
          ...(currentRes === undefined ? {} : { currentRes }),
        };
      }),
      result: substituteValue(summary.analysis.result, substitution),
      callSigs,
    },
  };
}

function defaultSymbolicResultForType(
  type: Type,
  structDefs: Map<string, Array<{ name: string; type: Type }>>,
): SymValue | null {
  if (type.tag === "int") {
    return normalizeValueForType({ kind: "scalar", expr: { tag: "int_lit", value: 0 } }, type);
  }
  if (type.tag === "float") {
    return normalizeValueForType({ kind: "scalar", expr: { tag: "float_lit", value: 0 } }, type);
  }
  if (type.tag === "void") {
    return { kind: "void", type };
  }
  if (type.tag === "named") {
    const fields = structDefs.get(type.name);
    if (!fields) {
      return null;
    }
    const values = fields.map((field) => defaultSymbolicResultForType(field.type, structDefs));
    if (values.some((value) => value === null)) {
      return null;
    }
    return {
      kind: "struct",
      typeName: type.name,
      fields: fields.map((field, index) => ({
        name: field.name,
        type: field.type,
        value: values[index]!,
      })),
    };
  }
  return null;
}

function proveRecursiveSummaryEquivalence(
  fnName: string,
  baselineProgram: IRProgram,
  refinedProgram: IRProgram,
  baseline: SymbolicFunctionSummary,
  refined: SymbolicFunctionSummary,
  solverOptions: Z3RunOptions,
): RefinementCheck {
  if (baseline.fn.body.some((stmt) => stmt.tag === "gas") || refined.fn.body.some((stmt) => stmt.tag === "gas")) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' could not be proven equivalent: gas-based recursive refinements are not supported yet`,
    };
  }

  const candidateMeasures = uniqueScalarMeasures([
    ...baseline.analysis.radSites.map((rad) => rad.measure),
    ...refined.analysis.radSites.map((rad) => rad.measure),
  ]);
  if (candidateMeasures.length === 0) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' could not be proven equivalent: no shared rad candidate was available for recursive refinement proof`,
    };
  }

  const reasons: string[] = [];
  for (const measure of candidateMeasures) {
    const decrease = proveSharedRecursiveMeasureDecreases(fnName, baseline, refined, measure, solverOptions);
    if (!decrease.ok) {
      reasons.push(decrease.message);
      continue;
    }

    const step = proveRecursiveStepEquivalence(
      fnName,
      baselineProgram,
      refinedProgram,
      baseline,
      refined,
      measure,
      solverOptions,
    );
    if (step.ok || step.code === "REF_MISMATCH") {
      return step;
    }
    reasons.push(step.message);
  }

  return {
    ok: false,
    code: "REF_UNPROVEN",
    message: `ref '${fnName}' could not be proven equivalent for recursive bodies: ${uniqueStrings(reasons).join("; ")}`,
  };
}

function proveSharedRecursiveMeasureDecreases(
  fnName: string,
  baseline: SymbolicFunctionSummary,
  refined: SymbolicFunctionSummary,
  measure: ScalarExpr,
  solverOptions: Z3RunOptions,
): { ok: true } | { ok: false; message: string } {
  const sites = [
    ...baseline.analysis.recSites.map((site, index) => ({
      label: `baseline site ${index + 1}`,
      summary: baseline,
      site,
    })),
    ...refined.analysis.recSites.map((site, index) => ({
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

    const result = checkSat(query.query.baseLines, solverOptions);
    if (!result.ok) {
      return {
        ok: false,
        message: result.timedOut
          ? `ref '${fnName}' timed out while checking recursive rad '${renderSharedScalarExpr(measure)}': ${result.error}`
          : `ref '${fnName}' could not invoke z3 while checking recursive rad '${renderSharedScalarExpr(measure)}': ${result.error}`,
      };
    }
    if (result.status === "unsat") {
      continue;
    }
    if (result.status === "sat") {
      const witness = queryCounterexample(query.query, solverOptions);
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
  summary: SymbolicFunctionSummary,
  site: IrRecSite,
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

function proveRecursiveStepEquivalence(
  fnName: string,
  baselineProgram: IRProgram,
  refinedProgram: IRProgram,
  baseline: SymbolicFunctionSummary,
  refined: SymbolicFunctionSummary,
  measure: ScalarExpr,
  solverOptions: Z3RunOptions,
): RefinementCheck {
  const comparisonEnv = buildComparisonEnvFromParams(baseline.fn.params);
  const baselineResult = normalizeValueForComparison(baseline.analysis.result, comparisonEnv);
  const refinedResult = normalizeValueForComparison(refined.analysis.result, comparisonEnv);
  const lines = buildJplScalarPrelude();
  const smtState = createSmtEncodingState();
  const smtOverrides: EmitOverrides = { smt: smtState };

  const callSigs = new Map([...baseline.analysis.callSigs, ...refined.analysis.callSigs]);
  const vars = new Map<string, "int" | "float">();
  collectValueVars(baselineResult, vars);
  collectValueVars(refinedResult, vars);
  collectValueVars({ kind: "scalar", expr: measure }, vars);
  for (const value of baseline.analysis.paramValues.values()) {
    collectValueVars(value, vars);
  }
  for (const value of refined.analysis.paramValues.values()) {
    collectValueVars(value, vars);
  }
  for (const site of [...baseline.analysis.recSites, ...refined.analysis.recSites]) {
    if (site.currentRes) {
      collectValueVars(site.currentRes, vars);
    }
    for (const value of site.argValues.values()) {
      collectValueVars(value, vars);
    }
  }

  for (const [name, tag] of vars) {
    lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
    const paramType = baseline.fn.params.find((param) => param.name === name)?.type
      ?? refined.fn.params.find((param) => param.name === name)?.type;
    if (paramType) {
      appendScalarTypeConstraints(lines, name, paramType);
    } else if (tag === "int") {
      lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
      lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
    }
  }

  const hypotheses = buildRecursiveHypotheses([baseline, refined], callSigs, solverOptions);

  for (const [name, sig] of callSigs) {
    const domain = sig.args.map((arg) => (arg === "int" ? "Int" : "Real")).join(" ");
    const sort = sig.ret === "int" ? "Int" : "Real";
    lines.push(`(declare-fun ${sanitize(name)} (${domain}) ${sort})`);
  }

  const overridesResult = buildRecursiveEmitOverrides([baseline, refined], hypotheses, smtOverrides);
  if (!overridesResult.ok) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' could not be proven equivalent: ${overridesResult.reason}`,
    };
  }

  const equality = emitValueEquality(
    baselineResult,
    refinedResult,
    baseline.fn.retType,
    overridesResult.overrides,
  );
  if (!equality) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' could not be proven equivalent: recursive symbolic equality could not encode return type '${baseline.fn.retType.tag}'`,
    };
  }

  appendSmtEncodingState(lines, smtState);
  lines.push(`(assert (not ${equality}))`);

  const result = checkSat(lines, solverOptions);
  if (!result.ok) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: result.timedOut
        ? `ref '${fnName}' timed out during recursive refinement proof: ${result.error}`
        : `ref '${fnName}' could not invoke z3 for recursive refinement proof: ${result.error}`,
    };
  }
  if (result.status === "unsat") {
    return {
      ok: true,
      method: "symbolic_recursive_induction",
      detail: `proved recursive symbolic equivalence by induction on rad '${renderSharedScalarExpr(measure)}'`,
      equivalence: `shared rad '${renderSharedScalarExpr(measure)}' closes all recursive sites and aligns the inductive step`,
    };
  }
  if (result.status === "sat") {
    if (baseline.fn.params.every((param) => param.type.tag === "int")) {
      const values = runtimeIntCounterexampleInputs(lines, baseline.fn.params, solverOptions);
      const runtimeCounterexample = values && canTryRuntimeRecursiveCounterexample(baseline, values)
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
      const witness = buildSymbolicCounterexample(lines, baseline.fn.params, solverOptions);
      return {
        ok: false,
        code: "REF_UNPROVEN",
        message: `ref '${fnName}' did not admit an inductive proof for rad '${renderSharedScalarExpr(measure)}'${witness ? `; witness: ${witness}` : ""}`,
      };
    }
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' did not admit a symbolic inductive proof for rad '${renderSharedScalarExpr(measure)}'`,
    };
  }
  return {
    ok: false,
    code: "REF_UNPROVEN",
    message: `ref '${fnName}' could not be proven equivalent: z3 returned '${result.output || "unknown"}' for the recursive inductive step`,
  };
}

function emitRecursiveCollapse(summary: SymbolicFunctionSummary, site: IrRecSite, overrides: EmitOverrides = {}): string | null {
  const clauses: string[] = [];
  for (let i = 0; i < summary.fn.params.length; i += 1) {
    const param = summary.fn.params[i]!;
    const current = summary.analysis.paramValues.get(param.name);
    const next = site.argValues.get(i);
    if (!current || !next) {
      return null;
    }
    const equality = emitValueEquality(current, next, param.type, overrides);
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

type CallOverrideHandler = (expr: Extract<ScalarExpr, { tag: "call" }>, overrides: EmitOverrides) => string | null;

function buildRecursiveEmitOverrides(
  summaries: SymbolicFunctionSummary[],
  hypotheses: Map<IrRecSite, SymValue>,
  seedOverrides: EmitOverrides = {},
): { ok: true; overrides: EmitOverrides } | { ok: false; reason: string } {
  const handlers = new Map<string, CallOverrideHandler>();

  for (const summary of summaries) {
    for (const site of summary.analysis.recSites) {
      if (site.issues.length > 0) {
        return { ok: false, reason: site.issues.join("; ") };
      }
      if (!site.currentRes) {
        return { ok: false, reason: `rec site ${site.stmtIndex + 1} has no current 'res' semantics to collapse against` };
      }
      const hypothesis = hypotheses.get(site);
      if (!hypothesis) {
        return { ok: false, reason: `missing recursive hypothesis for site ${site.stmtIndex + 1}` };
      }
      const collapse = emitRecursiveCollapse(summary, site, seedOverrides);
      if (!collapse) {
        return { ok: false, reason: `could not encode recursive collapse test for site ${site.stmtIndex + 1}` };
      }
      const problem = registerRecursiveValueBindings(site.resultValue, site.currentRes, hypothesis, collapse, handlers);
      if (problem) {
        return { ok: false, reason: problem };
      }
    }
  }

  const cache = new Map<string, string>();
  const active = new Set<string>();
  const overrides: EmitOverrides = {
    ...seedOverrides,
    onCall: (expr) => {
      const seeded = seedOverrides.onCall?.(expr);
      if (seeded !== null && seeded !== undefined) {
        return seeded;
      }
      const handler = handlers.get(expr.name);
      if (!handler) {
        return null;
      }
      const key = `${expr.name}(${expr.args.map((arg) => renderSharedScalarExpr(arg)).join(",")})`;
      if (cache.has(key)) {
        return cache.get(key)!;
      }
      if (active.has(key)) {
        return null;
      }
      active.add(key);
      const rendered = handler(expr, overrides);
      active.delete(key);
      if (rendered !== null) {
        cache.set(key, rendered);
      }
      return rendered;
    },
  };
  return { ok: true, overrides };
}

type RecursiveSiteEntry = {
  summary: SymbolicFunctionSummary;
  site: IrRecSite;
};

function buildRecursiveHypotheses(
  summaries: SymbolicFunctionSummary[],
  callSigs: Map<string, { args: ScalarTag[]; ret: ScalarTag }>,
  solverOptions: Z3RunOptions,
): Map<IrRecSite, SymValue> {
  const entries: RecursiveSiteEntry[] = summaries.flatMap((summary) =>
    summary.analysis.recSites.map((site) => ({ summary, site })));
  const classes: Array<{ representative: RecursiveSiteEntry; hypothesis: SymValue }> = [];
  const hypotheses = new Map<IrRecSite, SymValue>();

  for (const entry of entries) {
    let hypothesis: SymValue | null = null;
    for (const group of classes) {
      if (recursiveArgTuplesEquivalent(entry, group.representative, callSigs, solverOptions)) {
        hypothesis = group.hypothesis;
        break;
      }
    }
    if (!hypothesis) {
      hypothesis = symbolizeAbstractValue(
        entry.summary.fn.retType,
        `jplmm_h_${classes.length}`,
        [],
        callSigs,
        entry.summary.structDefs,
      );
      classes.push({ representative: entry, hypothesis });
    }
    hypotheses.set(entry.site, hypothesis);
  }

  return hypotheses;
}

function recursiveArgTuplesEquivalent(
  left: RecursiveSiteEntry,
  right: RecursiveSiteEntry,
  callSigs: Map<string, { args: ScalarTag[]; ret: ScalarTag }>,
  solverOptions: Z3RunOptions,
): boolean {
  if (left.summary.fn.params.length !== right.summary.fn.params.length) {
    return false;
  }

  const smtState = createSmtEncodingState();
  const smtOverrides: EmitOverrides = { smt: smtState };
  const clauses: string[] = [];
  for (let i = 0; i < left.summary.fn.params.length; i += 1) {
    const leftArg = left.site.argValues.get(i);
    const rightArg = right.site.argValues.get(i);
    const paramType = left.summary.fn.params[i]!.type;
    if (!leftArg || !rightArg) {
      return false;
    }
    const equality = emitValueEquality(leftArg, rightArg, paramType, smtOverrides);
    if (!equality) {
      return false;
    }
    clauses.push(equality);
  }

  if (clauses.length === 0) {
    return true;
  }

  const lines = buildJplScalarPrelude();
  for (const [name, sig] of callSigs) {
    const domain = sig.args.map((arg) => (arg === "int" ? "Int" : "Real")).join(" ");
    const sort = sig.ret === "int" ? "Int" : "Real";
    lines.push(`(declare-fun ${sanitize(name)} (${domain}) ${sort})`);
  }

  const vars = new Map<string, "int" | "float">();
  for (const value of left.site.argValues.values()) {
    collectValueVars(value, vars);
  }
  for (const value of right.site.argValues.values()) {
    collectValueVars(value, vars);
  }

  for (const [name, tag] of vars) {
    lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
    const paramType = left.summary.fn.params.find((param) => param.name === name)?.type
      ?? right.summary.fn.params.find((param) => param.name === name)?.type;
    if (paramType) {
      appendScalarTypeConstraints(lines, name, paramType);
    } else if (tag === "int") {
      lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
      lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
    }
  }

  appendSmtEncodingState(lines, smtState);
  const conjunction = clauses.length === 1 ? clauses[0]! : `(and ${clauses.join(" ")})`;
  lines.push(`(assert (not ${conjunction}))`);

  const result = checkSat(lines, solverOptions);
  return result.ok && result.status === "unsat";
}

function registerRecursiveValueBindings(
  placeholder: SymValue,
  current: SymValue,
  hypothesis: SymValue,
  collapse: string,
  handlers: Map<string, CallOverrideHandler>,
): string | null {
  if (placeholder.kind === "scalar") {
    if (placeholder.expr.tag !== "call" || placeholder.expr.interpreted || current.kind !== "scalar" || hypothesis.kind !== "scalar") {
      return "recursive scalar placeholder does not lower to a symbolic call";
    }
    handlers.set(placeholder.expr.name, (_expr, overrides) =>
      `(ite ${collapse} ${emitScalarWithOverrides(current.expr, overrides)} ${emitScalarWithOverrides(hypothesis.expr, overrides)})`);
    return null;
  }
  if (placeholder.kind === "array") {
    if (current.kind !== "array" || hypothesis.kind !== "array") {
      return "recursive array placeholder does not align with array-valued current/hypothesis results";
    }
    return registerRecursiveArrayBindings(placeholder.array, current.array, hypothesis.array, collapse, handlers);
  }
  if (placeholder.kind === "struct") {
    if (current.kind !== "struct" || hypothesis.kind !== "struct" || current.typeName !== placeholder.typeName || hypothesis.typeName !== placeholder.typeName) {
      return "recursive struct placeholder does not align with current/hypothesis struct results";
    }
    for (let i = 0; i < placeholder.fields.length; i += 1) {
      const field = placeholder.fields[i]!;
      const currentField = current.fields[i];
      const hypothesisField = hypothesis.fields[i];
      if (!currentField || !hypothesisField || currentField.name !== field.name || hypothesisField.name !== field.name) {
        return `recursive struct field '${field.name}' could not be aligned`;
      }
      const nested = registerRecursiveValueBindings(field.value, currentField.value, hypothesisField.value, collapse, handlers);
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  if (placeholder.kind === "void") {
    return current.kind === "void" && hypothesis.kind === "void"
      ? null
      : "recursive void placeholder does not align with current/hypothesis values";
  }
  return "opaque recursive results are not supported by the symbolic induction prover";
}

function registerRecursiveArrayBindings(
  placeholder: SymArray,
  current: SymArray,
  hypothesis: SymArray,
  collapse: string,
  handlers: Map<string, CallOverrideHandler>,
): string | null {
  if (placeholder.tag !== "abstract") {
    return "recursive array placeholder does not lower to abstract closure semantics";
  }
  const currentDims = arrayDims(current);
  const hypothesisDims = arrayDims(hypothesis);
  if (!currentDims || !hypothesisDims || currentDims.length !== placeholder.dims.length || hypothesisDims.length !== placeholder.dims.length) {
    return "recursive array placeholder dimensions could not be aligned";
  }
  const placeholderType = placeholder.arrayType;
  if (placeholderType.tag !== "array") {
    return "recursive array placeholder lost its array type during symbolic lowering";
  }
  for (let i = 0; i < placeholder.dims.length; i += 1) {
    const dimCall = placeholder.dims[i]!;
    if (dimCall.tag !== "call" || dimCall.interpreted) {
      return "recursive array dimension placeholder is not abstract";
    }
    const currentDim = currentDims[i]!;
    const hypothesisDim = hypothesisDims[i]!;
    handlers.set(dimCall.name, (_expr, overrides) =>
      `(ite ${collapse} ${emitScalarWithOverrides(currentDim, overrides)} ${emitScalarWithOverrides(hypothesisDim, overrides)})`);
  }
  return registerRecursiveArrayLeafBindings(
    placeholder,
    current,
    hypothesis,
    collapse,
    placeholder.leafModel,
    placeholderType.element,
    [],
    handlers,
  );
}

function registerRecursiveArrayLeafBindings(
  placeholder: Extract<SymArray, { tag: "abstract" }>,
  current: SymArray,
  hypothesis: SymArray,
  collapse: string,
  model: Extract<SymArray, { tag: "abstract" }>["leafModel"],
  rootType: Type,
  path: string[],
  handlers: Map<string, CallOverrideHandler>,
): string | null {
  if (model.kind === "scalar") {
    handlers.set(model.readName, (expr, overrides) => {
      const indices = expr.args.slice(placeholder.args.length);
      const currentRead = projectValuePath(readSymbolicArray(current, indices, rootType, -1, -1), path);
      const hypothesisRead = projectValuePath(readSymbolicArray(hypothesis, indices, rootType, -1, -1), path);
      if (currentRead?.kind !== "scalar" || hypothesisRead?.kind !== "scalar") {
        return null;
      }
      return `(ite ${collapse} ${emitScalarWithOverrides(currentRead.expr, overrides)} ${emitScalarWithOverrides(hypothesisRead.expr, overrides)})`;
    });
    return null;
  }
  if (model.kind === "struct") {
    for (const field of model.fields) {
      const nested = registerRecursiveArrayLeafBindings(
        placeholder,
        current,
        hypothesis,
        collapse,
        field.model,
        rootType,
        [...path, field.name],
        handlers,
      );
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  return "opaque array leaves are not supported by the symbolic induction prover";
}

function projectValuePath(value: SymValue, path: string[]): SymValue | null {
  let current: SymValue | null = value;
  for (const fieldName of path) {
    if (!current || current.kind !== "struct") {
      return null;
    }
    let next: SymValue | null = null;
    for (const candidate of current.fields) {
      if (candidate.name === fieldName) {
        next = candidate.value;
        break;
      }
    }
    current = next;
  }
  return current;
}

function proveSymbolicSummaryEquivalence(
  fnName: string,
  baseline: SymbolicFunctionSummary,
  refined: SymbolicFunctionSummary,
  solverOptions: Z3RunOptions,
): RefinementCheck {
  const comparisonEnv = buildComparisonEnvFromParams(baseline.fn.params);
  const baselineResult = normalizeValueForComparison(baseline.analysis.result, comparisonEnv);
  const refinedResult = normalizeValueForComparison(refined.analysis.result, comparisonEnv);
  const baselineSexpr = emitValueSexpr(baselineResult);
  const refinedSexpr = emitValueSexpr(refinedResult);
  if (baselineSexpr === refinedSexpr) {
    return {
      ok: true,
      method: "symbolic_value_alpha",
      detail: "shared symbolic values are syntactically identical after helper specialization",
      equivalence: `${renderValueExpr(baselineResult)} == ${renderValueExpr(refinedResult)}`,
    };
  }

  const smtState = createSmtEncodingState();
  const smtOverrides: EmitOverrides = { smt: smtState };
  const equality = emitValueEquality(
    baselineResult,
    refinedResult,
    baseline.fn.retType,
    smtOverrides,
  );
  if (!equality) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: `ref '${fnName}' could not be proven equivalent: shared symbolic equality could not encode return type '${baseline.fn.retType.tag}'`,
    };
  }

  const lines = buildJplScalarPrelude();
  const callSigs = new Map([...baseline.analysis.callSigs, ...refined.analysis.callSigs]);
  for (const [name, sig] of callSigs) {
    const domain = sig.args.map((arg) => (arg === "int" ? "Int" : "Real")).join(" ");
    const sort = sig.ret === "int" ? "Int" : "Real";
    lines.push(`(declare-fun ${sanitize(name)} (${domain}) ${sort})`);
  }

  const vars = new Map<string, "int" | "float">();
  collectValueVars(baselineResult, vars);
  collectValueVars(refinedResult, vars);

  for (const [name, tag] of vars) {
    lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
    const paramType = baseline.fn.params.find((param) => param.name === name)?.type
      ?? refined.fn.params.find((param) => param.name === name)?.type;
    if (paramType) {
      appendScalarTypeConstraints(lines, name, paramType);
    } else if (tag === "int") {
      lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
      lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
    }
  }

  appendSmtEncodingState(lines, smtState);
  lines.push(`(assert (not ${equality}))`);

  const result = checkSat(lines, solverOptions);
  if (!result.ok) {
    return {
      ok: false,
      code: "REF_UNPROVEN",
      message: result.timedOut
        ? `ref '${fnName}' timed out during shared symbolic equivalence proof: ${result.error}`
        : `ref '${fnName}' could not invoke z3: ${result.error}`,
    };
  }
  if (result.status === "unsat") {
    return {
      ok: true,
      method: "symbolic_value_smt",
      detail: "proved shared symbolic value equivalence with Z3",
      equivalence: `${renderValueExpr(baselineResult)} == ${renderValueExpr(refinedResult)}`,
    };
  }
  if (result.status === "sat") {
    const counterexample = buildSymbolicCounterexample(lines, baseline.fn.params, solverOptions);
    return {
      ok: false,
      code: "REF_MISMATCH",
      message: counterexample
        ? `ref '${fnName}' is not equivalent: ${counterexample}`
        : `ref '${fnName}' is not equivalent: z3 found a counterexample in the shared symbolic model`,
    };
  }
  return {
    ok: false,
    code: "REF_UNPROVEN",
    message: `ref '${fnName}' could not be proven equivalent: z3 returned '${result.output || "unknown"}'`,
  };
}

function buildSymbolicCounterexample(
  lines: string[],
  params: Param[],
  solverOptions: Z3RunOptions,
): string | null {
  const querySymbols = params
    .filter((param) => param.type.tag === "int" || param.type.tag === "float")
    .map((param) => ({
      symbol: sanitize(param.name),
      label: param.name,
    }));
  if (querySymbols.length === 0) {
    return null;
  }
  return queryCounterexample(
    {
      baseLines: lines,
      querySymbols,
    },
    solverOptions,
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function canTryRuntimeRecursiveCounterexample(
  summary: SymbolicFunctionSummary,
  values: Map<string, number>,
): boolean {
  if (summary.analysis.recSites.length !== 1) {
    return false;
  }
  return summary.fn.params.every((param) => {
    if (param.type.tag !== "int") {
      return false;
    }
    return Math.abs(values.get(param.name) ?? 0) <= 256;
  });
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
    return `${formatModelAssignments(paramNames, values) ?? "counterexample"}; baseline=${renderRuntimeValue(baselineValue)}, ref=${renderRuntimeValue(refinedValue)}`;
  }
  return null;
}

function runtimeIntCounterexampleInputs(
  lines: string[],
  params: Param[],
  solverOptions: Z3RunOptions,
): Map<string, number> | null {
  return queryIntModelValues(lines, params.map((param) => param.name), solverOptions);
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
