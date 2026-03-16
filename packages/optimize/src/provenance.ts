import type { IRExpr, IRProgram } from "@jplmm/ir";

import type { ExprProvenance, ProvenanceStage, SerializedExprProvenance } from "./types";

export function buildExprProvenance(
  input: IRProgram,
  output: IRProgram,
  stage: ProvenanceStage = "canonicalize",
): ExprProvenance {
  const inputIds = new Set<number>();
  const inputTags = new Map<number, IRExpr["tag"]>();
  for (const global of input.globals) {
    collectExprIds(global.expr, inputIds, inputTags);
  }
  for (const fn of input.functions) {
    for (const stmt of fn.body) {
      if (stmt.tag !== "gas") {
        collectExprIds(stmt.expr, inputIds, inputTags);
      }
    }
  }

  const byOutputExprId = new Map<number, {
    sourceExprIds: number[];
    status: "preserved" | "rewritten" | "generated";
    rule: string | null;
  }>();
  for (const global of output.globals) {
    assignExprProvenance(global.expr, inputIds, inputTags, byOutputExprId, stage);
  }
  for (const fn of output.functions) {
    for (const stmt of fn.body) {
      if (stmt.tag !== "gas") {
        assignExprProvenance(stmt.expr, inputIds, inputTags, byOutputExprId, stage);
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
        .map(([exprId, entry]) => [
          String(exprId),
          {
            sourceExprIds: [...entry.sourceExprIds].sort((left, right) => left - right),
            status: entry.status,
            rule: entry.rule,
          },
        ]),
    ),
  };
}

function assignExprProvenance(
  expr: IRExpr,
  inputIds: Set<number>,
  inputTags: Map<number, IRExpr["tag"]>,
  byOutputExprId: Map<number, {
    sourceExprIds: number[];
    status: "preserved" | "rewritten" | "generated";
    rule: string | null;
  }>,
  stage: ProvenanceStage,
): number[] {
  const existing = byOutputExprId.get(expr.id);
  if (existing) {
    return existing.sourceExprIds;
  }

  const direct = inputIds.has(expr.id) ? [expr.id] : null;
  const childSources = new Set<number>();
  for (const child of exprChildren(expr)) {
    for (const sourceId of assignExprProvenance(child, inputIds, inputTags, byOutputExprId, stage)) {
      childSources.add(sourceId);
    }
  }
  const sources = direct ?? [...childSources].sort((left, right) => left - right);
  const inputTag = direct ? inputTags.get(expr.id) ?? null : null;
  const status = direct
    ? inputTag === expr.tag
      ? "preserved"
      : "rewritten"
    : "generated";
  byOutputExprId.set(expr.id, {
    sourceExprIds: sources,
    status,
    rule: inferProvenanceRule(stage, expr, status, inputTag),
  });
  return sources;
}

function inferProvenanceRule(
  stage: ProvenanceStage,
  expr: IRExpr,
  status: "preserved" | "rewritten" | "generated",
  inputTag: IRExpr["tag"] | null,
): string | null {
  if (stage === "identity") {
    return status === "preserved" ? "identity_preserve" : "identity_reuse";
  }
  if (stage === "guard_elimination") {
    return status === "preserved"
      ? "guard_preserve"
      : mapExprTagToRule(expr.tag, "guard");
  }
  if (stage === "ast_lowering") {
    if (expr.tag === "var" && expr.name.startsWith("jplmm_dim_")) {
      return "lower_bind_array_extent";
    }
    if (status === "preserved" && inputTag === expr.tag) {
      return "ast_preserve";
    }
    return mapExprTagToRule(expr.tag, "lower");
  }
  if (status === "preserved" && inputTag === expr.tag) {
    return "canonicalize_preserve";
  }
  return mapExprTagToRule(expr.tag, "canonicalize");
}

function mapExprTagToRule(
  tag: IRExpr["tag"],
  prefix: "lower" | "canonicalize" | "guard",
): string {
  switch (tag) {
    case "total_div":
      return `${prefix}_total_div`;
    case "total_mod":
      return `${prefix}_total_mod`;
    case "nan_to_zero":
      return `${prefix}_nan_to_zero`;
    case "sat_add":
      return `${prefix}_sat_add`;
    case "sat_sub":
      return `${prefix}_sat_sub`;
    case "sat_mul":
      return `${prefix}_sat_mul`;
    case "sat_neg":
      return `${prefix}_sat_neg`;
    case "call":
      return `${prefix}_call_rewrite`;
    case "array_expr":
      return `${prefix}_array_expr`;
    case "sum_expr":
      return `${prefix}_sum_expr`;
    default:
      return `${prefix}_rewrite`;
  }
}

function collectExprIds(expr: IRExpr, ids: Set<number>, tags: Map<number, IRExpr["tag"]>): void {
  if (ids.has(expr.id)) {
    return;
  }
  ids.add(expr.id);
  tags.set(expr.id, expr.tag);
  for (const child of exprChildren(expr)) {
    collectExprIds(child, ids, tags);
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
