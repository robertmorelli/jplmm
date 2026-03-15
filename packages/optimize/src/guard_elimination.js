import { mapProgramExprs } from "./utils";
export function eliminateGuards(program, rangeMap) {
    let removedNanToZero = 0;
    let removedTotalDiv = 0;
    let removedTotalMod = 0;
    const usedRangeExprIds = new Set();
    const out = mapProgramExprs(program, (expr) => {
        const nanReasons = expr.tag === "nan_to_zero" ? canRemoveNanToZero(expr.value, rangeMap) : null;
        if (expr.tag === "nan_to_zero" && nanReasons) {
            removedNanToZero += 1;
            for (const id of nanReasons) {
                usedRangeExprIds.add(id);
            }
            return expr.value;
        }
        if (expr.tag === "total_div" && divisorExcludesZero(expr.right.id, rangeMap)) {
            removedTotalDiv += 1;
            usedRangeExprIds.add(expr.right.id);
            return {
                tag: "binop",
                op: "/",
                left: expr.left,
                right: expr.right,
                id: expr.id,
                resultType: expr.resultType,
            };
        }
        if (expr.tag === "total_mod" && divisorExcludesZero(expr.right.id, rangeMap)) {
            removedTotalMod += 1;
            usedRangeExprIds.add(expr.right.id);
            return {
                tag: "binop",
                op: "%",
                left: expr.left,
                right: expr.right,
                id: expr.id,
                resultType: expr.resultType,
            };
        }
        return expr;
    });
    return {
        program: out,
        changed: removedNanToZero + removedTotalDiv + removedTotalMod > 0,
        removedNanToZero,
        removedTotalDiv,
        removedTotalMod,
        usedRangeExprIds: [...usedRangeExprIds].sort((left, right) => left - right),
    };
}
function canRemoveNanToZero(expr, rangeMap) {
    if (expr.tag === "call") {
        const arg = expr.args[0];
        const range = arg ? rangeMap.get(arg.id) : undefined;
        if (!range) {
            return null;
        }
        if (expr.name === "sqrt") {
            return range.lo >= 0 ? [arg.id] : null;
        }
        if (expr.name === "log") {
            return range.lo > 0 ? [arg.id] : null;
        }
        if (expr.name === "asin" || expr.name === "acos") {
            return range.lo >= -1 && range.hi <= 1 ? [arg.id] : null;
        }
    }
    if ((expr.tag === "total_div" || expr.tag === "total_mod") && divisorExcludesZero(expr.right.id, rangeMap)) {
        return [expr.right.id];
    }
    if (expr.tag === "binop" && (expr.op === "+" || expr.op === "-" || expr.op === "*")) {
        const left = rangeMap.get(expr.left.id);
        const right = rangeMap.get(expr.right.id);
        return left && right && isFiniteInterval(left) && isFiniteInterval(right)
            ? [expr.left.id, expr.right.id]
            : null;
    }
    return null;
}
function divisorExcludesZero(exprId, rangeMap) {
    const range = rangeMap.get(exprId);
    return Boolean(range && (range.hi < 0 || range.lo > 0));
}
function isFiniteInterval(range) {
    return Number.isFinite(range.lo) && Number.isFinite(range.hi);
}
//# sourceMappingURL=guard_elimination.js.map