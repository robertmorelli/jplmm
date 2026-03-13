export function checkStructuralDecrease(params, radExpr, recArgs) {
    const tracked = trackedParam(params, radExpr);
    if (!tracked) {
        return {
            ok: false,
            reason: "unsupported rad form for structural check (expected rad <int-param> or rad abs(<int-param>))",
        };
    }
    if (tracked.index >= recArgs.length) {
        return {
            ok: false,
            reason: `rec site does not provide tracked argument '${tracked.name}'`,
        };
    }
    const arg = recArgs[tracked.index];
    if (isParamMinusConst(tracked.name, arg)) {
        return { ok: true, reason: "argument decreases structurally" };
    }
    if (isMaxZeroParamMinusConst(tracked.name, arg)) {
        return { ok: true, reason: "argument decreases structurally with floor at zero" };
    }
    if (arg.tag === "var" && arg.name === tracked.name) {
        return { ok: false, reason: "argument is unchanged; no strict decrease" };
    }
    if (isAbsOfParam(tracked.name, arg) && tracked.absolute) {
        return { ok: false, reason: "argument is unchanged up to abs(); no strict decrease" };
    }
    return { ok: false, reason: `could not prove structural decrease of '${tracked.name}'` };
}
function trackedParam(params, radExpr) {
    for (let i = 0; i < params.length; i += 1) {
        const param = params[i];
        if (param.type.tag !== "int") {
            continue;
        }
        if (radExpr.tag === "var" && radExpr.name === param.name) {
            return { name: param.name, index: i, absolute: false };
        }
        if (isAbsOfParam(param.name, radExpr)) {
            return { name: param.name, index: i, absolute: true };
        }
    }
    return null;
}
function isParamMinusConst(paramName, expr) {
    if (expr.tag !== "binop" || expr.op !== "-") {
        return false;
    }
    return (expr.left.tag === "var" &&
        expr.left.name === paramName &&
        expr.right.tag === "int_lit" &&
        expr.right.value > 0);
}
function isMaxZeroParamMinusConst(paramName, expr) {
    if (expr.tag !== "call" || expr.name !== "max" || expr.args.length !== 2) {
        return false;
    }
    const [a, b] = expr.args;
    if (!a || !b) {
        return false;
    }
    if (!(a.tag === "int_lit" && a.value === 0)) {
        return false;
    }
    return isParamMinusConst(paramName, b);
}
function isAbsOfParam(paramName, expr) {
    return (expr.tag === "call" &&
        expr.name === "abs" &&
        expr.args.length === 1 &&
        expr.args[0]?.tag === "var" &&
        expr.args[0].name === paramName);
}
export function collectRecArgs(expr, out) {
    switch (expr.tag) {
        case "rec":
            out.push(expr.args);
            for (const a of expr.args) {
                collectRecArgs(a, out);
            }
            return;
        case "binop":
            collectRecArgs(expr.left, out);
            collectRecArgs(expr.right, out);
            return;
        case "unop":
            collectRecArgs(expr.operand, out);
            return;
        case "call":
            for (const a of expr.args) {
                collectRecArgs(a, out);
            }
            return;
        case "index":
            collectRecArgs(expr.array, out);
            for (const a of expr.indices) {
                collectRecArgs(a, out);
            }
            return;
        case "field":
            collectRecArgs(expr.target, out);
            return;
        case "array_cons":
            for (const a of expr.elements) {
                collectRecArgs(a, out);
            }
            return;
        case "struct_cons":
            for (const a of expr.fields) {
                collectRecArgs(a, out);
            }
            return;
        case "array_expr":
        case "sum_expr":
            collectRecArgs(expr.body, out);
            for (const b of expr.bindings) {
                collectRecArgs(b.expr, out);
            }
            return;
        default:
            return;
    }
}
export function findRadExprs(stmts) {
    return stmts.filter((stmt) => stmt.tag === "rad").map((stmt) => stmt.expr);
}
export function hasRec(stmts) {
    const bucket = [];
    for (const s of stmts) {
        if (s.tag === "let" || s.tag === "ret" || s.tag === "rad") {
            collectRecArgs(s.expr, bucket);
        }
    }
    return bucket.length > 0;
}
export function collectRecSites(stmts) {
    const bucket = [];
    for (const s of stmts) {
        if (s.tag === "let" || s.tag === "ret" || s.tag === "rad") {
            collectRecArgs(s.expr, bucket);
        }
    }
    return bucket;
}
//# sourceMappingURL=structural.js.map