import { error, warning } from "./errors";
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
export function resolveProgram(program) {
    const diagnostics = [];
    const definedFns = new Set();
    const globalVars = new Set();
    for (const cmd of program.commands) {
        if (cmd.tag === "fn_def") {
            if (definedFns.has(cmd.name)) {
                diagnostics.push(error(`Duplicate function '${cmd.name}'`, 0, 0, "DUP_FN"));
            }
            resolveFunction(cmd, diagnostics, definedFns);
            definedFns.add(cmd.name);
            continue;
        }
        if (cmd.tag === "let_cmd") {
            resolveExpr(cmd.expr, diagnostics, definedFns, globalVars, undefined);
            if (cmd.lvalue.tag === "var") {
                if (globalVars.has(cmd.lvalue.name)) {
                    diagnostics.push(error(`Shadowing is not allowed: '${cmd.lvalue.name}'`, 0, 0, "SHADOW"));
                }
                globalVars.add(cmd.lvalue.name);
            }
            else {
                diagnostics.push(error("Only simple variable lvalues are supported in v1", 0, 0, "LHS_V1"));
            }
        }
    }
    return { program, diagnostics };
}
function resolveFunction(cmd, diagnostics, definedFns) {
    const scope = new Set();
    for (const p of cmd.params) {
        if (scope.has(p.name)) {
            diagnostics.push(error(`Duplicate parameter '${p.name}' in '${cmd.name}'`, 0, 0, "DUP_PARAM"));
        }
        scope.add(p.name);
    }
    const ctx = {
        fnName: cmd.name,
        resAvailable: false,
        seenRec: false,
        radCount: 0,
        gasCount: 0,
        scope,
    };
    for (const stmt of cmd.body) {
        resolveStmt(stmt, diagnostics, definedFns, ctx);
    }
    if (ctx.gasCount > 1) {
        diagnostics.push(error(`Function '${cmd.name}' has multiple gas statements`, 0, 0, "MULTI_GAS"));
    }
    if (ctx.gasCount > 0 && ctx.radCount > 0) {
        diagnostics.push(error(`Function '${cmd.name}' mixes 'rad' and 'gas' (mutually exclusive)`, 0, 0, "RAD_GAS_MIX"));
    }
    if (ctx.seenRec && ctx.gasCount + ctx.radCount === 0) {
        diagnostics.push(error(`Function '${cmd.name}' uses 'rec' but has no 'rad' or 'gas'`, 0, 0, "REC_NO_PROOF"));
    }
    if (ctx.gasCount > 0) {
        const gasStmt = cmd.body.find((s) => s.tag === "gas");
        if (gasStmt && gasStmt.limit === "inf") {
            diagnostics.push(warning(`Function '${cmd.name}' uses gas inf — termination is not guaranteed`, 0, 0, "GAS_INF"));
        }
    }
}
function resolveStmt(stmt, diagnostics, definedFns, ctx) {
    if (stmt.tag === "let") {
        resolveExpr(stmt.expr, diagnostics, definedFns, ctx.scope, ctx);
        bindLValue(stmt.lvalue, diagnostics, ctx.scope);
        return;
    }
    if (stmt.tag === "ret") {
        resolveExpr(stmt.expr, diagnostics, definedFns, ctx.scope, ctx);
        ctx.resAvailable = true;
        return;
    }
    if (stmt.tag === "rad") {
        ctx.radCount += 1;
        resolveExpr(stmt.expr, diagnostics, definedFns, ctx.scope, ctx);
        return;
    }
    if (stmt.tag === "gas") {
        ctx.gasCount += 1;
    }
}
function bindLValue(lvalue, diagnostics, scope) {
    if (lvalue.tag !== "var") {
        diagnostics.push(error("Only simple variable lvalues are supported in v1", 0, 0, "LHS_V1"));
        return;
    }
    if (scope.has(lvalue.name)) {
        diagnostics.push(error(`Shadowing is not allowed: '${lvalue.name}'`, 0, 0, "SHADOW"));
        return;
    }
    scope.add(lvalue.name);
}
function resolveExpr(expr, diagnostics, definedFns, scope, fnCtx) {
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
            }
            else if (!fnCtx.resAvailable) {
                diagnostics.push(error("res used before first ret", 0, 0, "RES_BEFORE_RET"));
            }
            return;
        case "rec":
            if (!fnCtx) {
                diagnostics.push(error("rec is only valid inside a function body", 0, 0, "REC_TOP"));
            }
            else {
                fnCtx.seenRec = true;
                if (!fnCtx.resAvailable) {
                    diagnostics.push(error("rec used before first ret", 0, 0, "REC_BEFORE_RET"));
                }
            }
            for (const arg of expr.args) {
                resolveExpr(arg, diagnostics, definedFns, scope, fnCtx);
            }
            return;
        case "binop":
            resolveExpr(expr.left, diagnostics, definedFns, scope, fnCtx);
            resolveExpr(expr.right, diagnostics, definedFns, scope, fnCtx);
            return;
        case "unop":
            resolveExpr(expr.operand, diagnostics, definedFns, scope, fnCtx);
            return;
        case "call":
            if (!BUILTIN_FUNCTIONS.has(expr.name)) {
                if (fnCtx && expr.name === fnCtx.fnName) {
                    diagnostics.push(error(`Direct self-call '${expr.name}(...)' is not allowed; use rec(...)`, 0, 0));
                }
                else if (!definedFns.has(expr.name)) {
                    diagnostics.push(error(`Function '${expr.name}' not in scope (single-pass binding)`, 0, 0));
                }
            }
            for (const arg of expr.args) {
                resolveExpr(arg, diagnostics, definedFns, scope, fnCtx);
            }
            return;
        case "field":
            resolveExpr(expr.target, diagnostics, definedFns, scope, fnCtx);
            return;
        case "index":
            resolveExpr(expr.array, diagnostics, definedFns, scope, fnCtx);
            for (const idx of expr.indices) {
                resolveExpr(idx, diagnostics, definedFns, scope, fnCtx);
            }
            return;
        case "struct_cons":
            for (const v of expr.fields) {
                resolveExpr(v, diagnostics, definedFns, scope, fnCtx);
            }
            return;
        case "array_cons":
            for (const v of expr.elements) {
                resolveExpr(v, diagnostics, definedFns, scope, fnCtx);
            }
            return;
        case "array_expr":
        case "sum_expr":
            diagnostics.push(error(`${expr.tag} parsing/resolution is not implemented in v1`, 0, 0, "NYI_V1"));
            return;
        default: {
            const _never = expr;
            return _never;
        }
    }
}
//# sourceMappingURL=resolve.js.map