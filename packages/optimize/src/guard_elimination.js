import { mapProgramExprs } from "./utils";
export function eliminateGuards(program, rangeMap) {
    let removedNanToZero = 0;
    let removedTotalDiv = 0;
    let removedTotalMod = 0;
    const out = mapProgramExprs(program, (expr) => {
        if (expr.tag === "nan_to_zero" && canRemoveNanToZero(expr.value, rangeMap)) {
            removedNanToZero += 1;
            return expr.value;
        }
        if (expr.tag === "total_div" && divisorExcludesZero(expr.right.id, rangeMap)) {
            removedTotalDiv += 1;
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
    };
}
function canRemoveNanToZero(expr, rangeMap) {
    if (expr.tag === "call") {
        const arg = expr.args[0];
        const range = arg ? rangeMap.get(arg.id) : undefined;
        if (!range) {
            return false;
        }
        if (expr.name === "sqrt") {
            return range.lo >= 0;
        }
        if (expr.name === "log") {
            return range.lo > 0;
        }
        if (expr.name === "asin" || expr.name === "acos") {
            return range.lo >= -1 && range.hi <= 1;
        }
    }
    if ((expr.tag === "total_div" || expr.tag === "total_mod") && divisorExcludesZero(expr.right.id, rangeMap)) {
        return true;
    }
    if (expr.tag === "binop" && (expr.op === "+" || expr.op === "-" || expr.op === "*")) {
        const left = rangeMap.get(expr.left.id);
        const right = rangeMap.get(expr.right.id);
        return Boolean(left && right && isFiniteInterval(left) && isFiniteInterval(right));
    }
    return false;
}
function divisorExcludesZero(exprId, rangeMap) {
    const range = rangeMap.get(exprId);
    return Boolean(range && (range.hi < 0 || range.lo > 0));
}
function isFiniteInterval(range) {
    return Number.isFinite(range.lo) && Number.isFinite(range.hi);
}
//# sourceMappingURL=guard_elimination.js.map