import { getArrayExtentNames, getScalarBounds, sameType as sameDeclaredType, scalarTag as astScalarTag, } from "@jplmm/ast";
import { INT32_MAX, INT32_MIN, buildJplScalarPrelude, checkSatAndGetValues, parseZ3Int, sanitizeSymbol as sanitize, } from "@jplmm/smt";
let arrayEqCounter = 0;
const TRACE_OPAQUE = process.env.JPLMM_TRACE_OPAQUE === "1";
const opaqueCounts = new Map();
let opaqueHookInstalled = false;
function noteOpaque(site, label) {
    if (!TRACE_OPAQUE) {
        return;
    }
    if (!opaqueHookInstalled) {
        opaqueHookInstalled = true;
        process.on("exit", () => {
            if (opaqueCounts.size === 0) {
                return;
            }
            const entries = [...opaqueCounts.entries()]
                .sort((left, right) => right[1] - left[1])
                .map(([key, count]) => ({ key, count }));
            const total = entries.reduce((sum, entry) => sum + entry.count, 0);
            console.error(`[jplmm-opaque] ${JSON.stringify({ total, entries })}`);
        });
    }
    const family = label.includes("_") ? label.slice(0, label.indexOf("_")) : label;
    const key = `${site}|${family}`;
    opaqueCounts.set(key, (opaqueCounts.get(key) ?? 0) + 1);
}
export function makeOpaque(type, label, site) {
    noteOpaque(site, label);
    return { kind: "opaque", type, label };
}
export function createSmtEncodingState() {
    return {
        sumDefinitions: [],
        sumHelpers: new Map(),
        nextSumId: 0,
    };
}
export function appendSmtEncodingState(lines, state) {
    if (!state) {
        return;
    }
    lines.push(...state.sumDefinitions);
}
export function scalarTag(type) {
    return astScalarTag(type);
}
export function sameType(left, right) {
    return sameDeclaredType(left, right);
}
export function normalizeScalarExprForType(expr, type) {
    const tag = scalarTag(type);
    if (!tag) {
        return expr;
    }
    let normalized = expr;
    if (tag === "float") {
        normalized = { tag: "nan_to_zero", value: normalized };
    }
    const bounds = getScalarBounds(type);
    if (!bounds) {
        return normalized;
    }
    if (bounds.lo !== null && bounds.hi !== null) {
        return {
            tag: "call",
            name: "clamp",
            args: [normalized, literalScalar(tag, bounds.lo), literalScalar(tag, bounds.hi)],
            valueType: tag,
            interpreted: true,
        };
    }
    if (bounds.lo !== null) {
        return {
            tag: "call",
            name: "max",
            args: [normalized, literalScalar(tag, bounds.lo)],
            valueType: tag,
            interpreted: true,
        };
    }
    if (bounds.hi !== null) {
        return {
            tag: "call",
            name: "min",
            args: [normalized, literalScalar(tag, bounds.hi)],
            valueType: tag,
            interpreted: true,
        };
    }
    return normalized;
}
export function normalizeValueForType(value, type) {
    if (scalarTag(type) && value.kind === "scalar") {
        return {
            kind: "scalar",
            expr: normalizeScalarExprForType(value.expr, type),
        };
    }
    return value;
}
export function buildComparisonEnvFromParams(params) {
    const env = new Map();
    for (const param of params) {
        env.set(param.name, comparisonIntervalForType(param.type));
        const extentNames = getArrayExtentNames(param.type);
        if (extentNames) {
            for (const extentName of extentNames) {
                if (extentName !== null) {
                    env.set(extentName, { lo: 0, hi: INT32_MAX, exact: false });
                }
            }
        }
    }
    return env;
}
export function normalizeValueForComparison(value, env = new Map()) {
    switch (value.kind) {
        case "scalar":
            return { kind: "scalar", expr: normalizeScalarForComparison(value.expr, env) };
        case "array":
            return { kind: "array", array: normalizeArrayForComparison(value.array, env) };
        case "struct":
            return {
                kind: "struct",
                typeName: value.typeName,
                fields: value.fields.map((field) => ({
                    ...field,
                    value: normalizeValueForComparison(field.value, env),
                })),
            };
        case "void":
        case "opaque":
            return value;
    }
}
export function normalizeScalarForComparison(expr, env = new Map()) {
    let normalized;
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
        case "var":
            normalized = expr;
            break;
        case "unop":
            normalized = { ...expr, operand: normalizeScalarForComparison(expr.operand, env) };
            break;
        case "select":
            normalized = {
                ...expr,
                index: normalizeScalarForComparison(expr.index, env),
                cases: expr.cases.map((value) => normalizeScalarForComparison(value, env)),
            };
            break;
        case "sum": {
            const bindings = expr.bindings.map((binding) => ({
                name: binding.name,
                extent: normalizeScalarForComparison(binding.extent, env),
            }));
            const innerEnv = new Map(env);
            for (const binding of bindings) {
                innerEnv.set(binding.name, comparisonIntervalForBinding(binding.extent, env));
            }
            normalized = {
                ...expr,
                bindings,
                body: normalizeScalarForComparison(expr.body, innerEnv),
            };
            break;
        }
        case "binop": {
            const left = normalizeScalarForComparison(expr.left, env);
            const right = normalizeScalarForComparison(expr.right, env);
            if (expr.op === "+" || expr.op === "*") {
                const [orderedLeft, orderedRight] = orderScalarPair(left, right);
                normalized = { ...expr, left: orderedLeft, right: orderedRight };
                break;
            }
            normalized = { ...expr, left, right };
            break;
        }
        case "sat_add":
        case "sat_mul": {
            const left = normalizeScalarForComparison(expr.left, env);
            const right = normalizeScalarForComparison(expr.right, env);
            const [orderedLeft, orderedRight] = orderScalarPair(left, right);
            normalized = { ...expr, left: orderedLeft, right: orderedRight };
            break;
        }
        case "sat_sub":
            normalized = {
                ...expr,
                left: normalizeScalarForComparison(expr.left, env),
                right: normalizeScalarForComparison(expr.right, env),
            };
            break;
        case "sat_neg":
            normalized = { ...expr, operand: normalizeScalarForComparison(expr.operand, env) };
            break;
        case "total_div":
        case "total_mod":
            normalized = {
                ...expr,
                left: normalizeScalarForComparison(expr.left, env),
                right: normalizeScalarForComparison(expr.right, env),
            };
            break;
        case "nan_to_zero":
            normalized = { ...expr, value: normalizeScalarForComparison(expr.value, env) };
            break;
        case "positive_extent":
            normalized = { ...expr, value: normalizeScalarForComparison(expr.value, env) };
            break;
        case "clamp_index":
            normalized = {
                ...expr,
                index: normalizeScalarForComparison(expr.index, env),
                dim: normalizeScalarForComparison(expr.dim, env),
            };
            break;
        case "read":
            normalized = {
                ...expr,
                array: normalizeArrayForComparison(expr.array, env),
                indices: expr.indices.map((index) => normalizeScalarForComparison(index, env)),
            };
            break;
        case "call":
            normalized = {
                ...expr,
                args: expr.args.map((arg) => normalizeScalarForComparison(arg, env)),
            };
            break;
        default: {
            const _never = expr;
            normalized = _never;
            break;
        }
    }
    return simplifyNormalizedScalar(normalized, env);
}
function normalizeArrayForComparison(array, env) {
    switch (array.tag) {
        case "param":
            return {
                ...array,
                dims: array.dims.map((dim) => normalizeScalarForComparison(dim, env)),
            };
        case "abstract":
            return {
                ...array,
                args: array.args.map((arg) => normalizeScalarForComparison(arg, env)),
                dims: array.dims.map((dim) => normalizeScalarForComparison(dim, env)),
            };
        case "slice":
            return {
                ...array,
                base: normalizeArrayForComparison(array.base, env),
                fixedIndices: array.fixedIndices.map((index) => normalizeScalarForComparison(index, env)),
            };
        case "literal":
            return {
                ...array,
                elements: array.elements.map((element) => normalizeValueForComparison(element, env)),
            };
        case "choice":
            return {
                ...array,
                selector: normalizeScalarForComparison(array.selector, env),
                options: array.options.map((option) => normalizeArrayForComparison(option, env)),
            };
        case "comprehension": {
            const bindings = array.bindings.map((binding) => ({
                name: binding.name,
                extent: normalizeScalarForComparison(binding.extent, env),
            }));
            const innerEnv = new Map(env);
            for (const binding of bindings) {
                innerEnv.set(binding.name, comparisonIntervalForBinding(binding.extent, env));
            }
            return {
                ...array,
                bindings,
                body: normalizeValueForComparison(array.body, innerEnv),
            };
        }
        default: {
            const _never = array;
            return _never;
        }
    }
}
function orderScalarPair(left, right) {
    return scalarComparisonKey(left) <= scalarComparisonKey(right)
        ? [left, right]
        : [right, left];
}
function scalarComparisonKey(expr) {
    return emitScalar(expr);
}
function simplifyNormalizedScalar(expr, env) {
    if (expr.tag === "read") {
        if (expr.array.tag !== "param" && expr.array.tag !== "abstract") {
            const reduced = readSymbolicArray(expr.array, expr.indices, scalarTypeToType(expr.valueType), -1, -1);
            if (reduced.kind === "scalar") {
                return normalizeScalarForComparison(reduced.expr, env);
            }
        }
    }
    if (expr.tag === "positive_extent") {
        const valueInterval = comparisonInterval(expr.value, env);
        if (valueInterval.lo >= 1) {
            return expr.value;
        }
        if (valueInterval.hi <= 0) {
            return { tag: "int_lit", value: 1 };
        }
    }
    if (expr.tag === "clamp_index") {
        const dimInterval = comparisonInterval(expr.dim, env);
        if (dimInterval.hi <= 1) {
            return { tag: "int_lit", value: 0 };
        }
        if (canProveInRange(expr.index, expr.dim, env)) {
            return expr.index;
        }
    }
    if (expr.tag === "call" && expr.interpreted) {
        if (expr.name === "clamp" && expr.args.length === 3) {
            const value = expr.args[0];
            const lo = expr.args[1];
            const hi = expr.args[2];
            if (canProveWithinBounds(value, lo, hi, env)) {
                return value;
            }
            const valueInterval = comparisonInterval(value, env);
            const loInterval = comparisonInterval(lo, env);
            const hiInterval = comparisonInterval(hi, env);
            if (valueInterval.hi <= loInterval.lo) {
                return lo;
            }
            if (valueInterval.lo >= hiInterval.hi) {
                return hi;
            }
        }
        if ((expr.name === "max" || expr.name === "min") && expr.args.length === 2) {
            const left = expr.args[0];
            const right = expr.args[1];
            const leftInterval = comparisonInterval(left, env);
            const rightInterval = comparisonInterval(right, env);
            if (expr.name === "max") {
                if (leftInterval.lo >= rightInterval.hi) {
                    return left;
                }
                if (rightInterval.lo >= leftInterval.hi) {
                    return right;
                }
            }
            else {
                if (leftInterval.hi <= rightInterval.lo) {
                    return left;
                }
                if (rightInterval.hi <= leftInterval.lo) {
                    return right;
                }
            }
        }
        if (expr.name === "abs" && expr.args.length === 1) {
            const interval = comparisonInterval(expr.args[0], env);
            if (interval.lo >= 0) {
                return expr.args[0];
            }
        }
    }
    if (expr.tag === "total_div" || expr.tag === "total_mod") {
        const decomposition = matchAffineDivMod(expr.left, expr.right, env);
        if (decomposition) {
            return expr.tag === "total_div" ? decomposition.quotient : decomposition.remainder;
        }
    }
    return constantFoldScalar(expr);
}
function comparisonIntervalForType(type) {
    if (type.tag === "float") {
        const bounds = getScalarBounds(type);
        return {
            lo: bounds?.lo ?? -Infinity,
            hi: bounds?.hi ?? Infinity,
            exact: true,
        };
    }
    if (type.tag === "int") {
        const bounds = getScalarBounds(type);
        return {
            lo: bounds?.lo ?? INT32_MIN,
            hi: bounds?.hi ?? INT32_MAX,
            exact: true,
        };
    }
    return { lo: -Infinity, hi: Infinity, exact: false };
}
function comparisonIntervalForBinding(extent, env) {
    const positive = positiveExtentInterval(comparisonInterval(extent, env));
    return {
        lo: 0,
        hi: Math.max(0, positive.hi - 1),
        exact: Number.isFinite(positive.hi),
        boundBy: normalizeScalarForComparison({ tag: "positive_extent", value: extent }, env),
    };
}
function comparisonInterval(expr, env) {
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
            return { lo: expr.value, hi: expr.value, exact: true };
        case "var":
            return env.get(expr.name)
                ?? { lo: expr.valueType === "int" ? INT32_MIN : -Infinity, hi: expr.valueType === "int" ? INT32_MAX : Infinity, exact: true };
        case "unop": {
            const inner = comparisonInterval(expr.operand, env);
            return { lo: -inner.hi, hi: -inner.lo, exact: inner.exact };
        }
        case "select": {
            const cases = expr.cases.map((value) => comparisonInterval(value, env));
            return {
                lo: Math.min(...cases.map((value) => value.lo)),
                hi: Math.max(...cases.map((value) => value.hi)),
                exact: cases.every((value) => value.exact),
            };
        }
        case "sum": {
            if (expr.valueType !== "int") {
                return { lo: -Infinity, hi: Infinity, exact: false };
            }
            const bindings = expr.bindings.map((binding) => ({
                name: binding.name,
                extent: comparisonIntervalForBinding(binding.extent, env),
            }));
            const innerEnv = new Map(env);
            for (const binding of bindings) {
                innerEnv.set(binding.name, binding.extent);
            }
            const body = comparisonInterval(expr.body, innerEnv);
            const tripCount = bindings.reduce((count, binding) => count * Math.max(0, binding.extent.hi - binding.extent.lo + 1), 1);
            if (!Number.isFinite(tripCount)) {
                return { lo: INT32_MIN, hi: INT32_MAX, exact: false };
            }
            return clampIntInterval({
                lo: body.lo * tripCount,
                hi: body.hi * tripCount,
                exact: body.exact,
            });
        }
        case "binop":
            return expr.valueType === "float"
                ? comparisonFloatBinop(expr.op, comparisonInterval(expr.left, env), comparisonInterval(expr.right, env))
                : comparisonIntBinop(expr.op, comparisonInterval(expr.left, env), comparisonInterval(expr.right, env), true);
        case "sat_add":
            return comparisonIntBinop("+", comparisonInterval(expr.left, env), comparisonInterval(expr.right, env), false);
        case "sat_sub":
            return comparisonIntBinop("-", comparisonInterval(expr.left, env), comparisonInterval(expr.right, env), false);
        case "sat_mul":
            return comparisonIntBinop("*", comparisonInterval(expr.left, env), comparisonInterval(expr.right, env), false);
        case "sat_neg": {
            const inner = comparisonInterval(expr.operand, env);
            return clampIntInterval({ lo: -inner.hi, hi: -inner.lo, exact: inner.exact });
        }
        case "total_div": {
            const left = comparisonInterval(expr.left, env);
            const right = comparisonInterval(expr.right, env);
            if (right.lo <= 0 && right.hi >= 0) {
                return expr.valueType === "int"
                    ? { lo: INT32_MIN, hi: INT32_MAX, exact: false }
                    : { lo: -Infinity, hi: Infinity, exact: false };
            }
            const quotients = [
                left.lo / right.lo,
                left.lo / right.hi,
                left.hi / right.lo,
                left.hi / right.hi,
            ];
            return expr.valueType === "int"
                ? clampIntInterval({
                    lo: Math.min(...quotients.map((value) => Math.trunc(value))),
                    hi: Math.max(...quotients.map((value) => Math.trunc(value))),
                    exact: left.exact && right.exact,
                })
                : { lo: Math.min(...quotients), hi: Math.max(...quotients), exact: left.exact && right.exact };
        }
        case "total_mod": {
            const right = comparisonInterval(expr.right, env);
            if (right.lo >= 1) {
                return { lo: 0, hi: Math.max(0, right.hi - 1), exact: false };
            }
            return { lo: INT32_MIN, hi: INT32_MAX, exact: false };
        }
        case "nan_to_zero": {
            const inner = comparisonInterval(expr.value, env);
            return { lo: Math.min(0, inner.lo), hi: Math.max(0, inner.hi), exact: inner.exact };
        }
        case "positive_extent":
            return positiveExtentInterval(comparisonInterval(expr.value, env));
        case "clamp_index": {
            const dim = positiveExtentInterval(comparisonInterval(expr.dim, env));
            return { lo: 0, hi: Math.max(0, dim.hi - 1), exact: dim.exact };
        }
        case "read":
            return expr.valueType === "int"
                ? { lo: INT32_MIN, hi: INT32_MAX, exact: false }
                : { lo: -Infinity, hi: Infinity, exact: false };
        case "call":
            if (expr.interpreted) {
                if ((expr.name === "max" || expr.name === "min") && expr.args.length === 2) {
                    const left = comparisonInterval(expr.args[0], env);
                    const right = comparisonInterval(expr.args[1], env);
                    return expr.name === "max"
                        ? {
                            lo: Math.max(left.lo, right.lo),
                            hi: Math.max(left.hi, right.hi),
                            exact: left.exact && right.exact,
                        }
                        : {
                            lo: Math.min(left.lo, right.lo),
                            hi: Math.min(left.hi, right.hi),
                            exact: left.exact && right.exact,
                        };
                }
                if (expr.name === "clamp" && expr.args.length === 3) {
                    const value = comparisonInterval(expr.args[0], env);
                    const lo = comparisonInterval(expr.args[1], env);
                    const hi = comparisonInterval(expr.args[2], env);
                    return {
                        lo: Math.max(value.lo, lo.lo),
                        hi: Math.min(value.hi, hi.hi),
                        exact: value.exact && lo.exact && hi.exact,
                    };
                }
                if (expr.name === "abs" && expr.args.length === 1) {
                    const inner = comparisonInterval(expr.args[0], env);
                    return inner.lo >= 0
                        ? inner
                        : inner.hi <= 0
                            ? { lo: -inner.hi, hi: -inner.lo, exact: inner.exact }
                            : { lo: 0, hi: Math.max(-inner.lo, inner.hi), exact: inner.exact };
                }
                if (expr.name === "to_float" && expr.args.length === 1) {
                    return comparisonInterval(expr.args[0], env);
                }
            }
            return expr.valueType === "int"
                ? { lo: INT32_MIN, hi: INT32_MAX, exact: false }
                : { lo: -Infinity, hi: Infinity, exact: false };
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function comparisonIntBinop(op, left, right, unsaturated) {
    if (op === "/") {
        if (right.lo <= 0 && right.hi >= 0) {
            return { lo: INT32_MIN, hi: INT32_MAX, exact: false };
        }
        const quotients = [
            Math.trunc(left.lo / right.lo),
            Math.trunc(left.lo / right.hi),
            Math.trunc(left.hi / right.lo),
            Math.trunc(left.hi / right.hi),
        ];
        return clampIntInterval({
            lo: Math.min(...quotients),
            hi: Math.max(...quotients),
            exact: left.exact && right.exact,
        });
    }
    if (op === "%") {
        if (right.lo >= 1) {
            return { lo: 0, hi: Math.max(0, right.hi - 1), exact: false };
        }
        return { lo: INT32_MIN, hi: INT32_MAX, exact: false };
    }
    const raw = op === "+"
        ? { lo: left.lo + right.lo, hi: left.hi + right.hi }
        : op === "-"
            ? { lo: left.lo - right.hi, hi: left.hi - right.lo }
            : mulInterval(left, right);
    const exact = left.exact && right.exact && raw.lo >= INT32_MIN && raw.hi <= INT32_MAX;
    return unsaturated
        ? clampIntInterval({ lo: raw.lo, hi: raw.hi, exact })
        : clampIntInterval({ lo: raw.lo, hi: raw.hi, exact });
}
function comparisonFloatBinop(op, left, right) {
    if (op === "+") {
        return { lo: left.lo + right.lo, hi: left.hi + right.hi, exact: left.exact && right.exact };
    }
    if (op === "-") {
        return { lo: left.lo - right.hi, hi: left.hi - right.lo, exact: left.exact && right.exact };
    }
    if (op === "*") {
        const raw = mulInterval(left, right);
        return { lo: raw.lo, hi: raw.hi, exact: left.exact && right.exact };
    }
    return { lo: -Infinity, hi: Infinity, exact: false };
}
function positiveExtentInterval(value) {
    if (value.lo >= 1) {
        return value;
    }
    if (value.hi <= 0) {
        return { lo: 1, hi: 1, exact: true };
    }
    return { lo: 1, hi: Math.max(1, value.hi), exact: false };
}
function clampIntInterval(value) {
    return {
        lo: Math.max(INT32_MIN, Math.min(INT32_MAX, Math.trunc(value.lo))),
        hi: Math.max(INT32_MIN, Math.min(INT32_MAX, Math.trunc(value.hi))),
        exact: value.exact,
    };
}
function mulInterval(left, right) {
    const products = [
        left.lo * right.lo,
        left.lo * right.hi,
        left.hi * right.lo,
        left.hi * right.hi,
    ];
    return {
        lo: Math.min(...products),
        hi: Math.max(...products),
    };
}
function canProvePositive(expr, env) {
    return comparisonInterval(expr, env).lo >= 1;
}
function canProveInRange(index, dim, env) {
    if (canProveRemainderBounds(index, dim, env)) {
        return true;
    }
    const indexInterval = comparisonInterval(index, env);
    const dimInterval = positiveExtentInterval(comparisonInterval(dim, env));
    if (indexInterval.lo >= 0 && indexInterval.hi < dimInterval.lo) {
        return true;
    }
    for (const factorization of factorProduct(dim, env)) {
        const affine = matchAffineDivMod(index, factorization.factor, env);
        if (!affine) {
            continue;
        }
        if (canProveInRange(affine.quotient, factorization.multiplier, env)
            && canProveRemainderBounds(affine.remainder, factorization.factor, env)) {
            return true;
        }
    }
    return false;
}
function canProveRemainderBounds(remainder, divisor, env) {
    if (divisor.tag === "positive_extent" && canProvePositive(divisor.value, env)) {
        return canProveRemainderBounds(remainder, divisor.value, env);
    }
    if (remainder.tag === "var") {
        const interval = env.get(remainder.name);
        if (interval?.boundBy && sameScalarExprWithPositiveExtent(interval.boundBy, divisor, env)) {
            return true;
        }
    }
    if ((remainder.tag === "total_mod" || remainder.tag === "clamp_index")
        && sameScalarExprWithPositiveExtent(remainder.tag === "total_mod" ? remainder.right : remainder.dim, divisor, env)) {
        return true;
    }
    const remainderInterval = comparisonInterval(remainder, env);
    const divisorInterval = comparisonInterval(divisor, env);
    return remainderInterval.lo >= 0 && divisorInterval.lo >= 1 && remainderInterval.hi < divisorInterval.lo;
}
function canProveWithinBounds(value, lo, hi, env) {
    const valueInterval = comparisonInterval(value, env);
    const loInterval = comparisonInterval(lo, env);
    const hiInterval = comparisonInterval(hi, env);
    return valueInterval.lo >= loInterval.hi && valueInterval.hi <= hiInterval.lo;
}
function factorProduct(expr, env) {
    if (expr.tag === "positive_extent" && canProvePositive(expr.value, env)) {
        return factorProduct(expr.value, env);
    }
    if ((expr.tag === "binop" && expr.op === "*") || expr.tag === "sat_mul") {
        return [
            { multiplier: expr.left, factor: expr.right },
            { multiplier: expr.right, factor: expr.left },
        ];
    }
    return [];
}
function matchAffineDivMod(left, right, env) {
    if (!canProvePositive(right, env)) {
        return null;
    }
    const additive = left.tag === "sat_add" || (left.tag === "binop" && left.op === "+")
        ? left
        : null;
    if (!additive) {
        return null;
    }
    const candidates = [
        { mul: additive.left, remainder: additive.right },
        { mul: additive.right, remainder: additive.left },
    ];
    for (const candidate of candidates) {
        const multiplicative = candidate.mul.tag === "sat_mul"
            || (candidate.mul.tag === "binop" && candidate.mul.op === "*")
            ? candidate.mul
            : null;
        if (!multiplicative) {
            continue;
        }
        let quotient = null;
        if (scalarComparisonKey(multiplicative.left) === scalarComparisonKey(right)
            || sameScalarExprWithPositiveExtent(multiplicative.left, right, env)) {
            quotient = multiplicative.right;
        }
        else if (scalarComparisonKey(multiplicative.right) === scalarComparisonKey(right)
            || sameScalarExprWithPositiveExtent(multiplicative.right, right, env)) {
            quotient = multiplicative.left;
        }
        if (!quotient) {
            continue;
        }
        if (!canProveRemainderBounds(candidate.remainder, right, env)) {
            continue;
        }
        const mulIntervalValue = comparisonInterval(candidate.mul, env);
        const addIntervalValue = comparisonInterval(left, env);
        if (mulIntervalValue.lo < INT32_MIN || mulIntervalValue.hi > INT32_MAX) {
            continue;
        }
        if (addIntervalValue.lo < INT32_MIN || addIntervalValue.hi > INT32_MAX) {
            continue;
        }
        return { quotient, remainder: candidate.remainder };
    }
    return null;
}
function constantFoldScalar(expr) {
    switch (expr.tag) {
        case "positive_extent": {
            const value = constantIntValue(expr.value);
            if (value === null) {
                return expr;
            }
            return { tag: "int_lit", value: Math.max(1, value) };
        }
        case "clamp_index": {
            const index = constantIntValue(expr.index);
            const dim = constantIntValue(expr.dim);
            if (index === null || dim === null) {
                return expr;
            }
            const upper = Math.max(0, Math.max(1, dim) - 1);
            return { tag: "int_lit", value: Math.max(0, Math.min(upper, index)) };
        }
        case "total_div": {
            const left = constantIntValue(expr.left);
            const right = constantIntValue(expr.right);
            if (left === null || right === null) {
                return expr;
            }
            return { tag: "int_lit", value: right === 0 ? 0 : Math.trunc(left / right) };
        }
        case "total_mod": {
            const left = constantIntValue(expr.left);
            const right = constantIntValue(expr.right);
            if (left === null || right === null) {
                return expr;
            }
            if (right === 0) {
                return { tag: "int_lit", value: 0 };
            }
            const quotient = Math.trunc(left / right);
            return { tag: "int_lit", value: left - right * quotient };
        }
        default:
            return expr;
    }
}
function sameScalarExpr(left, right) {
    return scalarComparisonKey(left) === scalarComparisonKey(right);
}
function sameScalarExprWithPositiveExtent(left, right, env) {
    if (sameScalarExpr(left, right)) {
        return true;
    }
    if (left.tag === "positive_extent" && sameScalarExpr(left.value, right) && canProvePositive(right, env)) {
        return true;
    }
    if (right.tag === "positive_extent" && sameScalarExpr(left, right.value) && canProvePositive(left, env)) {
        return true;
    }
    return false;
}
function scalarTypeToType(tag) {
    return tag === "int" ? { tag: "int" } : { tag: "float" };
}
export function appendScalarTypeConstraints(lines, symbol, type) {
    const tag = scalarTag(type);
    if (!tag) {
        return;
    }
    const safe = sanitize(symbol);
    if (tag === "int") {
        lines.push(`(assert (<= ${INT32_MIN} ${safe}))`);
        lines.push(`(assert (<= ${safe} ${INT32_MAX}))`);
    }
    const bounds = getScalarBounds(type);
    if (!bounds) {
        return;
    }
    if (bounds.lo !== null) {
        lines.push(`(assert (<= ${literalScalarSmt(tag, bounds.lo)} ${safe}))`);
    }
    if (bounds.hi !== null) {
        lines.push(`(assert (<= ${safe} ${literalScalarSmt(tag, bounds.hi)}))`);
    }
}
export function arrayLeafType(type) {
    return type.tag === "array" ? type.element : type;
}
function literalScalar(tag, value) {
    return tag === "int"
        ? { tag: "int_lit", value: Math.trunc(value) }
        : { tag: "float_lit", value };
}
function literalScalarSmt(tag, value) {
    return tag === "int" ? `${Math.trunc(value)}` : realLiteral(value);
}
export function scalarExprType(expr) {
    switch (expr.tag) {
        case "int_lit":
            return "int";
        case "float_lit":
            return "float";
        case "sum":
        case "select":
            return expr.valueType;
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "sat_neg":
            return "int";
        case "nan_to_zero":
            return scalarExprType(expr.value);
        case "positive_extent":
        case "clamp_index":
            return "int";
        default:
            return expr.valueType;
    }
}
export function isInterpretedCall(name, arity) {
    if (name === "max" || name === "min") {
        return arity === 2;
    }
    if (name === "abs" || name === "to_float" || name === "to_int") {
        return arity === 1;
    }
    if (name === "clamp") {
        return arity === 3;
    }
    return false;
}
export function canEncodeScalarExprWithSmt(expr) {
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
        case "var":
            return true;
        case "unop":
            return canEncodeScalarExprWithSmt(expr.operand);
        case "binop":
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            return canEncodeScalarExprWithSmt(expr.left) && canEncodeScalarExprWithSmt(expr.right);
        case "sat_neg":
            return canEncodeScalarExprWithSmt(expr.operand);
        case "nan_to_zero":
            return canEncodeScalarExprWithSmt(expr.value);
        case "positive_extent":
            return canEncodeScalarExprWithSmt(expr.value);
        case "clamp_index":
            return canEncodeScalarExprWithSmt(expr.index) && canEncodeScalarExprWithSmt(expr.dim);
        case "read":
            return expr.indices.every(canEncodeScalarExprWithSmt) && canEncodeArrayWithSmt(expr.array);
        case "call":
            return expr.args.every(canEncodeScalarExprWithSmt);
        case "select":
            return canEncodeScalarExprWithSmt(expr.index) && expr.cases.every(canEncodeScalarExprWithSmt);
        case "sum":
            return expr.bindings.every((binding) => canEncodeScalarExprWithSmt(binding.extent))
                && canEncodeScalarExprWithSmt(expr.body);
    }
}
export function canEncodeValueWithSmt(value) {
    switch (value.kind) {
        case "scalar":
            return canEncodeScalarExprWithSmt(value.expr);
        case "array":
            return canEncodeArrayWithSmt(value.array);
        case "struct":
            return value.fields.every((field) => canEncodeValueWithSmt(field.value));
        case "void":
            return true;
        case "opaque":
            return false;
    }
}
export function canEncodeArrayWithSmt(array) {
    switch (array.tag) {
        case "param":
            return array.dims.every(canEncodeScalarExprWithSmt) && canEncodeLeafModelWithSmt(array.leafModel);
        case "abstract":
            return array.args.every(canEncodeScalarExprWithSmt)
                && array.dims.every(canEncodeScalarExprWithSmt)
                && canEncodeLeafModelWithSmt(array.leafModel);
        case "comprehension":
            return array.bindings.every((binding) => canEncodeScalarExprWithSmt(binding.extent))
                && canEncodeValueWithSmt(array.body);
        case "literal":
            return array.elements.every(canEncodeValueWithSmt);
        case "choice":
            return canEncodeScalarExprWithSmt(array.selector) && array.options.every(canEncodeArrayWithSmt);
        case "slice":
            return canEncodeArrayWithSmt(array.base) && array.fixedIndices.every(canEncodeScalarExprWithSmt);
    }
}
function canEncodeLeafModelWithSmt(model) {
    switch (model.kind) {
        case "scalar":
            return true;
        case "struct":
            return model.fields.every((field) => canEncodeLeafModelWithSmt(field.model));
        case "opaque":
            return false;
    }
}
export function symbolizeArrayParam(param, callSigs, structDefs = new Map()) {
    return buildParamArrayValue(param.name, param.type, callSigs, structDefs);
}
function buildParamArrayValue(name, type, callSigs, structDefs) {
    if (type.tag !== "array") {
        throw new Error(`Expected array param, got ${type.tag}`);
    }
    const dims = new Array(type.dims).fill(null).map((_, index) => ({
        tag: "var",
        name: `jplmm_dim_${name}_${index}`,
        valueType: "int",
    }));
    const leaf = arrayLeafType(type);
    return {
        tag: "param",
        name,
        arrayType: type,
        dims,
        leafType: leaf,
        leafModel: buildLeafModel(leaf, `jplmm_${name}`, [], type.dims, callSigs, structDefs),
    };
}
export function symbolizeParamValue(param, callSigs, structDefs = new Map()) {
    return buildParamValue(param.type, param.name, callSigs, structDefs);
}
export function symbolizeAbstractValue(type, baseName, args, callSigs, structDefs = new Map()) {
    return buildAbstractValue(type, baseName, args, callSigs, structDefs);
}
function buildParamValue(type, baseName, callSigs, structDefs) {
    const scalar = scalarTag(type);
    if (scalar) {
        return {
            kind: "scalar",
            expr: {
                tag: "var",
                name: baseName,
                valueType: scalar,
            },
        };
    }
    if (type.tag === "array") {
        return {
            kind: "array",
            array: buildParamArrayValue(baseName, type, callSigs, structDefs),
        };
    }
    if (type.tag === "named") {
        return symbolizeStructParam(type, baseName, callSigs, structDefs);
    }
    if (type.tag === "void") {
        return { kind: "void", type };
    }
    return makeOpaque(type, baseName, "scalar:buildParamValue:fallback");
}
function buildAbstractValue(type, baseName, args, callSigs, structDefs) {
    const scalar = scalarTag(type);
    if (scalar) {
        const argTypes = args.map((arg) => scalarExprType(arg));
        callSigs.set(baseName, { args: argTypes, ret: scalar });
        return {
            kind: "scalar",
            expr: {
                tag: "call",
                name: baseName,
                args,
                valueType: scalar,
                interpreted: false,
            },
        };
    }
    if (type.tag === "array") {
        return {
            kind: "array",
            array: buildAbstractArrayValue(baseName, type, args, callSigs, structDefs),
        };
    }
    if (type.tag === "named") {
        const fields = lookupStructFields(type.name, structDefs);
        if (!fields) {
            return makeOpaque(type, baseName, "scalar:buildAbstractValue:struct_lookup");
        }
        return {
            kind: "struct",
            typeName: type.name,
            fields: fields.map((field) => ({
                name: field.name,
                type: field.type,
                value: buildAbstractValue(field.type, `${baseName}.${field.name}`, args, callSigs, structDefs),
            })),
        };
    }
    if (type.tag === "void") {
        return { kind: "void", type };
    }
    return makeOpaque(type, baseName, "scalar:buildAbstractValue:fallback");
}
function buildAbstractArrayValue(name, type, args, callSigs, structDefs) {
    const argTypes = args.map((arg) => scalarExprType(arg));
    const dims = new Array(type.dims).fill(null).map((_, index) => {
        const dimName = `${name}__dim_${index}`;
        callSigs.set(dimName, { args: argTypes, ret: "int" });
        return {
            tag: "call",
            name: dimName,
            args,
            valueType: "int",
            interpreted: false,
        };
    });
    const leaf = arrayLeafType(type);
    return {
        tag: "abstract",
        name,
        args,
        arrayType: type,
        dims,
        leafType: leaf,
        leafModel: buildLeafModel(leaf, `jplmm_${name}`, argTypes, type.dims, callSigs, structDefs),
    };
}
function symbolizeStructParam(type, baseName, callSigs, structDefs) {
    const fields = lookupStructFields(type.name, structDefs);
    if (!fields) {
        return makeOpaque(type, baseName, "scalar:symbolizeStructParam:struct_lookup");
    }
    return {
        kind: "struct",
        typeName: type.name,
        fields: fields.map((field) => ({
            name: field.name,
            type: field.type,
            value: buildParamValue(field.type, `${baseName}.${field.name}`, callSigs, structDefs),
        })),
    };
}
function buildLeafModel(type, baseName, prefixArgTypes, indexArity, callSigs, structDefs) {
    const scalar = scalarTag(type);
    if (scalar) {
        const readName = `jplmm_read_${baseName}`;
        callSigs.set(readName, { args: [...prefixArgTypes, ...new Array(indexArity).fill("int")], ret: scalar });
        return {
            kind: "scalar",
            type,
            readName,
        };
    }
    if (type.tag === "named") {
        const fields = lookupStructFields(type.name, structDefs);
        if (!fields) {
            noteOpaque("scalar:buildLeafModel:struct_lookup", baseName);
            return { kind: "opaque", type, label: baseName };
        }
        return {
            kind: "struct",
            typeName: type.name,
            fields: fields.map((field) => ({
                name: field.name,
                type: field.type,
                model: buildLeafModel(field.type, `${baseName}.${field.name}`, prefixArgTypes, indexArity, callSigs, structDefs),
            })),
        };
    }
    noteOpaque("scalar:buildLeafModel:fallback", baseName);
    return { kind: "opaque", type, label: baseName };
}
export function isSupportedRecArgValue(type, value, current) {
    if (scalarTag(type)) {
        return value.kind === "scalar";
    }
    if (type.tag === "array") {
        return value.kind === "array";
    }
    if (type.tag === "named") {
        return value.kind === "struct" && current?.kind === "struct" && value.typeName === current.typeName;
    }
    if (type.tag === "void") {
        return value.kind === "void";
    }
    return value.kind === "opaque" && current?.kind === "opaque" && current.label === value.label;
}
export function readSymbolicArray(array, indices, resultType, stmtIndex, nodeId) {
    switch (array.tag) {
        case "slice":
            return readSymbolicArray(array.base, [...array.fixedIndices, ...indices], resultType, stmtIndex, nodeId);
        case "param":
            if (resultType.tag === "array") {
                return {
                    kind: "array",
                    array: {
                        tag: "slice",
                        base: array,
                        fixedIndices: indices,
                        arrayType: resultType,
                    },
                };
            }
            if (scalarTag(resultType) && array.leafModel.kind === "scalar" && scalarTag(array.leafModel.type) === scalarTag(resultType)) {
                return {
                    kind: "scalar",
                    expr: {
                        tag: "read",
                        array,
                        indices,
                        valueType: scalarTag(resultType),
                    },
                };
            }
            return instantiateLeafRead(array.leafModel, [], indices, array.dims, resultType, stmtIndex, nodeId);
        case "abstract":
            if (resultType.tag === "array") {
                return {
                    kind: "array",
                    array: {
                        tag: "slice",
                        base: array,
                        fixedIndices: indices,
                        arrayType: resultType,
                    },
                };
            }
            if (scalarTag(resultType) && array.leafModel.kind === "scalar" && scalarTag(array.leafModel.type) === scalarTag(resultType)) {
                return {
                    kind: "scalar",
                    expr: {
                        tag: "read",
                        array,
                        indices,
                        valueType: scalarTag(resultType),
                    },
                };
            }
            return instantiateLeafRead(array.leafModel, array.args, indices, array.dims, resultType, stmtIndex, nodeId);
        case "comprehension": {
            if (resultType.tag === "array") {
                return {
                    kind: "array",
                    array: {
                        tag: "slice",
                        base: array,
                        fixedIndices: indices,
                        arrayType: resultType,
                    },
                };
            }
            const consumed = array.bindings.length;
            const bindings = array.bindings.slice(0, consumed);
            const substitution = new Map();
            for (let i = 0; i < bindings.length; i += 1) {
                const binding = bindings[i];
                const index = indices[i];
                if (!index) {
                    return makeOpaque(resultType, `read_${stmtIndex}_${nodeId}`, "scalar:readSymbolicArray:comprehension_missing_index");
                }
                substitution.set(binding.name, {
                    kind: "scalar",
                    expr: {
                        tag: "clamp_index",
                        index,
                        dim: { tag: "positive_extent", value: binding.extent },
                    },
                });
            }
            const reduced = substituteValue(array.body, substitution);
            const remaining = indices.slice(consumed);
            if (remaining.length === 0) {
                return reduced.kind === "opaque" || sameKindForType(reduced, resultType)
                    ? reduced
                    : makeOpaque(resultType, `read_${stmtIndex}_${nodeId}`, "scalar:readSymbolicArray:comprehension_kind_mismatch");
            }
            if (reduced.kind === "array") {
                return readSymbolicArray(reduced.array, remaining, resultType, stmtIndex, nodeId);
            }
            return makeOpaque(resultType, `read_${stmtIndex}_${nodeId}`, "scalar:readSymbolicArray:comprehension_remaining_non_array");
        }
        case "literal":
            return readLiteralArray(array, indices, resultType, stmtIndex, nodeId);
        case "choice": {
            const values = array.options.map((option) => readSymbolicArray(option, indices, resultType, stmtIndex, nodeId));
            return selectValue(array.selector, values, resultType, stmtIndex, nodeId);
        }
    }
}
function instantiateLeafRead(model, prefixArgs, indices, dims, resultType, stmtIndex, nodeId) {
    switch (model.kind) {
        case "scalar":
            if (scalarTag(resultType) !== scalarTag(model.type)) {
                return makeOpaque(resultType, `read_${stmtIndex}_${nodeId}`, "scalar:instantiateLeafRead:scalar_type_mismatch");
            }
            return {
                kind: "scalar",
                expr: {
                    tag: "call",
                    name: model.readName,
                    args: [
                        ...prefixArgs,
                        ...indices.map((index, dim) => ({
                            tag: "clamp_index",
                            index,
                            dim: dims[dim] ?? { tag: "int_lit", value: 1 },
                        })),
                    ],
                    valueType: scalarTag(model.type),
                    interpreted: false,
                },
            };
        case "struct":
            if (resultType.tag !== "named" || resultType.name !== model.typeName) {
                return makeOpaque(resultType, `read_${stmtIndex}_${nodeId}`, "scalar:instantiateLeafRead:struct_type_mismatch");
            }
            return {
                kind: "struct",
                typeName: model.typeName,
                fields: model.fields.map((field) => ({
                    name: field.name,
                    type: field.type,
                    value: instantiateLeafRead(field.model, prefixArgs, indices, dims, field.type, stmtIndex, nodeId),
                })),
            };
        case "opaque":
            return makeOpaque(resultType, model.label, "scalar:instantiateLeafRead:opaque_model");
    }
}
function readLiteralArray(array, indices, resultType, stmtIndex, nodeId) {
    if (indices.length === 0) {
        return { kind: "array", array };
    }
    const selector = clampLiteralIndex(indices[0], array.elements.length);
    const remaining = indices.slice(1);
    if (remaining.length === 0) {
        return selectValue(selector, array.elements, resultType, stmtIndex, nodeId);
    }
    const reads = array.elements.map((element) => {
        if (element.kind !== "array") {
            return makeOpaque(resultType, `literal_read_${stmtIndex}_${nodeId}`, "scalar:readLiteralArray:non_array_element");
        }
        return readSymbolicArray(element.array, remaining, resultType, stmtIndex, nodeId);
    });
    return selectValue(selector, reads, resultType, stmtIndex, nodeId);
}
export function selectValue(selector, cases, resultType, stmtIndex, nodeId) {
    if (cases.length === 0) {
        return makeOpaque(resultType, `select_${stmtIndex}_${nodeId}`, "scalar:selectValue:empty_cases");
    }
    const constantIndex = constantClampedIndex(selector, cases.length);
    if (constantIndex !== null) {
        return cases[constantIndex] ?? makeOpaque(resultType, `select_${stmtIndex}_${nodeId}`, "scalar:selectValue:constant_missing_case");
    }
    if (scalarTag(resultType)) {
        if (cases.every((value) => value.kind === "scalar")) {
            return {
                kind: "scalar",
                expr: {
                    tag: "select",
                    index: selector,
                    cases: cases.map((value) => value.expr),
                    valueType: scalarTag(resultType),
                },
            };
        }
        return makeOpaque(resultType, `select_${stmtIndex}_${nodeId}`, "scalar:selectValue:scalar_case_mismatch");
    }
    if (resultType.tag === "array") {
        if (cases.every((value) => value.kind === "array")) {
            return {
                kind: "array",
                array: {
                    tag: "choice",
                    selector,
                    options: cases.map((value) => value.array),
                    arrayType: resultType,
                },
            };
        }
        return makeOpaque(resultType, `select_${stmtIndex}_${nodeId}`, "scalar:selectValue:array_case_mismatch");
    }
    if (resultType.tag === "named") {
        if (!cases.every((value) => value.kind === "struct" && value.typeName === resultType.name)) {
            return makeOpaque(resultType, `select_${stmtIndex}_${nodeId}`, "scalar:selectValue:struct_case_mismatch");
        }
        const fields = cases[0].fields;
        return {
            kind: "struct",
            typeName: resultType.name,
            fields: fields.map((field, fieldIndex) => ({
                name: field.name,
                type: field.type,
                value: selectValue(selector, cases.map((value) => value.fields[fieldIndex].value), field.type, stmtIndex, nodeId),
            })),
        };
    }
    if (resultType.tag === "void") {
        return { kind: "void", type: resultType };
    }
    return makeOpaque(resultType, `select_${stmtIndex}_${nodeId}`, "scalar:selectValue:fallback");
}
function clampLiteralIndex(index, length) {
    return {
        tag: "clamp_index",
        index,
        dim: { tag: "int_lit", value: Math.max(1, length) },
    };
}
function constantClampedIndex(index, length) {
    if (index.tag === "int_lit") {
        if (length <= 1) {
            return 0;
        }
        if (index.value < 0) {
            return 0;
        }
        if (index.value >= length) {
            return length - 1;
        }
        return index.value;
    }
    if (index.tag === "clamp_index") {
        return constantClampedIndex(index.index, length);
    }
    return null;
}
export function sameKindForType(value, type) {
    if (value.kind === "scalar") {
        return scalarTag(type) === scalarExprType(value.expr);
    }
    if (value.kind === "array") {
        return type.tag === "array";
    }
    if (value.kind === "struct") {
        return type.tag === "named" && value.typeName === type.name;
    }
    if (value.kind === "void") {
        return type.tag === "void";
    }
    return true;
}
export function substituteValue(expr, substitution) {
    switch (expr.kind) {
        case "scalar":
            return { kind: "scalar", expr: substituteScalar(expr.expr, substitution) };
        case "array":
            return { kind: "array", array: substituteArray(expr.array, substitution) };
        case "struct":
            return {
                kind: "struct",
                typeName: expr.typeName,
                fields: expr.fields.map((field) => ({
                    ...field,
                    value: substituteValue(field.value, substitution),
                })),
            };
        case "void":
            return expr;
        case "opaque":
            return expr;
    }
}
export function substituteArray(array, substitution) {
    switch (array.tag) {
        case "param": {
            const replacement = substitution.get(array.name);
            if (replacement?.kind === "array") {
                return replacement.array;
            }
            return {
                ...array,
                dims: array.dims.map((dim) => substituteScalar(dim, substitution)),
            };
        }
        case "abstract":
            return {
                ...array,
                args: array.args.map((arg) => substituteScalar(arg, substitution)),
                dims: array.dims.map((dim) => substituteScalar(dim, substitution)),
            };
        case "slice":
            return {
                ...array,
                base: substituteArray(array.base, substitution),
                fixedIndices: array.fixedIndices.map((index) => substituteScalar(index, substitution)),
            };
        case "literal":
            return {
                ...array,
                elements: array.elements.map((element) => substituteValue(element, substitution)),
            };
        case "choice":
            return {
                ...array,
                selector: substituteScalar(array.selector, substitution),
                options: array.options.map((option) => substituteArray(option, substitution)),
            };
        case "comprehension": {
            const shadowed = new Map(substitution);
            for (const binding of array.bindings) {
                shadowed.delete(binding.name);
            }
            return {
                ...array,
                bindings: array.bindings.map((binding) => ({
                    name: binding.name,
                    extent: substituteScalar(binding.extent, substitution),
                })),
                body: substituteValue(array.body, shadowed),
            };
        }
    }
}
export function substituteScalar(expr, substitution) {
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
            return expr;
        case "var": {
            const replacement = substitution.get(expr.name);
            return replacement?.kind === "scalar" ? replacement.expr : expr;
        }
        case "unop":
            return {
                tag: "unop",
                op: expr.op,
                operand: substituteScalar(expr.operand, substitution),
                valueType: expr.valueType,
            };
        case "select":
            return {
                tag: "select",
                index: substituteScalar(expr.index, substitution),
                cases: expr.cases.map((value) => substituteScalar(value, substitution)),
                valueType: expr.valueType,
            };
        case "sum": {
            const shadowed = new Map(substitution);
            for (const binding of expr.bindings) {
                shadowed.delete(binding.name);
            }
            return {
                tag: "sum",
                bindings: expr.bindings.map((binding) => ({
                    name: binding.name,
                    extent: substituteScalar(binding.extent, substitution),
                })),
                body: substituteScalar(expr.body, shadowed),
                valueType: expr.valueType,
            };
        }
        case "binop":
            return {
                tag: "binop",
                op: expr.op,
                left: substituteScalar(expr.left, substitution),
                right: substituteScalar(expr.right, substitution),
                valueType: expr.valueType,
            };
        case "total_div":
        case "total_mod":
            return {
                tag: expr.tag,
                left: substituteScalar(expr.left, substitution),
                right: substituteScalar(expr.right, substitution),
                valueType: expr.valueType,
            };
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
            return {
                tag: expr.tag,
                left: substituteScalar(expr.left, substitution),
                right: substituteScalar(expr.right, substitution),
            };
        case "sat_neg":
            return {
                tag: "sat_neg",
                operand: substituteScalar(expr.operand, substitution),
            };
        case "nan_to_zero":
            return {
                tag: "nan_to_zero",
                value: substituteScalar(expr.value, substitution),
            };
        case "positive_extent":
            return { tag: "positive_extent", value: substituteScalar(expr.value, substitution) };
        case "clamp_index":
            return {
                tag: "clamp_index",
                index: substituteScalar(expr.index, substitution),
                dim: substituteScalar(expr.dim, substitution),
            };
        case "read":
            return {
                tag: "read",
                array: substituteArray(expr.array, substitution),
                indices: expr.indices.map((index) => substituteScalar(index, substitution)),
                valueType: expr.valueType,
            };
        case "call":
            return {
                tag: "call",
                name: expr.name,
                args: expr.args.map((arg) => substituteScalar(arg, substitution)),
                valueType: expr.valueType,
                interpreted: expr.interpreted,
            };
    }
}
export function buildMeasureCounterexampleQuery(params, currentMeasure, nextMeasure, substitution, callSigs, currentValues, collapseCondition = null) {
    if (!canEncodeScalarExprWithSmt(currentMeasure) || !canEncodeScalarExprWithSmt(nextMeasure)) {
        return {
            ok: false,
            reason: "current refinement proof backend cannot encode this rad expression in SMT yet",
        };
    }
    const vars = new Map();
    collectVars(currentMeasure, vars);
    collectVars(nextMeasure, vars);
    for (const value of substitution.values()) {
        collectValueVars(value, vars);
    }
    const smtState = createSmtEncodingState();
    const smtOverrides = { smt: smtState };
    const preconditions = [];
    const preconditionFailures = [];
    for (let i = 0; i < params.length; i += 1) {
        const param = params[i];
        const next = substitution.get(param.name);
        if (!next) {
            continue;
        }
        const current = currentValues.get(param.name) ?? symbolizeCurrentParamValue(param);
        collectValueVars(current, vars);
        const change = emitValueChange(current, next, param.type, smtOverrides);
        if (change) {
            preconditions.push(change);
            continue;
        }
        preconditionFailures.push(`could not encode non-collapse guard for '${param.name}'`);
    }
    if (preconditions.length === 0 && !collapseCondition) {
        return {
            ok: false,
            reason: preconditionFailures[0]
                ?? "no symbolizable recursive argument change was available for the SMT rad proof",
        };
    }
    const lines = buildJplScalarPrelude();
    for (const [name, sig] of callSigs) {
        const domain = sig.args.map((arg) => (arg === "int" ? "Int" : "Real")).join(" ");
        const sort = sig.ret === "int" ? "Int" : "Real";
        lines.push(`(declare-fun ${sanitize(name)} (${domain}) ${sort})`);
    }
    for (const [name, tag] of vars) {
        lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
        const paramType = params.find((param) => param.name === name)?.type;
        if (paramType) {
            appendScalarTypeConstraints(lines, name, paramType);
        }
        else if (tag === "int") {
            lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
            lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
        }
    }
    const decrease = strictDecrease(currentMeasure, nextMeasure, smtOverrides);
    const querySymbols = [];
    for (const param of params) {
        const tag = scalarTag(param.type);
        if (!tag) {
            continue;
        }
        querySymbols.push({
            symbol: sanitize(param.name),
            label: param.name,
        });
    }
    const nextDefinitions = [];
    for (const param of params) {
        const tag = scalarTag(param.type);
        const next = substitution.get(param.name);
        if (!tag || !next || next.kind !== "scalar") {
            continue;
        }
        const nextSymbol = `jplmm_next_${sanitize(param.name)}`;
        nextDefinitions.push(`(define-fun ${nextSymbol} () ${tag === "int" ? "Int" : "Real"} ${emitScalarWithOverrides(normalizeScalarExprForType(next.expr, param.type), smtOverrides)})`);
        querySymbols.push({
            symbol: nextSymbol,
            label: `next ${param.name}`,
        });
    }
    const measureSort = scalarExprType(currentMeasure) === "int" ? "Int" : "Real";
    const currentMeasureDef = `(define-fun jplmm_abs_current_measure () ${measureSort} ${emitAbsoluteMeasure(currentMeasure, smtOverrides)})`;
    const nextMeasureDef = `(define-fun jplmm_abs_next_measure () ${measureSort} ${emitAbsoluteMeasure(nextMeasure, smtOverrides)})`;
    querySymbols.push({ symbol: "jplmm_abs_current_measure", label: "|rad| current" }, { symbol: "jplmm_abs_next_measure", label: "|rad| next" });
    appendSmtEncodingState(lines, smtState);
    lines.push(...nextDefinitions);
    lines.push(currentMeasureDef);
    lines.push(nextMeasureDef);
    if (collapseCondition) {
        lines.push(`(assert (not ${collapseCondition}))`);
    }
    else {
        lines.push(`(assert (or ${preconditions.join(" ")}))`);
    }
    lines.push(`(assert (not ${decrease}))`);
    return {
        ok: true,
        query: {
            baseLines: lines,
            querySymbols,
        },
    };
}
export function symbolizeCurrentParamValue(param) {
    return symbolizeParamValue(param, new Map(), new Map());
}
export function emitValueChange(current, next, type, overrides = {}) {
    const equality = emitValueEquality(current, next, type, overrides);
    return equality ? `(not ${equality})` : null;
}
export function emitValueEquality(current, next, type, overrides = {}) {
    if (scalarTag(type)) {
        if (current.kind !== "scalar" || next.kind !== "scalar") {
            return null;
        }
        if (!canEncodeScalarExprWithSmt(current.expr) || !canEncodeScalarExprWithSmt(next.expr)) {
            return null;
        }
        return `(= ${emitScalarWithOverrides(normalizeScalarExprForType(current.expr, type), overrides)} ${emitScalarWithOverrides(normalizeScalarExprForType(next.expr, type), overrides)})`;
    }
    if (type.tag === "array") {
        if (current.kind !== "array" || next.kind !== "array") {
            return null;
        }
        return emitArrayEquality(current.array, next.array, overrides);
    }
    if (type.tag === "named") {
        if (current.kind !== "struct" || next.kind !== "struct" || current.typeName !== type.name || next.typeName !== type.name) {
            return null;
        }
        if (current.fields.length !== next.fields.length) {
            return null;
        }
        const clauses = current.fields.map((field, index) => {
            const right = next.fields[index];
            if (!right || right.name !== field.name) {
                return null;
            }
            return emitValueEquality(field.value, right.value, field.type, overrides);
        });
        if (clauses.some((clause) => clause === null)) {
            return null;
        }
        if (clauses.length === 0) {
            return "true";
        }
        return clauses.length === 1 ? clauses[0] : `(and ${clauses.join(" ")})`;
    }
    if (type.tag === "void") {
        return current.kind === "void" && next.kind === "void" ? "true" : null;
    }
    if (current.kind === "opaque" && next.kind === "opaque" && current.label === next.label) {
        return "true";
    }
    return null;
}
export function emitArrayEquality(left, right, overrides = {}) {
    const leftDims = arrayDims(left);
    const rightDims = arrayDims(right);
    if (!leftDims || !rightDims || leftDims.length !== rightDims.length) {
        return null;
    }
    const leftType = resolveArrayType(left);
    const rightType = resolveArrayType(right);
    if (leftType.tag !== "array" || rightType.tag !== "array" || !sameType(leftType.element, rightType.element)) {
        return null;
    }
    const dimEqualities = leftDims.map((dim, index) => `(= ${emitScalarWithOverrides(dim, overrides)} ${emitScalarWithOverrides(rightDims[index], overrides)})`);
    const prefix = dimEqualities.length === 0 ? "true" : dimEqualities.length === 1 ? dimEqualities[0] : `(and ${dimEqualities.join(" ")})`;
    const counter = arrayEqCounter;
    arrayEqCounter += 1;
    const binders = leftDims.map((_, index) => `(${`jplmm_idx_${counter}_${index}`} Int)`);
    const idxExprs = leftDims.map((_, index) => ({
        tag: "var",
        name: `jplmm_idx_${counter}_${index}`,
        valueType: "int",
    }));
    const ranges = leftDims.map((dim, index) => {
        const name = sanitize(`jplmm_idx_${counter}_${index}`);
        return `(and (<= 0 ${name}) (< ${name} ${emitScalarWithOverrides(dim, overrides)}))`;
    });
    const rangeGuard = ranges.length === 0 ? "true" : ranges.length === 1 ? ranges[0] : `(and ${ranges.join(" ")})`;
    const leftRead = readSymbolicArray(left, idxExprs, leftType.element, -1, -1);
    const rightRead = readSymbolicArray(right, idxExprs, rightType.element, -1, -1);
    const readEquality = emitValueEquality(leftRead, rightRead, leftType.element, overrides);
    if (!readEquality) {
        return null;
    }
    const quantified = `(forall (${binders.join(" ")}) (=> ${rangeGuard} ${readEquality}))`;
    return prefix === "true" ? quantified : `(and ${prefix} ${quantified})`;
}
export function emitLeafArrayRead(array, indices, resultType) {
    const value = readSymbolicArray(array, indices, resultType, -1, -1);
    return value.kind === "scalar" && canEncodeScalarExprWithSmt(value.expr) ? emitScalar(value.expr) : null;
}
export function arrayDims(array) {
    switch (array.tag) {
        case "param":
        case "abstract":
            return array.dims;
        case "slice": {
            const dims = arrayDims(array.base);
            return dims ? dims.slice(array.fixedIndices.length) : null;
        }
        case "comprehension":
            return arrayDimsWithPrefix(array.bindings.map((binding) => ({ tag: "positive_extent", value: binding.extent })), array.body.kind === "array" ? array.body.array : null);
        case "literal":
            return arrayDimsWithPrefix([{ tag: "int_lit", value: Math.max(1, array.elements.length) }], array.elements[0]?.kind === "array" ? array.elements[0].array : null);
        case "choice":
            return array.options[0] ? arrayDims(array.options[0]) : null;
    }
}
export function resolveArrayType(array) {
    switch (array.tag) {
        case "param":
        case "abstract":
        case "comprehension":
        case "literal":
        case "choice":
        case "slice":
            return array.arrayType;
    }
}
export function strictDecrease(currentMeasure, nextMeasure, overrides = {}) {
    if (scalarExprType(currentMeasure) === "int") {
        return `(< (abs_int ${emitScalarWithOverrides(nextMeasure, overrides)}) (abs_int ${emitScalarWithOverrides(currentMeasure, overrides)}))`;
    }
    return `(< (abs_real ${emitScalarWithOverrides(nextMeasure, overrides)}) (abs_real ${emitScalarWithOverrides(currentMeasure, overrides)}))`;
}
export function emitAbsoluteMeasure(expr, overrides = {}) {
    return `(${scalarExprType(expr) === "int" ? "abs_int" : "abs_real"} ${emitScalarWithOverrides(expr, overrides)})`;
}
export function emitScalar(expr) {
    return emitScalarWithOverrides(expr);
}
export function emitScalarWithOverrides(expr, overrides = {}) {
    switch (expr.tag) {
        case "int_lit":
            return `${expr.value}`;
        case "float_lit":
            return realLiteral(expr.value);
        case "var":
            return overrides.onVar?.(expr) ?? sanitize(expr.name);
        case "unop":
            return `(- ${emitScalarWithOverrides(expr.operand, overrides)})`;
        case "select":
            return emitSelect(expr.index, expr.cases, overrides);
        case "positive_extent":
            return `(positive_extent_int ${emitScalarWithOverrides(expr.value, overrides)})`;
        case "clamp_index":
            return `(clamp_index_int ${emitScalarWithOverrides(expr.index, overrides)} ${emitScalarWithOverrides(expr.dim, overrides)})`;
        case "read":
            return emitArrayReadWithOverrides(expr.array, expr.indices, expr.valueType, overrides);
        case "binop":
            if (expr.valueType === "int") {
                if (expr.op === "+")
                    return `(+ ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
                if (expr.op === "-")
                    return `(- ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
                if (expr.op === "*")
                    return `(* ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
                if (expr.op === "/")
                    return `(total_div_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
                return `(total_mod_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
            }
            if (expr.op === "+")
                return `(+ ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
            if (expr.op === "-")
                return `(- ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
            if (expr.op === "*")
                return `(* ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
            if (expr.op === "/")
                return `(total_div_real ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
            return `(- ${emitScalarWithOverrides(expr.left, overrides)} (* ${emitScalarWithOverrides(expr.right, overrides)} (to_real (trunc_real (/ ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})))))`;
        case "sat_add":
            return `(sat_add_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
        case "sat_sub":
            return `(sat_sub_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
        case "sat_mul":
            return `(sat_mul_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
        case "sat_neg":
            return `(sat_neg_int ${emitScalarWithOverrides(expr.operand, overrides)})`;
        case "total_div":
            return expr.valueType === "int"
                ? `(total_div_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`
                : `(total_div_real ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
        case "total_mod":
            return expr.valueType === "int"
                ? `(total_mod_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`
                : `(- ${emitScalarWithOverrides(expr.left, overrides)} (* ${emitScalarWithOverrides(expr.right, overrides)} (to_real (trunc_real (/ ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})))))`;
        case "nan_to_zero":
            return emitScalarWithOverrides(expr.value, overrides);
        case "call": {
            const overridden = overrides.onCall?.(expr);
            if (overridden !== null && overridden !== undefined) {
                return overridden;
            }
            const args = expr.args.map((arg) => emitScalarWithOverrides(arg, overrides)).join(" ");
            if (!expr.interpreted) {
                return expr.args.length === 0 ? sanitize(expr.name) : `(${sanitize(expr.name)} ${args})`;
            }
            switch (expr.name) {
                case "max":
                    return `(${expr.valueType === "int" ? "max_int" : "max_real"} ${args})`;
                case "min":
                    return `(${expr.valueType === "int" ? "min_int" : "min_real"} ${args})`;
                case "abs":
                    return `(${expr.valueType === "int" ? "abs_int" : "abs_real"} ${args})`;
                case "clamp":
                    return `(${expr.valueType === "int" ? "clamp_int" : "clamp_real"} ${args})`;
                case "to_float":
                    return `(to_real ${emitScalarWithOverrides(expr.args[0], overrides)})`;
                case "to_int":
                    return `(to_int_real ${emitScalarWithOverrides(expr.args[0], overrides)})`;
                default:
                    return `(${sanitize(expr.name)} ${args})`;
            }
        }
        case "sum":
            return emitSumWithOverrides(expr, overrides);
    }
}
function emitSumWithOverrides(expr, overrides) {
    const unrolled = tryUnrollSum(expr);
    if (unrolled) {
        return emitScalarWithOverrides(unrolled, overrides);
    }
    if (!overrides.smt) {
        return emitSumSexpr(expr, overrides);
    }
    return emitSumFoldCall(expr, overrides.smt, overrides);
}
function emitSumSexpr(expr, overrides) {
    return sexprForm("sum:fold", sexprForm("bindings", ...expr.bindings.map((binding) => sexprForm(sexprAtom(binding.name), emitScalarWithOverrides(binding.extent, overrides)))), emitScalarWithOverrides(expr.body, overrides));
}
function emitSumFoldCall(expr, state, overrides) {
    if (expr.bindings.length === 0) {
        return emitScalarWithOverrides(expr.body, overrides);
    }
    const freeVars = collectSortedFreeVars(expr);
    const key = [
        expr.valueType,
        renderScalarExpr(expr),
        freeVars.map((entry) => `${entry.name}:${entry.tag}`).join(","),
    ].join("|");
    let helperName = state.sumHelpers.get(key);
    if (!helperName) {
        helperName = `jplmm_sum_${state.nextSumId}`;
        state.nextSumId += 1;
        state.sumHelpers.set(key, helperName);
        const definition = buildSumFoldDefinition(helperName, expr, freeVars, state, overrides);
        state.sumDefinitions.push(definition);
    }
    const helperArgs = ["0", ...freeVars.map((entry) => sanitize(entry.name))];
    return `(${helperName} ${helperArgs.join(" ")})`;
}
function tryUnrollSum(expr, maxTerms = 16) {
    const extents = expr.bindings.map((binding) => constantPositiveExtent(binding.extent));
    if (extents.some((extent) => extent === null)) {
        return null;
    }
    let termCount = 1;
    for (const extent of extents) {
        termCount *= extent;
        if (termCount > maxTerms) {
            return null;
        }
    }
    const terms = [];
    expandSumTerms(expr, 0, new Map(), terms);
    if (terms.length === 0) {
        return expr.valueType === "int" ? { tag: "int_lit", value: 0 } : { tag: "float_lit", value: 0 };
    }
    let acc = terms[0];
    for (let i = 1; i < terms.length; i += 1) {
        acc = expr.valueType === "int"
            ? { tag: "sat_add", left: acc, right: terms[i] }
            : { tag: "binop", op: "+", left: acc, right: terms[i], valueType: "float" };
    }
    return acc;
}
function expandSumTerms(expr, bindingIndex, substitution, out) {
    if (bindingIndex >= expr.bindings.length) {
        out.push(substituteScalar(expr.body, substitution));
        return;
    }
    const binding = expr.bindings[bindingIndex];
    const extent = constantPositiveExtent(binding.extent);
    if (extent === null) {
        return;
    }
    for (let i = 0; i < extent; i += 1) {
        const nextSubstitution = new Map(substitution);
        nextSubstitution.set(binding.name, {
            kind: "scalar",
            expr: { tag: "int_lit", value: i },
        });
        expandSumTerms(expr, bindingIndex + 1, nextSubstitution, out);
    }
}
function constantPositiveExtent(expr) {
    const value = constantIntValue(expr);
    if (value === null) {
        return null;
    }
    return Math.max(1, clampInt32(value));
}
function constantIntValue(expr) {
    switch (expr.tag) {
        case "int_lit":
            return expr.value;
        case "positive_extent":
            return constantPositiveExtent(expr.value);
        case "nan_to_zero":
            return constantIntValue(expr.value);
        case "sat_neg": {
            const operand = constantIntValue(expr.operand);
            return operand === null ? null : clampInt32(-operand);
        }
        case "sat_add":
        case "sat_sub":
        case "sat_mul": {
            const left = constantIntValue(expr.left);
            const right = constantIntValue(expr.right);
            if (left === null || right === null) {
                return null;
            }
            if (expr.tag === "sat_add") {
                return clampInt32(left + right);
            }
            if (expr.tag === "sat_sub") {
                return clampInt32(left - right);
            }
            return clampInt32(left * right);
        }
        case "binop":
            if (expr.valueType !== "int") {
                return null;
            }
            return constantIntBinop(expr.op, expr.left, expr.right);
        case "total_div":
        case "total_mod":
            if (expr.valueType !== "int") {
                return null;
            }
            return constantIntBinop(expr.tag === "total_div" ? "/" : "%", expr.left, expr.right);
        case "call":
            return constantInterpretedIntCall(expr);
        default:
            return null;
    }
}
function constantIntBinop(op, leftExpr, rightExpr) {
    const left = constantIntValue(leftExpr);
    const right = constantIntValue(rightExpr);
    if (left === null || right === null) {
        return null;
    }
    if (op === "+") {
        return clampInt32(left + right);
    }
    if (op === "-") {
        return clampInt32(left - right);
    }
    if (op === "*") {
        return clampInt32(left * right);
    }
    if (right === 0) {
        return 0;
    }
    const quotient = Math.trunc(left / right);
    if (op === "/") {
        return clampInt32(quotient);
    }
    return clampInt32(left - right * quotient);
}
function constantInterpretedIntCall(expr) {
    if (!expr.interpreted) {
        return null;
    }
    if (expr.name === "abs" && expr.args.length === 1) {
        const value = constantIntValue(expr.args[0]);
        return value === null ? null : Math.abs(value);
    }
    if ((expr.name === "max" || expr.name === "min") && expr.args.length === 2) {
        const left = constantIntValue(expr.args[0]);
        const right = constantIntValue(expr.args[1]);
        if (left === null || right === null) {
            return null;
        }
        return expr.name === "max" ? Math.max(left, right) : Math.min(left, right);
    }
    if (expr.name === "clamp" && expr.args.length === 3) {
        const value = constantIntValue(expr.args[0]);
        const lo = constantIntValue(expr.args[1]);
        const hi = constantIntValue(expr.args[2]);
        if (value === null || lo === null || hi === null) {
            return null;
        }
        return Math.min(Math.max(value, lo), hi);
    }
    if (expr.name === "to_int" && expr.args.length === 1) {
        return null;
    }
    return null;
}
function clampInt32(value) {
    if (value < INT32_MIN) {
        return INT32_MIN;
    }
    if (value > INT32_MAX) {
        return INT32_MAX;
    }
    return Math.trunc(value);
}
function collectSortedFreeVars(expr) {
    const vars = new Map();
    collectVars(expr, vars);
    return [...vars.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, tag]) => ({ name, tag }));
}
function buildSumFoldDefinition(helperName, expr, freeVars, state, overrides) {
    const [binding, ...restBindings] = expr.bindings;
    if (!binding) {
        return `(define-fun ${helperName} () ${scalarSort(expr.valueType)} ${emitScalarWithOverrides(expr.body, overrides)})`;
    }
    const indexName = `${helperName}__idx`;
    const indexExpr = {
        tag: "var",
        name: indexName,
        valueType: "int",
    };
    const bindingSubstitution = new Map([
        [binding.name, { kind: "scalar", expr: indexExpr }],
    ]);
    const termExpr = restBindings.length === 0
        ? substituteScalar(expr.body, bindingSubstitution)
        : substituteScalar({
            tag: "sum",
            bindings: restBindings,
            body: expr.body,
            valueType: expr.valueType,
        }, bindingSubstitution);
    const bodyTerm = emitScalarWithOverrides(termExpr, {
        ...overrides,
        smt: state,
    });
    const recursiveCall = `(${helperName} ${[`(+ ${sanitize(indexName)} 1)`, ...freeVars.map((entry) => sanitize(entry.name))].join(" ")})`;
    const limit = `(positive_extent_int ${emitScalarWithOverrides(binding.extent, { ...overrides, smt: state })})`;
    const zero = expr.valueType === "int" ? "0" : "0.0";
    const folded = expr.valueType === "int"
        ? `(sat_add_int ${bodyTerm} ${recursiveCall})`
        : `(+ ${bodyTerm} ${recursiveCall})`;
    const params = [
        `(${sanitize(indexName)} Int)`,
        ...freeVars.map((entry) => `(${sanitize(entry.name)} ${scalarSort(entry.tag)})`),
    ].join(" ");
    return `(define-fun-rec ${helperName} (${params}) ${scalarSort(expr.valueType)} (ite (>= ${sanitize(indexName)} ${limit}) ${zero} ${folded}))`;
}
function scalarSort(tag) {
    return tag === "int" ? "Int" : "Real";
}
export function emitArrayRead(array, indices, valueType) {
    return emitArrayReadWithOverrides(array, indices, valueType);
}
export function emitArrayReadWithOverrides(array, indices, valueType, overrides = {}) {
    switch (array.tag) {
        case "slice":
            return emitArrayReadWithOverrides(array.base, [...array.fixedIndices, ...indices], valueType, overrides);
        case "param":
            return emitLeafReadWithOverrides(array.leafModel, [], indices, array.dims, overrides);
        case "abstract":
            return emitLeafReadWithOverrides(array.leafModel, array.args, indices, array.dims, overrides);
        case "comprehension":
        case "literal":
        case "choice":
            return emitDerivedArrayReadWithOverrides(array, indices, valueType, overrides);
    }
}
function emitLeafReadWithOverrides(model, prefixArgs, indices, dims, overrides) {
    if (model.kind !== "scalar") {
        throw new Error("Expected scalar leaf when emitting symbolic array read");
    }
    const args = [
        ...prefixArgs,
        ...indices.map((index, dim) => ({
            tag: "clamp_index",
            index,
            dim: dims[dim] ?? { tag: "int_lit", value: 1 },
        })),
    ];
    const callExpr = {
        tag: "call",
        name: model.readName,
        args,
        valueType: scalarTag(model.type),
        interpreted: false,
    };
    const overridden = overrides.onCall?.(callExpr);
    if (overridden !== null && overridden !== undefined) {
        return overridden;
    }
    return `(${sanitize(model.readName)} ${args.map((arg) => emitScalarWithOverrides(arg, overrides)).join(" ")})`;
}
export function renderScalarExpr(expr) {
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
            return `${expr.value}`;
        case "var":
            return expr.name;
        case "unop":
            return `(-${renderScalarExpr(expr.operand)})`;
        case "select":
            return `select(${renderScalarExpr(expr.index)}; ${expr.cases.map((value) => renderScalarExpr(value)).join(", ")})`;
        case "sum":
            return `sum[${expr.bindings.map((binding) => `${binding.name}:${renderScalarExpr(binding.extent)}`).join(", ")}] ${renderScalarExpr(expr.body)}`;
        case "sat_add":
            return `sat_add(${renderScalarExpr(expr.left)}, ${renderScalarExpr(expr.right)})`;
        case "sat_sub":
            return `sat_sub(${renderScalarExpr(expr.left)}, ${renderScalarExpr(expr.right)})`;
        case "sat_mul":
            return `sat_mul(${renderScalarExpr(expr.left)}, ${renderScalarExpr(expr.right)})`;
        case "sat_neg":
            return `sat_neg(${renderScalarExpr(expr.operand)})`;
        case "total_div":
            return `total_div(${renderScalarExpr(expr.left)}, ${renderScalarExpr(expr.right)})`;
        case "total_mod":
            return `total_mod(${renderScalarExpr(expr.left)}, ${renderScalarExpr(expr.right)})`;
        case "nan_to_zero":
            return `nan_to_zero(${renderScalarExpr(expr.value)})`;
        case "positive_extent":
            return `extent(${renderScalarExpr(expr.value)})`;
        case "clamp_index":
            return `clamp_index(${renderScalarExpr(expr.index)}, ${renderScalarExpr(expr.dim)})`;
        case "read":
            return `${renderArrayExpr(expr.array)}[${expr.indices.map((index) => renderScalarExpr(index)).join(", ")}]`;
        case "binop":
            return `(${renderScalarExpr(expr.left)} ${expr.op} ${renderScalarExpr(expr.right)})`;
        case "call":
            return `${expr.name}(${expr.args.map((arg) => renderScalarExpr(arg)).join(", ")})`;
    }
}
export function renderArrayExpr(array) {
    switch (array.tag) {
        case "param":
            return array.name;
        case "abstract":
            return `${array.name}(${array.args.map((arg) => renderScalarExpr(arg)).join(", ")})`;
        case "slice":
            return `${renderArrayExpr(array.base)}[${array.fixedIndices.map((index) => renderScalarExpr(index)).join(", ")}]`;
        case "comprehension":
            return `array[${array.bindings.map((binding) => `${binding.name}:${renderScalarExpr(binding.extent)}`).join(", ")}]`;
        case "literal":
            return `[${array.elements.map((element) => renderValueExpr(element)).join(", ")}]`;
        case "choice":
            return `select_array(${renderScalarExpr(array.selector)}; ${array.options.map((option) => renderArrayExpr(option)).join(", ")})`;
    }
}
export function collectVars(expr, out, shadowed = new Set()) {
    switch (expr.tag) {
        case "var":
            if (!shadowed.has(expr.name)) {
                out.set(expr.name, expr.valueType);
            }
            return;
        case "unop":
            collectVars(expr.operand, out, shadowed);
            return;
        case "select":
            collectVars(expr.index, out, shadowed);
            for (const value of expr.cases) {
                collectVars(value, out, shadowed);
            }
            return;
        case "sum": {
            const innerShadowed = new Set(shadowed);
            for (const binding of expr.bindings) {
                collectVars(binding.extent, out, innerShadowed);
                innerShadowed.add(binding.name);
            }
            collectVars(expr.body, out, innerShadowed);
            return;
        }
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            collectVars(expr.left, out, shadowed);
            collectVars(expr.right, out, shadowed);
            return;
        case "sat_neg":
            collectVars(expr.operand, out, shadowed);
            return;
        case "nan_to_zero":
            collectVars(expr.value, out, shadowed);
            return;
        case "positive_extent":
            collectVars(expr.value, out, shadowed);
            return;
        case "clamp_index":
            collectVars(expr.index, out, shadowed);
            collectVars(expr.dim, out, shadowed);
            return;
        case "read":
            for (const index of expr.indices) {
                collectVars(index, out, shadowed);
            }
            collectArrayVars(expr.array, out, shadowed);
            return;
        case "binop":
            collectVars(expr.left, out, shadowed);
            collectVars(expr.right, out, shadowed);
            return;
        case "call":
            for (const arg of expr.args) {
                collectVars(arg, out, shadowed);
            }
            return;
        default:
            return;
    }
}
export function collectValueVars(value, out, shadowed = new Set()) {
    switch (value.kind) {
        case "scalar":
            collectVars(value.expr, out, shadowed);
            return;
        case "array":
            collectArrayVars(value.array, out, shadowed);
            return;
        case "struct":
            for (const field of value.fields) {
                collectValueVars(field.value, out, shadowed);
            }
            return;
        case "void":
            return;
        case "opaque":
            return;
    }
}
export function collectArrayVars(array, out, shadowed = new Set()) {
    switch (array.tag) {
        case "param":
            for (const dim of array.dims) {
                collectVars(dim, out, shadowed);
            }
            return;
        case "abstract":
            for (const arg of array.args) {
                collectVars(arg, out, shadowed);
            }
            for (const dim of array.dims) {
                collectVars(dim, out, shadowed);
            }
            return;
        case "slice":
            collectArrayVars(array.base, out, shadowed);
            for (const index of array.fixedIndices) {
                collectVars(index, out, shadowed);
            }
            return;
        case "literal":
            for (const element of array.elements) {
                collectValueVars(element, out, shadowed);
            }
            return;
        case "choice":
            collectVars(array.selector, out, shadowed);
            for (const option of array.options) {
                collectArrayVars(option, out, shadowed);
            }
            return;
        case "comprehension": {
            const innerShadowed = new Set(shadowed);
            for (const binding of array.bindings) {
                collectVars(binding.extent, out, innerShadowed);
                innerShadowed.add(binding.name);
            }
            collectValueVars(array.body, out, innerShadowed);
            return;
        }
    }
}
export function queryCounterexample(query, solverOptions = {}) {
    const result = checkSatAndGetValues(query.baseLines, query.querySymbols.map((entry) => entry.symbol), solverOptions);
    if (!result.ok) {
        return null;
    }
    if (result.status !== "sat" || !result.values) {
        return null;
    }
    const values = result.values;
    const currentAssignments = query.querySymbols
        .filter((entry) => !entry.label.startsWith("next ") && !entry.label.startsWith("|rad|"))
        .map((entry) => `${entry.label} = ${values.get(entry.symbol) ?? "?"}`);
    const nextAssignments = query.querySymbols
        .filter((entry) => entry.label.startsWith("next "))
        .map((entry) => `${entry.label} = ${values.get(entry.symbol) ?? "?"}`);
    const currentMeasure = values.get("jplmm_abs_current_measure");
    const nextMeasure = values.get("jplmm_abs_next_measure");
    const parts = [];
    if (currentAssignments.length > 0) {
        parts.push(currentAssignments.join(", "));
    }
    if (nextAssignments.length > 0) {
        parts.push(nextAssignments.join(", "));
    }
    if (currentMeasure && nextMeasure) {
        parts.push(`|rad| ${currentMeasure} -> ${nextMeasure}`);
    }
    return parts.length > 0 ? `counterexample: ${parts.join("; ")}` : null;
}
export function queryIntModelValues(lines, vars, solverOptions = {}) {
    const result = checkSatAndGetValues(lines, vars.map((name) => sanitize(name)), solverOptions);
    if (!result.ok || result.status !== "sat" || !result.values) {
        return null;
    }
    const parsed = new Map();
    for (const name of vars) {
        const raw = result.values.get(sanitize(name));
        const value = raw ? parseZ3Int(raw) : null;
        if (value === null) {
            return null;
        }
        parsed.set(name, value);
    }
    return parsed;
}
export function formatModelAssignments(names, values) {
    const assignments = names.map((name) => `${name} = ${values.get(name) ?? "?"}`);
    return assignments.length > 0 ? assignments.join(", ") : null;
}
function realLiteral(value) {
    const negative = value < 0;
    const fixed = Math.abs(value).toFixed(20).replace(/\.?0+$/, "");
    const literal = fixed.includes(".") ? fixed : `${fixed}.0`;
    return negative ? `(- ${literal})` : literal;
}
function emitSelect(index, cases, overrides = {}) {
    if (cases.length === 0) {
        throw new Error("Cannot emit empty select expression");
    }
    let acc = emitScalarWithOverrides(cases[cases.length - 1], overrides);
    for (let i = cases.length - 2; i >= 0; i -= 1) {
        acc = `(ite (= ${emitScalarWithOverrides(index, overrides)} ${i}) ${emitScalarWithOverrides(cases[i], overrides)} ${acc})`;
    }
    return acc;
}
export function renderValueExpr(value) {
    switch (value.kind) {
        case "scalar":
            return renderScalarExpr(value.expr);
        case "array":
            return renderArrayExpr(value.array);
        case "struct":
            return `${value.typeName} { ${value.fields.map((field) => renderValueExpr(field.value)).join(", ")} }`;
        case "void":
            return "void";
        case "opaque":
            return value.label;
    }
}
export function emitValueSexpr(value) {
    switch (value.kind) {
        case "scalar":
            return emitScalar(value.expr);
        case "array":
            return emitArraySexpr(value.array);
        case "struct":
            return sexprForm("struct", sexprAtom(value.typeName), ...value.fields.map((field) => sexprForm(sexprAtom(field.name), emitValueSexpr(field.value))));
        case "void":
            return "void";
        case "opaque":
            return sexprForm("opaque", JSON.stringify(value.label));
    }
}
export function extendSymbolicSubstitution(current, next, substitution) {
    if (current.kind === "scalar" && current.expr.tag === "var") {
        substitution.set(current.expr.name, next);
        return;
    }
    if (current.kind === "array" && current.array.tag === "param") {
        substitution.set(current.array.name, next);
        return;
    }
    if (current.kind === "struct" && next.kind === "struct" && current.typeName === next.typeName) {
        for (let i = 0; i < current.fields.length; i += 1) {
            const left = current.fields[i];
            const right = next.fields[i];
            if (!left || !right || left.name !== right.name) {
                continue;
            }
            extendSymbolicSubstitution(left.value, right.value, substitution);
        }
    }
}
function emitDerivedArrayReadWithOverrides(array, indices, valueType, overrides = {}) {
    const value = readSymbolicArray(array, indices, valueType === "int" ? { tag: "int" } : { tag: "float" }, -1, -1);
    if (value.kind !== "scalar" || !canEncodeScalarExprWithSmt(value.expr)) {
        throw new Error("Expected encodable scalar value when emitting symbolic array read");
    }
    return emitScalarWithOverrides(value.expr, overrides);
}
function arrayDimsWithPrefix(prefix, nested) {
    if (!nested) {
        return prefix;
    }
    const suffix = arrayDims(nested);
    return suffix ? [...prefix, ...suffix] : null;
}
function lookupStructFields(typeName, structDefs) {
    return structDefs.get(typeName) ?? null;
}
function emitArraySexpr(array) {
    switch (array.tag) {
        case "param":
            return sexprForm("array:param", sexprAtom(array.name), sexprForm("dims", ...array.dims.map((dim) => emitScalar(dim))), sexprForm("leaf", emitLeafModelSexpr(array.leafModel)));
        case "abstract":
            return sexprForm("array:abstract", sexprAtom(array.name), sexprForm("args", ...array.args.map((arg) => emitScalar(arg))), sexprForm("dims", ...array.dims.map((dim) => emitScalar(dim))), sexprForm("leaf", emitLeafModelSexpr(array.leafModel)));
        case "slice":
            return sexprForm("array:slice", emitArraySexpr(array.base), ...array.fixedIndices.map((index) => emitScalar(index)));
        case "comprehension":
            return sexprForm("array:closure", sexprForm("bindings", ...array.bindings.map((binding) => sexprForm(sexprAtom(binding.name), emitScalar(binding.extent)))), emitValueSexpr(array.body));
        case "literal":
            return sexprForm("array:literal", ...array.elements.map((element) => emitValueSexpr(element)));
        case "choice":
            return sexprForm("array:choice", emitScalar(array.selector), ...array.options.map((option) => emitArraySexpr(option)));
    }
}
function emitLeafModelSexpr(model) {
    switch (model.kind) {
        case "scalar":
            return sexprForm("scalar-read", sexprAtom(model.readName));
        case "struct":
            return sexprForm("struct-read", sexprAtom(model.typeName), ...model.fields.map((field) => sexprForm(sexprAtom(field.name), emitLeafModelSexpr(field.model))));
        case "opaque":
            return sexprForm("opaque", JSON.stringify(model.label));
    }
}
function sexprForm(head, ...parts) {
    const rendered = [head, ...parts.filter((part) => part.length > 0)];
    return `(${rendered.join(" ")})`;
}
function sexprAtom(value) {
    return /^[A-Za-z_+\-*/<>=!?][A-Za-z0-9_+\-*/<>=!?:.]*$/.test(value)
        ? value
        : JSON.stringify(value);
}
//# sourceMappingURL=scalar.js.map