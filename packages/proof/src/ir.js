import { getArrayExtentNames, renderType as renderDeclaredType } from "@jplmm/ast";
import { buildIR, } from "@jplmm/ir";
import { canonicalizeProgram } from "@jplmm/optimize";
import { checkSat } from "@jplmm/smt";
import { withHardTimeout } from "@jplmm/smt";
import { buildMeasureCounterexampleQuery, canEncodeScalarExprWithSmt, extendSymbolicSubstitution, isInterpretedCall, normalizeValueForType, isSupportedRecArgValue, makeOpaque, queryCounterexample, arrayDims, readSymbolicArray, renderScalarExpr, scalarExprType, scalarTag, selectValue, sameType, substituteScalar, substituteValue, symbolizeAbstractValue, symbolizeParamValue, } from "./scalar";
const NAN_GUARDED_BUILTINS = new Set(["sqrt", "log", "pow", "asin", "acos"]);
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
export function analyzeIrFunction(fn, structDefs = new Map(), symbolPrefix = "", options = {}) {
    const callSigs = new Map();
    const env = new Map();
    const paramValues = new Map();
    for (const param of fn.params) {
        const value = symbolizeParamValue(param, callSigs, structDefs);
        env.set(param.name, value);
        paramValues.set(param.name, value);
        bindArrayExtentValues(env, param.type, value);
    }
    const state = {
        symbolPrefix,
        env,
        paramValues,
        exprSemantics: new Map(),
        res: null,
        stmtSemantics: [],
        radSites: [],
        recSites: [],
        callSigs,
        structDefs,
        callSummaries: options.callSummaries ?? new Map(),
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
        exprSemantics: state.exprSemantics,
        result: state.res,
        stmtSemantics: state.stmtSemantics,
        radSites: state.radSites,
        recSites: state.recSites,
        callSigs: state.callSigs,
    };
}
function bindArrayExtentValues(env, type, value) {
    const extentNames = getArrayExtentNames(type);
    if (!extentNames || value.kind !== "array") {
        return;
    }
    const dims = arrayDims(value.array);
    if (!dims) {
        return;
    }
    for (let i = 0; i < extentNames.length; i += 1) {
        const extentName = extentNames[i];
        const extent = dims[i];
        if (typeof extentName === "string" && extent) {
            env.set(extentName, { kind: "scalar", expr: extent });
        }
    }
}
export function buildIrCallSummaries(program, structDefs = new Map(program.structs.map((struct) => [struct.name, struct.fields])), symbolPrefix = "") {
    const summaries = new Map();
    for (const fn of program.functions) {
        if (hasRec(fn)) {
            continue;
        }
        const analysis = analyzeIrFunction(fn, structDefs, `${symbolPrefix}${fn.name}_`, { callSummaries: summaries });
        summaries.set(fn.name, {
            fn,
            analysis,
            inlineable: analysis.result !== null && !containsOpaqueValue(analysis.result),
        });
    }
    return summaries;
}
export function proveIrSiteWithSmt(fn, rad, site, analysis, solverOptions = {}) {
    const proofSolverOptions = withHardTimeout(solverOptions);
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
    const result = checkSat(query.query.baseLines, proofSolverOptions);
    if (!result.ok) {
        return {
            ok: false,
            reasons: [result.timedOut ? `solver timed out: ${result.error}` : `failed to invoke z3: ${result.error}`],
        };
    }
    if (result.status === "unsat") {
        return {
            ok: true,
            method: "smt",
            details: `rec site decreases '${rad.rendered}'`,
        };
    }
    if (result.status === "sat") {
        const witness = queryCounterexample(query.query, proofSolverOptions);
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
export function analyzeIrProofSites(fn, analysis = analyzeIrFunction(fn), solverOptions = {}) {
    const proofSolverOptions = withHardTimeout(solverOptions);
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
            const smt = proveIrSiteWithSmt(fn, rad, site, analysis, proofSolverOptions);
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
    const value = symbolizeIrExprCore(expr, fn, state, stmtIndex);
    state.exprSemantics.set(expr.id, value);
    return value;
}
function symbolizeIrExprCore(expr, fn, state, stmtIndex) {
    switch (expr.tag) {
        case "int_lit":
            return { kind: "scalar", expr: { tag: "int_lit", value: expr.value } };
        case "float_lit":
            return { kind: "scalar", expr: { tag: "float_lit", value: expr.value } };
        case "void_lit":
            return { kind: "void", type: { tag: "void" } };
        case "var":
            return state.env.get(expr.name) ?? makeOpaque(expr.resultType, expr.name, "ir:symbolizeIrExpr:var_missing");
        case "res":
            return state.res ?? makeOpaque(fn.retType, "res", "ir:symbolizeIrExpr:res_missing");
        case "unop": {
            return symbolizeUnaryScalar(expr, symbolizeIrExpr(expr.operand, fn, state, stmtIndex), (operand, tag) => buildDenotationalUnaryScalarExpr(expr, operand, tag), stmtIndex);
        }
        case "binop": {
            return symbolizeBinaryScalar(expr, symbolizeIrExpr(expr.left, fn, state, stmtIndex), symbolizeIrExpr(expr.right, fn, state, stmtIndex), (left, right, tag) => buildDenotationalBinaryScalarExpr(expr, left, right, tag), stmtIndex);
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
            const summarized = tryInlineCallSummary(expr, args, state);
            if (summarized) {
                return summarized;
            }
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
                    expr: buildDenotationalScalarCallExpr(expr.name, scalarArgs, tag, interpreted),
                };
            }
            if (scalarArgs) {
                return symbolizeAbstractValue(expr.resultType, `__call_${state.symbolPrefix}${expr.name}_${stmtIndex}_${expr.id}`, scalarArgs, state.callSigs, state.structDefs);
            }
            return makeOpaque(expr.resultType, `call_${expr.name}_${stmtIndex}`, "ir:symbolizeIrExpr:call_non_scalar_args");
        }
        case "field": {
            const target = symbolizeIrExpr(expr.target, fn, state, stmtIndex);
            if (target.kind !== "struct") {
                return makeOpaque(expr.resultType, `field_${stmtIndex}_${expr.id}`, "ir:symbolizeIrExpr:field_non_struct_target");
            }
            const field = target.fields.find((candidate) => candidate.name === expr.field);
            return field?.value ?? makeOpaque(expr.resultType, `field_${stmtIndex}_${expr.id}`, "ir:symbolizeIrExpr:field_missing");
        }
        case "index": {
            const arrayValue = symbolizeIrExpr(expr.array, fn, state, stmtIndex);
            if (arrayValue.kind !== "array") {
                return makeOpaque(expr.resultType, `index_${stmtIndex}_${expr.id}`, "ir:symbolizeIrExpr:index_non_array_target");
            }
            const indices = [];
            for (const indexExpr of expr.indices) {
                const indexValue = symbolizeIrExpr(indexExpr, fn, state, stmtIndex);
                if (indexValue.kind !== "scalar" || scalarExprType(indexValue.expr) !== "int") {
                    return makeOpaque(expr.resultType, `index_${stmtIndex}_${expr.id}`, "ir:symbolizeIrExpr:index_non_int_index");
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
                argValues.set(i, normalizeValueForType(value, param.type));
            }
            const resultValue = symbolizeAbstractValue(fn.retType, `__rec_result_${state.symbolPrefix}${stmtIndex}_${expr.id}`, [], state.callSigs, state.structDefs);
            state.recSites.push({
                stmtIndex,
                args: expr.args,
                argValues,
                issues,
                resultValue,
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
function tryInlineCallSummary(expr, args, state) {
    const summary = state.callSummaries.get(expr.name);
    if (!summary || !summary.inlineable || !summary.analysis.result) {
        return null;
    }
    if (summary.fn.params.length !== args.length) {
        return null;
    }
    const substitution = new Map();
    for (let i = 0; i < summary.fn.params.length; i += 1) {
        const param = summary.fn.params[i];
        const arg = normalizeValueForType(args[i], param.type);
        substitution.set(param.name, arg);
        const current = summary.analysis.paramValues.get(param.name);
        if (current) {
            extendSymbolicSubstitution(current, arg, substitution);
        }
    }
    for (const [name, sig] of summary.analysis.callSigs) {
        if (!state.callSigs.has(name)) {
            state.callSigs.set(name, sig);
        }
    }
    return substituteValue(summary.analysis.result, substitution);
}
function symbolizeArrayExpr(expr, fn, state, stmtIndex) {
    if (expr.resultType.tag !== "array") {
        return makeOpaque(expr.resultType, `array_expr_${stmtIndex}_${expr.id}`, "ir:symbolizeArrayExpr:non_array_type");
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
    const elementType = expr.resultType.tag === "array" ? expr.resultType.element : expr.resultType;
    const indexVar = {
        kind: "scalar",
        expr: {
            tag: "var",
            name: `jplmm_array_cons_${stmtIndex}_${expr.id}`,
            valueType: "int",
        },
    };
    return {
        kind: "array",
        array: {
            tag: "comprehension",
            arrayType: expr.resultType,
            bindings: [{
                    name: indexVar.expr.name,
                    extent: { tag: "int_lit", value: Math.max(1, elements.length) },
                }],
            body: selectValue(indexVar.expr, elements, elementType, stmtIndex, expr.id),
        },
    };
}
function symbolizeSumExpr(expr, fn, state, stmtIndex) {
    const unrolled = tryUnrollIrSumExpr(expr);
    if (unrolled) {
        return symbolizeIrExpr(unrolled, fn, state, stmtIndex);
    }
    const prepared = prepareComprehensionBindings(expr, fn, state, stmtIndex);
    if (!prepared.ok) {
        return prepared.value;
    }
    const body = symbolizeIrExpr(expr.body, fn, prepared.localState, stmtIndex);
    const tag = scalarTag(expr.resultType);
    if (body.kind !== "scalar" || !tag) {
        return makeOpaque(expr.resultType, `sum_expr_${stmtIndex}_${expr.id}`, "ir:symbolizeSumExpr:non_scalar_body");
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
function tryUnrollIrSumExpr(expr, maxTerms = 16) {
    const extents = expr.bindings.map((binding) => constantIrPositiveExtent(binding.expr));
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
    const freshIds = { next: expr.id * 1000 + 1 };
    expandIrSumTerms(expr, 0, new Map(), terms, freshIds);
    if (terms.length === 0) {
        return expr.resultType.tag === "float"
            ? { tag: "float_lit", value: 0, id: expr.id, resultType: expr.resultType }
            : { tag: "int_lit", value: 0, id: expr.id, resultType: expr.resultType };
    }
    let acc = terms[0];
    for (let i = 1; i < terms.length; i += 1) {
        acc = expr.resultType.tag === "float"
            ? {
                tag: "binop",
                op: "+",
                left: acc,
                right: terms[i],
                id: freshIds.next,
                resultType: expr.resultType,
            }
            : {
                tag: "sat_add",
                left: acc,
                right: terms[i],
                id: freshIds.next,
                resultType: expr.resultType,
            };
        freshIds.next += 1;
    }
    return acc;
}
function expandIrSumTerms(expr, bindingIndex, substitution, out, freshIds) {
    if (bindingIndex >= expr.bindings.length) {
        out.push(freshenIrExpr(substituteIrExpr(expr.body, substitution), freshIds));
        return;
    }
    const binding = expr.bindings[bindingIndex];
    const extent = constantIrPositiveExtent(binding.expr);
    if (extent === null) {
        return;
    }
    for (let i = 0; i < extent; i += 1) {
        const nextSubstitution = new Map(substitution);
        nextSubstitution.set(binding.name, {
            tag: "int_lit",
            value: i,
            id: binding.expr.id,
            resultType: { tag: "int" },
        });
        expandIrSumTerms(expr, bindingIndex + 1, nextSubstitution, out, freshIds);
    }
}
function substituteIrExpr(expr, substitution) {
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
        case "void_lit":
        case "res":
            return expr;
        case "var":
            return substitution.get(expr.name) ?? expr;
        case "binop":
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            return {
                ...expr,
                left: substituteIrExpr(expr.left, substitution),
                right: substituteIrExpr(expr.right, substitution),
            };
        case "unop":
        case "sat_neg":
            return {
                ...expr,
                operand: substituteIrExpr(expr.operand, substitution),
            };
        case "nan_to_zero":
            return {
                ...expr,
                value: substituteIrExpr(expr.value, substitution),
            };
        case "call":
            return {
                ...expr,
                args: expr.args.map((arg) => substituteIrExpr(arg, substitution)),
            };
        case "index":
            return {
                ...expr,
                array: substituteIrExpr(expr.array, substitution),
                indices: expr.indices.map((index) => substituteIrExpr(index, substitution)),
            };
        case "field":
            return {
                ...expr,
                target: substituteIrExpr(expr.target, substitution),
            };
        case "struct_cons":
            return {
                ...expr,
                fields: expr.fields.map((field) => substituteIrExpr(field, substitution)),
            };
        case "array_cons":
            return {
                ...expr,
                elements: expr.elements.map((element) => substituteIrExpr(element, substitution)),
            };
        case "array_expr":
        case "sum_expr": {
            const inner = new Map(substitution);
            for (const binding of expr.bindings) {
                inner.delete(binding.name);
            }
            return {
                ...expr,
                bindings: expr.bindings.map((binding) => ({
                    name: binding.name,
                    expr: substituteIrExpr(binding.expr, substitution),
                })),
                body: substituteIrExpr(expr.body, inner),
            };
        }
        case "rec":
            return {
                ...expr,
                args: expr.args.map((arg) => substituteIrExpr(arg, substitution)),
            };
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function freshenIrExpr(expr, freshIds) {
    const id = freshIds.next;
    freshIds.next += 1;
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
        case "void_lit":
        case "var":
        case "res":
            return { ...expr, id };
        case "binop":
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            return {
                ...expr,
                id,
                left: freshenIrExpr(expr.left, freshIds),
                right: freshenIrExpr(expr.right, freshIds),
            };
        case "unop":
        case "sat_neg":
            return {
                ...expr,
                id,
                operand: freshenIrExpr(expr.operand, freshIds),
            };
        case "nan_to_zero":
            return {
                ...expr,
                id,
                value: freshenIrExpr(expr.value, freshIds),
            };
        case "call":
            return {
                ...expr,
                id,
                args: expr.args.map((arg) => freshenIrExpr(arg, freshIds)),
            };
        case "index":
            return {
                ...expr,
                id,
                array: freshenIrExpr(expr.array, freshIds),
                indices: expr.indices.map((index) => freshenIrExpr(index, freshIds)),
            };
        case "field":
            return {
                ...expr,
                id,
                target: freshenIrExpr(expr.target, freshIds),
            };
        case "struct_cons":
            return {
                ...expr,
                id,
                fields: expr.fields.map((field) => freshenIrExpr(field, freshIds)),
            };
        case "array_cons":
            return {
                ...expr,
                id,
                elements: expr.elements.map((element) => freshenIrExpr(element, freshIds)),
            };
        case "array_expr":
        case "sum_expr":
            return {
                ...expr,
                id,
                bindings: expr.bindings.map((binding) => ({
                    name: binding.name,
                    expr: freshenIrExpr(binding.expr, freshIds),
                })),
                body: freshenIrExpr(expr.body, freshIds),
            };
        case "rec":
            return {
                ...expr,
                id,
                args: expr.args.map((arg) => freshenIrExpr(arg, freshIds)),
            };
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function constantIrPositiveExtent(expr) {
    const value = constantIrIntValue(expr);
    if (value === null) {
        return null;
    }
    return Math.max(1, Math.min(2147483647, Math.max(-2147483648, Math.trunc(value))));
}
function constantIrIntValue(expr) {
    switch (expr.tag) {
        case "int_lit":
            return expr.value;
        case "binop":
            if (expr.resultType.tag !== "int") {
                return null;
            }
            return constantIrIntBinop(expr.op, expr.left, expr.right);
        case "sat_add":
        case "sat_sub":
        case "sat_mul": {
            const left = constantIrIntValue(expr.left);
            const right = constantIrIntValue(expr.right);
            if (left === null || right === null) {
                return null;
            }
            if (expr.tag === "sat_add") {
                return clampIrInt32(left + right);
            }
            if (expr.tag === "sat_sub") {
                return clampIrInt32(left - right);
            }
            return clampIrInt32(left * right);
        }
        case "sat_neg": {
            const operand = constantIrIntValue(expr.operand);
            return operand === null ? null : clampIrInt32(-operand);
        }
        case "total_div":
            return constantIrIntBinop("/", expr.left, expr.right);
        case "total_mod":
            return constantIrIntBinop("%", expr.left, expr.right);
        case "call":
            return constantIrInterpretedIntCall(expr);
        default:
            return null;
    }
}
function constantIrIntBinop(op, leftExpr, rightExpr) {
    const left = constantIrIntValue(leftExpr);
    const right = constantIrIntValue(rightExpr);
    if (left === null || right === null) {
        return null;
    }
    if (op === "+") {
        return clampIrInt32(left + right);
    }
    if (op === "-") {
        return clampIrInt32(left - right);
    }
    if (op === "*") {
        return clampIrInt32(left * right);
    }
    if (right === 0) {
        return 0;
    }
    const quotient = Math.trunc(left / right);
    if (op === "/") {
        return clampIrInt32(quotient);
    }
    if (op === "%") {
        return clampIrInt32(left - right * quotient);
    }
    return null;
}
function constantIrInterpretedIntCall(expr) {
    if (expr.name === "abs" && expr.args.length === 1) {
        const value = constantIrIntValue(expr.args[0]);
        return value === null ? null : Math.abs(value);
    }
    if ((expr.name === "max" || expr.name === "min") && expr.args.length === 2) {
        const left = constantIrIntValue(expr.args[0]);
        const right = constantIrIntValue(expr.args[1]);
        if (left === null || right === null) {
            return null;
        }
        return expr.name === "max" ? Math.max(left, right) : Math.min(left, right);
    }
    if (expr.name === "clamp" && expr.args.length === 3) {
        const value = constantIrIntValue(expr.args[0]);
        const lo = constantIrIntValue(expr.args[1]);
        const hi = constantIrIntValue(expr.args[2]);
        if (value === null || lo === null || hi === null) {
            return null;
        }
        return Math.min(Math.max(value, lo), hi);
    }
    return null;
}
function clampIrInt32(value) {
    return Math.max(-2147483648, Math.min(2147483647, Math.trunc(value)));
}
function containsOpaqueValue(value) {
    switch (value.kind) {
        case "scalar":
        case "void":
            return false;
        case "opaque":
            return true;
        case "struct":
            return value.fields.some((field) => containsOpaqueValue(field.value));
        case "array":
            return containsOpaqueArray(value.array);
        default: {
            const _never = value;
            return _never;
        }
    }
}
function containsOpaqueArray(array) {
    switch (array.tag) {
        case "param":
        case "abstract":
            return containsOpaqueLeafModel(array.leafModel);
        case "slice":
            return containsOpaqueArray(array.base);
        case "literal":
            return array.elements.some(containsOpaqueValue);
        case "choice":
            return array.options.some(containsOpaqueArray);
        case "comprehension":
            return containsOpaqueValue(array.body);
        default: {
            const _never = array;
            return _never;
        }
    }
}
function containsOpaqueLeafModel(model) {
    switch (model.kind) {
        case "scalar":
            return false;
        case "opaque":
            return true;
        case "struct":
            return model.fields.some((field) => containsOpaqueLeafModel(field.model));
        default: {
            const _never = model;
            return _never;
        }
    }
}
function symbolizeUnaryScalar(expr, operand, build, stmtIndex, requireResultTag = true) {
    const tag = scalarTag(expr.resultType);
    if (operand.kind === "scalar" && (!requireResultTag || tag)) {
        return {
            kind: "scalar",
            expr: build(operand.expr, tag ?? scalarExprType(operand.expr)),
        };
    }
    return makeOpaque(expr.resultType, `${expr.tag}_${stmtIndex}_${expr.id}`, "ir:symbolizeUnaryScalar:fallback");
}
function symbolizeBinaryScalar(expr, left, right, build, stmtIndex, requireResultTag = true) {
    const tag = scalarTag(expr.resultType);
    if (left.kind === "scalar" && right.kind === "scalar" && (!requireResultTag || tag)) {
        return {
            kind: "scalar",
            expr: build(left.expr, right.expr, tag ?? scalarExprType(left.expr)),
        };
    }
    return makeOpaque(expr.resultType, `${expr.tag}_${stmtIndex}_${expr.id}`, "ir:symbolizeBinaryScalar:fallback");
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
                value: makeOpaque(expr.resultType, `${expr.tag}_${stmtIndex}_${expr.id}`, "ir:prepareComprehensionBindings:non_int_extent"),
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
function buildDenotationalUnaryScalarExpr(expr, operand, tag) {
    if (tag === "int" && expr.op === "-") {
        return { tag: "sat_neg", operand };
    }
    return { tag: "unop", op: expr.op, operand, valueType: tag };
}
function buildDenotationalBinaryScalarExpr(expr, left, right, tag) {
    if (expr.op === "/" || expr.op === "%") {
        if (isZeroScalarLiteral(right)) {
            return zeroScalarLiteral(tag);
        }
        const totalExpr = {
            tag: expr.op === "/" ? "total_div" : "total_mod",
            left,
            right,
            valueType: tag,
        };
        return tag === "float" ? { tag: "nan_to_zero", value: totalExpr } : totalExpr;
    }
    if (tag === "int") {
        if (expr.op === "+") {
            return { tag: "sat_add", left, right };
        }
        if (expr.op === "-") {
            return { tag: "sat_sub", left, right };
        }
        if (expr.op === "*") {
            return { tag: "sat_mul", left, right };
        }
    }
    const baseExpr = { tag: "binop", op: expr.op, left, right, valueType: tag };
    if (tag === "float" && (expr.op === "+" || expr.op === "-" || expr.op === "*")) {
        return { tag: "nan_to_zero", value: baseExpr };
    }
    return baseExpr;
}
function buildDenotationalScalarCallExpr(name, args, tag, interpreted) {
    const callExpr = {
        tag: "call",
        name,
        args,
        valueType: tag,
        interpreted,
    };
    if (tag === "float" && NAN_GUARDED_BUILTINS.has(name)) {
        return { tag: "nan_to_zero", value: callExpr };
    }
    return callExpr;
}
function isZeroScalarLiteral(expr) {
    return (expr.tag === "int_lit" || expr.tag === "float_lit") && expr.value === 0;
}
function zeroScalarLiteral(tag) {
    return tag === "float" ? { tag: "float_lit", value: 0 } : { tag: "int_lit", value: 0 };
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
    return renderDeclaredType(type);
}
function unique(values) {
    return [...new Set(values)];
}
//# sourceMappingURL=ir.js.map