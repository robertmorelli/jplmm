import { isFloatType, isIntType } from "@jplmm/ir";
import type { IRExpr, IRFunction, IRGlobalLet, IRProgram, IRStmt } from "@jplmm/ir";

export type CanonicalPass = "total_arithmetic" | "saturating_arithmetic";

export type CanonicalizeStats = {
  totalDivInserted: number;
  totalModInserted: number;
  nanToZeroInserted: number;
  satAddInserted: number;
  satSubInserted: number;
  satMulInserted: number;
  satNegInserted: number;
  zeroDivisorConstantFolded: number;
};

export type CanonicalizeResult = {
  program: IRProgram;
  passOrder: CanonicalPass[];
  stats: CanonicalizeStats;
};

const DEFAULT_STATS: CanonicalizeStats = {
  totalDivInserted: 0,
  totalModInserted: 0,
  nanToZeroInserted: 0,
  satAddInserted: 0,
  satSubInserted: 0,
  satMulInserted: 0,
  satNegInserted: 0,
  zeroDivisorConstantFolded: 0,
};

const NAN_GUARDED_BUILTINS = new Set(["sqrt", "log", "pow", "asin", "acos"]);

export function canonicalizeProgram(program: IRProgram): CanonicalizeResult {
  const passOrder: CanonicalPass[] = ["total_arithmetic", "saturating_arithmetic"];
  const stats: CanonicalizeStats = { ...DEFAULT_STATS };
  const nextId = makeSyntheticIdFactory(program);

  const out: IRProgram = {
    structs: program.structs,
    globals: program.globals.map((g) => canonicalizeGlobal(g, nextId, stats)),
    functions: program.functions.map((f) => canonicalizeFunction(f, nextId, stats)),
  };

  return {
    program: out,
    passOrder,
    stats,
  };
}

export function isNaNlessCanonical(program: IRProgram): boolean {
  const checkExpr = (expr: IRExpr, guarded: boolean): boolean => {
    switch (expr.tag) {
      case "int_lit":
      case "float_lit":
      case "void_lit":
      case "var":
      case "res":
        return true;
      case "nan_to_zero":
        return checkExpr(expr.value, true);
      case "binop":
        if (isFloatType(expr.resultType)) {
          if (expr.op === "/" || expr.op === "%") {
            return false;
          }
          if ((expr.op === "+" || expr.op === "-" || expr.op === "*") && !guarded) {
            return false;
          }
        }
        return checkExpr(expr.left, guarded) && checkExpr(expr.right, guarded);
      case "unop":
        if (expr.op === "-" && isFloatType(expr.resultType) && !guarded) {
          return false;
        }
        return checkExpr(expr.operand, guarded);
      case "call":
        if (isFloatType(expr.resultType) && NAN_GUARDED_BUILTINS.has(expr.name) && !guarded) {
          return false;
        }
        return expr.args.every((a) => checkExpr(a, guarded));
      case "index":
        return checkExpr(expr.array, guarded) && expr.indices.every((a) => checkExpr(a, guarded));
      case "field":
        return checkExpr(expr.target, guarded);
      case "struct_cons":
        return expr.fields.every((a) => checkExpr(a, guarded));
      case "array_cons":
        return expr.elements.every((a) => checkExpr(a, guarded));
      case "array_expr":
      case "sum_expr":
        return (
          expr.bindings.every((b) => checkExpr(b.expr, guarded)) &&
          checkExpr(expr.body, guarded)
        );
      case "rec":
        return expr.args.every((a) => checkExpr(a, guarded));
      case "total_div":
      case "total_mod":
        if (isFloatType(expr.resultType) && !guarded) {
          return false;
        }
        return checkExpr(expr.left, guarded) && checkExpr(expr.right, guarded);
      case "sat_add":
      case "sat_sub":
      case "sat_mul":
        return checkExpr(expr.left, guarded) && checkExpr(expr.right, guarded);
      case "sat_neg":
        return checkExpr(expr.operand, guarded);
      default: {
        const _never: never = expr;
        return _never;
      }
    }
  };

  const stmtExprs = (stmt: IRStmt): IRExpr[] => {
    if (stmt.tag === "gas") {
      return [];
    }
    return [stmt.expr];
  };

  for (const g of program.globals) {
    if (!checkExpr(g.expr, false)) {
      return false;
    }
  }
  for (const fn of program.functions) {
    for (const stmt of fn.body) {
      for (const expr of stmtExprs(stmt)) {
        if (!checkExpr(expr, false)) {
          return false;
        }
      }
    }
  }
  return true;
}

function canonicalizeGlobal(
  g: IRGlobalLet,
  nextId: () => number,
  stats: CanonicalizeStats,
): IRGlobalLet {
  return { ...g, expr: canonicalizeExpr(g.expr, nextId, stats) };
}

function canonicalizeFunction(
  fn: IRFunction,
  nextId: () => number,
  stats: CanonicalizeStats,
): IRFunction {
  return {
    ...fn,
    body: fn.body.map((stmt) => canonicalizeStmt(stmt, nextId, stats)),
  };
}

function canonicalizeStmt(stmt: IRStmt, nextId: () => number, stats: CanonicalizeStats): IRStmt {
  if (stmt.tag === "gas") {
    return stmt;
  }
  return {
    ...stmt,
    expr: canonicalizeExpr(stmt.expr, nextId, stats),
  };
}

