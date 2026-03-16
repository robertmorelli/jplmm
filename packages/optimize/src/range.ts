import { getArrayExtentNames, getScalarBounds, type Type } from "@jplmm/ast";
import type { IRExpr, IRProgram } from "@jplmm/ir";

import type { Interval, ParameterRangeHints, RangeAnalysisResult } from "./types";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

export function analyzeRanges(
  program: IRProgram,
  parameterRangeHints: ParameterRangeHints = {},
): RangeAnalysisResult {
  const rangeMap = new Map<number, Interval>();
  const cardinalityMap = new Map<string, { parameterRanges: Interval[]; cardinality: number | "inf" }>();

  for (const fn of program.functions) {
    const env = new Map<string, Interval>();
    const parameterRanges = fn.params.map((param, idx) => {
      const hinted = parameterRangeHints[fn.name]?.[idx];
      const range = hinted ?? defaultInterval(param.type);
      env.set(param.name, range);
      bindArrayExtentRanges(env, param.type);
      return range;
    });

    cardinalityMap.set(fn.name, {
      parameterRanges,
      cardinality: computeCardinality(parameterRanges, fn.params.map((p) => p.type)),
    });

    let resRange: Interval | null = null;
    for (const stmt of fn.body) {
      if (stmt.tag === "let") {
        const range = evalRange(stmt.expr, env, resRange, fn.retType, rangeMap);
        env.set(stmt.name, range);
        continue;
      }
      if (stmt.tag === "ret") {
        resRange = evalRange(stmt.expr, env, resRange, fn.retType, rangeMap);
        continue;
      }
      if (stmt.tag === "rad") {
        evalRange(stmt.expr, env, resRange, fn.retType, rangeMap);
      }
    }
  }

  for (const global of program.globals) {
    evalRange(global.expr, new Map(), null, global.expr.resultType, rangeMap);
  }

  return { rangeMap, cardinalityMap };
}

function bindArrayExtentRanges(env: Map<string, Interval>, type: Type): void {
  const extentNames = getArrayExtentNames(type);
  if (!extentNames) {
    return;
  }
  for (const extentName of extentNames) {
    if (extentName !== null) {
      env.set(extentName, { lo: 0, hi: INT32_MAX });
    }
  }
}

