import type { Binding, Cmd, Expr, Program, Stmt, Type } from "@jplmm/ast";

import type { IRBinding, IRExpr, IRFunction, IRGlobalLet, IRProgram, IRStmt, IRStructDef } from "./nodes";
import { FLOAT_T, INT_T, VOID_T } from "./types";

type FnSig = {
  params: Type[];
  ret: Type;
};

type LowerCtx = {
  env: Map<string, Type>;
  fnRetType: Type;
  fnSigs: Map<string, FnSig>;
  structDefs: Map<string, Extract<Cmd, { tag: "struct_def" }>>;
  typeMap: Map<number, Type> | undefined;
};

export function buildIR(program: Program, typeMap?: Map<number, Type>): IRProgram {
  const fnSigs = collectFnSigs(program);
  const structDefs = collectStructDefs(program);
  const functions: IRFunction[] = [];
  const globals: IRGlobalLet[] = [];
  const structs: IRStructDef[] = [];
  const globalEnv = new Map<string, Type>();

  for (const cmd of program.commands) {
    const structDef = unwrapTimedDefinition(cmd, "struct_def");
    if (structDef) {
      structs.push({
        name: structDef.name,
        fields: structDef.fields,
        id: structDef.id,
      });
      continue;
    }

    const fnDef = unwrapTimedDefinition(cmd, "fn_def");
    if (fnDef) {
      functions.push(lowerFunction(fnDef, fnSigs, structDefs, typeMap));
      continue;
    }

    if (cmd.tag === "let_cmd") {
      const lowered = lowerLetBinding(cmd.lvalue, cmd.expr, {
        env: globalEnv,
        fnRetType: VOID_T,
        fnSigs,
        structDefs,
        typeMap,
      });
      if (!lowered) {
        continue;
      }
      globalEnv.set(lowered.name, lowered.expr.resultType);
      globals.push({
        tag: "let_cmd",
        name: lowered.name,
        expr: lowered.expr,
        id: cmd.id,
      });
    }
  }

  return { structs, functions, globals };
}

function collectFnSigs(program: Program): Map<string, FnSig> {
  const out = new Map<string, FnSig>();
  for (const cmd of program.commands) {
    const fnDef = unwrapTimedDefinition(cmd, "fn_def");
    if (!fnDef) {
      continue;
    }
    out.set(fnDef.name, {
      params: fnDef.params.map((p) => p.type),
      ret: fnDef.retType,
    });
  }
  return out;
}

