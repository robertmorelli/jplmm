import { BUILTIN_FUNCTIONS, INT32_MAX, INT32_MIN, getArrayExtentNames, getScalarBounds, scalarTag, unwrapTimedDefinition, } from "@jplmm/ast";
import { nodeError, nodeWarning } from "./errors";
export function resolveProgram(program) {
    const diagnostics = [];
    const definedFns = new Set();
    const definedStructs = new Set();
    const globalVars = new Set();
    for (const cmd of program.commands) {
        resolveProgramCmd(cmd, diagnostics, definedFns, definedStructs, globalVars);
    }
    reportUnusedLets(program, diagnostics);
    return { program, diagnostics };
}
function resolveProgramCmd(cmd, diagnostics, definedFns, definedStructs, globalVars) {
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
function resolveStructDef(cmd, diagnostics, definedStructs) {
    if (definedStructs.has(cmd.name)) {
        diagnostics.push(nodeError(cmd, `Duplicate struct '${cmd.name}'`, "DUP_STRUCT"));
    }
    const fieldNames = new Set();
    for (const field of cmd.fields) {
        if (fieldNames.has(field.name)) {
            diagnostics.push(nodeError(field, `Duplicate field '${field.name}' in struct '${cmd.name}'`, "DUP_FIELD"));
        }
        fieldNames.add(field.name);
        resolveType(field.type, diagnostics, definedStructs, {
            allowScalarBounds: false,
            allowArrayExtentNames: false,
            location: "struct field",
        });
    }
    definedStructs.add(cmd.name);
}
function resolveFnDef(cmd, diagnostics, definedFns, definedStructs) {
    if (cmd.keyword === "ref" && !definedFns.has(cmd.name)) {
        diagnostics.push(nodeError(cmd, `ref '${cmd.name}' requires an earlier fun/def/fn definition`, "REF_NO_BASE"));
    }
    else if (cmd.keyword !== "ref" && definedFns.has(cmd.name)) {
        diagnostics.push(nodeError(cmd, `Duplicate function '${cmd.name}'`, "DUP_FN"));
    }
    if (cmd.name === "main" && cmd.params.length !== 0) {
        diagnostics.push(nodeError(cmd, "Function 'main' must not take parameters", "MAIN_ARITY"));
    }
    for (const param of cmd.params) {
        resolveType(param.type, diagnostics, definedStructs, {
            allowScalarBounds: true,
            allowArrayExtentNames: true,
            location: "parameter",
        });
    }
    resolveType(cmd.retType, diagnostics, definedStructs, {
        allowScalarBounds: false,
        allowArrayExtentNames: false,
        location: "return type",
    });
    resolveFunction(cmd, diagnostics, definedFns, definedStructs);
    if (cmd.keyword !== "ref") {
        definedFns.add(cmd.name);
    }
}
function resolveTopLevelCmd(cmd, diagnostics, definedFns, definedStructs, globalVars) {
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
            const _never = cmd;
            return _never;
        }
    }
}
function resolveFunction(cmd, diagnostics, definedFns, definedStructs) {
    const scope = new Set();
    for (const p of cmd.params) {
        if (scope.has(p.name)) {
            diagnostics.push(nodeError(p, `Duplicate parameter '${p.name}' in '${cmd.name}'`, "DUP_PARAM"));
        }
        scope.add(p.name);
        for (const extentName of getArrayExtentNames(p.type) ?? []) {
            if (extentName === null) {
                continue;
            }
            if (scope.has(extentName)) {
                diagnostics.push(nodeError(p.type, `Duplicate parameter or extent binder '${extentName}' in '${cmd.name}'`, "DUP_PARAM"));
                continue;
            }
            scope.add(extentName);
        }
    }
    const ctx = {
        fnName: cmd.name,
        paramNames: cmd.params.map((param) => param.name),
        resAvailable: false,
        seenRec: false,
        radCount: 0,
        gasCount: 0,
        hasPendingRet: false,
        pendingRetUsed: false,
        pendingRetStmt: null,
        firstRadStmt: null,
        gasStmts: [],
        firstRecExpr: null,
        scope,
    };
    for (const stmt of cmd.body) {
        resolveStmt(stmt, diagnostics, definedFns, definedStructs, ctx);
    }
    if (ctx.gasCount > 1) {
        diagnostics.push(nodeError(ctx.gasStmts[1] ?? ctx.gasStmts[0] ?? cmd, `Function '${cmd.name}' has multiple gas statements`, "MULTI_GAS"));
    }
    if (ctx.gasCount > 0 && ctx.radCount > 0) {
        diagnostics.push(nodeError(ctx.gasStmts[0] ?? ctx.firstRadStmt ?? cmd, `Function '${cmd.name}' mixes 'rad' and 'gas' (mutually exclusive)`, "RAD_GAS_MIX"));
    }
    if (ctx.seenRec && ctx.gasCount + ctx.radCount === 0) {
        diagnostics.push(nodeError(ctx.firstRecExpr ?? cmd, `Function '${cmd.name}' uses 'rec' but has no 'rad' or 'gas'`, "REC_NO_PROOF"));
    }
    const gasStmt = ctx.gasStmts[0];
    if (gasStmt && gasStmt.limit === "inf") {
        diagnostics.push(nodeWarning(gasStmt, `Function '${cmd.name}' uses gas inf — termination is not guaranteed`, "GAS_INF"));
    }
}
function resolveStmt(stmt, diagnostics, definedFns, definedStructs, ctx) {
    if (stmt.tag === "let") {
        resolveExpr(stmt.expr, diagnostics, definedFns, definedStructs, ctx.scope, ctx);
        bindLValue(stmt.lvalue, diagnostics, ctx.scope, "local", definedFns, definedStructs, ctx);
        return;
    }
    if (stmt.tag === "ret") {
        resolveExpr(stmt.expr, diagnostics, definedFns, definedStructs, ctx.scope, ctx);
        reportIgnoredRetIfNeeded(ctx, diagnostics);
        ctx.resAvailable = true;
        ctx.hasPendingRet = true;
        ctx.pendingRetUsed = false;
        ctx.pendingRetStmt = stmt;
        return;
    }
    if (stmt.tag === "rad") {
        ctx.radCount += 1;
        ctx.firstRadStmt ??= stmt;
        resolveExpr(stmt.expr, diagnostics, definedFns, definedStructs, ctx.scope, ctx);
        return;
    }
    if (stmt.tag === "gas") {
        ctx.gasCount += 1;
        ctx.gasStmts.push(stmt);
    }
}
function bindLValue(lvalue, diagnostics, scope, mode, definedFns, definedStructs, fnCtx) {
    switch (lvalue.tag) {
        case "var":
            if (scope.has(lvalue.name)) {
                diagnostics.push(nodeError(lvalue, `Shadowing is not allowed: '${lvalue.name}'`, "SHADOW"));
                return;
            }
            scope.add(lvalue.name);
            return;
        case "field":
            if (!scope.has(lvalue.base)) {
                diagnostics.push(nodeError(lvalue, `Unbound variable '${lvalue.base}'`, "UNBOUND_VAR"));
            }
            return;
        case "tuple":
            if (mode === "local") {
                diagnostics.push(nodeError(lvalue, "Tuple lvalues are only supported for read image targets", "LHS_TUPLE"));
                return;
            }
            for (const item of lvalue.items) {
                bindLValue(item, diagnostics, scope, mode, definedFns, definedStructs, fnCtx);
            }
            return;
        default: {
            const _never = lvalue;
            return _never;
        }
    }
}
function bindArgument(argument, diagnostics, scope) {
    if (argument.tag === "var") {
        if (scope.has(argument.name)) {
            diagnostics.push(nodeError(argument, `Shadowing is not allowed: '${argument.name}'`, "SHADOW"));
            return;
        }
        scope.add(argument.name);
        return;
    }
    for (const item of argument.items) {
        bindArgument(item, diagnostics, scope);
    }
}
function resolveExpr(expr, diagnostics, definedFns, definedStructs, scope, fnCtx) {
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
        case "void_lit":
            return;
        case "var":
            if (!scope.has(expr.name)) {
                diagnostics.push(nodeError(expr, `Unbound variable '${expr.name}'`, "UNBOUND_VAR"));
            }
            return;
        case "res":
            if (!fnCtx) {
                diagnostics.push(nodeError(expr, "res is only valid inside a function body", "RES_TOP"));
            }
            else if (!fnCtx.resAvailable) {
                diagnostics.push(nodeError(expr, "res used before first ret", "RES_BEFORE_RET"));
            }
            else {
                markPendingRetUsed(fnCtx);
            }
            return;
        case "rec":
            if (!fnCtx) {
                diagnostics.push(nodeError(expr, "rec is only valid inside a function body", "REC_TOP"));
            }
            else {
                fnCtx.seenRec = true;
                fnCtx.firstRecExpr ??= expr;
                if (!fnCtx.resAvailable) {
                    diagnostics.push(nodeError(expr, "rec used before first ret", "REC_BEFORE_RET"));
                }
                else {
                    markPendingRetUsed(fnCtx);
                }
                if (isStaticExactRec(expr, fnCtx.paramNames)) {
                    diagnostics.push(nodeWarning(expr, `Function '${fnCtx.fnName}' calls rec with the current parameters unchanged; this statically collapses to res`, "REC_STATIC_COLLAPSE"));
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
                    diagnostics.push(nodeError(expr, `Direct self-call '${expr.name}(...)' is not allowed; use rec(...)`));
                }
                else if (!definedFns.has(expr.name)) {
                    diagnostics.push(nodeError(expr, `Function '${expr.name}' not in scope (single-pass binding)`));
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
                diagnostics.push(nodeError(expr, `Struct '${expr.name}' not in scope (single-pass binding)`, "STRUCT_SCOPE"));
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
            const _never = expr;
            return _never;
        }
    }
}
function markPendingRetUsed(ctx) {
    if (ctx.hasPendingRet) {
        ctx.pendingRetUsed = true;
    }
}
function isStaticExactRec(expr, paramNames) {
    return expr.args.length === paramNames.length
        && expr.args.every((arg, index) => arg.tag === "var" && arg.name === paramNames[index]);
}
function reportIgnoredRetIfNeeded(ctx, diagnostics) {
    if (ctx.hasPendingRet && !ctx.pendingRetUsed) {
        diagnostics.push(nodeError(ctx.pendingRetStmt, `Function '${ctx.fnName}' overwrites a previous ret before any rec/res can observe it`, "IGNORED_RET"));
    }
}
function resolveBindings(bindings, diagnostics, definedFns, definedStructs, parentScope, fnCtx, body) {
    const localScope = new Set(parentScope);
    for (const binding of bindings) {
        resolveExpr(binding.expr, diagnostics, definedFns, definedStructs, localScope, fnCtx);
        if (localScope.has(binding.name)) {
            diagnostics.push(nodeError(binding, `Shadowing is not allowed: '${binding.name}'`, "SHADOW"));
        }
        localScope.add(binding.name);
    }
    resolveExpr(body, diagnostics, definedFns, definedStructs, localScope, fnCtx);
}
function resolveType(type, diagnostics, definedStructs, options) {
    const bounds = getScalarBounds(type);
    if (bounds) {
        validateScalarBounds(type, diagnostics);
        if (!options.allowScalarBounds) {
            diagnostics.push(nodeError(type, `Bounded scalar types are only allowed on direct function parameters, not in ${options.location}`, "TYPE_BOUND_TARGET"));
        }
    }
    if (type.tag === "array") {
        const extentNames = getArrayExtentNames(type);
        if (extentNames && !options.allowArrayExtentNames) {
            diagnostics.push(nodeError(type, `Named array extents are only allowed on direct function parameters, not in ${options.location}`, "TYPE_EXTENT_TARGET"));
        }
        resolveType(type.element, diagnostics, definedStructs, {
            allowScalarBounds: false,
            allowArrayExtentNames: false,
            location: `${options.location} array element`,
        });
        return;
    }
    if (type.tag === "named" && !definedStructs.has(type.name)) {
        diagnostics.push(nodeError(type, `Unknown type '${type.name}'`, "TYPE_UNKNOWN"));
    }
}
function validateScalarBounds(type, diagnostics) {
    const tag = scalarTag(type);
    const bounds = getScalarBounds(type);
    if (!tag || !bounds) {
        return;
    }
    if (tag === "int") {
        const loOk = bounds.lo === null || (Number.isInteger(bounds.lo) && bounds.lo >= INT32_MIN && bounds.lo <= INT32_MAX);
        const hiOk = bounds.hi === null || (Number.isInteger(bounds.hi) && bounds.hi >= INT32_MIN && bounds.hi <= INT32_MAX);
        if (!loOk || !hiOk) {
            diagnostics.push(nodeError(type, "int bounds must stay inside the 32-bit scalar domain", "TYPE_BOUND_RANGE"));
            return;
        }
    }
    else {
        const loOk = bounds.lo === null || Number.isFinite(bounds.lo);
        const hiOk = bounds.hi === null || Number.isFinite(bounds.hi);
        if (!loOk || !hiOk) {
            diagnostics.push(nodeError(type, "float bounds must be finite literals", "TYPE_BOUND_RANGE"));
            return;
        }
    }
    if (bounds.lo !== null && bounds.hi !== null && bounds.lo > bounds.hi) {
        diagnostics.push(nodeError(type, "scalar lower bound must be <= upper bound", "TYPE_BOUND_ORDER"));
    }
}
function reportUnusedLets(program, diagnostics) {
    const topScope = new Set();
    const topLets = new Map();
    const topUsed = new Set();
    for (const cmd of program.commands) {
        analyzeTopLevelUsage(cmd, topScope, topLets, topUsed);
    }
    for (const [name, binding] of topLets) {
        if (!topUsed.has(name)) {
            diagnostics.push(nodeError(binding, `Unused let '${name}'`, "UNUSED_LET"));
        }
    }
    for (const cmd of program.commands) {
        const fnDef = unwrapTimedDefinition(cmd, "fn_def");
        if (!fnDef) {
            continue;
        }
        reportUnusedFunctionLets(fnDef, diagnostics);
    }
}
function analyzeTopLevelUsage(cmd, scope, letBindings, usedBindings) {
    if (cmd.tag === "time") {
        analyzeTopLevelUsage(cmd.cmd, scope, letBindings, usedBindings);
        return;
    }
    switch (cmd.tag) {
        case "fn_def":
        case "struct_def":
        case "print":
        case "read_image":
            return;
        case "let_cmd":
            markExprUsage(cmd.expr, scope, letBindings, usedBindings);
            markLValueUsage(cmd.lvalue, scope, letBindings, usedBindings);
            if (cmd.lvalue.tag === "var") {
                scope.add(cmd.lvalue.name);
                letBindings.set(cmd.lvalue.name, cmd.lvalue);
            }
            return;
        case "show":
            markExprUsage(cmd.expr, scope, letBindings, usedBindings);
            return;
        case "write_image":
            markExprUsage(cmd.expr, scope, letBindings, usedBindings);
            return;
        default: {
            const _never = cmd;
            return _never;
        }
    }
}
function reportUnusedFunctionLets(cmd, diagnostics) {
    const scope = new Set(cmd.params.map((param) => param.name));
    const letBindings = new Map();
    const usedBindings = new Set();
    for (const stmt of cmd.body) {
        if (stmt.tag === "let") {
            markExprUsage(stmt.expr, scope, letBindings, usedBindings);
            markLValueUsage(stmt.lvalue, scope, letBindings, usedBindings);
            if (stmt.lvalue.tag === "var") {
                scope.add(stmt.lvalue.name);
                letBindings.set(stmt.lvalue.name, stmt.lvalue);
            }
            continue;
        }
        if (stmt.tag === "ret" || stmt.tag === "rad") {
            markExprUsage(stmt.expr, scope, letBindings, usedBindings);
        }
    }
    for (const [name, binding] of letBindings) {
        if (!usedBindings.has(name)) {
            diagnostics.push(nodeError(binding, `Unused let '${name}' in '${cmd.name}'`, "UNUSED_LET"));
        }
    }
}
function markExprUsage(expr, scope, letBindings, usedBindings) {
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
        case "void_lit":
        case "res":
            return;
        case "var":
            if (scope.has(expr.name) && letBindings.has(expr.name)) {
                usedBindings.add(expr.name);
            }
            return;
        case "binop":
            markExprUsage(expr.left, scope, letBindings, usedBindings);
            markExprUsage(expr.right, scope, letBindings, usedBindings);
            return;
        case "unop":
            markExprUsage(expr.operand, scope, letBindings, usedBindings);
            return;
        case "call":
            for (const arg of expr.args) {
                markExprUsage(arg, scope, letBindings, usedBindings);
            }
            return;
        case "index":
            markExprUsage(expr.array, scope, letBindings, usedBindings);
            for (const idx of expr.indices) {
                markExprUsage(idx, scope, letBindings, usedBindings);
            }
            return;
        case "field":
            markExprUsage(expr.target, scope, letBindings, usedBindings);
            return;
        case "struct_cons":
            for (const field of expr.fields) {
                markExprUsage(field, scope, letBindings, usedBindings);
            }
            return;
        case "array_cons":
            for (const element of expr.elements) {
                markExprUsage(element, scope, letBindings, usedBindings);
            }
            return;
        case "array_expr":
        case "sum_expr": {
            const localScope = new Set(scope);
            for (const binding of expr.bindings) {
                markExprUsage(binding.expr, localScope, letBindings, usedBindings);
                localScope.add(binding.name);
            }
            markExprUsage(expr.body, localScope, letBindings, usedBindings);
            return;
        }
        case "rec":
            for (const arg of expr.args) {
                markExprUsage(arg, scope, letBindings, usedBindings);
            }
            return;
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function markLValueUsage(lvalue, scope, letBindings, usedBindings) {
    switch (lvalue.tag) {
        case "var":
            return;
        case "field":
            if (scope.has(lvalue.base) && letBindings.has(lvalue.base)) {
                usedBindings.add(lvalue.base);
            }
            return;
        case "tuple":
            for (const item of lvalue.items) {
                markLValueUsage(item, scope, letBindings, usedBindings);
            }
            return;
        default: {
            const _never = lvalue;
            return _never;
        }
    }
}
//# sourceMappingURL=resolve.js.map