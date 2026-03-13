import type { Argument, Binding, Cmd, Expr, LValue, Program, Stmt, Type } from "@jplmm/ast";

import { error, type Diagnostic, warning } from "./errors";

type ResolveResult = {
  program: Program;
  diagnostics: Diagnostic[];
};

const BUILTIN_FUNCTIONS = new Set([
  "sqrt",
  "exp",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "log",
  "pow",
  "atan2",
  "to_float",
  "to_int",
  "max",
  "min",
  "abs",
  "clamp",
]);

type FnContext = {
  fnName: string;
  resAvailable: boolean;
  seenRec: boolean;
  radCount: number;
  gasCount: number;
  scope: Set<string>;
};

export function resolveProgram(program: Program): ResolveResult {
  const diagnostics: Diagnostic[] = [];
  const definedFns = new Set<string>();
  const definedStructs = new Set<string>();
  const globalVars = new Set<string>();

  for (const cmd of program.commands) {
    resolveProgramCmd(cmd, diagnostics, definedFns, definedStructs, globalVars);
  }

  return { program, diagnostics };
}

function resolveProgramCmd(
  cmd: Cmd,
  diagnostics: Diagnostic[],
  definedFns: Set<string>,
  definedStructs: Set<string>,
  globalVars: Set<string>,
): void {
  if (cmd.tag === "time") {
    resolveProgramCmd(cmd.cmd, diagnostics, definedFns, definedStructs, globalVars);
    return;
  }
  if (cmd.tag === "struct_def") {
    resolveStructDef(cmd, diagnostics, definedStructs);
    return;
  }
  if (cmd.tag === "fn_def") {
    resolveFnDef(cmd, diagnostics, definedFns, definedStructs);
    return;
  }
  resolveTopLevelCmd(cmd, diagnostics, definedFns, definedStructs, globalVars);
}

function resolveStructDef(
  cmd: Extract<Cmd, { tag: "struct_def" }>,
  diagnostics: Diagnostic[],
  definedStructs: Set<string>,
): void {
  if (definedStructs.has(cmd.name)) {
    diagnostics.push(error(`Duplicate struct '${cmd.name}'`, 0, 0, "DUP_STRUCT"));
  }
  const fieldNames = new Set<string>();
  for (const field of cmd.fields) {
    if (fieldNames.has(field.name)) {
      diagnostics.push(error(`Duplicate field '${field.name}' in struct '${cmd.name}'`, 0, 0, "DUP_FIELD"));
    }
    fieldNames.add(field.name);
    resolveType(field.type, diagnostics, definedStructs);
  }
  definedStructs.add(cmd.name);
}

function resolveFnDef(
  cmd: Extract<Cmd, { tag: "fn_def" }>,
  diagnostics: Diagnostic[],
  definedFns: Set<string>,
  definedStructs: Set<string>,
): void {
  if (definedFns.has(cmd.name)) {
    diagnostics.push(error(`Duplicate function '${cmd.name}'`, 0, 0, "DUP_FN"));
  }
  for (const param of cmd.params) {
    resolveType(param.type, diagnostics, definedStructs);
  }
  resolveType(cmd.retType, diagnostics, definedStructs);
  resolveFunction(cmd, diagnostics, definedFns, definedStructs);
  definedFns.add(cmd.name);
}

function resolveTopLevelCmd(
  cmd: Exclude<Cmd, { tag: "fn_def" } | { tag: "struct_def" } | { tag: "time" }>,
  diagnostics: Diagnostic[],
  definedFns: Set<string>,
  definedStructs: Set<string>,
  globalVars: Set<string>,
): void {
  switch (cmd.tag) {
    case "let_cmd":
      resolveExpr(cmd.expr, diagnostics, definedFns, definedStructs, globalVars, undefined);
      bindLValue(cmd.lvalue, diagnostics, globalVars, "top", definedFns, definedStructs, undefined);
      return;
    case "read_image":
      bindArgument(cmd.target, diagnostics, globalVars);
      return;
    case "write_image":
      resolveExpr(cmd.expr, diagnostics, definedFns, definedStructs, globalVars, undefined);
      return;
    case "show":
      resolveExpr(cmd.expr, diagnostics, definedFns, definedStructs, globalVars, undefined);
      return;
    case "print":
      return;
    default: {
      const _never: never = cmd;
      return _never;
    }
  }
}

