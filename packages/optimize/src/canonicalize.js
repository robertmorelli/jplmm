import { NAN_GUARDED_BUILTINS } from "@jplmm/ast";
import { isFloatType, isIntType } from "@jplmm/ir";
const DEFAULT_STATS = {
    totalDivInserted: 0,
    totalModInserted: 0,
    nanToZeroInserted: 0,
    satAddInserted: 0,
    satSubInserted: 0,
    satMulInserted: 0,
    satNegInserted: 0,
    zeroDivisorConstantFolded: 0,
};
export function canonicalizeProgram(program) {
    const passOrder = ["total_arithmetic", "saturating_arithmetic"];
    const stats = { ...DEFAULT_STATS };
    const nextId = makeSyntheticIdFactory(program);
    const out = {
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
export function isNaNlessCanonical(program) {
    const checkExpr = (expr, guarded) => {
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
                return (expr.bindings.every((b) => checkExpr(b.expr, guarded)) &&
                    checkExpr(expr.body, guarded));
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
                const _never = expr;
                return _never;
            }
        }
    };
    const stmtExprs = (stmt) => {
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
function canonicalizeGlobal(g, nextId, stats) {
    return { ...g, expr: canonicalizeExpr(g.expr, nextId, stats, emptyScope()) };
}
function canonicalizeFunction(fn, nextId, stats) {
    let scope = scopeWithNames(emptyScope(), fn.params.map((param) => param.name));
    const body = [];
    for (const stmt of fn.body) {
        const canonical = canonicalizeStmt(stmt, nextId, stats, scope);
        body.push(canonical.stmt);
        scope = canonical.scope;
    }
    return {
        ...fn,
        body,
    };
}
function canonicalizeStmt(stmt, nextId, stats, scope) {
    if (stmt.tag === "gas") {
        return { stmt, scope };
    }
    const expr = canonicalizeExpr(stmt.expr, nextId, stats, scope);
    if (stmt.tag === "let") {
        return {
            stmt: {
                ...stmt,
                expr,
            },
            scope: scopeWithNames(scope, [stmt.name]),
        };
    }
    return {
        stmt: {
            ...stmt,
            expr,
        },
        scope,
    };
}
function canonicalizeExpr(expr, nextId, stats, scope) {
    const mapped = mapChildren(expr, (child, childScope) => canonicalizeExpr(child, nextId, stats, childScope), scope);
    const normalized = normalizeCommutativeOperands(mapped, scope);
    const totalized = applyTotalArithmetic(normalized, nextId, stats);
    const saturated = applySaturatingArithmetic(totalized, nextId, stats);
    return normalizeCommutativeOperands(saturated, scope);
}
function mapChildren(expr, f, scope) {
    switch (expr.tag) {
        case "binop":
            return { ...expr, left: f(expr.left, scope), right: f(expr.right, scope) };
        case "unop":
            return { ...expr, operand: f(expr.operand, scope) };
        case "call":
            return { ...expr, args: expr.args.map((arg) => f(arg, scope)) };
        case "index":
            return {
                ...expr,
                array: f(expr.array, scope),
                indices: expr.indices.map((index) => f(index, scope)),
            };
        case "field":
            return { ...expr, target: f(expr.target, scope) };
        case "struct_cons":
            return { ...expr, fields: expr.fields.map((field) => f(field, scope)) };
        case "array_cons":
            return { ...expr, elements: expr.elements.map((element) => f(element, scope)) };
        case "array_expr":
        case "sum_expr":
            return {
                ...expr,
                ...mapBindingsAndBody(expr.bindings, expr.body, f, scope),
            };
        case "rec":
            return { ...expr, args: expr.args.map((arg) => f(arg, scope)) };
        case "total_div":
        case "total_mod":
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
            return { ...expr, left: f(expr.left, scope), right: f(expr.right, scope) };
        case "nan_to_zero":
        case "sat_neg":
            return {
                ...expr,
                ...(expr.tag === "nan_to_zero"
                    ? { value: f(expr.value, scope) }
                    : { operand: f(expr.operand, scope) }),
            };
        default:
            return expr;
    }
}
function mapBindingsAndBody(bindings, body, f, scope) {
    const scoped = cloneScope(scope);
    const mappedBindings = bindings.map((binding) => {
        const mapped = {
            ...binding,
            expr: f(binding.expr, scoped),
        };
        bindName(scoped, binding.name);
        return mapped;
    });
    return {
        bindings: mappedBindings,
        body: f(body, scoped),
    };
}
function applyTotalArithmetic(expr, nextId, stats) {
    if (expr.tag === "binop" && (expr.op === "/" || expr.op === "%")) {
        if (isZeroLiteral(expr.right)) {
            stats.zeroDivisorConstantFolded += 1;
            return zeroLiteral(expr.resultType, nextId());
        }
        if (expr.op === "/") {
            stats.totalDivInserted += 1;
            const op = {
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
            const op = {
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
function applySaturatingArithmetic(expr, nextId, stats) {
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
function normalizeCommutativeOperands(expr, scope) {
    if (!isCommutativeExpr(expr)) {
        return expr;
    }
    const leftKey = exprOrderKey(expr.left, scope);
    const rightKey = exprOrderKey(expr.right, scope);
    if (rightKey >= leftKey) {
        return expr;
    }
    return {
        ...expr,
        left: expr.right,
        right: expr.left,
    };
}
function isCommutativeExpr(expr) {
    if (expr.tag === "sat_add" || expr.tag === "sat_mul") {
        return true;
    }
    return expr.tag === "binop" && (expr.op === "+" || expr.op === "*");
}
function exprOrderKey(expr, scope) {
    switch (expr.tag) {
        case "int_lit":
            return `int:${expr.value}`;
        case "float_lit":
            return `float:${expr.value}`;
        case "void_lit":
            return "void";
        case "var":
            return scope.slots.has(expr.name) ? `var@${scope.slots.get(expr.name)}` : `var:${expr.name}`;
        case "res":
            return "res";
        case "binop":
            return `binop:${expr.op}(${exprOrderKey(expr.left, scope)},${exprOrderKey(expr.right, scope)})`;
        case "unop":
            return `unop:${expr.op}(${exprOrderKey(expr.operand, scope)})`;
        case "call":
            return `call:${expr.name}(${expr.args.map((arg) => exprOrderKey(arg, scope)).join(",")})`;
        case "index":
            return `index(${exprOrderKey(expr.array, scope)}|${expr.indices.map((index) => exprOrderKey(index, scope)).join(",")})`;
        case "field":
            return `field:${expr.field}(${exprOrderKey(expr.target, scope)})`;
        case "struct_cons":
            return `struct:${expr.name}(${expr.fields.map((field) => exprOrderKey(field, scope)).join(",")})`;
        case "array_cons":
            return `array_cons(${expr.elements.map((element) => exprOrderKey(element, scope)).join(",")})`;
        case "array_expr":
            return boundedExprOrderKey("array_expr", expr.bindings, expr.body, scope);
        case "sum_expr":
            return boundedExprOrderKey("sum_expr", expr.bindings, expr.body, scope);
        case "rec":
            return `rec(${expr.args.map((arg) => exprOrderKey(arg, scope)).join(",")})`;
        case "total_div":
            return `total_div(${exprOrderKey(expr.left, scope)},${exprOrderKey(expr.right, scope)})`;
        case "total_mod":
            return `total_mod(${exprOrderKey(expr.left, scope)},${exprOrderKey(expr.right, scope)})`;
        case "sat_add":
            return `sat_add(${exprOrderKey(expr.left, scope)},${exprOrderKey(expr.right, scope)})`;
        case "sat_sub":
            return `sat_sub(${exprOrderKey(expr.left, scope)},${exprOrderKey(expr.right, scope)})`;
        case "sat_mul":
            return `sat_mul(${exprOrderKey(expr.left, scope)},${exprOrderKey(expr.right, scope)})`;
        case "sat_neg":
            return `sat_neg(${exprOrderKey(expr.operand, scope)})`;
        case "nan_to_zero":
            return `nan_to_zero(${exprOrderKey(expr.value, scope)})`;
        default: {
            const _never = expr;
            return `${_never}`;
        }
    }
}
function boundedExprOrderKey(tag, bindings, body, scope) {
    const scoped = cloneScope(scope);
    const bindingKeys = bindings.map((binding) => {
        const key = exprOrderKey(binding.expr, scoped);
        const slot = bindName(scoped, binding.name);
        return `${slot}:${key}`;
    });
    return `${tag}[${bindingKeys.join(",")}](${exprOrderKey(body, scoped)})`;
}
function wrapNanToZero(expr, nextId, stats) {
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
function isZeroLiteral(expr) {
    return (expr.tag === "int_lit" || expr.tag === "float_lit") && expr.value === 0;
}
function zeroLiteral(resultType, id) {
    if (isFloatType(resultType)) {
        return { tag: "float_lit", value: 0, id, resultType };
    }
    return { tag: "int_lit", value: 0, id, resultType };
}
function emptyScope() {
    return {
        slots: new Map(),
        nextSlot: 0,
    };
}
function cloneScope(scope) {
    return {
        slots: new Map(scope.slots),
        nextSlot: scope.nextSlot,
    };
}
function scopeWithNames(scope, names) {
    const next = cloneScope(scope);
    for (const name of names) {
        bindName(next, name);
    }
    return next;
}
function bindName(scope, name) {
    const slot = scope.nextSlot;
    scope.nextSlot += 1;
    scope.slots.set(name, slot);
    return slot;
}
function makeSyntheticIdFactory(program) {
    let maxId = 0;
    const visitExpr = (expr) => {
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
//# sourceMappingURL=canonicalize.js.map