export function checkStructuralDecrease(paramName, radExpr, recArgs) {
    if (radExpr.tag !== "var" || radExpr.name !== paramName) {
        return {
            ok: false,
            reason: `unsupported rad form for structural check (expected rad ${paramName})`,
        };
    }
    if (recArgs.length !== 1) {
        return {
            ok: false,
            reason: "structural verifier currently supports single-argument rec only",
        };
    }
    const arg = recArgs[0];
    if (isParamMinusConst(paramName, arg)) {
        return { ok: true, reason: "argument decreases structurally" };
    }
    if (isMaxZeroParamMinusConst(paramName, arg)) {
        return { ok: true, reason: "argument decreases structurally with floor at zero" };
    }
    if (arg.tag === "var" && arg.name === paramName) {
        return { ok: false, reason: "argument is unchanged; no strict decrease" };
    }
    return { ok: false, reason: "could not prove structural decrease" };
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
export function findRadExpr(stmts) {
    for (const s of stmts) {
        if (s.tag === "rad") {
            return s.expr;
        }
    }
    return null;
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