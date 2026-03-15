import type { IRExpr, IRProgram } from "@jplmm/ir";

import type { ExprProvenance, SerializedExprProvenance } from "./types";

export function buildExprProvenance(input: IRProgram, output: IRProgram): ExprProvenance {
  const inputIds = new Set<number>();
  for (const global of input.globals) {
    collectExprIds(global.expr, inputIds);
  }
  for (const fn of input.functions) {
    for (const stmt of fn.body) {
      if (stmt.tag !== "gas") {
        collectExprIds(stmt.expr, inputIds);
      }
    }
  }

  const byOutputExprId = new Map<number, number[]>();
  for (const global of output.globals) {
    assignExprProvenance(global.expr, inputIds, byOutputExprId);
  }
  for (const fn of output.functions) {
    for (const stmt of fn.body) {
      if (stmt.tag !== "gas") {
        assignExprProvenance(stmt.expr, inputIds, byOutputExprId);
      }
    }
  }
  return { byOutputExprId };
}

export function serializeExprProvenance(provenance: ExprProvenance): SerializedExprProvenance {
  return {
    byOutputExprId: Object.fromEntries(
      [...provenance.byOutputExprId.entries()]
        .sort(([left], [right]) => left - right)
        .map(([exprId, sources]) => [String(exprId), [...sources].sort((left, right) => left - right)]),
    ),
  };
}

function assignExprProvenance(
  expr: IRExpr,
  inputIds: Set<number>,
  byOutputExprId: Map<number, number[]>,
): number[] {
  const existing = byOutputExprId.get(expr.id);
  if (existing) {
    return existing;
  }

  const direct = inputIds.has(expr.id) ? [expr.id] : null;
  const childSources = new Set<number>();
  for (const child of exprChildren(expr)) {
    for (const sourceId of assignExprProvenance(child, inputIds, byOutputExprId)) {
      childSources.add(sourceId);
    }
  }
  const sources = direct ?? [...childSources].sort((left, right) => left - right);
  byOutputExprId.set(expr.id, sources);
  return sources;
}

function collectExprIds(expr: IRExpr, ids: Set<number>): void {
  if (ids.has(expr.id)) {
    return;
  }
  ids.add(expr.id);
  for (const child of exprChildren(expr)) {
    collectExprIds(child, ids);
  }
}

function exprChildren(expr: IRExpr): IRExpr[] {
  switch (expr.tag) {
    case "int_lit":
    case "float_lit":
    case "void_lit":
    case "var":
    case "res":
      return [];
    case "unop":
    case "sat_neg":
      return [expr.operand];
    case "nan_to_zero":
      return [expr.value];
    case "binop":
    case "total_div":
    case "total_mod":
    case "sat_add":
    case "sat_sub":
    case "sat_mul":
      return [expr.left, expr.right];
    case "call":
      return [...expr.args];
    case "index":
      return [expr.array, ...expr.indices];
    case "field":
      return [expr.target];
    case "struct_cons":
      return [...expr.fields];
    case "array_cons":
      return [...expr.elements];
    case "array_expr":
    case "sum_expr":
      return [...expr.bindings.map((binding) => binding.expr), expr.body];
    case "rec":
      return [...expr.args];
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}
