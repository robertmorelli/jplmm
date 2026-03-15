import type { Cmd, Expr, Program, Stmt } from "@jplmm/ast";
import type { RefinementReport } from "@jplmm/frontend";
import type { FunctionMetrics, VerificationDiagnostic } from "@jplmm/verify";

type SourceFunctionSite = {
  name: string;
  start: number;
  end: number;
};

export type FunctionMetricAnnotation = {
  name: string;
  start: number;
  end: number;
  label: string;
};

export type FunctionRefinementAnnotation = {
  name: string;
  start: number;
  end: number;
  label: string;
};

export type OutResultAnnotation = {
  offset: number;
  label: string;
  tooltip: string;
};

export function collectFunctionMetricAnnotations(
  program: Program,
  metrics: Map<string, FunctionMetrics>,
): FunctionMetricAnnotation[] {
  const annotations: FunctionMetricAnnotation[] = [];

  for (const cmd of program.commands) {
    const fn = unwrapTimedFnDef(cmd);
    if (!fn) {
      continue;
    }
    const metric = metrics.get(fn.name);
    if (!metric) {
      continue;
    }
    annotations.push({
      name: fn.name,
      start: fn.start ?? 0,
      end: fn.end ?? fn.start ?? 0,
      label: `complexity ${metric.sourceComplexity} | 100% line coverage via ${metric.canonicalWitness}`,
    });
  }

  return annotations;
}

export function collectSourceFunctionMetricAnnotations(
  functions: ReadonlyArray<SourceFunctionSite>,
  metrics: Map<string, FunctionMetrics>,
): FunctionMetricAnnotation[] {
  return functions.flatMap((fn) => {
    const metric = metrics.get(fn.name);
    if (!metric) {
      return [];
    }
    return [{
      name: fn.name,
      start: fn.start,
      end: fn.end,
      label: `complexity ${metric.sourceComplexity} | 100% line coverage via ${metric.canonicalWitness}`,
    }];
  });
}

export function collectFunctionRefinementAnnotations(refinements: RefinementReport[]): FunctionRefinementAnnotation[] {
  const annotations: FunctionRefinementAnnotation[] = [];
  for (const refinement of refinements) {
    if (refinement.baselineStart !== undefined) {
      annotations.push({
        name: refinement.fnName,
        start: refinement.baselineStart,
        end: refinement.baselineEnd ?? refinement.baselineStart,
        label: baselineRefinementLabel(refinement),
      });
    }
    if (refinement.refStart !== undefined) {
      annotations.push({
        name: refinement.fnName,
        start: refinement.refStart,
        end: refinement.refEnd ?? refinement.refStart,
        label: refinementLabel(refinement),
      });
    }
  }
  return annotations;
}

export function canAnnotateInlineOutResults(program: Program): boolean {
  let hasShow = false;

  for (const cmd of program.commands) {
    if (cmd.tag === "fn_def" || cmd.tag === "struct_def") {
      continue;
    }
    if (cmd.tag === "time" && (cmd.cmd.tag === "fn_def" || cmd.cmd.tag === "struct_def")) {
      continue;
    }
    if (cmd.tag === "let_cmd") {
      continue;
    }
    if (cmd.tag === "show") {
      hasShow = true;
      continue;
    }
    return false;
  }

  return hasShow;
}

export function buildOutResultAnnotations(program: Program, output: string[]): OutResultAnnotation[] {
  if (!canAnnotateInlineOutResults(program)) {
    return [];
  }

  const showCmds = program.commands.filter((cmd): cmd is Extract<Cmd, { tag: "show" }> => cmd.tag === "show");

  if (showCmds.length === 0 || showCmds.length !== output.length) {
    return [];
  }

  return showCmds.map((cmd, index) => ({
    offset: cmd.expr.end ?? cmd.end ?? cmd.start ?? 0,
    label: `=> ${output[index] ?? ""}`,
    tooltip: "Inline result from a safe editor run of top-level out commands.",
  }));
}