function evalRange(
  expr: IRExpr,
  env: Map<string, Interval>,
  resRange: Interval | null,
  fnRetType: Type,
  rangeMap: Map<number, Interval>,
): Interval {
  let out: Interval;

  switch (expr.tag) {
    case "int_lit":
    case "float_lit":
      out = { lo: expr.value, hi: expr.value };
      break;
    case "void_lit":
      out = { lo: 0, hi: 0 };
      break;
    case "var":
      out = env.get(expr.name) ?? defaultInterval(expr.resultType);
      break;
    case "res":
      out = resRange ?? defaultInterval(fnRetType);
      break;
    case "unop": {
      const inner = evalRange(expr.operand, env, resRange, fnRetType, rangeMap);
      out =
        expr.resultType.tag === "int"
          ? normalizeIntRange({ lo: -inner.hi, hi: -inner.lo })
          : normalizeFloatRange({ lo: -inner.hi, hi: -inner.lo });
      break;
    }
    case "binop": {
      const left = evalRange(expr.left, env, resRange, fnRetType, rangeMap);
      const right = evalRange(expr.right, env, resRange, fnRetType, rangeMap);
      out = evalBinaryRange(expr.op, left, right, expr.resultType);
      break;
    }
    case "sat_add": {
      const left = evalRange(expr.left, env, resRange, fnRetType, rangeMap);
      const right = evalRange(expr.right, env, resRange, fnRetType, rangeMap);
      out = normalizeIntRange({ lo: left.lo + right.lo, hi: left.hi + right.hi });
      break;
    }
    case "sat_sub": {
      const left = evalRange(expr.left, env, resRange, fnRetType, rangeMap);
      const right = evalRange(expr.right, env, resRange, fnRetType, rangeMap);
      out = normalizeIntRange({ lo: left.lo - right.hi, hi: left.hi - right.lo });
      break;
    }
    case "sat_mul": {
      const left = evalRange(expr.left, env, resRange, fnRetType, rangeMap);
      const right = evalRange(expr.right, env, resRange, fnRetType, rangeMap);
      out = normalizeIntRange(mulRange(left, right));
      break;
    }
    case "sat_neg": {
      const inner = evalRange(expr.operand, env, resRange, fnRetType, rangeMap);
      out = normalizeIntRange({ lo: -inner.hi, hi: -inner.lo });
      break;
    }
    case "total_div": {
      const left = evalRange(expr.left, env, resRange, fnRetType, rangeMap);
      const right = evalRange(expr.right, env, resRange, fnRetType, rangeMap);
      out = evalTotalDivRange(left, right, expr.resultType);
      break;
    }
    case "total_mod": {
      const left = evalRange(expr.left, env, resRange, fnRetType, rangeMap);
      const right = evalRange(expr.right, env, resRange, fnRetType, rangeMap);
      out = evalTotalModRange(left, right, expr.resultType);
      break;
    }
    case "nan_to_zero": {
      const inner = evalRange(expr.value, env, resRange, fnRetType, rangeMap);
      out = { lo: Math.min(0, inner.lo), hi: Math.max(0, inner.hi) };
      break;
    }
    case "call": {
      const args = expr.args.map((arg) => evalRange(arg, env, resRange, fnRetType, rangeMap));
      out = evalCallRange(expr.name, args, expr.resultType);
      break;
    }
    case "rec":
      for (const arg of expr.args) {
        evalRange(arg, env, resRange, fnRetType, rangeMap);
      }
      out = defaultInterval(expr.resultType);
      break;
    case "field":
      evalRange(expr.target, env, resRange, fnRetType, rangeMap);
      out = defaultInterval(expr.resultType);
      break;
    case "index":
      evalRange(expr.array, env, resRange, fnRetType, rangeMap);
      for (const idx of expr.indices) {
        evalRange(idx, env, resRange, fnRetType, rangeMap);
      }
      out = defaultInterval(expr.resultType);
      break;
    case "struct_cons":
      for (const field of expr.fields) {
        evalRange(field, env, resRange, fnRetType, rangeMap);
      }
      out = defaultInterval(expr.resultType);
      break;
    case "array_cons":
      for (const element of expr.elements) {
        evalRange(element, env, resRange, fnRetType, rangeMap);
      }
      out = defaultInterval(expr.resultType);
      break;
    case "array_expr":
    case "sum_expr":
      for (const binding of expr.bindings) {
        evalRange(binding.expr, env, resRange, fnRetType, rangeMap);
      }
      out = evalRange(expr.body, env, resRange, fnRetType, rangeMap);
      break;
    default: {
      const _never: never = expr;
      out = _never;
      break;
    }
  }

  rangeMap.set(expr.id, out);
  return out;
}

function evalBinaryRange(op: string, left: Interval, right: Interval, resultType: Type): Interval {
  if (resultType.tag === "int") {
    if (op === "+") {
      return normalizeIntRange({ lo: left.lo + right.lo, hi: left.hi + right.hi });
    }
    if (op === "-") {
      return normalizeIntRange({ lo: left.lo - right.hi, hi: left.hi - right.lo });
    }
    if (op === "*") {
      return normalizeIntRange(mulRange(left, right));
    }
  } else {
    if (op === "+") {
      return normalizeFloatRange({ lo: left.lo + right.lo, hi: left.hi + right.hi });
    }
    if (op === "-") {
      return normalizeFloatRange({ lo: left.lo - right.hi, hi: left.hi - right.lo });
    }
    if (op === "*") {
      return normalizeFloatRange(mulRange(left, right));
    }
  }
  if (op === "/") {
    return evalTotalDivRange(left, right, resultType);
  }
  if (op === "%") {
    return evalTotalModRange(left, right, resultType);
  }
  return defaultInterval(resultType);
}

