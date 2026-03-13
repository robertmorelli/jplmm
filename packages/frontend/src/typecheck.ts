import type { Argument, Binding, Cmd, Expr, LValue, Program, StructField, Type } from "@jplmm/ast";

import { error, type Diagnostic } from "./errors";

type TypecheckResult = {
  program: Program;
  typeMap: Map<number, Type>;
  diagnostics: Diagnostic[];
};

type FnSig = {
  params: Type[];
  ret: Type;
};

type FnContext = {
  sig: FnSig;
};

const INT_T: Type = { tag: "int" };
const FLOAT_T: Type = { tag: "float" };
const VOID_T: Type = { tag: "void" };
const IMAGE_T: Type = { tag: "array", element: INT_T, dims: 3 };

export function typecheckProgram(program: Program): TypecheckResult {
  const diagnostics: Diagnostic[] = [];
  const typeMap = new Map<number, Type>();
  const fnSigs = collectFnSigs(program);
  const structDefs = collectStructDefs(program);
  const globalEnv = new Map<string, Type>();

  for (const cmd of program.commands) {
    if (unwrapTimedDefinition(cmd, "struct_def")) {
      continue;
    }

    const fnDef = unwrapTimedDefinition(cmd, "fn_def");
    if (fnDef) {
      const env = new Map<string, Type>();
      for (const p of fnDef.params) {
        env.set(p.name, p.type);
      }
      const ctx: FnContext = { sig: fnSigs.get(fnDef.name)! };
      for (const stmt of fnDef.body) {
        if (stmt.tag === "let") {
          const t = inferExpr(stmt.expr, env, fnSigs, structDefs, diagnostics, typeMap, ctx);
          applyLValueType(stmt.lvalue, t, env, fnSigs, structDefs, diagnostics, typeMap, ctx, "local");
          continue;
        }
        if (stmt.tag === "ret") {
          const t = inferExpr(stmt.expr, env, fnSigs, structDefs, diagnostics, typeMap, ctx);
          if (!sameType(t, fnDef.retType)) {
            diagnostics.push(
              error(
                `ret type mismatch: expected ${typeToString(fnDef.retType)}, got ${typeToString(t)}`,
                0,
                0,
                "RET_TYPE",
              ),
            );
          }
          continue;
        }
        if (stmt.tag === "rad") {
          const t = inferExpr(stmt.expr, env, fnSigs, structDefs, diagnostics, typeMap, ctx);
          if (t.tag !== "int" && t.tag !== "float") {
            diagnostics.push(error("rad expression must be int or float", 0, 0, "RAD_TYPE"));
          }
          continue;
        }
        if (stmt.tag === "gas") {
          if (
            stmt.limit !== "inf" &&
            (!Number.isInteger(stmt.limit) || stmt.limit < 0 || stmt.limit > 4294967296)
          ) {
            diagnostics.push(error("gas N requires an integer literal in [0, 2^32]", 0, 0, "GAS_LIT"));
          }
        }
      }
      continue;
    }

    typecheckTopLevelCmd(
      cmd as Exclude<Cmd, { tag: "fn_def" } | { tag: "struct_def" }>,
      globalEnv,
      fnSigs,
      structDefs,
      diagnostics,
      typeMap,
    );
  }

  return { program, typeMap, diagnostics };
}

function collectFnSigs(program: Program): Map<string, FnSig> {
  const out = new Map<string, FnSig>();
  for (const cmd of program.commands) {
    const definition = unwrapTimedDefinition(cmd, "fn_def");
    if (!definition) {
      continue;
    }
    out.set(definition.name, {
      params: definition.params.map((p) => p.type),
      ret: definition.retType,
    });
  }
  return out;
}

