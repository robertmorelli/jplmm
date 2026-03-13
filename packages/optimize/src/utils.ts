import type { IRExpr, IRFunction, IRGlobalLet, IRProgram, IRStmt } from "@jplmm/ir";

export function mapProgramExprs(
  program: IRProgram,
  visit: (expr: IRExpr) => IRExpr,
): IRProgram {
  return {
    structs: program.structs,
    globals: program.globals.map((g) => mapGlobal(g, visit)),
    functions: program.functions.map((fn) => mapFunction(fn, visit)),
  };
}

export function mapFunction(
  fn: IRFunction,
  visit: (expr: IRExpr) => IRExpr,
): IRFunction {
  return {
    ...fn,
    body: fn.body.map((stmt) => mapStmt(stmt, visit)),
  };
}

export function mapStmt(stmt: IRStmt, visit: (expr: IRExpr) => IRExpr): IRStmt {
  if (stmt.tag === "gas") {
    return stmt;
  }
  return {
    ...stmt,
    expr: mapExpr(stmt.expr, visit),
  };
}

export function mapExpr(expr: IRExpr, visit: (expr: IRExpr) => IRExpr): IRExpr {
  const mapped = mapExprChildren(expr, (child) => mapExpr(child, visit));
  return visit(mapped);
}

export function mapExprChildren(expr: IRExpr, f: (expr: IRExpr) => IRExpr): IRExpr {
  switch (expr.tag) {
    case "binop":
    case "total_div":
    case "total_mod":
    case "sat_add":
    case "sat_sub":
    case "sat_mul":
      return { ...expr, left: f(expr.left), right: f(expr.right) };
    case "unop":
    case "sat_neg":
      return { ...expr, operand: f(expr.operand) };
    case "nan_to_zero":
      return { ...expr, value: f(expr.value) };
    case "call":
      return { ...expr, args: expr.args.map(f) };
    case "index":
      return { ...expr, array: f(expr.array), indices: expr.indices.map(f) };
    case "field":
      return { ...expr, target: f(expr.target) };
    case "struct_cons":
      return { ...expr, fields: expr.fields.map(f) };
    case "array_cons":
      return { ...expr, elements: expr.elements.map(f) };
    case "array_expr":
    case "sum_expr":
      return {
        ...expr,
        bindings: expr.bindings.map((b) => ({ ...b, expr: f(b.expr) })),
        body: f(expr.body),
      };
    case "rec":
      return { ...expr, args: expr.args.map(f) };
    default:
      return expr;
  }
}

export function makeSyntheticIdFactory(program: IRProgram): () => number {
  let maxId = 0;

  const visitExpr = (expr: IRExpr): void => {
    maxId = Math.max(maxId, expr.id);
    switch (expr.tag) {
      case "binop":
      case "total_div":
      case "total_mod":
      case "sat_add":
      case "sat_sub":
      case "sat_mul":
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case "unop":
      case "sat_neg":
        visitExpr(expr.operand);
        return;
      case "nan_to_zero":
        visitExpr(expr.value);
        return;
      case "call":
        for (const arg of expr.args) {
          visitExpr(arg);
        }
        return;
      case "index":
        visitExpr(expr.array);
        for (const idx of expr.indices) {
          visitExpr(idx);
        }
        return;
      case "field":
        visitExpr(expr.target);
        return;
      case "struct_cons":
        for (const field of expr.fields) {
          visitExpr(field);
        }
        return;
      case "array_cons":
        for (const element of expr.elements) {
          visitExpr(element);
        }
        return;
      case "array_expr":
      case "sum_expr":
        for (const binding of expr.bindings) {
          visitExpr(binding.expr);
        }
        visitExpr(expr.body);
        return;
      case "rec":
        for (const arg of expr.args) {
          visitExpr(arg);
        }
        return;
      default:
        return;
    }
  };

  for (const global of program.globals) {
    maxId = Math.max(maxId, global.id);
    visitExpr(global.expr);
  }
  for (const struct of program.structs) {
    maxId = Math.max(maxId, struct.id);
  }
  for (const fn of program.functions) {
    maxId = Math.max(maxId, fn.id);
    for (const stmt of fn.body) {
      maxId = Math.max(maxId, stmt.id);
      if (stmt.tag !== "gas") {
        visitExpr(stmt.expr);
      }
    }
  }

  return () => {
    maxId += 1;
    return maxId;
  };
}

export function mapGlobal(
  global: IRGlobalLet,
  visit: (expr: IRExpr) => IRExpr,
): IRGlobalLet {
  return {
    ...global,
    expr: mapExpr(global.expr, visit),
  };
}

export function stripNanToZero(expr: IRExpr): IRExpr {
  return expr.tag === "nan_to_zero" ? stripNanToZero(expr.value) : expr;
}

export function isNumericLiteral(expr: IRExpr, value?: number): boolean {
  if (expr.tag !== "int_lit" && expr.tag !== "float_lit") {
    return false;
  }
  return value === undefined ? true : expr.value === value;
}
