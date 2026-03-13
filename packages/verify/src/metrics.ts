import type { Cmd, Expr, Program, StructField, Type } from "@jplmm/ast";

export type FunctionMetrics = {
  sourceComplexity: number;
  recSites: number;
  canonicalWitness: string;
  coarseTotalCallBound: string;
};

export function analyzeProgramMetrics(program: Program): Map<string, FunctionMetrics> {
  const metrics = new Map<string, FunctionMetrics>();
  const structDefs = collectStructDefs(program);

  for (const cmd of program.commands) {
    const fn = unwrapTimedDefinition(cmd, "fn_def");
    if (!fn) {
      continue;
    }
    const recSites = countRecSitesInFunction(fn.body);
    metrics.set(fn.name, {
      sourceComplexity: 1 + recSites,
      recSites,
      canonicalWitness: `${fn.name}(${fn.params.map((param) => renderCanonicalValue(param.type, structDefs)).join(", ")})`,
      coarseTotalCallBound: renderCoarseTotalCallBound(fn.body, recSites),
    });
  }

  return metrics;
}

function countRecSitesInFunction(body: Extract<Cmd, { tag: "fn_def" }>["body"]): number {
  let total = 0;
  for (const stmt of body) {
    switch (stmt.tag) {
      case "let":
      case "ret":
      case "rad":
        total += countRecSitesInExpr(stmt.expr);
        break;
      case "gas":
        break;
      default: {
        const _never: never = stmt;
        void _never;
      }
    }
  }
  return total;
}

function countRecSitesInExpr(expr: Expr): number {
  switch (expr.tag) {
    case "rec":
      return 1 + expr.args.reduce((sum, arg) => sum + countRecSitesInExpr(arg), 0);
    case "binop":
      return countRecSitesInExpr(expr.left) + countRecSitesInExpr(expr.right);
    case "unop":
      return countRecSitesInExpr(expr.operand);
    case "call":
      return expr.args.reduce((sum, arg) => sum + countRecSitesInExpr(arg), 0);
    case "index":
      return countRecSitesInExpr(expr.array) + expr.indices.reduce((sum, arg) => sum + countRecSitesInExpr(arg), 0);
    case "field":
      return countRecSitesInExpr(expr.target);
    case "struct_cons":
      return expr.fields.reduce((sum, arg) => sum + countRecSitesInExpr(arg), 0);
    case "array_cons":
      return expr.elements.reduce((sum, arg) => sum + countRecSitesInExpr(arg), 0);
    case "array_expr":
    case "sum_expr":
      return expr.bindings.reduce((sum, binding) => sum + countRecSitesInExpr(binding.expr), 0) + countRecSitesInExpr(expr.body);
    case "int_lit":
    case "float_lit":
    case "void_lit":
    case "var":
    case "res":
      return 0;
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}

function renderCanonicalValue(type: Type, structDefs: Map<string, StructField[]>): string {
  switch (type.tag) {
    case "int":
      return "0";
    case "float":
      return "0.0";
    case "void":
      return "void";
    case "array":
      return renderMinimalArray(type.element, type.dims, structDefs);
    case "named": {
      const fields = structDefs.get(type.name) ?? [];
      return `${type.name} { ${fields.map((field) => renderCanonicalValue(field.type, structDefs)).join(", ")} }`;
    }
    default: {
      const _never: never = type;
      return _never;
    }
  }
}

function renderMinimalArray(element: Type, dims: number, structDefs: Map<string, StructField[]>): string {
  const inner = dims === 1
    ? renderCanonicalValue(element, structDefs)
    : renderMinimalArray(element, dims - 1, structDefs);
  return `[${inner}]`;
}

function collectStructDefs(program: Program): Map<string, StructField[]> {
  const structs = new Map<string, StructField[]>();
  for (const cmd of program.commands) {
    const struct = unwrapTimedDefinition(cmd, "struct_def");
    if (struct) {
      structs.set(struct.name, struct.fields);
    }
  }
  return structs;
}

function renderCoarseTotalCallBound(
  body: Extract<Cmd, { tag: "fn_def" }>["body"],
  recSites: number,
): string {
  if (recSites === 0) {
    return "1";
  }

  const gasStmt = body.find((stmt) => stmt.tag === "gas");
  if (gasStmt) {
    if (gasStmt.limit === "inf") {
      return "unbounded (gas inf)";
    }
    return renderBranchingSeries(recSites, String(gasStmt.limit));
  }

  const hasRad = body.some((stmt) => stmt.tag === "rad");
  if (hasRad) {
    return renderBranchingSeries(recSites, "2^32");
  }

  return "unknown (no rad/gas)";
}

function renderBranchingSeries(recSites: number, depth: string): string {
  if (recSites <= 1) {
    return `${depth} + 1`;
  }
  return `sum_{i=0..${depth}} ${recSites}^i`;
}

function unwrapTimedDefinition<TTag extends "fn_def" | "struct_def">(
  cmd: Cmd,
  tag: TTag,
): Extract<Cmd, { tag: TTag }> | null {
  if (cmd.tag === tag) {
    return cmd as Extract<Cmd, { tag: TTag }>;
  }
  if (cmd.tag === "time" && cmd.cmd.tag === tag) {
    return cmd.cmd as Extract<Cmd, { tag: TTag }>;
  }
  return null;
}
