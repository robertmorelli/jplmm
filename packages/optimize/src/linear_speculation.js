import { stripNanToZero } from "./utils";
export function findLinearSpeculationCandidates(program) {
    const out = new Map();
    for (const fn of program.functions) {
        const match = matchLinearTailRec(fn);
        if (match) {
            out.set(fn.name, [match.candidate]);
        }
    }
    return out;
}
export function matchLinearSpeculationPass(program) {
    const matches = [];
    for (const fn of program.functions) {
        const match = matchLinearTailRec(fn);
        if (match) {
            matches.push({ fnName: fn.name, ...match });
        }
    }
    return matches;
}
function matchLinearTailRec(fn) {
    if (fn.params.length === 0) {
        return null;
    }
    const tailRet = fn.body.find((stmt) => stmt.tag === "ret" && stmt.expr.tag === "rec" && stmt.expr.tailPosition);
    if (!tailRet || tailRet.tag !== "ret" || tailRet.expr.tag !== "rec") {
        return null;
    }
    let varyingParamIndex = null;
    const invariantParamIndices = [];
    for (let i = 0; i < fn.params.length; i += 1) {
        const param = fn.params[i];
        const arg = tailRet.expr.args[i];
        if (!param || !arg) {
            return null;
        }
        if (arg.tag === "var" && arg.name === param.name) {
            invariantParamIndices.push(i);
            continue;
        }
        if (varyingParamIndex !== null || param.type.tag !== "int") {
            return null;
        }
        varyingParamIndex = i;
    }
    if (varyingParamIndex === null) {
        return null;
    }
    const recurrence = analyzeLinearRecurrence(tailRet.expr.args[varyingParamIndex], fn.params[varyingParamIndex].name);
    if (!recurrence) {
        return null;
    }
    return {
        implementation: {
            tag: "linear_speculation",
            varyingParamIndex,
            fixedPoint: recurrence.fixedPoint,
            stride: recurrence.stride,
            direction: recurrence.direction,
            invariantParamIndices,
        },
        candidate: {
            pass: "linear_speculation",
            reason: `tail recursion drives ${fn.params[varyingParamIndex].name} ${recurrence.direction} toward ${recurrence.fixedPoint} with stride ${recurrence.stride}`,
        },
    };
}
function analyzeLinearRecurrence(expr, paramName) {
    const stripped = stripNanToZero(expr);
    const maxMatch = matchBoundedStep(stripped, paramName, "max");
    if (maxMatch) {
        return maxMatch;
    }
    const minMatch = matchBoundedStep(stripped, paramName, "min");
    if (minMatch) {
        return minMatch;
    }
    if (stripped.tag === "call" && stripped.name === "clamp" && stripped.args.length === 3) {
        const [value, lo, hi] = stripped.args;
        if (!value) {
            return null;
        }
        const delta = matchSignedDelta(value, paramName);
        if (!delta || lo?.tag !== "int_lit" || hi?.tag !== "int_lit") {
            return null;
        }
        return delta > 0
            ? { fixedPoint: hi.value, stride: delta, direction: "up" }
            : { fixedPoint: lo.value, stride: Math.abs(delta), direction: "down" };
    }
    return null;
}
function matchBoundedStep(expr, paramName, op) {
    if (expr.tag !== "call" || expr.name !== op || expr.args.length !== 2) {
        return null;
    }
    const [left, right] = expr.args;
    const literal = left?.tag === "int_lit" ? left : right?.tag === "int_lit" ? right : null;
    const other = literal === left ? right : left;
    const delta = other ? matchSignedDelta(other, paramName) : null;
    if (!literal || delta === null) {
        return null;
    }
    if (op === "max" && delta < 0) {
        return { fixedPoint: literal.value, stride: Math.abs(delta), direction: "down" };
    }
    if (op === "min" && delta > 0) {
        return { fixedPoint: literal.value, stride: delta, direction: "up" };
    }
    return null;
}
function matchSignedDelta(expr, paramName) {
    const stripped = stripNanToZero(expr);
    if (stripped.tag === "sat_add" || (stripped.tag === "binop" && stripped.op === "+")) {
        if (stripped.left.tag === "var" && stripped.left.name === paramName && stripped.right.tag === "int_lit") {
            return stripped.right.value;
        }
        if (stripped.right.tag === "var" && stripped.right.name === paramName && stripped.left.tag === "int_lit") {
            return stripped.left.value;
        }
    }
    if (stripped.tag === "sat_sub" || (stripped.tag === "binop" && stripped.op === "-")) {
        if (stripped.left.tag === "var" && stripped.left.name === paramName && stripped.right.tag === "int_lit") {
            return -stripped.right.value;
        }
    }
    return null;
}
//# sourceMappingURL=linear_speculation.js.map