function evalCallRange(name: string, args: Interval[], resultType: Type): Interval {
  if (name === "max" && args[0] && args[1]) {
    return {
      lo: Math.max(args[0].lo, args[1].lo),
      hi: Math.max(args[0].hi, args[1].hi),
    };
  }
  if (name === "min" && args[0] && args[1]) {
    return {
      lo: Math.min(args[0].lo, args[1].lo),
      hi: Math.min(args[0].hi, args[1].hi),
    };
  }
  if (name === "abs" && args[0]) {
    return {
      lo: 0,
      hi: Math.max(Math.abs(args[0].lo), Math.abs(args[0].hi)),
    };
  }
  if (name === "clamp" && args[1] && args[2]) {
    return { lo: args[1].lo, hi: args[2].hi };
  }
  if (name === "sqrt" && args[0]) {
    return { lo: 0, hi: Math.sqrt(Math.max(0, args[0].hi)) };
  }
  if (name === "log" && args[0]) {
    return args[0].hi <= 0 ? { lo: 0, hi: 0 } : { lo: Math.log(Math.max(args[0].lo, Number.EPSILON)), hi: Math.log(args[0].hi) };
  }
  if (name === "to_int") {
    return { lo: INT32_MIN, hi: INT32_MAX };
  }
  if (name === "to_float") {
    return normalizeFloatRange(args[0] ?? defaultInterval(resultType));
  }
  return defaultInterval(resultType);
}

function evalTotalDivRange(left: Interval, right: Interval, resultType: Type): Interval {
  if (includesZero(right)) {
    return resultType.tag === "int"
      ? normalizeIntRange({ lo: Math.min(0, INT32_MIN), hi: Math.max(0, INT32_MAX) })
      : normalizeFloatRange({ lo: Math.min(0, -Infinity), hi: Math.max(0, Infinity) });
  }
  const quot = {
    lo: Math.min(left.lo / right.lo, left.lo / right.hi, left.hi / right.lo, left.hi / right.hi),
    hi: Math.max(left.lo / right.lo, left.lo / right.hi, left.hi / right.lo, left.hi / right.hi),
  };
  return resultType.tag === "int" ? normalizeIntRange(quot) : normalizeFloatRange(quot);
}

function evalTotalModRange(left: Interval, right: Interval, resultType: Type): Interval {
  if (includesZero(right)) {
    return { lo: 0, hi: 0 };
  }
  const bound = Math.max(Math.abs(right.lo), Math.abs(right.hi));
  if (resultType.tag === "int") {
    return normalizeIntRange({ lo: -Math.max(0, bound - 1), hi: Math.max(0, bound - 1) });
  }
  return normalizeFloatRange({ lo: -bound, hi: bound });
}

function includesZero(range: Interval): boolean {
  return range.lo <= 0 && range.hi >= 0;
}

function mulRange(a: Interval, b: Interval): Interval {
  const products = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
  return {
    lo: Math.min(...products),
    hi: Math.max(...products),
  };
}

function computeCardinality(ranges: Interval[], types: Type[]): number | "inf" {
  let out = 1;
  for (let i = 0; i < ranges.length; i += 1) {
    if (types[i]?.tag !== "int") {
      return "inf";
    }
    const range = ranges[i]!;
    if (!Number.isFinite(range.lo) || !Number.isFinite(range.hi) || !Number.isInteger(range.lo) || !Number.isInteger(range.hi)) {
      return "inf";
    }
    const size = range.hi - range.lo + 1;
    if (size <= 0) {
      return 0;
    }
    out *= size;
    if (!Number.isSafeInteger(out) || out > 1_000_000_000) {
      return "inf";
    }
  }
  return out;
}

function defaultInterval(type: Type): Interval {
  if (type.tag === "int") {
    const bounds = getScalarBounds(type);
    return {
      lo: bounds?.lo ?? INT32_MIN,
      hi: bounds?.hi ?? INT32_MAX,
    };
  }
  if (type.tag === "float") {
    const bounds = getScalarBounds(type);
    return {
      lo: bounds?.lo ?? -Infinity,
      hi: bounds?.hi ?? Infinity,
    };
  }
  return { lo: 0, hi: 0 };
}

function normalizeIntRange(range: Interval): Interval {
  return {
    lo: Math.max(INT32_MIN, Math.trunc(range.lo)),
    hi: Math.min(INT32_MAX, Math.trunc(range.hi)),
  };
}

function normalizeFloatRange(range: Interval): Interval {
  return {
    lo: Number.isNaN(range.lo) ? 0 : Math.fround(range.lo),
    hi: Number.isNaN(range.hi) ? 0 : Math.fround(range.hi),
  };
}