function collectStructDefs(program: Program): Map<string, Extract<Cmd, { tag: "struct_def" }>> {
  const out = new Map<string, Extract<Cmd, { tag: "struct_def" }>>();
  for (const cmd of program.commands) {
    const structDef = unwrapTimedDefinition(cmd, "struct_def");
    if (!structDef) {
      continue;
    }
    out.set(structDef.name, structDef);
  }
  return out;
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

function lowerFunction(
  cmd: Extract<Cmd, { tag: "fn_def" }>,
  fnSigs: Map<string, FnSig>,
  structDefs: Map<string, Extract<Cmd, { tag: "struct_def" }>>,
  typeMap: Map<number, Type> | undefined,
): IRFunction {
  const env = new Map<string, Type>();
  for (const p of cmd.params) {
    env.set(p.name, p.type);
  }
  const ctx: LowerCtx = {
    env,
    fnRetType: cmd.retType,
    fnSigs,
    structDefs,
    typeMap,
  };

  const body: IRStmt[] = cmd.body
    .map((stmt) => lowerStmt(stmt, ctx))
    .filter((s): s is IRStmt => s !== null);

  return {
    name: cmd.name,
    keyword: cmd.keyword,
    params: cmd.params,
    retType: cmd.retType,
    body,
    id: cmd.id,
  };
}

function lowerStmt(stmt: Stmt, ctx: LowerCtx): IRStmt | null {
  if (stmt.tag === "let") {
    const lowered = lowerLetBinding(stmt.lvalue, stmt.expr, ctx);
    if (!lowered) {
      return null;
    }
    ctx.env.set(lowered.name, lowered.expr.resultType);
    return { tag: "let", name: lowered.name, expr: lowered.expr, id: stmt.id };
  }

  if (stmt.tag === "ret") {
    return { tag: "ret", expr: lowerExpr(stmt.expr, ctx, true), id: stmt.id };
  }

  if (stmt.tag === "rad") {
    return { tag: "rad", expr: lowerExpr(stmt.expr, ctx, false), id: stmt.id };
  }

  if (stmt.tag === "gas") {
    return { tag: "gas", limit: stmt.limit, id: stmt.id };
  }

  return null;
}

function lowerLetBinding(
  lvalue: import("@jplmm/ast").LValue,
  expr: Expr,
  ctx: LowerCtx,
): { name: string; expr: IRExpr } | null {
  if (lvalue.tag === "var") {
    return {
      name: lvalue.name,
      expr: lowerExpr(expr, ctx, false),
    };
  }

  if (lvalue.tag === "field") {
    const baseType = ctx.env.get(lvalue.base);
    if (!baseType || baseType.tag !== "named") {
      return null;
    }
    const structDef = ctx.structDefs.get(baseType.name);
    if (!structDef) {
      return null;
    }
    const replacement = lowerExpr(expr, ctx, false);
    return {
      name: lvalue.base,
      expr: {
        tag: "struct_cons",
        name: structDef.name,
        fields: structDef.fields.map((field) =>
          field.name === lvalue.field
            ? replacement
            : lowerExpr(
                {
                  tag: "field",
                  target: { tag: "var", name: lvalue.base, id: -1 },
                  field: field.name,
                  id: -1,
                },
                ctx,
                false,
              ),
        ),
        id: -1,
        resultType: { tag: "named", name: structDef.name },
      },
    };
  }

  return null;
}

function lowerExpr(expr: Expr, ctx: LowerCtx, isTailPosition: boolean): IRExpr {
  switch (expr.tag) {
    case "int_lit":
      return {
        tag: "int_lit",
        value: expr.value,
        id: expr.id,
        resultType: getType(expr.id, ctx, INT_T),
      };
    case "float_lit":
      return {
        tag: "float_lit",
        value: expr.value,
        id: expr.id,
        resultType: getType(expr.id, ctx, FLOAT_T),
      };
    case "void_lit":
      return {
        tag: "void_lit",
        id: expr.id,
        resultType: getType(expr.id, ctx, VOID_T),
      };
    case "var":
      return {
        tag: "var",
        name: expr.name,
        id: expr.id,
        resultType: getType(expr.id, ctx, ctx.env.get(expr.name) ?? VOID_T),
      };
    case "res":
      return {
        tag: "res",
        id: expr.id,
        resultType: getType(expr.id, ctx, ctx.fnRetType),
      };
    case "rec":
      return {
        tag: "rec",
        args: expr.args.map((a) => lowerExpr(a, ctx, false)),
        id: expr.id,
        resultType: getType(expr.id, ctx, ctx.fnRetType),
        tailPosition: isTailPosition,
      };
    case "binop": {
      const left = lowerExpr(expr.left, ctx, false);
      const right = lowerExpr(expr.right, ctx, false);
      const fallback = inferBinopType(expr.op, left.resultType, right.resultType);
      return {
        tag: "binop",
        op: expr.op,
        left,
        right,
        id: expr.id,
        resultType: getType(expr.id, ctx, fallback),
      };
    }
    case "unop": {
      const operand = lowerExpr(expr.operand, ctx, false);
      return {
        tag: "unop",
        op: expr.op,
        operand,
        id: expr.id,
        resultType: getType(expr.id, ctx, operand.resultType),
      };
    }
    case "call": {
      const args = expr.args.map((a) => lowerExpr(a, ctx, false));
      const fallback = inferCallType(expr.name, args.map((a) => a.resultType), ctx);
      return {
        tag: "call",
        name: expr.name,
        args,
        id: expr.id,
        resultType: getType(expr.id, ctx, fallback),
      };
    }
    case "index": {
      const array = lowerExpr(expr.array, ctx, false);
      const indices = expr.indices.map((i) => lowerExpr(i, ctx, false));
      const fallback: Type =
        array.resultType.tag === "array"
          ? indices.length >= array.resultType.dims
            ? array.resultType.element
            : {
                tag: "array",
                element: array.resultType.element,
                dims: array.resultType.dims - indices.length,
              }
          : VOID_T;
      return {
        tag: "index",
        array,
        indices,
        id: expr.id,
        resultType: getType(expr.id, ctx, fallback),
      };
    }
    case "field":
      return {
        tag: "field",
        target: lowerExpr(expr.target, ctx, false),
        field: expr.field,
        id: expr.id,
        resultType: getType(expr.id, ctx, VOID_T),
      };
    case "struct_cons":
      return {
        tag: "struct_cons",
        name: expr.name,
        fields: expr.fields.map((f) => lowerExpr(f, ctx, false)),
        id: expr.id,
        resultType: getType(expr.id, ctx, { tag: "named", name: expr.name }),
      };
    case "array_cons": {
      const elements = expr.elements.map((e) => lowerExpr(e, ctx, false));
      const elemType = elements[0]?.resultType ?? VOID_T;
      return {
        tag: "array_cons",
        elements,
        id: expr.id,
        resultType: getType(expr.id, ctx, { tag: "array", element: elemType, dims: 1 }),
      };
    }
    case "array_expr":
    case "sum_expr": {
      const bindings = lowerBindings(expr.bindings, ctx);
      const body = withScopedBindings(bindings, ctx, () => lowerExpr(expr.body, ctx, false));
      return {
        tag: expr.tag,
        bindings,
        body,
        id: expr.id,
        resultType: getType(expr.id, ctx, body.resultType),
      };
    }
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}

function lowerBindings(bindings: Binding[], ctx: LowerCtx): IRBinding[] {
  const lowered: IRBinding[] = [];
  for (const binding of bindings) {
    const expr = lowerExpr(binding.expr, ctx, false);
    lowered.push({
      name: binding.name,
      expr,
    });
    ctx.env.set(binding.name, INT_T);
  }
  for (let i = bindings.length - 1; i >= 0; i -= 1) {
    ctx.env.delete(bindings[i]!.name);
  }
  return lowered;
}

function withScopedBindings<T>(bindings: IRBinding[], ctx: LowerCtx, f: () => T): T {
  for (const binding of bindings) {
    ctx.env.set(binding.name, INT_T);
  }
  try {
    return f();
  } finally {
    for (let i = bindings.length - 1; i >= 0; i -= 1) {
      ctx.env.delete(bindings[i]!.name);
    }
  }
}

function getType(id: number, ctx: LowerCtx, fallback: Type): Type {
  return ctx.typeMap?.get(id) ?? fallback;
}

function inferBinopType(op: string, left: Type, right: Type): Type {
  if (op === "%" || op === "/" || op === "+" || op === "-" || op === "*") {
    if (left.tag === "float" || right.tag === "float") {
      return FLOAT_T;
    }
    if (left.tag === "int" && right.tag === "int") {
      return INT_T;
    }
  }
  return left.tag === "void" ? right : left;
}

function inferCallType(name: string, argTypes: Type[], ctx: LowerCtx): Type {
  if (
    name === "sqrt" ||
    name === "exp" ||
    name === "sin" ||
    name === "cos" ||
    name === "tan" ||
    name === "asin" ||
    name === "acos" ||
    name === "atan" ||
    name === "log" ||
    name === "pow" ||
    name === "atan2" ||
    name === "to_float"
  ) {
    return FLOAT_T;
  }
  if (name === "to_int") {
    return INT_T;
  }
  if (name === "max" || name === "min" || name === "abs" || name === "clamp") {
    return argTypes[0] ?? VOID_T;
  }
  return ctx.fnSigs.get(name)?.ret ?? VOID_T;
}
