const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
export function executeProgram(program, fnName, args, options = {}) {
    const functions = new Map(program.functions.map((fn) => [fn.name, fn]));
    const stats = createStats();
    const value = executeFunction(functions, program, fnName, args, options.artifacts, stats, 1);
    return { value, stats };
}
function executeFunction(functions, program, fnName, args, artifacts, stats, depth) {
    const fn = functions.get(fnName);
    if (!fn) {
        throw new Error(`Unknown IR function '${fnName}'`);
    }
    stats.functionCalls += 1;
    stats.maxCallDepth = Math.max(stats.maxCallDepth, depth);
    const impl = artifacts?.implementations.get(fnName);
    if (impl?.tag === "closed_form_linear_countdown") {
        recordImplementationHit(stats, impl.tag);
        return evalClosedFormLinear(impl, args);
    }
    if (impl?.tag === "lut") {
        const lutValue = tryEvalLut(impl, args);
        if (lutValue !== null) {
            recordImplementationHit(stats, impl.tag);
            return lutValue;
        }
    }
    let currentParams = args.map((arg, idx) => normalizeByType(arg, fn.params[idx]?.type));
    if (impl?.tag === "linear_speculation") {
        recordImplementationHit(stats, impl.tag);
        currentParams = applyLinearSpeculation(impl, currentParams, fn);
    }
    let remainingFuel = getInitialFuel(fn);
    const aitkenHistory = [];
    const aitkenImpl = impl?.tag === "aitken_scalar_tail" ? impl : undefined;
    while (true) {
        stats.iterations += 1;
        if (aitkenImpl) {
            const stateParam = currentParams[aitkenImpl.stateParamIndex];
            if (stateParam !== undefined) {
                aitkenHistory.push(normalizeByType(stateParam, fn.params[aitkenImpl.stateParamIndex]?.type));
            }
        }
        const env = new Map();
        for (let i = 0; i < fn.params.length; i += 1) {
            env.set(fn.params[i].name, currentParams[i]);
        }
        const frame = {
            fn,
            params: currentParams,
            env,
            currentRes: undefined,
            fuel: remainingFuel,
            aitkenHistory,
            aitkenImpl,
        };
        let pendingTailArgs = null;
        for (const stmt of fn.body) {
            if (stmt.tag === "let") {
                frame.env.set(stmt.name, evalExpr(stmt.expr, frame, functions, program, artifacts, stats, depth));
                continue;
            }
            if (stmt.tag === "ret") {
                if (stmt.expr.tag === "rec" && stmt.expr.tailPosition) {
                    const recResult = handleTailRec(stmt.expr, frame, functions, program, artifacts, stats, depth);
                    remainingFuel = frame.fuel;
                    if (recResult.kind === "return") {
                        return recResult.value;
                    }
                    pendingTailArgs = recResult.nextArgs;
                    break;
                }
                frame.currentRes = evalExpr(stmt.expr, frame, functions, program, artifacts, stats, depth);
                continue;
            }
            if (stmt.tag === "gas" || stmt.tag === "rad") {
                continue;
            }
        }
        if (!pendingTailArgs) {
            return frame.currentRes ?? defaultValueForType(fn.retType);
        }
        currentParams = pendingTailArgs;
    }
}
function handleTailRec(expr, frame, functions, program, artifacts, stats, depth) {
    const nextArgs = expr.args.map((arg) => evalExpr(arg, frame, functions, program, artifacts, stats, depth));
    if (argsMatchCurrent(frame.fn, nextArgs, frame.params)) {
        stats.recCalls += 1;
        stats.recCollapses += 1;
        return { kind: "return", value: frame.currentRes ?? defaultValueForType(frame.fn.retType) };
    }
    if (typeof frame.fuel === "number" && frame.fuel === 0) {
        stats.recCalls += 1;
        stats.gasExhaustions += 1;
        return { kind: "return", value: frame.currentRes ?? defaultValueForType(frame.fn.retType) };
    }
    stats.recCalls += 1;
    stats.tailRecTransitions += 1;
    if (typeof frame.fuel === "number") {
        frame.fuel -= 1;
    }
    let rewrittenArgs = nextArgs;
    if (frame.aitkenImpl) {
        const aitkenArgs = tryApplyAitken(frame.aitkenImpl, frame, nextArgs);
        if (aitkenArgs) {
            recordImplementationHit(stats, frame.aitkenImpl.tag);
            rewrittenArgs = aitkenArgs;
        }
    }
    return { kind: "tail", nextArgs: rewrittenArgs };
}
function evalExpr(expr, frame, functions, program, artifacts, stats, depth) {
    stats.exprEvaluations += 1;
    switch (expr.tag) {
        case "int_lit":
            return saturateInt(expr.value);
        case "float_lit":
            return nanToZero(f32(expr.value));
        case "void_lit":
            return 0;
        case "var": {
            const value = frame.env.get(expr.name);
            if (value === undefined) {
                throw new Error(`Unbound IR variable '${expr.name}' at runtime`);
            }
            return value;
        }
        case "res":
            return frame.currentRes ?? 0;
        case "unop": {
            const operand = evalExpr(expr.operand, frame, functions, program, artifacts, stats, depth);
            return evalUnary(expr.op, operand, expr.resultType);
        }
        case "binop": {
            const left = evalExpr(expr.left, frame, functions, program, artifacts, stats, depth);
            const right = evalExpr(expr.right, frame, functions, program, artifacts, stats, depth);
            return evalBinary(expr.op, left, right, expr.resultType);
        }
        case "call": {
            const args = expr.args.map((arg) => evalExpr(arg, frame, functions, program, artifacts, stats, depth));
            return evalCall(expr.name, args, expr.resultType, functions, program, artifacts, stats, depth + 1);
        }
        case "rec": {
            const args = expr.args.map((arg) => evalExpr(arg, frame, functions, program, artifacts, stats, depth));
            stats.recCalls += 1;
            if (argsMatchCurrent(frame.fn, args, frame.params)) {
                stats.recCollapses += 1;
                return frame.currentRes ?? defaultValueForType(frame.fn.retType);
            }
            if (typeof frame.fuel === "number" && frame.fuel === 0) {
                stats.gasExhaustions += 1;
                return frame.currentRes ?? defaultValueForType(frame.fn.retType);
            }
            if (typeof frame.fuel === "number") {
                frame.fuel -= 1;
            }
            return executeFunction(functions, program, frame.fn.name, args, artifacts, stats, depth + 1);
        }
        case "total_div": {
            const left = evalExpr(expr.left, frame, functions, program, artifacts, stats, depth);
            const right = evalExpr(expr.right, frame, functions, program, artifacts, stats, depth);
            return totalDiv(left, right, expr.resultType);
        }
        case "total_mod": {
            const left = evalExpr(expr.left, frame, functions, program, artifacts, stats, depth);
            const right = evalExpr(expr.right, frame, functions, program, artifacts, stats, depth);
            return totalMod(left, right, expr.resultType);
        }
        case "nan_to_zero":
            return nanToZero(evalExpr(expr.value, frame, functions, program, artifacts, stats, depth));
        case "sat_add": {
            const left = evalExpr(expr.left, frame, functions, program, artifacts, stats, depth);
            const right = evalExpr(expr.right, frame, functions, program, artifacts, stats, depth);
            return saturateInt(left + right);
        }
        case "sat_sub": {
            const left = evalExpr(expr.left, frame, functions, program, artifacts, stats, depth);
            const right = evalExpr(expr.right, frame, functions, program, artifacts, stats, depth);
            return saturateInt(left - right);
        }
        case "sat_mul": {
            const left = evalExpr(expr.left, frame, functions, program, artifacts, stats, depth);
            const right = evalExpr(expr.right, frame, functions, program, artifacts, stats, depth);
            return saturateInt(left * right);
        }
        case "sat_neg":
            return operandNeg(evalExpr(expr.operand, frame, functions, program, artifacts, stats, depth), expr.resultType);
        case "index":
        case "field":
        case "struct_cons":
        case "array_cons":
        case "array_expr":
        case "sum_expr":
            throw new Error(`Runtime support for '${expr.tag}' is not implemented yet`);
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function evalCall(name, args, resultType, functions, program, artifacts, stats, depth) {
    switch (name) {
        case "to_float":
            return nanToZero(f32(args[0] ?? 0));
        case "to_int":
            return saturateInt(args[0] ?? 0);
        case "max":
            return normalizeByType(Math.max(args[0] ?? 0, args[1] ?? 0), resultType);
        case "min":
            return normalizeByType(Math.min(args[0] ?? 0, args[1] ?? 0), resultType);
        case "abs":
            return normalizeByType(Math.abs(args[0] ?? 0), resultType);
        case "clamp": {
            const value = args[0] ?? 0;
            const lo = args[1] ?? 0;
            const hi = args[2] ?? 0;
            return normalizeByType(Math.min(Math.max(value, lo), hi), resultType);
        }
        case "sqrt":
            return nanToZero(f32(Math.sqrt(args[0] ?? 0)));
        case "exp":
            return nanToZero(f32(Math.exp(args[0] ?? 0)));
        case "sin":
            return nanToZero(f32(Math.sin(args[0] ?? 0)));
        case "cos":
            return nanToZero(f32(Math.cos(args[0] ?? 0)));
        case "tan":
            return nanToZero(f32(Math.tan(args[0] ?? 0)));
        case "asin":
            return nanToZero(f32(Math.asin(args[0] ?? 0)));
        case "acos":
            return nanToZero(f32(Math.acos(args[0] ?? 0)));
        case "atan":
            return nanToZero(f32(Math.atan(args[0] ?? 0)));
        case "log":
            return nanToZero(f32(Math.log(args[0] ?? 0)));
        case "pow":
            return nanToZero(f32(Math.pow(args[0] ?? 0, args[1] ?? 0)));
        case "atan2":
            return nanToZero(f32(Math.atan2(args[0] ?? 0, args[1] ?? 0)));
        default:
            return executeFunction(functions, program, name, args, artifacts, stats, depth);
    }
}
function evalUnary(op, operand, resultType) {
    if (op !== "-") {
        throw new Error(`Unsupported unary op '${op}'`);
    }
    return operandNeg(operand, resultType);
}
function evalBinary(op, left, right, resultType) {
    if (resultType.tag === "int") {
        switch (op) {
            case "+":
                return saturateInt(left + right);
            case "-":
                return saturateInt(left - right);
            case "*":
                return saturateInt(left * right);
            case "/":
                return totalDiv(left, right, resultType);
            case "%":
                return totalMod(left, right, resultType);
            default:
                throw new Error(`Unsupported int binary op '${op}'`);
        }
    }
    switch (op) {
        case "+":
            return nanToZero(f32(left + right));
        case "-":
            return nanToZero(f32(left - right));
        case "*":
            return nanToZero(f32(left * right));
        case "/":
            return totalDiv(left, right, resultType);
        case "%":
            return totalMod(left, right, resultType);
        default:
            throw new Error(`Unsupported float binary op '${op}'`);
    }
}
function totalDiv(left, right, resultType) {
    if (right === 0) {
        return resultType.tag === "float" ? 0 : 0;
    }
    if (resultType.tag === "float") {
        return nanToZero(f32(left / right));
    }
    return saturateInt(Math.trunc(left / right));
}
function totalMod(left, right, resultType) {
    if (right === 0) {
        return 0;
    }
    if (resultType.tag === "float") {
        return nanToZero(f32(left % right));
    }
    return saturateInt(left % right);
}
function operandNeg(value, resultType) {
    if (resultType.tag === "int") {
        if (value === INT32_MIN) {
            return INT32_MAX;
        }
        return saturateInt(-value);
    }
    return nanToZero(f32(-value));
}
function normalizeByType(value, type) {
    if (!type) {
        return value;
    }
    if (type.tag === "int") {
        return saturateInt(value);
    }
    if (type.tag === "float") {
        return nanToZero(f32(value));
    }
    return value;
}
function saturateInt(value) {
    if (!Number.isFinite(value)) {
        return value < 0 ? INT32_MIN : INT32_MAX;
    }
    const truncated = Math.trunc(value);
    if (truncated < INT32_MIN) {
        return INT32_MIN;
    }
    if (truncated > INT32_MAX) {
        return INT32_MAX;
    }
    return truncated;
}
function f32(value) {
    return Math.fround(value);
}
function nanToZero(value) {
    return Number.isNaN(value) ? 0 : value;
}
function argsMatchCurrent(fn, nextArgs, currentParams) {
    if (nextArgs.length !== currentParams.length) {
        return false;
    }
    for (let i = 0; i < nextArgs.length; i += 1) {
        if (!sameValue(nextArgs[i], currentParams[i], fn.params[i]?.type)) {
            return false;
        }
    }
    return true;
}
function sameValue(a, b, type) {
    if (!type || type.tag === "int") {
        return saturateInt(a) === saturateInt(b);
    }
    if (type.tag === "float") {
        if (Object.is(a, -0) && Object.is(b, 0)) {
            return true;
        }
        if (Object.is(a, 0) && Object.is(b, -0)) {
            return true;
        }
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
            return a === b;
        }
        return ulpDistance(a, b) <= 1;
    }
    return a === b;
}
function ulpDistance(a, b) {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setFloat32(0, f32(a), true);
    const ua = view.getUint32(0, true);
    view.setFloat32(0, f32(b), true);
    const ub = view.getUint32(0, true);
    const oa = (ua & 0x80000000) !== 0 ? (~ua >>> 0) : (ua | 0x80000000);
    const ob = (ub & 0x80000000) !== 0 ? (~ub >>> 0) : (ub | 0x80000000);
    return Math.abs(oa - ob);
}
function getInitialFuel(fn) {
    const gas = fn.body.find((stmt) => stmt.tag === "gas");
    if (!gas) {
        return null;
    }
    return gas.limit === "inf" ? "inf" : gas.limit;
}
function tryEvalLut(impl, args) {
    if (impl.parameterRanges.length !== args.length) {
        return null;
    }
    let index = 0;
    let stride = 1;
    for (let i = impl.parameterRanges.length - 1; i >= 0; i -= 1) {
        const range = impl.parameterRanges[i];
        const arg = saturateInt(args[i] ?? 0);
        if (!Number.isInteger(range.lo) || !Number.isInteger(range.hi)) {
            return null;
        }
        if (arg < range.lo || arg > range.hi) {
            return null;
        }
        index += (arg - range.lo) * stride;
        stride *= range.hi - range.lo + 1;
    }
    return normalizeByType(impl.table[index] ?? 0, impl.resultType);
}
function evalClosedFormLinear(impl, args) {
    const x = saturateInt(args[impl.paramIndex] ?? 0);
    const steps = x <= 0 ? 1 : Math.ceil(x / impl.decrement) + 1;
    return saturateInt(impl.baseValue + steps * impl.stepValue);
}
function tryApplyAitken(impl, frame, nextArgs) {
    if (frame.aitkenHistory.length < impl.afterIterations) {
        return null;
    }
    const history = frame.aitkenHistory;
    const s0 = history[history.length - 3];
    const s1 = history[history.length - 2];
    const s2 = history[history.length - 1];
    if (s0 === undefined || s1 === undefined || s2 === undefined) {
        return null;
    }
    const delta0 = f32(s1 - s0);
    const delta1 = f32(s2 - s1);
    if (Math.abs(delta1) >= Math.abs(delta0)) {
        return null;
    }
    const denominator = f32(delta1 - delta0);
    if (denominator === 0 || !Number.isFinite(denominator)) {
        return null;
    }
    const extrapolated = nanToZero(f32(s2 - (delta1 * delta1) / denominator));
    if (!Number.isFinite(extrapolated)) {
        return null;
    }
    if (Math.abs(extrapolated - s2) >
        Math.max(1, Math.abs(delta1) * 64)) {
        return null;
    }
    if (impl.targetParamIndex !== null) {
        const target = frame.params[impl.targetParamIndex];
        if (target === undefined) {
            return null;
        }
        const currentDistance = Math.abs(s2 - target);
        const extrapolatedDistance = Math.abs(extrapolated - target);
        if (extrapolatedDistance > currentDistance) {
            return null;
        }
    }
    if (sameValue(extrapolated, s2, frame.fn.params[impl.stateParamIndex]?.type)) {
        return null;
    }
    const rewritten = [...nextArgs];
    rewritten[impl.stateParamIndex] = normalizeByType(extrapolated, frame.fn.params[impl.stateParamIndex]?.type);
    return rewritten;
}
function applyLinearSpeculation(impl, args, fn) {
    const rewritten = [...args];
    rewritten[impl.varyingParamIndex] = normalizeByType(impl.fixedPoint, fn.params[impl.varyingParamIndex]?.type);
    return rewritten;
}
function defaultValueForType(type) {
    return type.tag === "float" ? 0 : 0;
}
function createStats() {
    return {
        exprEvaluations: 0,
        functionCalls: 0,
        recCalls: 0,
        recCollapses: 0,
        tailRecTransitions: 0,
        gasExhaustions: 0,
        iterations: 0,
        maxCallDepth: 0,
        implementationHits: {},
    };
}
function recordImplementationHit(stats, name) {
    stats.implementationHits[name] = (stats.implementationHits[name] ?? 0) + 1;
}
//# sourceMappingURL=runtime.js.map