function typecheckTopLevelCmd(
  cmd: Exclude<Cmd, { tag: "fn_def" } | { tag: "struct_def" }>,
  env: Map<string, Type>,
  fnSigs: Map<string, FnSig>,
  structDefs: Map<string, StructField[]>,
  diagnostics: Diagnostic[],
  typeMap: Map<number, Type>,
): void {
  switch (cmd.tag) {
    case "let_cmd": {
      const t = inferExpr(cmd.expr, env, fnSigs, structDefs, diagnostics, typeMap, undefined);
      applyLValueType(cmd.lvalue, t, env, fnSigs, structDefs, diagnostics, typeMap, undefined, "top");
      return;
    }
    case "read_image":
      bindImageArgument(cmd.target, env, diagnostics);
      return;
    case "write_image": {
      const t = inferExpr(cmd.expr, env, fnSigs, structDefs, diagnostics, typeMap, undefined);
      if (!isWritableImageType(t)) {
        diagnostics.push(error(`write image expects int[][] or int[][][], got ${typeToString(t)}`, 0, 0, "IMAGE_TYPE"));
      }
      return;
    }
    case "show":
      inferExpr(cmd.expr, env, fnSigs, structDefs, diagnostics, typeMap, undefined);
      return;
    case "time":
      if (cmd.cmd.tag === "fn_def" || cmd.cmd.tag === "struct_def") {
        return;
      }
      typecheckTopLevelCmd(cmd.cmd, env, fnSigs, structDefs, diagnostics, typeMap);
      return;
    case "print":
      return;
    default: {
      const _never: never = cmd;
      return _never;
    }
  }
}

function applyLValueType(
  lvalue: LValue,
  exprType: Type,
  env: Map<string, Type>,
  fnSigs: Map<string, FnSig>,
  structDefs: Map<string, StructField[]>,
  diagnostics: Diagnostic[],
  typeMap: Map<number, Type>,
  fnCtx: FnContext | undefined,
  mode: "local" | "top",
): void {
  switch (lvalue.tag) {
    case "var":
      env.set(lvalue.name, exprType);
      return;
    case "field": {
      const baseType = env.get(lvalue.base);
      if (!baseType || baseType.tag !== "named") {
        diagnostics.push(error(`Field assignment requires a struct variable, got ${typeToString(baseType ?? VOID_T)}`, 0, 0, "FIELD_BASE"));
        return;
      }
      const field = structDefs.get(baseType.name)?.find((candidate) => candidate.name === lvalue.field);
      if (!field) {
        diagnostics.push(error(`Struct '${baseType.name}' has no field '${lvalue.field}'`, 0, 0, "FIELD_UNKNOWN"));
        return;
      }
      if (!sameType(field.type, exprType)) {
        diagnostics.push(
          error(
            `Field assignment type mismatch: expected ${typeToString(field.type)}, got ${typeToString(exprType)}`,
            0,
            0,
            "FIELD_ASSIGN_TYPE",
          ),
        );
      }
      return;
    }
    case "tuple":
      diagnostics.push(
        error(
          mode === "top"
            ? "Tuple let bindings are only supported for read image targets"
            : "Tuple let bindings are not supported inside functions",
          0,
          0,
          "LHS_TUPLE",
        ),
      );
      return;
    default: {
      const _never: never = lvalue;
      return _never;
    }
  }
}

function bindImageArgument(argument: Argument, env: Map<string, Type>, diagnostics: Diagnostic[]): void {
  const leaves = flattenArgument(argument);
  if (leaves.length === 1) {
    env.set(leaves[0]!, IMAGE_T);
    return;
  }
  if (leaves.length === 3) {
    env.set(leaves[0]!, INT_T);
    env.set(leaves[1]!, INT_T);
    env.set(leaves[2]!, IMAGE_T);
    return;
  }
  diagnostics.push(
    error("read image target must bind either image or (width, height, image)", 0, 0, "IMAGE_TARGET"),
  );
}

function flattenArgument(argument: Argument): string[] {
  if (argument.tag === "var") {
    return [argument.name];
  }
  return argument.items.flatMap((item) => flattenArgument(item));
}

