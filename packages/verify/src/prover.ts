import { spawnSync } from "node:child_process";

import type { Cmd, Expr, Param, Stmt, Type } from "@jplmm/ast";

type ScalarTag = "int" | "float";

type ScalarExpr =
  | { tag: "int_lit"; value: number }
  | { tag: "float_lit"; value: number }
  | { tag: "var"; name: string; valueType: ScalarTag }
  | { tag: "unop"; op: "-"; operand: ScalarExpr; valueType: ScalarTag }
  | { tag: "binop"; op: "+" | "-" | "*" | "/" | "%"; left: ScalarExpr; right: ScalarExpr; valueType: ScalarTag }
  | { tag: "call"; name: string; args: ScalarExpr[]; valueType: ScalarTag; interpreted: boolean };

type SymValue =
  | { kind: "scalar"; expr: ScalarExpr }
  | { kind: "opaque"; type: Type; label: string };

export type RadWitness = {
  stmtIndex: number;
  source: Expr;
  measure: ScalarExpr;
  rendered: string;
};

export type ProvedSite = {
  method: "structural" | "smt";
  details: string;
};

export type FailedSite = {
  ok: false;
  reasons: string[];
};

export type SiteProof = ({ ok: true } & ProvedSite) | FailedSite;

type RecSite = {
  stmtIndex: number;
  args: Expr[];
  scalarArgs: Map<number, ScalarExpr>;
  changedNonScalarParam: boolean;
  issues: string[];
};

type AnalysisState = {
  env: Map<string, SymValue>;
  res: SymValue | null;
  radSites: RadWitness[];
  recSites: RecSite[];
  callSigs: Map<string, { args: ScalarTag[]; ret: ScalarTag }>;
};

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const Z3_PATH = "z3";

export function analyzeFunction(
  fn: Extract<Cmd, { tag: "fn_def" }>,
  typeMap: Map<number, Type>,
): {
  radSites: RadWitness[];
  recSites: RecSite[];
  callSigs: Map<string, { args: ScalarTag[]; ret: ScalarTag }>;
} {
  const env = new Map<string, SymValue>();
  for (const param of fn.params) {
    const scalar = scalarTag(param.type);
    if (scalar) {
      env.set(param.name, {
        kind: "scalar",
        expr: { tag: "var", name: param.name, valueType: scalar },
      });
    } else {
      env.set(param.name, { kind: "opaque", type: param.type, label: param.name });
    }
  }

  const state: AnalysisState = {
    env,
    res: null,
    radSites: [],
    recSites: [],
    callSigs: new Map(),
  };

  for (let stmtIndex = 0; stmtIndex < fn.body.length; stmtIndex += 1) {
    const stmt = fn.body[stmtIndex]!;
    if (stmt.tag === "let") {
      const value = symbolizeExpr(stmt.expr, fn, typeMap, state, stmtIndex);
      if (stmt.lvalue.tag === "var") {
        state.env.set(stmt.lvalue.name, value);
      } else if (stmt.lvalue.tag === "field") {
        const base = state.env.get(stmt.lvalue.base);
        const nextType = base?.kind === "opaque" ? base.type : { tag: "named", name: stmt.lvalue.base } satisfies Type;
        state.env.set(stmt.lvalue.base, {
          kind: "opaque",
          type: nextType,
          label: `${stmt.lvalue.base}#updated_${stmtIndex}`,
        });
      }
      continue;
    }

    if (stmt.tag === "ret") {
      state.res = symbolizeExpr(stmt.expr, fn, typeMap, state, stmtIndex);
      continue;
    }

    if (stmt.tag === "rad") {
      const value = symbolizeExpr(stmt.expr, fn, typeMap, state, stmtIndex);
      if (value.kind === "scalar") {
        state.radSites.push({
          stmtIndex,
          source: stmt.expr,
          measure: value.expr,
          rendered: renderScalarExpr(value.expr),
        });
      }
    }
  }

  return {
    radSites: state.radSites,
    recSites: state.recSites,
    callSigs: state.callSigs,
  };
}

