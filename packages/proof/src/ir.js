import { buildIR, } from "@jplmm/ir";
import { canonicalizeProgram } from "@jplmm/optimize";
import { checkSat } from "@jplmm/smt";
import { buildMeasureCounterexampleQuery, canEncodeScalarExprWithSmt, extendSymbolicSubstitution, isInterpretedCall, isSupportedRecArgValue, queryCounterexample, readSymbolicArray, renderScalarExpr, scalarExprType, scalarTag, sameType, substituteScalar, symbolizeParamValue, } from "./scalar";
export function buildCanonicalProgram(program, typeMap) {
    return canonicalizeProgram(buildIR(program, typeMap)).program;
}
export function functionsAlphaEquivalent(left, right) {
    if (left.params.length !== right.params.length || !sameType(left.retType, right.retType)) {
        return false;
    }
    const names = new Map();
    for (let i = 0; i < left.params.length; i += 1) {
        if (!sameType(left.params[i].type, right.params[i].type)) {
            return false;
        }
        names.set(left.params[i].name, right.params[i].name);
    }
    const leftBody = runtimeRelevantBody(left);
    const rightBody = runtimeRelevantBody(right);
    if (leftBody.length !== rightBody.length) {
        return false;
    }
    for (let i = 0; i < leftBody.length; i += 1) {
        const leftStmt = leftBody[i];
        const rightStmt = rightBody[i];
        if (leftStmt.tag !== rightStmt.tag) {
            return false;
        }
        if (leftStmt.tag === "gas" && rightStmt.tag === "gas") {
            if (leftStmt.limit !== rightStmt.limit) {
                return false;
            }
            continue;
        }
        if (leftStmt.tag === "let" && rightStmt.tag === "let") {
            if (!exprAlphaEquivalent(leftStmt.expr, rightStmt.expr, names)) {
                return false;
            }
            names.set(leftStmt.name, rightStmt.name);
            continue;
        }
        if (leftStmt.tag === "ret" && rightStmt.tag === "ret") {
            if (!exprAlphaEquivalent(leftStmt.expr, rightStmt.expr, names)) {
                return false;
            }
            continue;
        }
        return false;
    }
    return true;
}
export function hasRec(fn) {
    return fn.body.some((stmt) => stmt.tag !== "gas" && stmt.tag !== "rad" && stmtHasRec(stmt.expr));
}
export function analyzeIrFunction(fn, structDefs = new Map()) {
    const callSigs = new Map();
    const env = new Map();
    const paramValues = new Map();
    for (const param of fn.params) {
        const value = symbolizeParamValue(param, callSigs, structDefs);
        env.set(param.name, value);
        paramValues.set(param.name, value);
    }
    const state = {
        env,
        paramValues,
        res: null,
        stmtSemantics: [],
        radSites: [],
        recSites: [],
        callSigs,
        structDefs,
    };
    for (let stmtIndex = 0; stmtIndex < fn.body.length; stmtIndex += 1) {
        const stmt = fn.body[stmtIndex];
        if (stmt.tag === "let") {
            const value = symbolizeIrExpr(stmt.expr, fn, state, stmtIndex);
            state.env.set(stmt.name, value);
            state.stmtSemantics.push({
                stmtIndex,
                stmtTag: stmt.tag,
                rendered: renderIrExpr(stmt.expr),
                value,
            });
            continue;
        }
        if (stmt.tag === "ret") {
            state.res = symbolizeIrExpr(stmt.expr, fn, state, stmtIndex);
            state.stmtSemantics.push({
                stmtIndex,
                stmtTag: stmt.tag,
                rendered: renderIrExpr(stmt.expr),
                value: state.res,
            });
            continue;
        }
        if (stmt.tag === "rad") {
            const value = symbolizeIrExpr(stmt.expr, fn, state, stmtIndex);
            state.stmtSemantics.push({
                stmtIndex,
                stmtTag: stmt.tag,
                rendered: renderIrExpr(stmt.expr),
                value,
            });
            if (value.kind === "scalar") {
                state.radSites.push({
                    stmtIndex,
                    source: stmt.expr,
                    measure: value.expr,
                    rendered: renderScalarExpr(value.expr),
                });
            }
        }
        if (stmt.tag === "gas") {
            state.stmtSemantics.push({
                stmtIndex,
                stmtTag: stmt.tag,
                rendered: `${stmt.limit}`,
                value: null,
            });
        }
    }
    return {
        paramValues: state.paramValues,
        result: state.res,
        stmtSemantics: state.stmtSemantics,
        radSites: state.radSites,
        recSites: state.recSites,
        callSigs: state.callSigs,
    };
}
export function proveIrSiteWithSmt(fn, rad, site, analysis) {
    if (site.issues.length > 0) {
        return { ok: false, reasons: [...site.issues] };
    }
    if (!canEncodeScalarExprWithSmt(rad.measure)) {
        return {
            ok: false,
            reasons: [`'${rad.rendered}' has semantics but not SMT lowering in the current proof backend`],
        };
    }
    const substitution = new Map();
    for (let i = 0; i < fn.params.length; i += 1) {
        const param = fn.params[i];
        const next = site.argValues.get(i);
        if (!next) {
            return { ok: false, reasons: [`rec site is missing argument '${param.name}'`] };
        }
        if (scalarTag(param.type) && next.kind !== "scalar") {
            return { ok: false, reasons: [`rec site could not symbolize scalar recursive argument '${param.name}'`] };
        }
        substitution.set(param.name, next);
        const current = analysis.paramValues.get(param.name);
        if (current) {
            extendSymbolicSubstitution(current, next, substitution);
        }
    }
    const nextMeasure = substituteScalar(rad.measure, substitution);
    const query = buildMeasureCounterexampleQuery(fn.params, rad.measure, nextMeasure, substitution, analysis.callSigs, analysis.paramValues);
    if (!query.ok) {
        return { ok: false, reasons: [query.reason] };
    }
    const result = checkSat(query.query.baseLines);
    if (!result.ok) {
        return { ok: false, reasons: [`failed to invoke z3: ${result.error}`] };
    }
    if (result.status === "unsat") {
        return {
            ok: true,
            method: "smt",
            details: `rec site decreases '${rad.rendered}'`,
        };
    }
    if (result.status === "sat") {
        const witness = queryCounterexample(query.query);
        return {
            ok: false,
            reasons: [`solver found a counterexample for '${rad.rendered}'${witness ? `: ${witness}` : ""}`],
        };
    }
    return {
        ok: false,
        reasons: [`solver returned '${result.output || "unknown"}' for '${rad.rendered}'`],
    };
}
export function checkIrStructuralDecrease(params, radExpr, recArgs) {
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
export function analyzeIrProofSites(fn, analysis = analyzeIrFunction(fn)) {
    return analysis.recSites.map((site, siteIndex) => {
        const obligations = analysis.radSites.map((rad) => {
            const structural = checkIrStructuralDecrease(fn.params, rad.source, site.args);
            if (structural.ok) {
                return {
                    rad,
                    structural,
                    smt: null,
                    proved: true,
                    method: "structural",
                    details: `rec site ${siteIndex + 1}: structural via '${rad.rendered}'`,
                    reasons: [structural.reason],
                };
            }
            const smt = proveIrSiteWithSmt(fn, rad, site, analysis);
            if (smt.ok) {
                return {
                    rad,
                    structural,
                    smt,
                    proved: true,
                    method: "smt",
                    details: `rec site ${siteIndex + 1}: ${smt.details}`,
                    reasons: [structural.reason],
                };
            }
            return {
                rad,
                structural,
                smt,
                proved: false,
                method: null,
                details: null,
                reasons: [structural.reason, ...smt.reasons],
            };
        });
        const winner = obligations.find((obligation) => obligation.proved) ?? null;
        return {
            siteIndex,
            site,
            obligations,
            proved: winner !== null,
            reasons: winner ? [] : unique(obligations.flatMap((obligation) => obligation.reasons)),
        };
    });
}
function runtimeRelevantBody(fn) {
    const keepGas = hasRec(fn);
    return fn.body.filter((stmt) => stmt.tag !== "rad" && (keepGas || stmt.tag !== "gas"));
}
function exprAlphaEquivalent(left, right, names) {
    if (left.tag !== right.tag || !sameType(left.resultType, right.resultType)) {
        return false;
    }
    switch (left.tag) {
        case "int_lit":
            return left.value === right.value;
        case "float_lit":
            return Object.is(left.value, right.value);
        case "void_lit":
        case "res":
            return true;
        case "var": {
            const mapped = names.get(left.name);
            return mapped ? mapped === right.name : left.name === right.name;
        }
        case "unop":
            return left.op === right.op && exprAlphaEquivalent(left.operand, right.operand, names);
        case "binop":
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            return (left.tag === right.tag
                && exprAlphaEquivalent(left.left, right.left, names)
                && exprAlphaEquivalent(left.right, right.right, names)
                && ("op" in left ? left.op === right.op : true));
        case "sat_neg":
            return exprAlphaEquivalent(left.operand, right.operand, names);
        case "nan_to_zero":
            return exprAlphaEquivalent(left.value, right.value, names);
        case "call":
            return left.name === right.name && arrayExprsEqual(left.args, right.args, names);
        case "index":
            return exprAlphaEquivalent(left.array, right.array, names)
                && arrayExprsEqual(left.indices, right.indices, names);
        case "field":
            return left.field === right.field && exprAlphaEquivalent(left.target, right.target, names);
        case "struct_cons":
            return left.name === right.name && arrayExprsEqual(left.fields, right.fields, names);
        case "array_cons":
            return arrayExprsEqual(left.elements, right.elements, names);
        case "array_expr":
        case "sum_expr": {
            const rightExpr = right;
            if (left.bindings.length !== rightExpr.bindings.length) {
                return false;
            }
            const scoped = new Map(names);
            for (let i = 0; i < left.bindings.length; i += 1) {
                const leftBinding = left.bindings[i];
                const rightBinding = rightExpr.bindings[i];
                if (!exprAlphaEquivalent(leftBinding.expr, rightBinding.expr, scoped)) {
                    return false;
                }
                scoped.set(leftBinding.name, rightBinding.name);
            }
            return exprAlphaEquivalent(left.body, rightExpr.body, scoped);
        }
        case "rec":
            return arrayExprsEqual(left.args, right.args, names);
        default: {
            const _never = left;
            return _never;
        }
    }
}
function arrayExprsEqual(left, right, names) {
    return left.length === right.length && left.every((expr, index) => exprAlphaEquivalent(expr, right[index], names));
}
function stmtHasRec(expr) {
    switch (expr.tag) {
        case "rec":
            return true;
        case "unop":
        case "sat_neg":
        case "nan_to_zero":
            return stmtHasRec(expr.tag === "nan_to_zero" ? expr.value : expr.operand);
        case "binop":
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            return stmtHasRec(expr.left) || stmtHasRec(expr.right);
        case "call":
            return expr.args.some(stmtHasRec);
        case "index":
            return stmtHasRec(expr.array) || expr.indices.some(stmtHasRec);
        case "field":
            return stmtHasRec(expr.target);
        case "struct_cons":
            return expr.fields.some(stmtHasRec);
        case "array_cons":
            return expr.elements.some(stmtHasRec);
        case "array_expr":
        case "sum_expr":
            return expr.bindings.some((binding) => stmtHasRec(binding.expr)) || stmtHasRec(expr.body);
        default:
            return false;
    }
}
function symbolizeIrExpr(expr, fn, state, stmtIndex) {
    switch (expr.tag) {
        case "int_lit":
            return { kind: "scalar", expr: { tag: "int_lit", value: expr.value } };
        case "float_lit":
            return { kind: "scalar", expr: { tag: "float_lit", value: expr.value } };
        case "void_lit":
            return { kind: "void", type: { tag: "void" } };
        case "var":
            return state.env.get(expr.name) ?? { kind: "opaque", type: expr.resultType, label: expr.name };
        case "res":
            return state.res ?? { kind: "opaque", type: fn.retType, label: "res" };
        case "unop": {
            return symbolizeUnaryScalar(expr, symbolizeIrExpr(expr.operand, fn, state, stmtIndex), (operand, tag) => ({ tag: "unop", op: "-", operand, valueType: tag }), stmtIndex);
        }
        case "binop": {
            return symbolizeBinaryScalar(expr, symbolizeIrExpr(expr.left, fn, state, stmtIndex), symbolizeIrExpr(expr.right, fn, state, stmtIndex), (left, right, tag) => ({ tag: "binop", op: expr.op, left, right, valueType: tag }), stmtIndex);
        }
        case "sat_add":
        case "sat_sub":
        case "sat_mul": {
            return symbolizeBinaryScalar(expr, symbolizeIrExpr(expr.left, fn, state, stmtIndex), symbolizeIrExpr(expr.right, fn, state, stmtIndex), (left, right) => ({ tag: expr.tag, left, right }), stmtIndex, false);
        }
        case "sat_neg": {
            return symbolizeUnaryScalar(expr, symbolizeIrExpr(expr.operand, fn, state, stmtIndex), (operand) => ({ tag: "sat_neg", operand }), stmtIndex, false);
        }
        case "total_div":
        case "total_mod": {
            return symbolizeBinaryScalar(expr, symbolizeIrExpr(expr.left, fn, state, stmtIndex), symbolizeIrExpr(expr.right, fn, state, stmtIndex), (left, right, tag) => ({ tag: expr.tag, left, right, valueType: tag }), stmtIndex);
        }
        case "nan_to_zero": {
            return symbolizeUnaryScalar(expr, symbolizeIrExpr(expr.value, fn, state, stmtIndex), (value) => ({ tag: "nan_to_zero", value }), stmtIndex, false);
        }
        case "call": {
            const args = expr.args.map((arg) => symbolizeIrExpr(arg, fn, state, stmtIndex));
            const tag = scalarTag(expr.resultType);
            const scalarArgs = args.every((arg) => arg.kind === "scalar")
                ? args.map((arg) => arg.expr)
                : null;
            if (tag && scalarArgs) {
                const interpreted = isInterpretedCall(expr.name, scalarArgs.length);
                if (!interpreted && !state.callSigs.has(expr.name)) {
                    state.callSigs.set(expr.name, { args: scalarArgs.map((arg) => scalarExprType(arg)), ret: tag });
                }
                return {
                    kind: "scalar",
                    expr: {
                        tag: "call",
                        name: expr.name,
                        args: scalarArgs,
                        valueType: tag,
                        interpreted,
                    },
                };
            }
            return { kind: "opaque", type: expr.resultType, label: `call_${expr.name}_${stmtIndex}` };
        }
        case "field": {
            const target = symbolizeIrExpr(expr.target, fn, state, stmtIndex);
            if (target.kind !== "struct") {
                return { kind: "opaque", type: expr.resultType, label: `field_${stmtIndex}_${expr.id}` };
            }
            const field = target.fields.find((candidate) => candidate.name === expr.field);
            return field?.value ?? { kind: "opaque", type: expr.resultType, label: `field_${stmtIndex}_${expr.id}` };
        }
        case "index": {
            const arrayValue = symbolizeIrExpr(expr.array, fn, state, stmtIndex);
            if (arrayValue.kind !== "array") {
                return { kind: "opaque", type: expr.resultType, label: `index_${stmtIndex}_${expr.id}` };
            }
            const indices = [];
            for (const indexExpr of expr.indices) {
                const indexValue = symbolizeIrExpr(indexExpr, fn, state, stmtIndex);
                if (indexValue.kind !== "scalar" || scalarExprType(indexValue.expr) !== "int") {
                    return { kind: "opaque", type: expr.resultType, label: `index_${stmtIndex}_${expr.id}` };
                }
                indices.push(indexValue.expr);
            }
            return readSymbolicArray(arrayValue.array, indices, expr.resultType, stmtIndex, expr.id);
        }
        case "struct_cons":
            return symbolizeStructCons(expr, fn, state, stmtIndex);
        case "array_expr":
            return symbolizeArrayExpr(expr, fn, state, stmtIndex);
        case "array_cons":
            return symbolizeArrayCons(expr, fn, state, stmtIndex);
        case "sum_expr":
            return symbolizeSumExpr(expr, fn, state, stmtIndex);
        case "rec": {
            const argValues = new Map();
            const issues = [];
            for (let i = 0; i < fn.params.length; i += 1) {
                const param = fn.params[i];
                const arg = expr.args[i];
                if (!arg) {
                    continue;
                }
                const value = symbolizeIrExpr(arg, fn, state, stmtIndex);
                if (!isSupportedRecArgValue(param.type, value, state.env.get(param.name))) {
                    issues.push(`could not symbolize recursive argument '${param.name}' as a scalar/array proof value`);
                    continue;
                }
                argValues.set(i, value);
            }
            const retScalar = scalarTag(fn.retType);
            const resultValue = retScalar
                ? {
                    kind: "scalar",
                    expr: {
                        tag: "var",
                        name: `__rec_result_${stmtIndex}_${expr.id}`,
                        valueType: retScalar,
                    },
                }
                : { kind: "opaque", type: fn.retType, label: `rec_${stmtIndex}_${expr.id}` };
            state.recSites.push({
                stmtIndex,
                args: expr.args,
                argValues,
                issues,
                ...(resultValue.kind === "scalar" ? { resultSymbol: resultValue.expr.name } : {}),
                ...(state.res !== null ? { currentRes: state.res } : {}),
            });
            return resultValue;
        }
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function symbolizeArrayExpr(expr, fn, state, stmtIndex) {
    if (expr.resultType.tag !== "array") {
        return { kind: "opaque", type: expr.resultType, label: `array_expr_${stmtIndex}_${expr.id}` };
    }
    const prepared = prepareComprehensionBindings(expr, fn, state, stmtIndex);
    if (!prepared.ok) {
        return prepared.value;
    }
    return {
        kind: "array",
        array: {
            tag: "comprehension",
            arrayType: expr.resultType,
            bindings: prepared.bindings,
            body: symbolizeIrExpr(expr.body, fn, prepared.localState, stmtIndex),
        },
    };
}
function symbolizeStructCons(expr, fn, state, stmtIndex) {
    const structDef = state.structDefs.get(expr.name);
    const fields = expr.fields.map((field) => symbolizeIrExpr(field, fn, state, stmtIndex));
    return {
        kind: "struct",
        typeName: expr.name,
        fields: fields.map((value, index) => ({
            name: structDef?.[index]?.name ?? `field${index}`,
            type: structDef?.[index]?.type ?? expr.fields[index]?.resultType ?? expr.resultType,
            value,
        })),
    };
}
function symbolizeArrayCons(expr, fn, state, stmtIndex) {
    const elements = expr.elements.map((element) => symbolizeIrExpr(element, fn, state, stmtIndex));
    return {
        kind: "array",
        array: {
            tag: "literal",
            arrayType: expr.resultType,
            elements,
        },
    };
}
function symbolizeSumExpr(expr, fn, state, stmtIndex) {
    const prepared = prepareComprehensionBindings(expr, fn, state, stmtIndex);
    if (!prepared.ok) {
        return prepared.value;
    }
    const body = symbolizeIrExpr(expr.body, fn, prepared.localState, stmtIndex);
    const tag = scalarTag(expr.resultType);
    if (body.kind !== "scalar" || !tag) {
        return { kind: "opaque", type: expr.resultType, label: `sum_expr_${stmtIndex}_${expr.id}` };
    }
    return {
        kind: "scalar",
        expr: {
            tag: "sum",
            bindings: prepared.bindings,
            body: body.expr,
            valueType: tag,
        },
    };
}
function symbolizeUnaryScalar(expr, operand, build, stmtIndex, requireResultTag = true) {
    const tag = scalarTag(expr.resultType);
    if (operand.kind === "scalar" && (!requireResultTag || tag)) {
        return {
            kind: "scalar",
            expr: build(operand.expr, tag ?? scalarExprType(operand.expr)),
        };
    }
    return { kind: "opaque", type: expr.resultType, label: `${expr.tag}_${stmtIndex}_${expr.id}` };
}
function symbolizeBinaryScalar(expr, left, right, build, stmtIndex, requireResultTag = true) {
    const tag = scalarTag(expr.resultType);
    if (left.kind === "scalar" && right.kind === "scalar" && (!requireResultTag || tag)) {
        return {
            kind: "scalar",
            expr: build(left.expr, right.expr, tag ?? scalarExprType(left.expr)),
        };
    }
    return { kind: "opaque", type: expr.resultType, label: `${expr.tag}_${stmtIndex}_${expr.id}` };
}
function prepareComprehensionBindings(expr, fn, state, stmtIndex) {
    const localState = {
        ...state,
        env: new Map(state.env),
    };
    const bindings = [];
    for (const binding of expr.bindings) {
        const extentValue = symbolizeIrExpr(binding.expr, fn, localState, stmtIndex);
        if (extentValue.kind !== "scalar" || scalarExprType(extentValue.expr) !== "int") {
            return {
                ok: false,
                value: { kind: "opaque", type: expr.resultType, label: `${expr.tag}_${stmtIndex}_${expr.id}` },
            };
        }
        bindings.push({
            name: binding.name,
            extent: extentValue.expr,
        });
        localState.env.set(binding.name, {
            kind: "scalar",
            expr: { tag: "var", name: binding.name, valueType: "int" },
        });
    }
    return { ok: true, localState, bindings };
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
    if (expr.tag === "sat_sub") {
        return expr.left.tag === "var" && expr.left.name === paramName && expr.right.tag === "int_lit" && expr.right.value > 0;
    }
    if (expr.tag !== "binop" || expr.op !== "-") {
        return false;
    }
    return expr.left.tag === "var" && expr.left.name === paramName && expr.right.tag === "int_lit" && expr.right.value > 0;
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
    return expr.tag === "call"
        && expr.name === "abs"
        && expr.args.length === 1
        && expr.args[0]?.tag === "var"
        && expr.args[0].name === paramName;
}
export function renderIrFunctionHeader(fn) {
    return `${fn.keyword} ${fn.name}(${fn.params.map((param) => `${param.name}:${renderType(param.type)}`).join(", ")}): ${renderType(fn.retType)}`;
}
export function renderIrFunction(fn) {
    return [
        `${renderIrFunctionHeader(fn)} {`,
        ...fn.body.map((stmt) => `  ${renderIrStmt(stmt)}`),
        "}",
    ];
}
export function renderIrStmt(stmt) {
    switch (stmt.tag) {
        case "let":
            return `let ${stmt.name} = ${renderIrExpr(stmt.expr)};`;
        case "ret":
            return `ret ${renderIrExpr(stmt.expr)};`;
        case "rad":
            return `rad ${renderIrExpr(stmt.expr)};`;
        case "gas":
            return `gas ${stmt.limit};`;
        default: {
            const _never = stmt;
            return _never;
        }
    }
}
export function renderIrExpr(expr) {
    switch (expr.tag) {
        case "int_lit":
            return `${expr.value}`;
        case "float_lit":
            return `${expr.value}`;
        case "void_lit":
            return "void";
        case "var":
            return expr.name;
        case "res":
            return "res";
        case "binop":
            return `(${renderIrExpr(expr.left)} ${expr.op} ${renderIrExpr(expr.right)})`;
        case "unop":
            return `${expr.op}${renderIrExpr(expr.operand)}`;
        case "call":
            return `${expr.name}(${expr.args.map((arg) => renderIrExpr(arg)).join(", ")})`;
        case "index":
            return `${renderIrExpr(expr.array)}${expr.indices.map((index) => `[${renderIrExpr(index)}]`).join("")}`;
        case "field":
            return `${renderIrExpr(expr.target)}.${expr.field}`;
        case "struct_cons":
            return `${expr.name} { ${expr.fields.map((field) => renderIrExpr(field)).join(", ")} }`;
        case "array_cons":
            return `[${expr.elements.map((element) => renderIrExpr(element)).join(", ")}]`;
        case "array_expr":
            return `array[${expr.bindings.map((binding) => `${binding.name}:${renderIrExpr(binding.expr)}`).join(", ")}] ${renderIrExpr(expr.body)}`;
        case "sum_expr":
            return `sum[${expr.bindings.map((binding) => `${binding.name}:${renderIrExpr(binding.expr)}`).join(", ")}] ${renderIrExpr(expr.body)}`;
        case "rec":
            return `rec(${expr.args.map((arg) => renderIrExpr(arg)).join(", ")})`;
        case "total_div":
            return `total_div(${renderIrExpr(expr.left)}, ${renderIrExpr(expr.right)})`;
        case "total_mod":
            return `total_mod(${renderIrExpr(expr.left)}, ${renderIrExpr(expr.right)})`;
        case "nan_to_zero":
            return `nan_to_zero(${renderIrExpr(expr.value)})`;
        case "sat_add":
            return `sat_add(${renderIrExpr(expr.left)}, ${renderIrExpr(expr.right)})`;
        case "sat_sub":
            return `sat_sub(${renderIrExpr(expr.left)}, ${renderIrExpr(expr.right)})`;
        case "sat_mul":
            return `sat_mul(${renderIrExpr(expr.left)}, ${renderIrExpr(expr.right)})`;
        case "sat_neg":
            return `sat_neg(${renderIrExpr(expr.operand)})`;
        default: {
            const _never = expr;
            return _never;
        }
    }
}
export function renderType(type) {
    switch (type.tag) {
        case "int":
        case "float":
        case "void":
            return type.tag;
        case "named":
            return type.name;
        case "array":
            return `${renderType(type.element)}${"[]".repeat(type.dims)}`;
        default: {
            const _never = type;
            return _never;
        }
    }
}
function unique(values) {
    return [...new Set(values)];
}
//# sourceMappingURL=ir.js.map