function resolveFunction(
  cmd: Extract<Cmd, { tag: "fn_def" }>,
  diagnostics: Diagnostic[],
  definedFns: Set<string>,
  definedStructs: Set<string>,
): void {
  const scope = new Set<string>();
  for (const p of cmd.params) {
    if (scope.has(p.name)) {
      diagnostics.push(error(`Duplicate parameter '${p.name}' in '${cmd.name}'`, 0, 0, "DUP_PARAM"));
    }
    scope.add(p.name);
  }

  const ctx: FnContext = {
    fnName: cmd.name,
    resAvailable: false,
    seenRec: false,
    radCount: 0,
    gasCount: 0,
    scope,
  };

  for (const stmt of cmd.body) {
    resolveStmt(stmt, diagnostics, definedFns, definedStructs, ctx);
  }

  if (ctx.gasCount > 1) {
    diagnostics.push(error(`Function '${cmd.name}' has multiple gas statements`, 0, 0, "MULTI_GAS"));
  }
  if (ctx.gasCount > 0 && ctx.radCount > 0) {
    diagnostics.push(
      error(`Function '${cmd.name}' mixes 'rad' and 'gas' (mutually exclusive)`, 0, 0, "RAD_GAS_MIX"),
    );
  }
  if (ctx.seenRec && ctx.gasCount + ctx.radCount === 0) {
    diagnostics.push(
      error(`Function '${cmd.name}' uses 'rec' but has no 'rad' or 'gas'`, 0, 0, "REC_NO_PROOF"),
    );
  }
  if (ctx.gasCount > 0) {
    const gasStmt = cmd.body.find((s) => s.tag === "gas");
    if (gasStmt && gasStmt.limit === "inf") {
      diagnostics.push(
        warning(
          `Function '${cmd.name}' uses gas inf — termination is not guaranteed`,
          0,
          0,
          "GAS_INF",
        ),
      );
    }
  }
}

function resolveStmt(
  stmt: Stmt,
  diagnostics: Diagnostic[],
  definedFns: Set<string>,
  definedStructs: Set<string>,
  ctx: FnContext,
): void {
  if (stmt.tag === "let") {
    resolveExpr(stmt.expr, diagnostics, definedFns, definedStructs, ctx.scope, ctx);
    bindLValue(stmt.lvalue, diagnostics, ctx.scope, "local", definedFns, definedStructs, ctx);
    return;
  }

  if (stmt.tag === "ret") {
    resolveExpr(stmt.expr, diagnostics, definedFns, definedStructs, ctx.scope, ctx);
    ctx.resAvailable = true;
    return;
  }

  if (stmt.tag === "rad") {
    ctx.radCount += 1;
    resolveExpr(stmt.expr, diagnostics, definedFns, definedStructs, ctx.scope, ctx);
    return;
  }

  if (stmt.tag === "gas") {
    ctx.gasCount += 1;
  }
}

function bindLValue(
  lvalue: LValue,
  diagnostics: Diagnostic[],
  scope: Set<string>,
  mode: "local" | "top",
  definedFns: Set<string>,
  definedStructs: Set<string>,
  fnCtx: FnContext | undefined,
): void {
  switch (lvalue.tag) {
    case "var":
      if (scope.has(lvalue.name)) {
        diagnostics.push(error(`Shadowing is not allowed: '${lvalue.name}'`, 0, 0, "SHADOW"));
        return;
      }
      scope.add(lvalue.name);
      return;
    case "field":
      if (!scope.has(lvalue.base)) {
        diagnostics.push(error(`Unbound variable '${lvalue.base}'`, 0, 0, "UNBOUND_VAR"));
      }
      return;
    case "tuple":
      if (mode === "local") {
        diagnostics.push(error("Tuple lvalues are only supported for read image targets", 0, 0, "LHS_TUPLE"));
        return;
      }
      for (const item of lvalue.items) {
        bindLValue(item, diagnostics, scope, mode, definedFns, definedStructs, fnCtx);
      }
      return;
    default: {
      const _never: never = lvalue;
      return _never;
    }
  }
}

function bindArgument(argument: Argument, diagnostics: Diagnostic[], scope: Set<string>): void {
  if (argument.tag === "var") {
    if (scope.has(argument.name)) {
      diagnostics.push(error(`Shadowing is not allowed: '${argument.name}'`, 0, 0, "SHADOW"));
      return;
    }
    scope.add(argument.name);
    return;
  }
  for (const item of argument.items) {
    bindArgument(item, diagnostics, scope);
  }
}

