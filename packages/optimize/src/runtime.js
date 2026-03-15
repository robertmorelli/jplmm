import { getArrayExtentNames, getScalarBounds } from "@jplmm/ast";
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
export function executeProgram(program, fnName, args, options = {}) {
    const ctx = {
        functions: new Map(program.functions.map((fn) => [fn.name, fn])),
        structs: new Map(program.structs.map((struct) => [struct.name, struct])),
        program,
        artifacts: options.artifacts,
        stats: createStats(),
    };
    const value = executeFunction(ctx, fnName, args, 1);
    return { value, stats: ctx.stats };
}
function executeFunction(ctx, fnName, args, depth) {
    const fn = ctx.functions.get(fnName);
    if (!fn) {
        throw new Error(`Unknown IR function '${fnName}'`);
    }
    ctx.stats.functionCalls += 1;
    ctx.stats.maxCallDepth = Math.max(ctx.stats.maxCallDepth, depth);
    let currentParams = args.map((arg, idx) => normalizeByType(arg, fn.params[idx]?.type, ctx.structs));
    const impl = ctx.artifacts?.implementations.get(fnName);
    const scalarArgs = asScalarArgs(currentParams);
    if (impl?.tag === "closed_form_linear_countdown" && scalarArgs) {
        recordImplementationHit(ctx.stats, impl.tag);
        return evalClosedFormLinear(impl, scalarArgs);
    }
    if (impl?.tag === "lut" && scalarArgs) {
        const lutValue = tryEvalLut(impl, scalarArgs);
        if (lutValue !== null) {
            recordImplementationHit(ctx.stats, impl.tag);
            return lutValue;
        }
    }
    if (impl?.tag === "linear_speculation") {
        const specArgs = asScalarArgs(currentParams);
        if (specArgs) {
            recordImplementationHit(ctx.stats, impl.tag);
            currentParams = applyLinearSpeculation(impl, specArgs, fn);
        }
    }
    let remainingFuel = getInitialFuel(fn);
    const aitkenHistory = [];
    const aitkenImpl = impl?.tag === "aitken_scalar_tail" ? impl : undefined;
    while (true) {
        ctx.stats.iterations += 1;
        if (aitkenImpl) {
            const stateParam = currentParams[aitkenImpl.stateParamIndex];
            if (typeof stateParam === "number") {
                aitkenHistory.push(normalizeScalarByType(stateParam, fn.params[aitkenImpl.stateParamIndex]?.type));
            }
        }
        const env = new Map();
        for (let i = 0; i < fn.params.length; i += 1) {
            env.set(fn.params[i].name, currentParams[i]);
            bindArrayExtentRuntimeValues(env, fn.params[i].type, currentParams[i]);
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
                frame.env.set(stmt.name, evalExpr(stmt.expr, frame, ctx, depth));
                continue;
            }
            if (stmt.tag === "ret") {
                if (stmt.expr.tag === "rec" && stmt.expr.tailPosition) {
                    const recResult = handleTailRec(stmt.expr, frame, ctx, depth);
                    remainingFuel = frame.fuel;
                    if (recResult.kind === "return") {
                        return recResult.value;
                    }
                    pendingTailArgs = recResult.nextArgs;
                    break;
                }
                frame.currentRes = evalExpr(stmt.expr, frame, ctx, depth);
                continue;
            }
        }
        if (!pendingTailArgs) {
            return frame.currentRes ?? defaultValueForType(fn.retType, ctx.structs);
        }
        currentParams = pendingTailArgs;
    }
}
function bindArrayExtentRuntimeValues(env, type, value) {
    const extentNames = getArrayExtentNames(type);
    if (!extentNames || !isArrayValue(value)) {
        return;
    }
    for (let i = 0; i < extentNames.length; i += 1) {
        const extentName = extentNames[i];
        if (typeof extentName === "string") {
            env.set(extentName, value.dims[i] ?? 0);
        }
    }
}
function handleTailRec(expr, frame, ctx, depth) {
    const nextArgs = expr.args.map((arg) => evalExpr(arg, frame, ctx, depth));
    if (argsMatchCurrent(frame.fn, nextArgs, frame.params, ctx.structs)) {
        ctx.stats.recCalls += 1;
        ctx.stats.recCollapses += 1;
        return { kind: "return", value: frame.currentRes ?? defaultValueForType(frame.fn.retType, ctx.structs) };
    }
    if (typeof frame.fuel === "number" && frame.fuel === 0) {
        ctx.stats.recCalls += 1;
        ctx.stats.gasExhaustions += 1;
        return { kind: "return", value: frame.currentRes ?? defaultValueForType(frame.fn.retType, ctx.structs) };
    }
    ctx.stats.recCalls += 1;
    ctx.stats.tailRecTransitions += 1;
    if (typeof frame.fuel === "number") {
        frame.fuel -= 1;
    }
    let rewrittenArgs = nextArgs;
    if (frame.aitkenImpl) {
        const aitkenArgs = tryApplyAitken(frame.aitkenImpl, frame, nextArgs, ctx.structs);
        if (aitkenArgs) {
            recordImplementationHit(ctx.stats, frame.aitkenImpl.tag);
            rewrittenArgs = aitkenArgs;
        }
    }
    return { kind: "tail", nextArgs: rewrittenArgs };
}
function evalExpr(expr, frame, ctx, depth) {
    ctx.stats.exprEvaluations += 1;
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
            const operand = evalExpr(expr.operand, frame, ctx, depth);
            return evalUnary(expr.op, operand, expr.resultType);
        }
        case "binop": {
            const left = evalExpr(expr.left, frame, ctx, depth);
            const right = evalExpr(expr.right, frame, ctx, depth);
            return evalBinary(expr.op, left, right, expr.resultType);
        }
        case "call": {
            const args = expr.args.map((arg) => evalExpr(arg, frame, ctx, depth));
            return evalCall(expr.name, args, expr.resultType, ctx, depth + 1);
        }
        case "rec": {
            const args = expr.args.map((arg) => evalExpr(arg, frame, ctx, depth));
            ctx.stats.recCalls += 1;
            if (argsMatchCurrent(frame.fn, args, frame.params, ctx.structs)) {
                ctx.stats.recCollapses += 1;
                return frame.currentRes ?? defaultValueForType(frame.fn.retType, ctx.structs);
            }
            if (typeof frame.fuel === "number" && frame.fuel === 0) {
                ctx.stats.gasExhaustions += 1;
                return frame.currentRes ?? defaultValueForType(frame.fn.retType, ctx.structs);
            }
            if (typeof frame.fuel === "number") {
                frame.fuel -= 1;
            }
            return executeFunction(ctx, frame.fn.name, args, depth + 1);
        }
        case "total_div": {
            const left = evalExpr(expr.left, frame, ctx, depth);
            const right = evalExpr(expr.right, frame, ctx, depth);
            return totalDiv(left, right, expr.resultType);
        }
        case "total_mod": {
            const left = evalExpr(expr.left, frame, ctx, depth);
            const right = evalExpr(expr.right, frame, ctx, depth);
            return totalMod(left, right, expr.resultType);
        }
        case "nan_to_zero":
            return nanToZero(assertNumber(evalExpr(expr.value, frame, ctx, depth), "nan_to_zero"));
        case "sat_add": {
            const left = evalExpr(expr.left, frame, ctx, depth);
            const right = evalExpr(expr.right, frame, ctx, depth);
            return saturateInt(assertNumber(left, "sat_add") + assertNumber(right, "sat_add"));
        }
        case "sat_sub": {
            const left = evalExpr(expr.left, frame, ctx, depth);
            const right = evalExpr(expr.right, frame, ctx, depth);
            return saturateInt(assertNumber(left, "sat_sub") - assertNumber(right, "sat_sub"));
        }
        case "sat_mul": {
            const left = evalExpr(expr.left, frame, ctx, depth);
            const right = evalExpr(expr.right, frame, ctx, depth);
            return saturateInt(assertNumber(left, "sat_mul") * assertNumber(right, "sat_mul"));
        }
        case "sat_neg":
            return operandNeg(assertNumber(evalExpr(expr.operand, frame, ctx, depth), "sat_neg"), expr.resultType);
        case "struct_cons":
            return {
                kind: "struct",
                typeName: expr.name,
                fields: expr.fields.map((field) => evalExpr(field, frame, ctx, depth)),
            };
        case "field": {
            const target = evalExpr(expr.target, frame, ctx, depth);
            if (!isStructValue(target)) {
                throw new Error(`Field access on non-struct value for '${expr.field}'`);
            }
            const structDef = ctx.structs.get(target.typeName);
            const fieldIndex = structDef?.fields.findIndex((field) => field.name === expr.field) ?? -1;
            if (fieldIndex < 0) {
                throw new Error(`Unknown field '${expr.field}' on struct '${target.typeName}'`);
            }
            return target.fields[fieldIndex] ?? defaultValueForType(expr.resultType, ctx.structs);
        }
        case "array_cons": {
            const values = expr.elements.map((element) => evalExpr(element, frame, ctx, depth));
            return materializeArrayValue(expr.resultType, values, ctx.structs);
        }
        case "array_expr": {
            return evaluateArrayExpr(expr.resultType, expr.bindings, expr.body, frame, ctx, depth);
        }
        case "sum_expr": {
            return evaluateSumExpr(expr.resultType, expr.bindings, expr.body, frame, ctx, depth);
        }
        case "index": {
            const arrayValue = evalExpr(expr.array, frame, ctx, depth);
            if (!isArrayValue(arrayValue)) {
                throw new Error("Indexing requires an array value");
            }
            const indices = expr.indices.map((idx) => asPositiveIndex(evalExpr(idx, frame, ctx, depth)));
            return indexArrayValue(arrayValue, indices, expr.resultType, ctx.structs);
        }
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function evalCall(name, args, resultType, ctx, depth) {
    switch (name) {
        case "to_float":
            return nanToZero(f32(assertNumber(args[0], "to_float")));
        case "to_int":
            return saturateInt(assertNumber(args[0], "to_int"));
        case "max":
            return normalizeScalarByType(Math.max(assertNumber(args[0], "max"), assertNumber(args[1], "max")), resultType);
        case "min":
            return normalizeScalarByType(Math.min(assertNumber(args[0], "min"), assertNumber(args[1], "min")), resultType);
        case "abs":
            return normalizeScalarByType(Math.abs(assertNumber(args[0], "abs")), resultType);
        case "clamp": {
            const value = assertNumber(args[0], "clamp");
            const lo = assertNumber(args[1], "clamp");
            const hi = assertNumber(args[2], "clamp");
            return normalizeScalarByType(Math.min(Math.max(value, lo), hi), resultType);
        }
        case "sqrt":
            return nanToZero(f32(Math.sqrt(assertNumber(args[0], "sqrt"))));
        case "exp":
            return nanToZero(f32(Math.exp(assertNumber(args[0], "exp"))));
        case "sin":
            return nanToZero(f32(Math.sin(assertNumber(args[0], "sin"))));
        case "cos":
            return nanToZero(f32(Math.cos(assertNumber(args[0], "cos"))));
        case "tan":
            return nanToZero(f32(Math.tan(assertNumber(args[0], "tan"))));
        case "asin":
            return nanToZero(f32(Math.asin(assertNumber(args[0], "asin"))));
        case "acos":
            return nanToZero(f32(Math.acos(assertNumber(args[0], "acos"))));
        case "atan":
            return nanToZero(f32(Math.atan(assertNumber(args[0], "atan"))));
        case "log":
            return nanToZero(f32(Math.log(assertNumber(args[0], "log"))));
        case "pow":
            return nanToZero(f32(Math.pow(assertNumber(args[0], "pow"), assertNumber(args[1], "pow"))));
        case "atan2":
            return nanToZero(f32(Math.atan2(assertNumber(args[0], "atan2"), assertNumber(args[1], "atan2"))));
        default:
            return executeFunction(ctx, name, args, depth);
    }
}
function evalUnary(op, operand, resultType) {
    if (op !== "-") {
        throw new Error(`Unsupported unary op '${op}'`);
    }
    return operandNeg(assertNumber(operand, "unary -"), resultType);
}
function evalBinary(op, left, right, resultType) {
    const a = assertNumber(left, `binary ${op}`);
    const b = assertNumber(right, `binary ${op}`);
    if (resultType.tag === "int") {
        switch (op) {
            case "+":
                return saturateInt(a + b);
            case "-":
                return saturateInt(a - b);
            case "*":
                return saturateInt(a * b);
            case "/":
                return totalDiv(a, b, resultType);
            case "%":
                return totalMod(a, b, resultType);
            default:
                throw new Error(`Unsupported int binary op '${op}'`);
        }
    }
    switch (op) {
        case "+":
            return nanToZero(f32(a + b));
        case "-":
            return nanToZero(f32(a - b));
        case "*":
            return nanToZero(f32(a * b));
        case "/":
            return totalDiv(a, b, resultType);
        case "%":
            return totalMod(a, b, resultType);
        default:
            throw new Error(`Unsupported float binary op '${op}'`);
    }
}
function totalDiv(left, right, resultType) {
    const a = assertNumber(left, "total_div");
    const b = assertNumber(right, "total_div");
    if (b === 0) {
        return 0;
    }
    if (resultType.tag === "float") {
        return nanToZero(f32(a / b));
    }
    return saturateInt(Math.trunc(a / b));
}
function totalMod(left, right, resultType) {
    const a = assertNumber(left, "total_mod");
    const b = assertNumber(right, "total_mod");
    if (b === 0) {
        return 0;
    }
    if (resultType.tag === "float") {
        return nanToZero(f32(a % b));
    }
    return saturateInt(a % b);
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
function materializeArrayValue(arrayType, items, structs) {
    const baseType = arrayLeafType(arrayType);
    if (items.length === 0) {
        return {
            kind: "array",
            elementType: baseType,
            dims: [0],
            values: [],
        };
    }
    if (isArrayValue(items[0])) {
        const first = items[0];
        const dims = [items.length, ...first.dims];
        const values = [];
        for (const item of items) {
            if (!isArrayValue(item) || item.dims.length !== first.dims.length || !sameDims(item.dims, first.dims)) {
                throw new Error("Array literal requires nested arrays with matching dimensions");
            }
            values.push(...item.values);
        }
        return {
            kind: "array",
            elementType: arrayLeafType(first.elementType),
            dims,
            values,
        };
    }
    return {
        kind: "array",
        elementType: baseType,
        dims: [items.length],
        values: items.map((item) => normalizeByType(item, baseType, structs)),
    };
}
function evaluateArrayExpr(resultType, bindings, body, frame, ctx, depth) {
    const values = [];
    const prefixDims = [];
    let suffixDims = null;
    const walk = (index) => {
        if (index === bindings.length) {
            const bodyValue = evalExpr(body, frame, ctx, depth);
            if (isArrayValue(bodyValue)) {
                if (suffixDims === null) {
                    suffixDims = [...bodyValue.dims];
                }
                else if (!sameDims(suffixDims, bodyValue.dims)) {
                    throw new Error("array body produced ragged nested arrays");
                }
                values.push(...bodyValue.values);
                return;
            }
            values.push(normalizeByType(bodyValue, arrayLeafType(resultType), ctx.structs));
            return;
        }
        const binding = bindings[index];
        const extent = asPositiveExtent(evalExpr(binding.expr, frame, ctx, depth));
        if (prefixDims.length === index) {
            prefixDims.push(extent);
        }
        else if (prefixDims[index] !== extent) {
            throw new Error("array body produced ragged dimensions");
        }
        for (let i = 0; i < extent; i += 1) {
            frame.env.set(binding.name, saturateInt(i));
            walk(index + 1);
        }
        frame.env.delete(binding.name);
    };
    walk(0);
    return {
        kind: "array",
        elementType: arrayLeafType(resultType),
        dims: [...prefixDims, ...(suffixDims ?? [])],
        values,
    };
}
function evaluateSumExpr(resultType, bindings, body, frame, ctx, depth) {
    let total = resultType.tag === "float" ? 0 : 0;
    const walk = (index) => {
        if (index === bindings.length) {
            total = evalBinary("+", total, evalExpr(body, frame, ctx, depth), resultType);
            return;
        }
        const binding = bindings[index];
        const extent = asPositiveExtent(evalExpr(binding.expr, frame, ctx, depth));
        for (let i = 0; i < extent; i += 1) {
            frame.env.set(binding.name, saturateInt(i));
            walk(index + 1);
        }
        frame.env.delete(binding.name);
    };
    walk(0);
    return total;
}
function indexArrayValue(arrayValue, indices, resultType, structs) {
    if (indices.length > arrayValue.dims.length) {
        throw new Error("Array index rank mismatch");
    }
    let offset = 0;
    for (let i = 0; i < indices.length; i += 1) {
        const idx = clampIndexToDim(indices[i], arrayValue.dims[i]);
        const dim = arrayValue.dims[i];
        offset += idx * strideOf(arrayValue.dims, i);
    }
    if (indices.length === arrayValue.dims.length) {
        return normalizeByType(arrayValue.values[offset] ?? defaultValueForType(resultType, structs), resultType, structs);
    }
    const remainingDims = arrayValue.dims.slice(indices.length);
    const sliceLength = product(remainingDims);
    return {
        kind: "array",
        elementType: arrayValue.elementType,
        dims: remainingDims,
        values: arrayValue.values.slice(offset, offset + sliceLength),
    };
}
function argsMatchCurrent(fn, nextArgs, currentParams, structs) {
    if (nextArgs.length !== currentParams.length) {
        return false;
    }
    for (let i = 0; i < nextArgs.length; i += 1) {
        if (!sameValue(nextArgs[i], currentParams[i], fn.params[i]?.type, structs)) {
            return false;
        }
    }
    return true;
}
function sameValue(a, b, type, structs) {
    if (!type || type.tag === "int") {
        return normalizeScalarByType(assertNumber(a, "int equality"), type)
            === normalizeScalarByType(assertNumber(b, "int equality"), type);
    }
    if (type.tag === "float") {
        const left = normalizeScalarByType(assertNumber(a, "float equality"), type);
        const right = normalizeScalarByType(assertNumber(b, "float equality"), type);
        if (Object.is(left, -0) && Object.is(right, 0)) {
            return true;
        }
        if (Object.is(left, 0) && Object.is(right, -0)) {
            return true;
        }
        if (!Number.isFinite(left) || !Number.isFinite(right)) {
            return left === right;
        }
        return ulpDistance(left, right) <= 1;
    }
    if (type.tag === "named") {
        if (!isStructValue(a) || !isStructValue(b) || a.typeName !== b.typeName) {
            return false;
        }
        const structDef = structs.get(type.name);
        if (!structDef) {
            return false;
        }
        for (let i = 0; i < structDef.fields.length; i += 1) {
            if (!sameValue(a.fields[i], b.fields[i], structDef.fields[i]?.type, structs)) {
                return false;
            }
        }
        return true;
    }
    if (type.tag === "array") {
        if (!isArrayValue(a) || !isArrayValue(b)) {
            return false;
        }
        if (!sameDims(a.dims, b.dims) || a.values.length !== b.values.length) {
            return false;
        }
        for (let i = 0; i < a.values.length; i += 1) {
            if (!sameValue(a.values[i], b.values[i], type.element, structs)) {
                return false;
            }
        }
        return true;
    }
    return false;
}
function normalizeByType(value, type, structs) {
    if (!type) {
        return value;
    }
    if (type.tag === "int" || type.tag === "float") {
        return normalizeScalarByType(assertNumber(value, "normalize"), type);
    }
    if (type.tag === "named") {
        if (!isStructValue(value)) {
            throw new Error(`Expected struct value for '${type.name}'`);
        }
        const structDef = structs?.get(type.name);
        const fields = structDef?.fields ?? [];
        return {
            kind: "struct",
            typeName: type.name,
            fields: fields.map((field, idx) => normalizeByType(value.fields[idx], field.type, structs)),
        };
    }
    if (type.tag !== "array") {
        return value;
    }
    if (!isArrayValue(value)) {
        throw new Error("Expected array value");
    }
    return {
        kind: "array",
        elementType: arrayLeafType(type),
        dims: [...value.dims],
        values: value.values.map((item) => normalizeByType(item, type.element, structs)),
    };
}
function normalizeScalarByType(value, type) {
    if (!type) {
        return value;
    }
    if (type.tag === "int") {
        let out = saturateInt(value);
        const bounds = getScalarBounds(type);
        if (bounds && bounds.lo !== null) {
            out = Math.max(out, saturateInt(bounds.lo));
        }
        if (bounds && bounds.hi !== null) {
            out = Math.min(out, saturateInt(bounds.hi));
        }
        return out;
    }
    if (type.tag === "float") {
        let out = nanToZero(f32(value));
        const bounds = getScalarBounds(type);
        if (bounds && bounds.lo !== null) {
            out = Math.max(out, nanToZero(f32(bounds.lo)));
        }
        if (bounds && bounds.hi !== null) {
            out = Math.min(out, nanToZero(f32(bounds.hi)));
        }
        return out;
    }
    return value;
}
function assertNumber(value, context) {
    if (typeof value !== "number") {
        throw new Error(`Expected numeric value in ${context}`);
    }
    return value;
}
function asScalarArgs(args) {
    if (args.every((arg) => typeof arg === "number")) {
        return args;
    }
    return null;
}
function isStructValue(value) {
    return typeof value === "object" && value !== null && value.kind === "struct";
}
function isArrayValue(value) {
    return typeof value === "object" && value !== null && value.kind === "array";
}
function arrayLeafType(type) {
    return type.tag === "array" ? arrayLeafType(type.element) : type;
}
function sameDims(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}
function strideOf(dims, index) {
    return product(dims.slice(index + 1));
}
function product(values) {
    return values.reduce((acc, value) => acc * value, 1);
}
function asPositiveExtent(value) {
    const extent = saturateInt(assertNumber(value, "comprehension extent"));
    return Math.max(1, extent);
}
function asPositiveIndex(value) {
    return saturateInt(assertNumber(value, "array index"));
}
function clampIndexToDim(index, dim) {
    if (dim <= 1) {
        return 0;
    }
    if (index < 0) {
        return 0;
    }
    if (index >= dim) {
        return dim - 1;
    }
    return index;
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
    if (impl.resultType.tag !== "int" && impl.resultType.tag !== "float") {
        return null;
    }
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
    return normalizeScalarByType(impl.table[index] ?? 0, impl.resultType);
}
function evalClosedFormLinear(impl, args) {
    const x = saturateInt(args[impl.paramIndex] ?? 0);
    const steps = x <= 0 ? 1 : Math.ceil(x / impl.decrement) + 1;
    return saturateInt(impl.baseValue + steps * impl.stepValue);
}
function tryApplyAitken(impl, frame, nextArgs, structs) {
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
    if (Math.abs(extrapolated - s2) > Math.max(1, Math.abs(delta1) * 64)) {
        return null;
    }
    if (impl.targetParamIndex !== null) {
        const target = frame.params[impl.targetParamIndex];
        if (typeof target !== "number") {
            return null;
        }
        const currentDistance = Math.abs(s2 - target);
        const extrapolatedDistance = Math.abs(extrapolated - target);
        if (extrapolatedDistance > currentDistance) {
            return null;
        }
    }
    if (sameValue(extrapolated, s2, frame.fn.params[impl.stateParamIndex]?.type, structs)) {
        return null;
    }
    const rewritten = [...nextArgs];
    rewritten[impl.stateParamIndex] = normalizeByType(extrapolated, frame.fn.params[impl.stateParamIndex]?.type, structs);
    return rewritten;
}
function applyLinearSpeculation(impl, args, fn) {
    const rewritten = [...args];
    rewritten[impl.varyingParamIndex] = normalizeScalarByType(impl.fixedPoint, fn.params[impl.varyingParamIndex]?.type);
    return rewritten;
}
function defaultValueForType(type, structs) {
    if (type.tag === "float") {
        return 0;
    }
    if (type.tag === "int" || type.tag === "void") {
        return 0;
    }
    if (type.tag === "named") {
        const struct = structs.get(type.name);
        return {
            kind: "struct",
            typeName: type.name,
            fields: (struct?.fields ?? []).map((field) => defaultValueForType(field.type, structs)),
        };
    }
    return {
        kind: "array",
        elementType: arrayLeafType(type),
        dims: new Array(type.dims).fill(0),
        values: [],
    };
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