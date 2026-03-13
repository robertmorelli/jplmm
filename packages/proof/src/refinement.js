import { executeProgram } from "@jplmm/optimize";
import { INT32_MAX, INT32_MIN, buildJplInt32Prelude as buildIntPrelude, buildJplScalarPrelude, checkSat, sanitizeSymbol as sanitize, } from "@jplmm/smt";
import { asPlainIntExpr, collectCalls, collectCallsRecursive, collectRecursiveCallPatterns, collectRecursiveSites, collectSummaryVars, emitCollapseCondition, emitIntExpr, formatIntAssignments, isSupportedIntBuiltin, queryIntCounterexample, queryIntValues, renderIntExpr, serializeRecArgs, substituteIntExpr, substituteRecursiveExpr, uniqueExprs, } from "./int";
import { analyzeIrFunction, buildCanonicalProgram, functionsAlphaEquivalent, hasRec, } from "./ir";
import { buildMeasureCounterexampleQuery, collectValueVars, emitScalarWithOverrides, emitValueEquality, extendSymbolicSubstitution, queryCounterexample, renderScalarExpr as renderSharedScalarExpr, renderValueExpr, scalarExprType, substituteScalar as substituteSharedScalar, substituteValue, symbolizeParamValue, } from "./scalar";
export function computeFunctionSummary(fnName, commands, typeMap, summaries) {
    const canonical = buildCanonicalProgram({ commands }, typeMap);
    const fn = canonical.functions.find((candidate) => candidate.name === fnName);
    if (!fn) {
        return null;
    }
    const availableFns = new Map(canonical.functions.map((candidate) => [candidate.name, candidate]));
    const env = new Map(summaries);
    env.delete(fnName);
    const summary = summarizeIntFunction(fn, availableFns, env);
    return summary.ok ? summary.summary : null;
}
export function checkFunctionRefinement(fnName, baselineCommands, refinedCommands, typeMap, summaries) {
    const baselineCanonical = buildCanonicalProgram({ commands: baselineCommands }, typeMap);
    const refinedCanonical = buildCanonicalProgram({ commands: refinedCommands }, typeMap);
    const baselineFn = baselineCanonical.functions.find((candidate) => candidate.name === fnName);
    const refinedFn = refinedCanonical.functions.find((candidate) => candidate.name === fnName);
    if (!baselineFn || !refinedFn) {
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: `ref '${fnName}' could not be analyzed because one implementation disappeared during canonical lowering`,
        };
    }
    if (functionsAlphaEquivalent(baselineFn, refinedFn)) {
        return {
            ok: true,
            method: "canonical",
            detail: "canonical semantics are alpha-equivalent after lowering",
        };
    }
    if (!hasRec(baselineFn) && !hasRec(refinedFn) && baselineFn.params.length === 0 && refinedFn.params.length === 0) {
        const baselineValue = executeProgram(baselineCanonical, fnName, []).value;
        const refinedValue = executeProgram(refinedCanonical, fnName, []).value;
        if (runtimeValueEquals(baselineValue, refinedValue)) {
            return {
                ok: true,
                method: "exact_zero_arity",
                detail: `zero-argument execution matched exactly: ${renderRuntimeValue(baselineValue)}`,
            };
        }
        return {
            ok: false,
            code: "REF_MISMATCH",
            message: `ref '${fnName}' changes zero-argument behavior: baseline=${renderRuntimeValue(baselineValue)}, ref=${renderRuntimeValue(refinedValue)}`,
        };
    }
    const priorSummaries = new Map(summaries);
    priorSummaries.delete(fnName);
    const baselineFunctions = new Map(baselineCanonical.functions.map((candidate) => [candidate.name, candidate]));
    const refinedFunctions = new Map(refinedCanonical.functions.map((candidate) => [candidate.name, candidate]));
    const baselineHasRec = hasRec(baselineFn);
    const refinedHasRec = hasRec(refinedFn);
    if (!baselineHasRec && !refinedHasRec) {
        const baselineSummary = summarizeIntFunction(baselineFn, baselineFunctions, priorSummaries);
        const refinedSummary = summarizeIntFunction(refinedFn, refinedFunctions, priorSummaries);
        if (baselineSummary.ok && refinedSummary.ok) {
            return proveIntSummaryEquivalence(fnName, baselineSummary.summary, refinedSummary.summary);
        }
        const reasons = [
            baselineSummary.ok ? null : `baseline: ${baselineSummary.reason}`,
            refinedSummary.ok ? null : `ref: ${refinedSummary.reason}`,
        ].filter((reason) => reason !== null);
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: reasons.length > 0
                ? `ref '${fnName}' could not be proven equivalent: ${reasons.join("; ")}`
                : `ref '${fnName}' could not be proven equivalent with the current refinement checker`,
        };
    }
    const baselineSummary = summarizeRecursiveScalarFunction(baselineFn, baselineFunctions, baselineCanonical.structs);
    const refinedSummary = summarizeRecursiveScalarFunction(refinedFn, refinedFunctions, refinedCanonical.structs);
    if (baselineSummary.ok && refinedSummary.ok) {
        return proveRecursiveScalarSummaryEquivalence(fnName, baselineCanonical, refinedCanonical, baselineSummary.summary, alignRecursiveScalarSummary(refinedSummary.summary, baselineSummary.summary.fn.params));
    }
    const reasons = [
        baselineSummary.ok ? null : `baseline: ${baselineSummary.reason}`,
        refinedSummary.ok ? null : `ref: ${refinedSummary.reason}`,
    ].filter((reason) => reason !== null);
    return {
        ok: false,
        code: "REF_UNPROVEN",
        message: reasons.length > 0
            ? `ref '${fnName}' could not be proven equivalent: ${reasons.join("; ")}`
            : `ref '${fnName}' could not be proven equivalent with the current refinement checker`,
    };
}
function summarizeRecursiveScalarFunction(fn, availableFns, structs) {
    if (fn.retType.tag !== "int") {
        return { ok: false, reason: "only scalar int refinements have an exact recursive checker today" };
    }
    const structDefs = new Map(structs.map((struct) => [struct.name, struct.fields]));
    const helperRecCalls = collectDirectRecursiveHelperCalls(fn, availableFns);
    if (helperRecCalls.length > 0) {
        return {
            ok: false,
            reason: helperRecCalls.length === 1
                ? `call to recursive helper '${helperRecCalls[0]}' needs a relational refinement proof beyond the current direct-recursion checker`
                : `calls to recursive helpers ${helperRecCalls.map((name) => `'${name}'`).join(", ")} need a relational refinement proof beyond the current direct-recursion checker`,
        };
    }
    const analysis = analyzeIrFunction(fn, structDefs);
    if (!analysis.result || analysis.result.kind !== "scalar" || scalarExprType(analysis.result.expr) !== "int") {
        return { ok: false, reason: "only scalar int return values are supported by the recursive refinement checker" };
    }
    const recSites = [];
    for (const site of analysis.recSites) {
        if (!site.resultSymbol) {
            return { ok: false, reason: "opaque recursive results are not yet supported in recursive refinement proofs" };
        }
        if (!site.currentRes || site.currentRes.kind !== "scalar" || scalarExprType(site.currentRes.expr) !== "int") {
            return { ok: false, reason: "recursive collapse currently requires an int-valued res at each rec site" };
        }
        recSites.push({
            stmtIndex: site.stmtIndex,
            resultSymbol: site.resultSymbol,
            currentRes: site.currentRes.expr,
            argValues: site.argValues,
            issues: site.issues,
        });
    }
    return {
        ok: true,
        summary: {
            fn,
            analysis,
            expr: analysis.result.expr,
            rads: analysis.radSites
                .map((rad) => rad.measure)
                .filter((measure) => scalarExprType(measure) === "int"),
            hasGas: fn.body.some((stmt) => stmt.tag === "gas"),
            helperRecCalls,
            structDefs,
            recSites,
        },
    };
}
function alignRecursiveScalarSummary(summary, params) {
    const callSigs = new Map(summary.analysis.callSigs);
    const substitution = new Map();
    const paramValues = new Map();
    const alignedParams = summary.fn.params.map((param, index) => ({
        ...param,
        name: params[index]?.name ?? param.name,
    }));
    for (let i = 0; i < summary.fn.params.length; i += 1) {
        const original = summary.fn.params[i];
        const aligned = alignedParams[i];
        const value = symbolizeParamValue(aligned, callSigs, summary.structDefs);
        substitution.set(original.name, value);
        paramValues.set(aligned.name, value);
    }
    const alignedResult = { kind: "scalar", expr: substituteSharedScalar(summary.expr, substitution) };
    return {
        ...summary,
        fn: {
            ...summary.fn,
            params: alignedParams,
        },
        analysis: {
            ...summary.analysis,
            paramValues,
            result: alignedResult,
            callSigs,
        },
        expr: alignedResult.expr,
        rads: summary.rads.map((rad) => substituteSharedScalar(rad, substitution)),
        recSites: summary.recSites.map((site) => ({
            ...site,
            currentRes: substituteSharedScalar(site.currentRes, substitution),
            argValues: new Map([...site.argValues.entries()].map(([index, value]) => [index, substituteValue(value, substitution)])),
        })),
    };
}
function proveRecursiveScalarSummaryEquivalence(fnName, baselineProgram, refinedProgram, baseline, refined) {
    if (baseline.hasGas || refined.hasGas) {
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: `ref '${fnName}' could not be proven equivalent: gas-based recursive refinements are not supported yet`,
        };
    }
    const candidateMeasures = uniqueScalarMeasures([...baseline.rads, ...refined.rads]);
    if (candidateMeasures.length === 0) {
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: `ref '${fnName}' could not be proven equivalent: no shared scalar-int rad candidate was available for recursive refinement proof`,
        };
    }
    const reasons = [];
    for (const measure of candidateMeasures) {
        const decrease = proveSharedRecursiveScalarMeasureDecreases(fnName, baseline, refined, measure);
        if (!decrease.ok) {
            reasons.push(decrease.message);
            continue;
        }
        const step = proveRecursiveScalarStepEquivalence(fnName, baselineProgram, refinedProgram, baseline, refined, measure);
        if (step.ok || step.code === "REF_MISMATCH") {
            return step;
        }
        reasons.push(step.message);
    }
    return {
        ok: false,
        code: "REF_UNPROVEN",
        message: `ref '${fnName}' could not be proven equivalent for recursive scalar-int bodies: ${uniqueStrings(reasons).join("; ")}`,
    };
}
function proveSharedRecursiveScalarMeasureDecreases(fnName, baseline, refined, measure) {
    const sites = [
        ...baseline.recSites.map((site, index) => ({
            label: `baseline site ${index + 1}`,
            summary: baseline,
            site,
        })),
        ...refined.recSites.map((site, index) => ({
            label: `ref site ${index + 1}`,
            summary: refined,
            site,
        })),
    ];
    for (const entry of sites) {
        const query = buildRecursiveMeasureQuery(entry.summary, entry.site, measure);
        if (!query.ok) {
            return {
                ok: false,
                message: `ref '${fnName}' could not prove recursive rad '${renderSharedScalarExpr(measure)}' at ${entry.label}: ${query.reason}`,
            };
        }
        const result = checkSat(query.query.baseLines);
        if (!result.ok) {
            return {
                ok: false,
                message: `ref '${fnName}' could not invoke z3 while checking recursive rad '${renderSharedScalarExpr(measure)}': ${result.error}`,
            };
        }
        if (result.status === "unsat") {
            continue;
        }
        if (result.status === "sat") {
            const witness = queryCounterexample(query.query);
            return {
                ok: false,
                message: `rad '${renderSharedScalarExpr(measure)}' does not decrease at ${entry.label}${witness ? `: ${witness}` : ""}`,
            };
        }
        return {
            ok: false,
            message: `z3 returned '${result.output || "unknown"}' while checking recursive rad '${renderSharedScalarExpr(measure)}'`,
        };
    }
    return { ok: true };
}
function buildRecursiveMeasureQuery(summary, site, measure) {
    if (site.issues.length > 0) {
        return {
            ok: false,
            reason: site.issues.join("; "),
        };
    }
    const substitution = new Map();
    for (let i = 0; i < summary.fn.params.length; i += 1) {
        const param = summary.fn.params[i];
        const next = site.argValues.get(i);
        if (!next) {
            return {
                ok: false,
                reason: `rec site is missing argument '${param.name}'`,
            };
        }
        substitution.set(param.name, next);
        const current = summary.analysis.paramValues.get(param.name);
        if (current) {
            extendSymbolicSubstitution(current, next, substitution);
        }
    }
    const nextMeasure = substituteSharedScalar(measure, substitution);
    return buildMeasureCounterexampleQuery(summary.fn.params, measure, nextMeasure, substitution, summary.analysis.callSigs, summary.analysis.paramValues);
}
function proveRecursiveScalarStepEquivalence(fnName, baselineProgram, refinedProgram, baseline, refined, measure) {
    const lines = buildJplScalarPrelude();
    const callSigs = new Map([...baseline.analysis.callSigs, ...refined.analysis.callSigs]);
    for (const [name, sig] of callSigs) {
        const domain = sig.args.map((arg) => (arg === "int" ? "Int" : "Real")).join(" ");
        const sort = sig.ret === "int" ? "Int" : "Real";
        lines.push(`(declare-fun ${sanitize(name)} (${domain}) ${sort})`);
    }
    const placeholderNames = new Set([
        ...baseline.recSites.map((site) => site.resultSymbol),
        ...refined.recSites.map((site) => site.resultSymbol),
    ]);
    const vars = new Map();
    collectValueVars({ kind: "scalar", expr: baseline.expr }, vars);
    collectValueVars({ kind: "scalar", expr: refined.expr }, vars);
    collectValueVars({ kind: "scalar", expr: measure }, vars);
    for (const value of baseline.analysis.paramValues.values()) {
        collectValueVars(value, vars);
    }
    for (const value of refined.analysis.paramValues.values()) {
        collectValueVars(value, vars);
    }
    for (const site of [...baseline.recSites, ...refined.recSites]) {
        collectValueVars({ kind: "scalar", expr: site.currentRes }, vars);
        for (const value of site.argValues.values()) {
            collectValueVars(value, vars);
        }
    }
    for (const name of placeholderNames) {
        vars.delete(name);
    }
    for (const [name, tag] of vars) {
        lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
        if (tag === "int") {
            lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
            lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
        }
    }
    const hypotheses = new Map();
    let hypothesisIndex = 0;
    for (const key of collectRecursivePatternKeys(baseline, refined)) {
        const symbol = `jplmm_h_${hypothesisIndex}`;
        hypothesisIndex += 1;
        hypotheses.set(key, symbol);
        lines.push(`(declare-const ${symbol} Int)`);
        lines.push(`(assert (<= ${INT32_MIN} ${symbol}))`);
        lines.push(`(assert (<= ${symbol} ${INT32_MAX}))`);
    }
    const baselineBindings = buildRecursiveScalarBindings(baseline, hypotheses);
    if (!baselineBindings.ok) {
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: `ref '${fnName}' could not be proven equivalent: baseline: ${baselineBindings.reason}`,
        };
    }
    const refinedBindings = buildRecursiveScalarBindings(refined, hypotheses);
    if (!refinedBindings.ok) {
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: `ref '${fnName}' could not be proven equivalent: ref: ${refinedBindings.reason}`,
        };
    }
    lines.push(`(assert (not (= ${emitRecursiveScalarExpr(baseline.expr, baselineBindings.bindings)} ${emitRecursiveScalarExpr(refined.expr, refinedBindings.bindings)})))`);
    const result = checkSat(lines);
    if (!result.ok) {
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: `ref '${fnName}' could not invoke z3 for recursive refinement proof: ${result.error}`,
        };
    }
    if (result.status === "unsat") {
        return {
            ok: true,
            method: "scalar_int_recursive_induction",
            detail: `proved recursive scalar-int equivalence by induction on rad '${renderSharedScalarExpr(measure)}'`,
            equivalence: `shared rad '${renderSharedScalarExpr(measure)}' closes all recursive sites and aligns the inductive step`,
        };
    }
    if (result.status === "sat") {
        if (baseline.fn.params.every((param) => param.type.tag === "int")) {
            const values = queryIntValues(lines, baseline.fn.params.map((param) => param.name));
            const runtimeCounterexample = values
                ? tryRuntimeRecursiveCounterexample(fnName, baselineProgram, refinedProgram, baseline.fn.params.map((param) => param.name), values)
                : null;
            if (runtimeCounterexample) {
                return {
                    ok: false,
                    code: "REF_MISMATCH",
                    message: `ref '${fnName}' is not equivalent: ${runtimeCounterexample}`,
                };
            }
            const witness = values
                ? formatIntAssignments(baseline.fn.params.map((param) => param.name), values)
                : queryIntCounterexample(lines, baseline.fn.params.map((param) => param.name));
            return {
                ok: false,
                code: "REF_UNPROVEN",
                message: `ref '${fnName}' did not admit an inductive proof for rad '${renderSharedScalarExpr(measure)}'${witness ? `; witness: ${witness}` : ""}`,
            };
        }
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: `ref '${fnName}' did not admit an inductive proof for rad '${renderSharedScalarExpr(measure)}'`,
        };
    }
    return {
        ok: false,
        code: "REF_UNPROVEN",
        message: `ref '${fnName}' could not be proven equivalent: z3 returned '${result.output || "unknown"}' for the recursive inductive step`,
    };
}
function buildRecursiveScalarBindings(summary, hypotheses) {
    const sites = new Map(summary.recSites.map((site) => [site.resultSymbol, site]));
    const cache = new Map();
    const active = new Set();
    const renderSite = (symbol) => {
        if (cache.has(symbol)) {
            return cache.get(symbol);
        }
        if (active.has(symbol)) {
            return null;
        }
        const site = sites.get(symbol);
        if (!site) {
            return null;
        }
        const collapse = emitRecursiveCollapse(summary, site);
        if (!collapse) {
            return null;
        }
        const hypothesis = hypotheses.get(recursivePatternKey(summary.fn.name, site.argValues));
        if (!hypothesis) {
            return null;
        }
        active.add(symbol);
        const currentRes = emitRecursiveScalarExpr(site.currentRes, cache, renderSite);
        active.delete(symbol);
        const rendered = `(ite ${collapse} ${currentRes} ${hypothesis})`;
        cache.set(symbol, rendered);
        return rendered;
    };
    for (const site of summary.recSites) {
        if (!renderSite(site.resultSymbol)) {
            return {
                ok: false,
                reason: `could not build recursive hypothesis for site ${site.stmtIndex + 1}`,
            };
        }
    }
    return { ok: true, bindings: cache };
}
function emitRecursiveCollapse(summary, site) {
    const clauses = [];
    for (let i = 0; i < summary.fn.params.length; i += 1) {
        const param = summary.fn.params[i];
        const current = summary.analysis.paramValues.get(param.name);
        const next = site.argValues.get(i);
        if (!current || !next) {
            return null;
        }
        const equality = emitValueEquality(current, next, param.type);
        if (!equality) {
            return null;
        }
        clauses.push(equality);
    }
    if (clauses.length === 0) {
        return "true";
    }
    return clauses.length === 1 ? clauses[0] : `(and ${clauses.join(" ")})`;
}
function emitRecursiveScalarExpr(expr, bindings, resolver = null) {
    return emitScalarWithOverrides(expr, {
        onVar: (variable) => {
            const bound = bindings.get(variable.name) ?? resolver?.(variable.name) ?? null;
            return bound;
        },
    });
}
function collectRecursivePatternKeys(baseline, refined) {
    return uniqueStrings([
        ...baseline.recSites.map((site) => recursivePatternKey(baseline.fn.name, site.argValues)),
        ...refined.recSites.map((site) => recursivePatternKey(refined.fn.name, site.argValues)),
    ]);
}
function recursivePatternKey(relationName, argValues) {
    const ordered = [...argValues.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, value]) => renderValueExpr(value));
    return `${relationName}::${ordered.join("||")}`;
}
function uniqueScalarMeasures(exprs) {
    const out = [];
    const seen = new Set();
    for (const expr of exprs) {
        const key = renderSharedScalarExpr(expr);
        if (!seen.has(key)) {
            seen.add(key);
            out.push(expr);
        }
    }
    return out;
}
function collectDirectRecursiveHelperCalls(fn, availableFns) {
    const found = new Set();
    const visit = (expr) => {
        switch (expr.tag) {
            case "call": {
                const callee = availableFns.get(expr.name);
                if (callee && hasRec(callee)) {
                    found.add(expr.name);
                }
                for (const arg of expr.args) {
                    visit(arg);
                }
                return;
            }
            case "unop":
            case "sat_neg":
                visit(expr.tag === "unop" ? expr.operand : expr.operand);
                return;
            case "binop":
            case "sat_add":
            case "sat_sub":
            case "sat_mul":
            case "total_div":
            case "total_mod":
                visit(expr.left);
                visit(expr.right);
                return;
            case "nan_to_zero":
                visit(expr.value);
                return;
            case "index":
                visit(expr.array);
                for (const index of expr.indices) {
                    visit(index);
                }
                return;
            case "field":
                visit(expr.target);
                return;
            case "struct_cons":
                for (const field of expr.fields) {
                    visit(field);
                }
                return;
            case "array_cons":
                for (const element of expr.elements) {
                    visit(element);
                }
                return;
            case "array_expr":
            case "sum_expr":
                for (const binding of expr.bindings) {
                    visit(binding.expr);
                }
                visit(expr.body);
                return;
            case "rec":
                for (const arg of expr.args) {
                    visit(arg);
                }
                return;
            default:
                return;
        }
    };
    for (const stmt of fn.body) {
        if (stmt.tag === "let" || stmt.tag === "ret" || stmt.tag === "rad") {
            visit(stmt.expr);
        }
    }
    return [...found];
}
function summarizeRecursiveIntFunction(fn, availableFns, summaries) {
    if (fn.retType.tag !== "int") {
        return { ok: false, reason: "only scalar int refinements have an exact recursive checker today" };
    }
    if (fn.params.some((param) => param.type.tag !== "int")) {
        return { ok: false, reason: "only scalar int parameters are supported by the recursive refinement checker" };
    }
    const env = new Map();
    for (const param of fn.params) {
        env.set(param.name, { tag: "var", name: param.name });
    }
    let currentRes = null;
    let hasGas = false;
    const rads = [];
    for (const stmt of fn.body) {
        if (stmt.tag === "gas") {
            hasGas = true;
            continue;
        }
        if (stmt.tag === "rad") {
            const radExpr = summarizeRecursiveIntExpr(stmt.expr, env, currentRes, availableFns, summaries);
            if (radExpr.ok) {
                const plain = asPlainIntExpr(radExpr.expr);
                if (plain) {
                    rads.push(plain);
                }
            }
            continue;
        }
        if (stmt.tag === "let") {
            const expr = summarizeRecursiveIntExpr(stmt.expr, env, currentRes, availableFns, summaries);
            if (!expr.ok) {
                return expr;
            }
            env.set(stmt.name, expr.expr);
            continue;
        }
        if (stmt.tag === "ret") {
            const expr = summarizeRecursiveIntExpr(stmt.expr, env, currentRes, availableFns, summaries);
            if (!expr.ok) {
                return expr;
            }
            currentRes = expr.expr;
        }
    }
    return {
        ok: true,
        summary: {
            paramNames: fn.params.map((param) => param.name),
            expr: currentRes ?? { tag: "int_lit", value: 0 },
            rads,
            hasRec: hasRec(fn),
            hasGas,
        },
    };
}
function summarizeRecursiveIntExpr(expr, env, currentRes, availableFns, summaries) {
    switch (expr.tag) {
        case "int_lit":
            return { ok: true, expr: { tag: "int_lit", value: expr.value } };
        case "var": {
            const value = env.get(expr.name);
            if (!value) {
                return { ok: false, reason: `free variable '${expr.name}' is not supported in recursive refinement summaries` };
            }
            return { ok: true, expr: value };
        }
        case "res":
            if (!currentRes) {
                return { ok: false, reason: "res was not available while building the recursive refinement summary" };
            }
            return { ok: true, expr: currentRes };
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod": {
            const left = summarizeRecursiveIntExpr(expr.left, env, currentRes, availableFns, summaries);
            if (!left.ok) {
                return left;
            }
            const right = summarizeRecursiveIntExpr(expr.right, env, currentRes, availableFns, summaries);
            if (!right.ok) {
                return right;
            }
            return {
                ok: true,
                expr: {
                    tag: expr.tag,
                    left: left.expr,
                    right: right.expr,
                },
            };
        }
        case "sat_neg": {
            const operand = summarizeRecursiveIntExpr(expr.operand, env, currentRes, availableFns, summaries);
            if (!operand.ok) {
                return operand;
            }
            return { ok: true, expr: { tag: "sat_neg", operand: operand.expr } };
        }
        case "call": {
            const recursiveArgs = [];
            const plainArgs = [];
            let allPlain = true;
            for (const arg of expr.args) {
                const summarized = summarizeRecursiveIntExpr(arg, env, currentRes, availableFns, summaries);
                if (!summarized.ok) {
                    return summarized;
                }
                recursiveArgs.push(summarized.expr);
                const plainArg = asPlainIntExpr(summarized.expr);
                if (!plainArg) {
                    allPlain = false;
                    continue;
                }
                plainArgs.push(plainArg);
            }
            if (isSupportedIntBuiltin(expr.name, recursiveArgs.length)) {
                return { ok: true, expr: { tag: "call", name: expr.name, args: recursiveArgs, interpreted: true } };
            }
            const summary = summaries.get(expr.name);
            if (summary && allPlain) {
                return {
                    ok: true,
                    expr: substituteIntExpr(summary.expr, new Map(summary.paramNames.map((name, index) => [name, plainArgs[index]]))),
                };
            }
            const callee = availableFns.get(expr.name);
            if (!callee) {
                return { ok: false, reason: `call to unknown function '${expr.name}' cannot be summarized` };
            }
            if (callee.retType.tag !== "int" || callee.params.some((param) => param.type.tag !== "int")) {
                return { ok: false, reason: `call to '${expr.name}' leaves the scalar-int refinement subset` };
            }
            if (hasRec(callee)) {
                return { ok: false, reason: `call to recursive helper '${expr.name}' is not yet supported in recursive refinement proofs` };
            }
            return { ok: true, expr: { tag: "call", name: expr.name, args: recursiveArgs, interpreted: false } };
        }
        case "rec": {
            if (!currentRes) {
                return { ok: false, reason: "recursive calls need an established res value in this refinement checker" };
            }
            const args = [];
            for (const arg of expr.args) {
                const summarized = summarizeRecursiveIntExpr(arg, env, currentRes, availableFns, summaries);
                if (!summarized.ok) {
                    return summarized;
                }
                const plainArg = asPlainIntExpr(summarized.expr);
                if (!plainArg) {
                    return { ok: false, reason: "recursive call arguments cannot depend on recursive results in this refinement checker" };
                }
                args.push(plainArg);
            }
            return { ok: true, expr: { tag: "rec", args, currentRes } };
        }
        default:
            return { ok: false, reason: `IR node '${expr.tag}' leaves the recursive scalar-int refinement subset` };
    }
}
function alignRecursiveSummary(summary, paramNames) {
    const recursiveSubstitution = new Map(summary.paramNames.map((name, index) => [
        name,
        { tag: "var", name: paramNames[index] ?? name },
    ]));
    const intSubstitution = new Map(summary.paramNames.map((name, index) => [
        name,
        { tag: "var", name: paramNames[index] ?? name },
    ]));
    return {
        ...summary,
        paramNames: [...paramNames],
        expr: substituteRecursiveExpr(summary.expr, recursiveSubstitution),
        rads: summary.rads.map((rad) => substituteIntExpr(rad, intSubstitution)),
    };
}
function summarizeIntFunction(fn, availableFns, summaries) {
    if (fn.retType.tag !== "int") {
        return { ok: false, reason: "only scalar int refinements have an exact SMT checker today" };
    }
    if (fn.params.some((param) => param.type.tag !== "int")) {
        return { ok: false, reason: "only scalar int parameters are supported by the exact SMT refinement checker" };
    }
    if (hasRec(fn)) {
        return { ok: false, reason: "recursive refinements need a dedicated relational/CHC proof path and are not enabled yet" };
    }
    const env = new Map();
    for (const param of fn.params) {
        env.set(param.name, { tag: "var", name: param.name });
    }
    let currentRes = null;
    for (const stmt of fn.body) {
        if (stmt.tag === "rad" || stmt.tag === "gas") {
            continue;
        }
        if (stmt.tag === "let") {
            const expr = summarizeIntExpr(stmt.expr, env, currentRes, availableFns, summaries);
            if (!expr.ok) {
                return expr;
            }
            env.set(stmt.name, expr.expr);
            continue;
        }
        if (stmt.tag === "ret") {
            const expr = summarizeIntExpr(stmt.expr, env, currentRes, availableFns, summaries);
            if (!expr.ok) {
                return expr;
            }
            currentRes = expr.expr;
        }
    }
    return {
        ok: true,
        summary: {
            paramNames: fn.params.map((param) => param.name),
            expr: currentRes ?? { tag: "int_lit", value: 0 },
        },
    };
}
function summarizeIntExpr(expr, env, currentRes, availableFns, summaries) {
    switch (expr.tag) {
        case "int_lit":
            return { ok: true, expr: { tag: "int_lit", value: expr.value } };
        case "var": {
            const value = env.get(expr.name);
            if (!value) {
                return { ok: false, reason: `free variable '${expr.name}' is not supported in refinement summaries` };
            }
            return { ok: true, expr: value };
        }
        case "res":
            if (!currentRes) {
                return { ok: false, reason: "res was not available while building the refinement summary" };
            }
            return { ok: true, expr: currentRes };
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod": {
            const left = summarizeIntExpr(expr.left, env, currentRes, availableFns, summaries);
            if (!left.ok) {
                return left;
            }
            const right = summarizeIntExpr(expr.right, env, currentRes, availableFns, summaries);
            if (!right.ok) {
                return right;
            }
            return {
                ok: true,
                expr: {
                    tag: expr.tag,
                    left: left.expr,
                    right: right.expr,
                },
            };
        }
        case "sat_neg": {
            const operand = summarizeIntExpr(expr.operand, env, currentRes, availableFns, summaries);
            if (!operand.ok) {
                return operand;
            }
            return { ok: true, expr: { tag: "sat_neg", operand: operand.expr } };
        }
        case "call": {
            const args = [];
            for (const arg of expr.args) {
                const summarized = summarizeIntExpr(arg, env, currentRes, availableFns, summaries);
                if (!summarized.ok) {
                    return summarized;
                }
                args.push(summarized.expr);
            }
            if (isSupportedIntBuiltin(expr.name, args.length)) {
                return { ok: true, expr: { tag: "call", name: expr.name, args, interpreted: true } };
            }
            const summary = summaries.get(expr.name);
            if (summary) {
                return {
                    ok: true,
                    expr: substituteIntExpr(summary.expr, new Map(summary.paramNames.map((name, index) => [name, args[index]]))),
                };
            }
            const callee = availableFns.get(expr.name);
            if (!callee) {
                return { ok: false, reason: `call to unknown function '${expr.name}' cannot be summarized` };
            }
            if (callee.retType.tag !== "int" || callee.params.some((param) => param.type.tag !== "int")) {
                return { ok: false, reason: `call to '${expr.name}' leaves the scalar-int refinement subset` };
            }
            return { ok: true, expr: { tag: "call", name: expr.name, args, interpreted: false } };
        }
        default:
            return { ok: false, reason: `IR node '${expr.tag}' leaves the exact scalar-int refinement subset` };
    }
}
function proveIntSummaryEquivalence(fnName, baseline, refined) {
    const alignedRefinedExpr = substituteIntExpr(refined.expr, new Map(refined.paramNames.map((name, index) => [
        name,
        { tag: "var", name: baseline.paramNames[index] ?? name },
    ])));
    const vars = collectSummaryVars(baseline.paramNames, baseline.expr, alignedRefinedExpr);
    const lines = buildIntPrelude();
    const calls = new Map();
    collectCalls(baseline.expr, calls);
    collectCalls(alignedRefinedExpr, calls);
    for (const [name, arity] of calls) {
        lines.push(`(declare-fun ${sanitize(name)} (${new Array(arity).fill("Int").join(" ")}) Int)`);
    }
    for (const name of vars) {
        lines.push(`(declare-const ${sanitize(name)} Int)`);
        lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
        lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
    }
    lines.push(`(assert (not (= ${emitIntExpr(baseline.expr)} ${emitIntExpr(alignedRefinedExpr)})))`);
    const result = checkSat(lines);
    if (!result.ok) {
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: `ref '${fnName}' could not invoke z3: ${result.error}`,
        };
    }
    if (result.status === "unsat") {
        return {
            ok: true,
            method: "scalar_int_smt",
            detail: "proved scalar-int equivalence with Z3",
            equivalence: `${renderIntExpr(baseline.expr)} == ${renderIntExpr(alignedRefinedExpr)}`,
        };
    }
    if (result.status === "sat") {
        const counterexample = queryIntCounterexample(lines, vars);
        return {
            ok: false,
            code: "REF_MISMATCH",
            message: counterexample
                ? `ref '${fnName}' is not equivalent: ${counterexample}`
                : `ref '${fnName}' is not equivalent: z3 found an integer counterexample`,
        };
    }
    return {
        ok: false,
        code: "REF_UNPROVEN",
        message: `ref '${fnName}' could not be proven equivalent: z3 returned '${result.output || "unknown"}'`,
    };
}
function proveRecursiveIntSummaryEquivalence(fnName, baselineProgram, refinedProgram, baseline, refined) {
    if (baseline.hasGas || refined.hasGas) {
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: `ref '${fnName}' could not be proven equivalent: gas-based recursive refinements are not supported yet`,
        };
    }
    const candidateMeasures = uniqueExprs([...baseline.rads, ...refined.rads]);
    if (candidateMeasures.length === 0) {
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: `ref '${fnName}' could not be proven equivalent: no shared scalar-int rad candidate was available for recursive refinement proof`,
        };
    }
    const reasons = [];
    for (const measure of candidateMeasures) {
        const decrease = proveSharedRecursiveMeasureDecreases(fnName, baseline, refined, measure);
        if (!decrease.ok) {
            reasons.push(decrease.message);
            continue;
        }
        const step = proveRecursiveStepEquivalence(fnName, baselineProgram, refinedProgram, baseline, refined, measure);
        if (step.ok || step.code === "REF_MISMATCH") {
            return step;
        }
        reasons.push(step.message);
    }
    return {
        ok: false,
        code: "REF_UNPROVEN",
        message: `ref '${fnName}' could not be proven equivalent for recursive scalar-int bodies: ${uniqueStrings(reasons).join("; ")}`,
    };
}
function proveSharedRecursiveMeasureDecreases(fnName, baseline, refined, measure) {
    const sites = [
        ...collectRecursiveSites(baseline.expr).map((site, index) => ({ label: `baseline site ${index + 1}`, args: site.args })),
        ...collectRecursiveSites(refined.expr).map((site, index) => ({ label: `ref site ${index + 1}`, args: site.args })),
    ];
    for (const site of sites) {
        const lines = buildIntPrelude();
        const calls = new Map();
        collectCalls(measure, calls);
        for (const arg of site.args) {
            collectCalls(arg, calls);
        }
        for (const [name, arity] of calls) {
            lines.push(`(declare-fun ${sanitize(name)} (${new Array(arity).fill("Int").join(" ")}) Int)`);
        }
        for (const name of baseline.paramNames) {
            lines.push(`(declare-const ${sanitize(name)} Int)`);
            lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
            lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
        }
        const nextMeasure = emitIntExpr(substituteIntExpr(measure, new Map(baseline.paramNames.map((name, index) => [name, site.args[index]]))));
        lines.push(`(assert (not ${emitCollapseCondition(site.args, baseline.paramNames)}))`);
        lines.push(`(assert (not (< ${nextMeasure} ${emitIntExpr(measure)})))`);
        const result = checkSat(lines);
        if (!result.ok) {
            return {
                ok: false,
                message: `ref '${fnName}' could not invoke z3 while checking recursive rad '${renderIntExpr(measure)}': ${result.error}`,
            };
        }
        if (result.status === "unsat") {
            continue;
        }
        if (result.status === "sat") {
            const witness = queryIntCounterexample(lines, baseline.paramNames);
            return {
                ok: false,
                message: `rad '${renderIntExpr(measure)}' does not decrease at ${site.label}${witness ? `: ${witness}` : ""}`,
            };
        }
        return {
            ok: false,
            message: `z3 returned '${result.output || "unknown"}' while checking recursive rad '${renderIntExpr(measure)}'`,
        };
    }
    return { ok: true };
}
function proveRecursiveStepEquivalence(fnName, baselineProgram, refinedProgram, baseline, refined, measure) {
    const patterns = new Map();
    collectRecursiveCallPatterns(baseline.expr, patterns);
    collectRecursiveCallPatterns(refined.expr, patterns);
    const lines = buildIntPrelude();
    const calls = new Map();
    collectCallsRecursive(baseline.expr, calls);
    collectCallsRecursive(refined.expr, calls);
    collectCalls(measure, calls);
    for (const [name, arity] of calls) {
        lines.push(`(declare-fun ${sanitize(name)} (${new Array(arity).fill("Int").join(" ")}) Int)`);
    }
    for (const name of baseline.paramNames) {
        lines.push(`(declare-const ${sanitize(name)} Int)`);
        lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
        lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
    }
    const hypotheses = new Map();
    let hypothesisIndex = 0;
    for (const key of patterns.keys()) {
        const symbol = `jplmm_h_${hypothesisIndex}`;
        hypothesisIndex += 1;
        hypotheses.set(key, symbol);
        lines.push(`(declare-const ${symbol} Int)`);
        lines.push(`(assert (<= ${INT32_MIN} ${symbol}))`);
        lines.push(`(assert (<= ${symbol} ${INT32_MAX}))`);
    }
    lines.push(`(assert (not (= ${emitRecursiveStepExpr(baseline.expr, baseline.paramNames, hypotheses)} ${emitRecursiveStepExpr(refined.expr, baseline.paramNames, hypotheses)})))`);
    const result = checkSat(lines);
    if (!result.ok) {
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: `ref '${fnName}' could not invoke z3 for recursive refinement proof: ${result.error}`,
        };
    }
    if (result.status === "unsat") {
        return {
            ok: true,
            method: "scalar_int_recursive_induction",
            detail: `proved recursive scalar-int equivalence by induction on rad '${renderIntExpr(measure)}'`,
            equivalence: `shared rad '${renderIntExpr(measure)}' closes all recursive sites and aligns the inductive step`,
        };
    }
    if (result.status === "sat") {
        const values = queryIntValues(lines, baseline.paramNames);
        const runtimeCounterexample = values
            ? tryRuntimeRecursiveCounterexample(fnName, baselineProgram, refinedProgram, baseline.paramNames, values)
            : null;
        if (runtimeCounterexample) {
            return {
                ok: false,
                code: "REF_MISMATCH",
                message: `ref '${fnName}' is not equivalent: ${runtimeCounterexample}`,
            };
        }
        const witness = values ? formatIntAssignments(baseline.paramNames, values) : queryIntCounterexample(lines, baseline.paramNames);
        return {
            ok: false,
            code: "REF_UNPROVEN",
            message: `ref '${fnName}' did not admit an inductive proof for rad '${renderIntExpr(measure)}'${witness ? `; witness: ${witness}` : ""}`,
        };
    }
    return {
        ok: false,
        code: "REF_UNPROVEN",
        message: `ref '${fnName}' could not be proven equivalent: z3 returned '${result.output || "unknown"}' for the recursive inductive step`,
    };
}
function emitRecursiveStepExpr(expr, paramNames, hypotheses) {
    switch (expr.tag) {
        case "int_lit":
            return `${expr.value}`;
        case "var":
            return sanitize(expr.name);
        case "sat_add":
            return `(sat_add_int ${emitRecursiveStepExpr(expr.left, paramNames, hypotheses)} ${emitRecursiveStepExpr(expr.right, paramNames, hypotheses)})`;
        case "sat_sub":
            return `(sat_sub_int ${emitRecursiveStepExpr(expr.left, paramNames, hypotheses)} ${emitRecursiveStepExpr(expr.right, paramNames, hypotheses)})`;
        case "sat_mul":
            return `(sat_mul_int ${emitRecursiveStepExpr(expr.left, paramNames, hypotheses)} ${emitRecursiveStepExpr(expr.right, paramNames, hypotheses)})`;
        case "sat_neg":
            return `(sat_neg_int ${emitRecursiveStepExpr(expr.operand, paramNames, hypotheses)})`;
        case "total_div":
            return `(total_div_int ${emitRecursiveStepExpr(expr.left, paramNames, hypotheses)} ${emitRecursiveStepExpr(expr.right, paramNames, hypotheses)})`;
        case "total_mod":
            return `(total_mod_int ${emitRecursiveStepExpr(expr.left, paramNames, hypotheses)} ${emitRecursiveStepExpr(expr.right, paramNames, hypotheses)})`;
        case "call": {
            const args = expr.args.map((arg) => emitRecursiveStepExpr(arg, paramNames, hypotheses)).join(" ");
            if (!expr.interpreted) {
                return `(${sanitize(expr.name)} ${args})`;
            }
            switch (expr.name) {
                case "max":
                    return `(max_int ${args})`;
                case "min":
                    return `(min_int ${args})`;
                case "abs":
                    return `(abs_int ${args})`;
                case "clamp":
                    return `(clamp_range_int ${args})`;
                default:
                    return `(${sanitize(expr.name)} ${args})`;
            }
        }
        case "rec": {
            const key = serializeRecArgs(expr.args);
            const hypothesis = hypotheses.get(key);
            if (!hypothesis) {
                throw new Error(`Missing recursive hypothesis for '${key}'`);
            }
            return `(ite ${emitCollapseCondition(expr.args, paramNames)} ${emitRecursiveStepExpr(expr.currentRes, paramNames, hypotheses)} ${hypothesis})`;
        }
    }
}
function uniqueStrings(values) {
    return [...new Set(values)];
}
function tryRuntimeRecursiveCounterexample(fnName, baselineProgram, refinedProgram, paramNames, values) {
    const args = paramNames.map((name) => values.get(name) ?? 0);
    const baselineValue = executeProgram(baselineProgram, fnName, args).value;
    const refinedValue = executeProgram(refinedProgram, fnName, args).value;
    if (!runtimeValueEquals(baselineValue, refinedValue)) {
        return `${formatIntAssignments(paramNames, values) ?? "counterexample"}; baseline=${renderRuntimeValue(baselineValue)}, ref=${renderRuntimeValue(refinedValue)}`;
    }
    return null;
}
function runtimeValueEquals(left, right) {
    if (typeof left === "number" || typeof right === "number") {
        return typeof left === "number" && typeof right === "number" && Object.is(left, right);
    }
    if (left.kind === "struct" && right.kind === "struct") {
        return left.typeName === right.typeName
            && left.fields.length === right.fields.length
            && left.fields.every((field, index) => runtimeValueEquals(field, right.fields[index]));
    }
    if (left.kind === "array" && right.kind === "array") {
        return left.elementType.tag === right.elementType.tag
            && left.dims.length === right.dims.length
            && left.dims.every((dim, index) => dim === right.dims[index])
            && left.values.length === right.values.length
            && left.values.every((value, index) => runtimeValueEquals(value, right.values[index]));
    }
    return false;
}
function renderRuntimeValue(value) {
    if (typeof value === "number") {
        return `${value}`;
    }
    if (value.kind === "struct") {
        return `${value.typeName} { ${value.fields.map((field) => renderRuntimeValue(field)).join(", ")} }`;
    }
    return `[${value.values.map((item) => renderRuntimeValue(item)).join(", ")}]`;
}
//# sourceMappingURL=refinement.js.map