function resolveExpr(
  expr: Expr,
  diagnostics: Diagnostic[],
  definedFns: Set<string>,
  definedStructs: Set<string>,
  scope: Set<string>,
  fnCtx: FnContext | undefined,
): void {
  switch (expr.tag) {
    case "int_lit":
    case "float_lit":
    case "void_lit":
      return;
    case "var":
      if (!scope.has(expr.name)) {
        diagnostics.push(error(`Unbound variable '${expr.name}'`, 0, 0, "UNBOUND_VAR"));
      }
      return;
    case "res":
      if (!fnCtx) {
        diagnostics.push(error("res is only valid inside a function body", 0, 0, "RES_TOP"));
      } else if (!fnCtx.resAvailable) {
        diagnostics.push(error("res used before first ret", 0, 0, "RES_BEFORE_RET"));
      }
      return;
    case "rec":
      if (!fnCtx) {
        diagnostics.push(error("rec is only valid inside a function body", 0, 0, "REC_TOP"));
      } else {
        fnCtx.seenRec = true;
        if (!fnCtx.resAvailable) {
          diagnostics.push(error("rec used before first ret", 0, 0, "REC_BEFORE_RET"));
        }
      }
      for (const arg of expr.args) {
        resolveExpr(arg, diagnostics, definedFns, definedStructs, scope, fnCtx);
      }
      return;
    case "binop":
      resolveExpr(expr.left, diagnostics, definedFns, definedStructs, scope, fnCtx);
      resolveExpr(expr.right, diagnostics, definedFns, definedStructs, scope, fnCtx);
      return;
    case "unop":
      resolveExpr(expr.operand, diagnostics, definedFns, definedStructs, scope, fnCtx);
      return;
    case "call":
      if (!BUILTIN_FUNCTIONS.has(expr.name)) {
        if (fnCtx && expr.name === fnCtx.fnName) {
          diagnostics.push(error(`Direct self-call '${expr.name}(...)' is not allowed; use rec(...)`, 0, 0));
        } else if (!definedFns.has(expr.name)) {
          diagnostics.push(error(`Function '${expr.name}' not in scope (single-pass binding)`, 0, 0));
        }
      }
      for (const arg of expr.args) {
        resolveExpr(arg, diagnostics, definedFns, definedStructs, scope, fnCtx);
      }
      return;
    case "field":
      resolveExpr(expr.target, diagnostics, definedFns, definedStructs, scope, fnCtx);
      return;
    case "index":
      resolveExpr(expr.array, diagnostics, definedFns, definedStructs, scope, fnCtx);
      for (const idx of expr.indices) {
        resolveExpr(idx, diagnostics, definedFns, definedStructs, scope, fnCtx);
      }
      return;
    case "struct_cons":
      if (!definedStructs.has(expr.name)) {
        diagnostics.push(error(`Struct '${expr.name}' not in scope (single-pass binding)`, 0, 0, "STRUCT_SCOPE"));
      }
      for (const v of expr.fields) {
        resolveExpr(v, diagnostics, definedFns, definedStructs, scope, fnCtx);
      }
      return;
    case "array_cons":
      for (const v of expr.elements) {
        resolveExpr(v, diagnostics, definedFns, definedStructs, scope, fnCtx);
      }
      return;
    case "array_expr":
    case "sum_expr":
      resolveBindings(expr.bindings, diagnostics, definedFns, definedStructs, scope, fnCtx, expr.body);
      return;
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}

function resolveBindings(
  bindings: Binding[],
  diagnostics: Diagnostic[],
  definedFns: Set<string>,
  definedStructs: Set<string>,
  parentScope: Set<string>,
  fnCtx: FnContext | undefined,
  body: Expr,
): void {
  const localScope = new Set(parentScope);
  for (const binding of bindings) {
    resolveExpr(binding.expr, diagnostics, definedFns, definedStructs, localScope, fnCtx);
    if (localScope.has(binding.name)) {
      diagnostics.push(error(`Shadowing is not allowed: '${binding.name}'`, 0, 0, "SHADOW"));
    }
    localScope.add(binding.name);
  }
  resolveExpr(body, diagnostics, definedFns, definedStructs, localScope, fnCtx);
}

function resolveType(type: Type, diagnostics: Diagnostic[], definedStructs: Set<string>): void {
  if (type.tag === "array") {
    resolveType(type.element, diagnostics, definedStructs);
    return;
  }
  if (type.tag === "named" && !definedStructs.has(type.name)) {
    diagnostics.push(error(`Unknown type '${type.name}'`, 0, 0, "TYPE_UNKNOWN"));
  }
}