function collectStructDefs(program: Program): Map<string, StructField[]> {
  const out = new Map<string, StructField[]>();
  for (const cmd of program.commands) {
    const definition = unwrapTimedDefinition(cmd, "struct_def");
    if (!definition) {
      continue;
    }
    out.set(definition.name, definition.fields);
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

function inferExpr(
  expr: Expr,
  env: Map<string, Type>,
  fnSigs: Map<string, FnSig>,
  structDefs: Map<string, StructField[]>,
  diagnostics: Diagnostic[],
  typeMap: Map<number, Type>,
  fnCtx: FnContext | undefined,
): Type {
  let out: Type = VOID_T;
  switch (expr.tag) {
    case "int_lit":
      out = INT_T;
      break;
    case "float_lit":
      out = FLOAT_T;
      break;
    case "void_lit":
      out = VOID_T;
      break;
    case "var":
      out = env.get(expr.name) ?? VOID_T;
      if (!env.has(expr.name)) {
        diagnostics.push(error(`Unbound variable '${expr.name}'`, 0, 0, "UNBOUND_VAR"));
      }
      break;
    case "res":
      out = fnCtx?.sig.ret ?? VOID_T;
      if (!fnCtx) {
        diagnostics.push(error("res used outside function", 0, 0, "RES_TOP"));
      }
      break;
    case "rec":
      if (!fnCtx) {
        diagnostics.push(error("rec used outside function", 0, 0, "REC_TOP"));
        out = VOID_T;
      } else {
        if (expr.args.length !== fnCtx.sig.params.length) {
          diagnostics.push(
            error(
              `rec argument arity mismatch: expected ${fnCtx.sig.params.length}, got ${expr.args.length}`,
              0,
              0,
              "REC_ARITY",
            ),
          );
        }
        for (let i = 0; i < expr.args.length; i += 1) {
          const actual = inferExpr(expr.args[i]!, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
          const expected = fnCtx.sig.params[i];
          if (expected && !sameType(actual, expected)) {
            diagnostics.push(
              error(
                `rec argument ${i + 1} type mismatch: expected ${typeToString(expected)}, got ${typeToString(actual)}`,
                0,
                0,
                "REC_ARG_TYPE",
              ),
            );
          }
        }
        out = fnCtx.sig.ret;
      }
      break;
    case "unop": {
      const t = inferExpr(expr.operand, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
      if (!isNumeric(t)) {
        diagnostics.push(error(`Unary '-' requires numeric operand, got ${typeToString(t)}`, 0, 0));
      }
      out = t;
      break;
    }
    case "binop": {
      const a = inferExpr(expr.left, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
      const b = inferExpr(expr.right, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
      if (!sameType(a, b)) {
        diagnostics.push(
          error(
            `Binary '${expr.op}' requires same-type operands, got ${typeToString(a)} and ${typeToString(b)}`,
            0,
            0,
            "BINOP_MISMATCH",
          ),
        );
      } else if (!isNumeric(a)) {
        diagnostics.push(
          error(`Binary '${expr.op}' requires numeric operands, got ${typeToString(a)}`, 0, 0, "BINOP_NUM"),
        );
      }
      out = a;
      break;
    }
    case "call":
      out = inferCall(expr.name, expr.args, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
      break;
    case "index": {
      const arrayT = inferExpr(expr.array, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
      for (const idx of expr.indices) {
        const idxT = inferExpr(idx, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
        if (idxT.tag !== "int") {
          diagnostics.push(error("Array index must be int", 0, 0, "INDEX_TYPE"));
        }
      }
      if (arrayT.tag !== "array") {
        diagnostics.push(error(`Indexing requires array type, got ${typeToString(arrayT)}`, 0, 0, "INDEX_BASE"));
        out = VOID_T;
      } else if (expr.indices.length > arrayT.dims) {
        diagnostics.push(error("Too many indices for array rank", 0, 0, "INDEX_RANK"));
        out = arrayT.element;
      } else if (expr.indices.length === arrayT.dims) {
        out = arrayT.element;
      } else {
        out = {
          tag: "array",
          element: arrayT.element,
          dims: arrayT.dims - expr.indices.length,
        };
      }
      break;
    }
    case "field": {
      const targetType = inferExpr(expr.target, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
      if (targetType.tag !== "named") {
        diagnostics.push(error(`Field access requires a struct, got ${typeToString(targetType)}`, 0, 0, "FIELD_BASE"));
        out = VOID_T;
        break;
      }
      const fields = structDefs.get(targetType.name);
      const field = fields?.find((candidate) => candidate.name === expr.field);
      if (!field) {
        diagnostics.push(error(`Struct '${targetType.name}' has no field '${expr.field}'`, 0, 0, "FIELD_UNKNOWN"));
        out = VOID_T;
        break;
      }
      out = field.type;
      break;
    }
    case "array_cons": {
      if (expr.elements.length === 0) {
        diagnostics.push(error("Empty array literal is not allowed in v1", 0, 0, "ARRAY_EMPTY"));
        out = { tag: "array", element: VOID_T, dims: 1 };
      } else {
        const first = inferExpr(expr.elements[0]!, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
        for (let i = 1; i < expr.elements.length; i += 1) {
          const t = inferExpr(expr.elements[i]!, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
          if (!sameType(t, first)) {
            diagnostics.push(error("Array literal elements must share one type", 0, 0, "ARRAY_HOMOGENEOUS"));
          }
        }
        if (first.tag === "void") {
          diagnostics.push(error("Array literal elements cannot be void", 0, 0, "ARRAY_ELEM_VOID"));
        }
        out = prependArrayDimension(first);
      }
      break;
    }
    case "struct_cons": {
      const fields = structDefs.get(expr.name);
      if (!fields) {
        diagnostics.push(error(`Unknown struct '${expr.name}'`, 0, 0, "STRUCT_UNKNOWN"));
        for (const f of expr.fields) {
          inferExpr(f, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
        }
        out = VOID_T;
        break;
      }
      if (expr.fields.length !== fields.length) {
        diagnostics.push(
          error(`Struct '${expr.name}' expects ${fields.length} fields, got ${expr.fields.length}`, 0, 0, "STRUCT_ARITY"),
        );
      }
      for (let i = 0; i < expr.fields.length; i += 1) {
        const actual = inferExpr(expr.fields[i]!, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
        const expected = fields[i]?.type;
        if (expected && !sameType(actual, expected)) {
          diagnostics.push(
            error(
              `Struct '${expr.name}' field ${i + 1} type mismatch: expected ${typeToString(expected)}, got ${typeToString(actual)}`,
              0,
              0,
              "STRUCT_FIELD_TYPE",
            ),
          );
        }
      }
      out = { tag: "named", name: expr.name };
      break;
    }
    case "array_expr": {
      const bodyType = inferComprehensionBody(expr.bindings, expr.body, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
      if (bodyType.tag === "void") {
        diagnostics.push(error("array body cannot be void", 0, 0, "ARRAY_BODY_VOID"));
      }
      out = addArrayDimensions(bodyType, expr.bindings.length);
      break;
    }
    case "sum_expr": {
      const bodyType = inferComprehensionBody(expr.bindings, expr.body, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
      if (!isNumeric(bodyType)) {
        diagnostics.push(error(`sum body must be numeric, got ${typeToString(bodyType)}`, 0, 0, "SUM_TYPE"));
      }
      out = bodyType;
      break;
    }
    default: {
      const _never: never = expr;
      out = _never;
      break;
    }
  }

  typeMap.set(expr.id, out);
  return out;
}

function inferComprehensionBody(
  bindings: Binding[],
  body: Expr,
  env: Map<string, Type>,
  fnSigs: Map<string, FnSig>,
  structDefs: Map<string, StructField[]>,
  diagnostics: Diagnostic[],
  typeMap: Map<number, Type>,
  fnCtx: FnContext | undefined,
): Type {
  const localEnv = new Map(env);
  for (const binding of bindings) {
    const boundType = inferExpr(binding.expr, localEnv, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
    if (boundType.tag !== "int") {
      diagnostics.push(error("Comprehension bounds must be int", 0, 0, "BINDING_TYPE"));
    }
    localEnv.set(binding.name, INT_T);
  }
  return inferExpr(body, localEnv, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
}

function inferCall(
  name: string,
  args: Expr[],
  env: Map<string, Type>,
  fnSigs: Map<string, FnSig>,
  structDefs: Map<string, StructField[]>,
  diagnostics: Diagnostic[],
  typeMap: Map<number, Type>,
  fnCtx: FnContext | undefined,
): Type {
  const inferArgs = (): Type[] =>
    args.map((a) => inferExpr(a, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx));

  if (name === "to_float") {
    const [a] = inferArgs();
    if (!a || a.tag !== "int" || args.length !== 1) {
      diagnostics.push(error("to_float expects exactly one int argument", 0, 0, "BUILTIN_SIG"));
    }
    return FLOAT_T;
  }
  if (name === "to_int") {
    const [a] = inferArgs();
    if (!a || a.tag !== "float" || args.length !== 1) {
      diagnostics.push(error("to_int expects exactly one float argument", 0, 0, "BUILTIN_SIG"));
    }
    return INT_T;
  }
  if (name === "max" || name === "min") {
    const ts = inferArgs();
    if (ts.length !== 2 || !ts[0] || !ts[1] || !sameType(ts[0], ts[1]) || !isNumeric(ts[0])) {
      diagnostics.push(error(`${name} expects two numeric arguments of the same type`, 0, 0, "BUILTIN_SIG"));
      return VOID_T;
    }
    return ts[0]!;
  }
  if (name === "abs") {
    const [a] = inferArgs();
    if (!a || !isNumeric(a) || args.length !== 1) {
      diagnostics.push(error("abs expects exactly one numeric argument", 0, 0, "BUILTIN_SIG"));
      return VOID_T;
    }
    return a;
  }
  if (name === "clamp") {
    const ts = inferArgs();
    if (
      ts.length !== 3 ||
      !ts[0] ||
      !ts[1] ||
      !ts[2] ||
      !sameType(ts[0], ts[1]) ||
      !sameType(ts[0], ts[2]) ||
      !isNumeric(ts[0])
    ) {
      diagnostics.push(
        error("clamp expects three numeric arguments of the same type", 0, 0, "BUILTIN_SIG"),
      );
      return VOID_T;
    }
    return ts[0];
  }

  if (
    name === "sqrt" ||
    name === "exp" ||
    name === "sin" ||
    name === "cos" ||
    name === "tan" ||
    name === "asin" ||
    name === "acos" ||
    name === "atan" ||
    name === "log"
  ) {
    const [a] = inferArgs();
    if (!a || a.tag !== "float" || args.length !== 1) {
      diagnostics.push(error(`${name} expects exactly one float argument`, 0, 0, "BUILTIN_SIG"));
    }
    return FLOAT_T;
  }

  if (name === "pow" || name === "atan2") {
    const ts = inferArgs();
    if (ts.length !== 2 || ts.some((t) => t.tag !== "float")) {
      diagnostics.push(error(`${name} expects exactly two float arguments`, 0, 0, "BUILTIN_SIG"));
    }
    return FLOAT_T;
  }

  const sig = fnSigs.get(name);
  const argTypes = inferArgs();
  if (!sig) {
    diagnostics.push(error(`Unknown function '${name}'`, 0, 0, "CALL_UNKNOWN"));
    return VOID_T;
  }
  if (argTypes.length !== sig.params.length) {
    diagnostics.push(
      error(`Function '${name}' expects ${sig.params.length} args, got ${argTypes.length}`, 0, 0, "CALL_ARITY"),
    );
    return sig.ret;
  }
  for (let i = 0; i < argTypes.length; i += 1) {
    if (!sameType(argTypes[i]!, sig.params[i]!)) {
      diagnostics.push(
        error(
          `Function '${name}' arg ${i + 1} type mismatch: expected ${typeToString(sig.params[i]!)}, got ${typeToString(argTypes[i]!)}`,
          0,
          0,
          "CALL_ARG_TYPE",
        ),
      );
    }
  }
  return sig.ret;
}

function isNumeric(t: Type): boolean {
  return t.tag === "int" || t.tag === "float";
}

function sameType(a: Type, b: Type): boolean {
  if (a.tag !== b.tag) {
    return false;
  }
  if (a.tag === "array" && b.tag === "array") {
    return a.dims === b.dims && sameType(a.element, b.element);
  }
  if (a.tag === "named" && b.tag === "named") {
    return a.name === b.name;
  }
  return true;
}

function prependArrayDimension(type: Type): Type {
  if (type.tag === "array") {
    return {
      tag: "array",
      element: type.element,
      dims: type.dims + 1,
    };
  }
  return { tag: "array", element: type, dims: 1 };
}

function addArrayDimensions(type: Type, dims: number): Type {
  if (type.tag === "array") {
    return {
      tag: "array",
      element: type.element,
      dims: type.dims + dims,
    };
  }
  return {
    tag: "array",
    element: type,
    dims,
  };
}

function isWritableImageType(type: Type): boolean {
  if (type.tag !== "array" || type.element.tag !== "int") {
    return false;
  }
  return type.dims === 2 || type.dims === 3;
}

function typeToString(t: Type): string {
  switch (t.tag) {
    case "int":
    case "float":
    case "void":
      return t.tag;
    case "named":
      return t.name;
    case "array":
      return `${typeToString(t.element)}${"[]".repeat(t.dims)}`;
    default: {
      const _never: never = t;
      return `${_never}`;
    }
  }
}