export function proveWithSmt(
  fn: Extract<Cmd, { tag: "fn_def" }>,
  rad: RadWitness,
  site: { args: Expr[]; scalarArgs: Map<number, ScalarExpr>; changedNonScalarParam: boolean; issues: string[] },
  callSigs: Map<string, { args: ScalarTag[]; ret: ScalarTag }>,
): SiteProof {
  if (site.issues.length > 0) {
    return { ok: false, reasons: [...site.issues] };
  }
  if (site.changedNonScalarParam) {
    return {
      ok: false,
      reasons: ["non-scalar recursive arguments changed in a way this verifier cannot prove soundly"],
    };
  }

  const substitution = new Map<string, ScalarExpr>();
  for (let i = 0; i < fn.params.length; i += 1) {
    const param = fn.params[i]!;
    const scalar = scalarTag(param.type);
    if (!scalar) {
      continue;
    }
    const next = site.scalarArgs.get(i);
    if (!next) {
      return {
        ok: false,
        reasons: [`rec site is missing scalar argument '${param.name}'`],
      };
    }
    substitution.set(param.name, next);
  }

  const nextMeasure = substituteScalar(rad.measure, substitution);
  const currentMeasure = rad.measure;
  const scalarParams = fn.params.filter((param) => scalarTag(param.type));
  if (scalarParams.length === 0) {
    return { ok: false, reasons: ["no scalar parameters are available for a scalar rad proof"] };
  }

  const script = emitSmtScript(fn.params, currentMeasure, nextMeasure, substitution, callSigs);
  const result = spawnSync(Z3_PATH, ["-in"], {
    input: script,
    encoding: "utf8",
  });
  if (result.error) {
    return { ok: false, reasons: [`failed to invoke z3: ${result.error.message}`] };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (output.startsWith("unsat")) {
    return {
      ok: true,
      method: "smt",
      details: `rec site decreases '${rad.rendered}'`,
    };
  }
  if (output.startsWith("sat")) {
    return {
      ok: false,
      reasons: [`solver found a counterexample for '${rad.rendered}'`],
    };
  }
  return {
    ok: false,
    reasons: [`solver returned '${output || "unknown"}' for '${rad.rendered}'`],
  };
}

function symbolizeExpr(
  expr: Expr,
  fn: Extract<Cmd, { tag: "fn_def" }>,
  typeMap: Map<number, Type>,
  state: AnalysisState,
  stmtIndex: number,
): SymValue {
  switch (expr.tag) {
    case "int_lit":
      return { kind: "scalar", expr: { tag: "int_lit", value: expr.value } };
    case "float_lit":
      return { kind: "scalar", expr: { tag: "float_lit", value: expr.value } };
    case "void_lit":
      return { kind: "opaque", type: { tag: "void" }, label: "void" };
    case "var":
      return state.env.get(expr.name) ?? { kind: "opaque", type: typeMap.get(expr.id) ?? { tag: "void" }, label: expr.name };
    case "res":
      return state.res ?? { kind: "opaque", type: fn.retType, label: "res" };
    case "unop": {
      const operand = symbolizeExpr(expr.operand, fn, typeMap, state, stmtIndex);
      const tag = scalarTag(typeMap.get(expr.id));
      if (operand.kind === "scalar" && tag) {
        return { kind: "scalar", expr: { tag: "unop", op: "-", operand: operand.expr, valueType: tag } };
      }
      return { kind: "opaque", type: typeMap.get(expr.id) ?? { tag: "void" }, label: `unop_${stmtIndex}_${expr.id}` };
    }
    case "binop": {
      const left = symbolizeExpr(expr.left, fn, typeMap, state, stmtIndex);
      const right = symbolizeExpr(expr.right, fn, typeMap, state, stmtIndex);
      const tag = scalarTag(typeMap.get(expr.id));
      if (left.kind === "scalar" && right.kind === "scalar" && tag) {
        return {
          kind: "scalar",
          expr: { tag: "binop", op: expr.op, left: left.expr, right: right.expr, valueType: tag },
        };
      }
      return { kind: "opaque", type: typeMap.get(expr.id) ?? { tag: "void" }, label: `binop_${stmtIndex}_${expr.id}` };
    }
    case "call": {
      const args = expr.args.map((arg) => symbolizeExpr(arg, fn, typeMap, state, stmtIndex));
      const tag = scalarTag(typeMap.get(expr.id));
      const scalarArgs = args.every((arg) => arg.kind === "scalar") ? args.map((arg) => (arg as Extract<SymValue, { kind: "scalar" }>).expr) : null;
      if (tag && scalarArgs) {
        const interpreted = isInterpretedCall(expr.name, scalarArgs.length);
        if (!interpreted) {
          const existing = state.callSigs.get(expr.name);
          const argTypes = scalarArgs.map((arg) => scalarExprType(arg));
          if (!existing) {
            state.callSigs.set(expr.name, { args: argTypes, ret: tag });
          }
        }
        return {
          kind: "scalar",
          expr: {
            tag: "call",
            name: expr.name,
            args: scalarArgs,
            valueType: tag,
            interpreted,
          },
        };
      }
      return { kind: "opaque", type: typeMap.get(expr.id) ?? { tag: "void" }, label: `call_${expr.name}_${stmtIndex}` };
    }
    case "rec": {
      const scalarArgs = new Map<number, ScalarExpr>();
      const issues: string[] = [];
      let changedNonScalarParam = false;
      for (let i = 0; i < fn.params.length; i += 1) {
        const param = fn.params[i]!;
        const arg = expr.args[i];
        if (!arg) {
          continue;
        }
        const scalar = scalarTag(param.type);
        if (scalar) {
          const value = symbolizeExpr(arg, fn, typeMap, state, stmtIndex);
          if (value.kind !== "scalar") {
            issues.push(`could not symbolize scalar recursive argument '${param.name}'`);
          } else {
            scalarArgs.set(i, value.expr);
          }
          continue;
        }
        if (!isUnchangedOpaqueParam(arg, param.name, state.env)) {
          changedNonScalarParam = true;
        }
      }
      state.recSites.push({
        stmtIndex,
        args: expr.args,
        scalarArgs,
        changedNonScalarParam,
        issues,
      });
      const retScalar = scalarTag(fn.retType);
      if (retScalar) {
        return {
          kind: "scalar",
          expr: {
            tag: "var",
            name: `__rec_result_${stmtIndex}_${expr.id}`,
            valueType: retScalar,
          },
        };
      }
      return { kind: "opaque", type: fn.retType, label: `rec_${stmtIndex}_${expr.id}` };
    }
    default:
      return { kind: "opaque", type: typeMap.get(expr.id) ?? { tag: "void" }, label: `opaque_${stmtIndex}_${expr.id}` };
  }
}

function scalarTag(type: Type | undefined): ScalarTag | null {
  if (!type) {
    return null;
  }
  if (type.tag === "int" || type.tag === "float") {
    return type.tag;
  }
  return null;
}

function isUnchangedOpaqueParam(arg: Expr, paramName: string, env: Map<string, SymValue>): boolean {
  if (arg.tag !== "var" || arg.name !== paramName) {
    return false;
  }
  const bound = env.get(paramName);
  return bound?.kind === "opaque" && bound.label === paramName;
}

function substituteScalar(expr: ScalarExpr, substitution: Map<string, ScalarExpr>): ScalarExpr {
  switch (expr.tag) {
    case "int_lit":
    case "float_lit":
      return expr;
    case "var":
      return substitution.get(expr.name) ?? expr;
    case "unop":
      return {
        tag: "unop",
        op: expr.op,
        operand: substituteScalar(expr.operand, substitution),
        valueType: expr.valueType,
      };
    case "binop":
      return {
        tag: "binop",
        op: expr.op,
        left: substituteScalar(expr.left, substitution),
        right: substituteScalar(expr.right, substitution),
        valueType: expr.valueType,
      };
    case "call":
      return {
        tag: "call",
        name: expr.name,
        args: expr.args.map((arg) => substituteScalar(arg, substitution)),
        valueType: expr.valueType,
        interpreted: expr.interpreted,
      };
  }
}

function emitSmtScript(
  params: Param[],
  currentMeasure: ScalarExpr,
  nextMeasure: ScalarExpr,
  substitution: Map<string, ScalarExpr>,
  callSigs: Map<string, { args: ScalarTag[]; ret: ScalarTag }>,
): string {
  const vars = new Map<string, ScalarTag>();
  collectVars(currentMeasure, vars);
  collectVars(nextMeasure, vars);
  for (const [name, expr] of substitution) {
    const param = params.find((candidate) => candidate.name === name);
    const tag = scalarTag(param?.type);
    if (tag) {
      vars.set(name, tag);
    }
    collectVars(expr, vars);
  }

  const lines = [
    "(set-logic ALL)",
    "(define-fun abs_int ((x Int)) Int (ite (< x 0) (- x) x))",
    "(define-fun abs_real ((x Real)) Real (ite (< x 0.0) (- x) x))",
    "(define-fun max_int ((a Int) (b Int)) Int (ite (< a b) b a))",
    "(define-fun min_int ((a Int) (b Int)) Int (ite (< a b) a b))",
    "(define-fun clamp_int ((x Int) (lo Int) (hi Int)) Int (min_int (max_int x lo) hi))",
    "(define-fun max_real ((a Real) (b Real)) Real (ite (< a b) b a))",
    "(define-fun min_real ((a Real) (b Real)) Real (ite (< a b) a b))",
    "(define-fun clamp_real ((x Real) (lo Real) (hi Real)) Real (min_real (max_real x lo) hi))",
    "(define-fun trunc_div_int ((a Int) (b Int)) Int (ite (= b 0) 0 (let ((q (div (abs_int a) (abs_int b)))) (ite (= (< a 0) (< b 0)) q (- q)))))",
    "(define-fun total_div_int ((a Int) (b Int)) Int (ite (= b 0) 0 (trunc_div_int a b)))",
    "(define-fun total_mod_int ((a Int) (b Int)) Int (ite (= b 0) 0 (- a (* b (trunc_div_int a b)))))",
    "(define-fun total_div_real ((a Real) (b Real)) Real (ite (= b 0.0) 0.0 (/ a b)))",
    "(define-fun trunc_real ((x Real)) Int (ite (>= x 0.0) (to_int x) (- (to_int (- x)))))",
    `(define-fun to_int_real ((x Real)) Int (clamp_int (trunc_real x) ${INT32_MIN} ${INT32_MAX}))`,
  ];

  for (const [name, sig] of callSigs) {
    const domain = sig.args.map((arg) => (arg === "int" ? "Int" : "Real")).join(" ");
    const sort = sig.ret === "int" ? "Int" : "Real";
    lines.push(`(declare-fun ${sanitize(name)} (${domain}) ${sort})`);
  }

  for (const [name, tag] of vars) {
    lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
    if (tag === "int") {
      lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
      lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
    }
  }

  const preconditions: string[] = [];
  for (let i = 0; i < params.length; i += 1) {
    const param = params[i]!;
    const tag = scalarTag(param.type);
    if (!tag) {
      continue;
    }
    const next = substitution.get(param.name);
    if (!next) {
      continue;
    }
    preconditions.push(`(not (= ${emitScalar(next)} ${sanitize(param.name)}))`);
  }

  const decrease = strictDecrease(currentMeasure, nextMeasure);
  lines.push(preconditions.length > 0 ? `(assert (or ${preconditions.join(" ")}))` : "(assert false)");
  lines.push(`(assert (not ${decrease}))`);
  lines.push("(check-sat)");
  return `${lines.join("\n")}\n`;
}

function strictDecrease(currentMeasure: ScalarExpr, nextMeasure: ScalarExpr): string {
  if (scalarExprType(currentMeasure) === "int") {
    return `(< (abs_int ${emitScalar(nextMeasure)}) (abs_int ${emitScalar(currentMeasure)}))`;
  }
  return `(< (abs_real ${emitScalar(nextMeasure)}) (abs_real ${emitScalar(currentMeasure)}))`;
}

function emitScalar(expr: ScalarExpr): string {
  switch (expr.tag) {
    case "int_lit":
      return `${expr.value}`;
    case "float_lit":
      return realLiteral(expr.value);
    case "var":
      return sanitize(expr.name);
    case "unop":
      return `(- ${emitScalar(expr.operand)})`;
    case "binop":
      if (expr.valueType === "int") {
        if (expr.op === "+") return `(+ ${emitScalar(expr.left)} ${emitScalar(expr.right)})`;
        if (expr.op === "-") return `(- ${emitScalar(expr.left)} ${emitScalar(expr.right)})`;
        if (expr.op === "*") return `(* ${emitScalar(expr.left)} ${emitScalar(expr.right)})`;
        if (expr.op === "/") return `(total_div_int ${emitScalar(expr.left)} ${emitScalar(expr.right)})`;
        return `(total_mod_int ${emitScalar(expr.left)} ${emitScalar(expr.right)})`;
      }
      if (expr.op === "+") return `(+ ${emitScalar(expr.left)} ${emitScalar(expr.right)})`;
      if (expr.op === "-") return `(- ${emitScalar(expr.left)} ${emitScalar(expr.right)})`;
      if (expr.op === "*") return `(* ${emitScalar(expr.left)} ${emitScalar(expr.right)})`;
      if (expr.op === "/") return `(total_div_real ${emitScalar(expr.left)} ${emitScalar(expr.right)})`;
      return `(- ${emitScalar(expr.left)} (* ${emitScalar(expr.right)} (to_real (trunc_real (/ ${emitScalar(expr.left)} ${emitScalar(expr.right)})))))`;
    case "call": {
      const args = expr.args.map((arg) => emitScalar(arg)).join(" ");
      if (!expr.interpreted) {
        return `(${sanitize(expr.name)} ${args})`;
      }
      switch (expr.name) {
        case "max":
          return `(${expr.valueType === "int" ? "max_int" : "max_real"} ${args})`;
        case "min":
          return `(${expr.valueType === "int" ? "min_int" : "min_real"} ${args})`;
        case "abs":
          return `(${expr.valueType === "int" ? "abs_int" : "abs_real"} ${args})`;
        case "clamp":
          return `(${expr.valueType === "int" ? "clamp_int" : "clamp_real"} ${args})`;
        case "to_float":
          return `(to_real ${emitScalar(expr.args[0]!)})`;
        case "to_int":
          return `(to_int_real ${emitScalar(expr.args[0]!)})`;
        default:
          return `(${sanitize(expr.name)} ${args})`;
      }
    }
  }
}

function renderScalarExpr(expr: ScalarExpr): string {
  switch (expr.tag) {
    case "int_lit":
    case "float_lit":
      return `${expr.value}`;
    case "var":
      return expr.name;
    case "unop":
      return `(-${renderScalarExpr(expr.operand)})`;
    case "binop":
      return `(${renderScalarExpr(expr.left)} ${expr.op} ${renderScalarExpr(expr.right)})`;
    case "call":
      return `${expr.name}(${expr.args.map((arg) => renderScalarExpr(arg)).join(", ")})`;
  }
}

function collectVars(expr: ScalarExpr, out: Map<string, ScalarTag>): void {
  switch (expr.tag) {
    case "var":
      out.set(expr.name, expr.valueType);
      return;
    case "unop":
      collectVars(expr.operand, out);
      return;
    case "binop":
      collectVars(expr.left, out);
      collectVars(expr.right, out);
      return;
    case "call":
      for (const arg of expr.args) {
        collectVars(arg, out);
      }
      return;
    default:
      return;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function realLiteral(value: number): string {
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(20).replace(/\.?0+$/, "");
  const literal = fixed.includes(".") ? fixed : `${fixed}.0`;
  return negative ? `(- ${literal})` : literal;
}

function isInterpretedCall(name: string, arity: number): boolean {
  if (name === "max" || name === "min") {
    return arity === 2;
  }
  if (name === "abs" || name === "to_float" || name === "to_int") {
    return arity === 1;
  }
  if (name === "clamp") {
    return arity === 3;
  }
  return false;
}

function scalarExprType(expr: ScalarExpr): ScalarTag {
  switch (expr.tag) {
    case "int_lit":
      return "int";
    case "float_lit":
      return "float";
    default:
      return expr.valueType;
  }
}