export function findVerificationDiagnosticAnchor(
  program: Program,
  diagnostic: VerificationDiagnostic,
): { start?: number; end?: number } | null {
  const fn = findFunctionByName(program, diagnostic.fnName);
  if (!fn) {
    return null;
  }
  if (diagnostic.code === "VERIFY_GAS_INF") {
    return fn.body.find((stmt) => stmt.tag === "gas" && stmt.limit === "inf") ?? fn;
  }
  if (diagnostic.code === "VERIFY_PROOF_FAIL") {
    return findLastRadStatement(fn.body) ?? findFirstRecInStatements(fn.body) ?? fn;
  }
  return findFirstRecInStatements(fn.body) ?? fn;
}

function findFunctionByName(program: Program, fnName: string): Extract<Cmd, { tag: "fn_def" }> | null {
  for (const cmd of program.commands) {
    const fn = unwrapTimedFnDef(cmd);
    if (fn && fn.name === fnName) {
      return fn;
    }
  }
  return null;
}

function refinementLabel(refinement: RefinementReport): string {
  if (refinement.status === "equivalent") {
    return `valid refinement${refinement.method ? ` via ${renderRefinementMethod(refinement.method)}` : ""}`;
  }
  if (refinement.status === "mismatch") {
    return "refinement mismatch";
  }
  if (refinement.status === "unproven") {
    return "refinement unproven";
  }
  return "invalid refinement";
}

function baselineRefinementLabel(refinement: RefinementReport): string {
  if (refinement.status === "equivalent") {
    return `refined by later ref${refinement.method ? ` via ${renderRefinementMethod(refinement.method)}` : ""}`;
  }
  if (refinement.status === "mismatch") {
    return "later ref mismatched";
  }
  if (refinement.status === "unproven") {
    return "later ref unproven";
  }
  return "later ref invalid";
}

function renderRefinementMethod(method: NonNullable<RefinementReport["method"]>): string {
  switch (method) {
    case "canonical":
      return "canonical equivalence";
    case "exact_zero_arity":
      return "exact execution";
    case "symbolic_value_alpha":
      return "shared symbolic identity";
    case "symbolic_value_smt":
      return "shared symbolic SMT";
    case "symbolic_recursive_induction":
      return "recursive induction";
    default:
      return method;
  }
}

function unwrapTimedFnDef(cmd: Cmd): Extract<Cmd, { tag: "fn_def" }> | null {
  if (cmd.tag === "fn_def") {
    return cmd;
  }
  if (cmd.tag === "time" && cmd.cmd.tag === "fn_def") {
    return cmd.cmd;
  }
  return null;
}

function findLastRadStatement(stmts: Stmt[]): Extract<Stmt, { tag: "rad" }> | null {
  let found: Extract<Stmt, { tag: "rad" }> | null = null;
  for (const stmt of stmts) {
    if (stmt.tag === "rad") {
      found = stmt;
    }
  }
  return found;
}

function findFirstRecInStatements(stmts: Stmt[]): { start?: number; end?: number } | null {
  for (const statement of stmts) {
    if (statement.tag === "let" || statement.tag === "ret" || statement.tag === "rad") {
      const rec = findFirstRecInExpr(statement.expr);
      if (rec) {
        return rec;
      }
    }
  }
  return null;
}

function findFirstRecInExpr(expr: Expr): { start?: number; end?: number } | null {
  if (expr.tag === "rec") {
    return expr;
  }
  switch (expr.tag) {
    case "binop":
      return findFirstRecInExpr(expr.left) ?? findFirstRecInExpr(expr.right);
    case "unop":
      return findFirstRecInExpr(expr.operand);
    case "call":
      return firstNonNull(expr.args, findFirstRecInExpr);
    case "index":
      return findFirstRecInExpr(expr.array) ?? firstNonNull(expr.indices, findFirstRecInExpr);
    case "field":
      return findFirstRecInExpr(expr.target);
    case "struct_cons":
      return firstNonNull(expr.fields, findFirstRecInExpr);
    case "array_cons":
      return firstNonNull(expr.elements, findFirstRecInExpr);
    case "array_expr":
    case "sum_expr":
      return firstNonNull(expr.bindings, (binding) => findFirstRecInExpr(binding.expr)) ?? findFirstRecInExpr(expr.body);
    case "int_lit":
    case "float_lit":
    case "void_lit":
    case "var":
    case "res":
      return null;
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}

function firstNonNull<T>(
  items: T[],
  map: (item: T) => { start?: number; end?: number } | null,
): { start?: number; end?: number } | null {
  for (const item of items) {
    const value = map(item);
    if (value) {
      return value;
    }
  }
  return null;
}