function canonicalizeExpr(expr: IRExpr, nextId: () => number, stats: CanonicalizeStats): IRExpr {
  const mapped = mapChildren(expr, (child) => canonicalizeExpr(child, nextId, stats));
  const totalized = applyTotalArithmetic(mapped, nextId, stats);
  return applySaturatingArithmetic(totalized, nextId, stats);
}

function mapChildren(expr: IRExpr, f: (child: IRExpr) => IRExpr): IRExpr {
  switch (expr.tag) {
    case "binop":
      return { ...expr, left: f(expr.left), right: f(expr.right) };
    case "unop":
      return { ...expr, operand: f(expr.operand) };
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
    case "total_div":
    case "total_mod":
    case "sat_add":
    case "sat_sub":
    case "sat_mul":
      return { ...expr, left: f(expr.left), right: f(expr.right) };
    case "nan_to_zero":
    case "sat_neg":
      return {
        ...expr,
        ...(expr.tag === "nan_to_zero" ? { value: f(expr.value) } : { operand: f(expr.operand) }),
      };
    default:
      return expr;
  }
}

function applyTotalArithmetic(
  expr: IRExpr,
  nextId: () => number,
  stats: CanonicalizeStats,
): IRExpr {
  if (expr.tag === "binop" && (expr.op === "/" || expr.op === "%")) {
    if (isZeroLiteral(expr.right)) {
      stats.zeroDivisorConstantFolded += 1;
      return zeroLiteral(expr.resultType, nextId());
    }

    if (expr.op === "/") {
      stats.totalDivInserted += 1;
      const op: IRExpr = {
        tag: "total_div",
        left: expr.left,
        right: expr.right,
        id: nextId(),
        resultType: expr.resultType,
        zeroDivisorValue: 0,
      };
      if (isFloatType(expr.resultType)) {
        return wrapNanToZero(op, nextId, stats);
      }
      return op;
    }

    {
      stats.totalModInserted += 1;
      const op: IRExpr = {
        tag: "total_mod",
        left: expr.left,
        right: expr.right,
        id: nextId(),
        resultType: expr.resultType,
        zeroDivisorValue: 0,
      };
      if (isFloatType(expr.resultType)) {
        return wrapNanToZero(op, nextId, stats);
      }
      return op;
    }
  }

  if (expr.tag === "binop" && isFloatType(expr.resultType)) {
    if (expr.op === "+" || expr.op === "-" || expr.op === "*") {
      return wrapNanToZero(expr, nextId, stats);
    }
  }

  if (expr.tag === "call" && isFloatType(expr.resultType) && NAN_GUARDED_BUILTINS.has(expr.name)) {
    return wrapNanToZero(expr, nextId, stats);
  }

  return expr;
}

function applySaturatingArithmetic(
  expr: IRExpr,
  nextId: () => number,
  stats: CanonicalizeStats,
): IRExpr {
  if (expr.tag === "binop" && isIntType(expr.resultType)) {
    if (expr.op === "+") {
      stats.satAddInserted += 1;
      return {
        tag: "sat_add",
        left: expr.left,
        right: expr.right,
        id: nextId(),
        resultType: expr.resultType,
      };
    }
    if (expr.op === "-") {
      stats.satSubInserted += 1;
      return {
        tag: "sat_sub",
        left: expr.left,
        right: expr.right,
        id: nextId(),
        resultType: expr.resultType,
      };
    }
    if (expr.op === "*") {
      stats.satMulInserted += 1;
      return {
        tag: "sat_mul",
        left: expr.left,
        right: expr.right,
        id: nextId(),
        resultType: expr.resultType,
      };
    }
  }

  if (expr.tag === "unop" && expr.op === "-" && isIntType(expr.resultType)) {
    stats.satNegInserted += 1;
    return {
      tag: "sat_neg",
      operand: expr.operand,
      id: nextId(),
      resultType: expr.resultType,
    };
  }

  return expr;
}

function wrapNanToZero(expr: IRExpr, nextId: () => number, stats: CanonicalizeStats): IRExpr {
  if (expr.tag === "nan_to_zero") {
    return expr;
  }
  stats.nanToZeroInserted += 1;
  return {
    tag: "nan_to_zero",
    value: expr,
    id: nextId(),
    resultType: expr.resultType,
  };
}

function isZeroLiteral(expr: IRExpr): boolean {
  return (expr.tag === "int_lit" || expr.tag === "float_lit") && expr.value === 0;
}

function zeroLiteral(resultType: IRExpr["resultType"], id: number): IRExpr {
  if (isFloatType(resultType)) {
    return { tag: "float_lit", value: 0, id, resultType };
  }
  return { tag: "int_lit", value: 0, id, resultType };
}

function makeSyntheticIdFactory(program: IRProgram): () => number {
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
      case "nan_to_zero":
      case "sat_neg":
        visitExpr(expr.tag === "nan_to_zero" ? expr.value : expr.operand);
        return;
      case "call":
      case "array_cons":
      case "struct_cons":
      case "rec":
        for (const a of expr.tag === "call" ? expr.args : expr.tag === "rec" ? expr.args : expr.tag === "array_cons" ? expr.elements : expr.fields) {
          visitExpr(a);
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
      case "array_expr":
      case "sum_expr":
        visitExpr(expr.body);
        for (const b of expr.bindings) {
          visitExpr(b.expr);
        }
        return;
      default:
        return;
    }
  };

  for (const g of program.globals) {
    maxId = Math.max(maxId, g.id);
    visitExpr(g.expr);
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
