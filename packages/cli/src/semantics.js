import { executeProgram, matchClosedForms, } from "@jplmm/optimize";
import { analyzeIrFunction, appendScalarTypeConstraints, appendSmtEncodingState, buildComparisonEnvFromParams, buildIrCallSummaries, canEncodeScalarExprWithSmt, checkIrFunctionRefinement, collectValueVars, createSmtEncodingState, emitScalarWithOverrides, hasRec, normalizeValueForComparison, renderIrExpr, renderIrFunction, } from "@jplmm/proof";
import { INT32_MAX, INT32_MIN, buildJplScalarPrelude, checkSat, sanitizeSymbol as sanitize, } from "@jplmm/smt";
import { analyzeProgramMetrics } from "@jplmm/verify";
export function buildSemanticsDebugData(frontend, verification, backend = null, compiler = null) {
    const metrics = analyzeProgramMetrics(frontend.program);
    return {
        kind: "jplmm_semantics_debug",
        diagnostics: {
            frontend: frontend.diagnostics,
            verification: verification.diagnostics,
        },
        refinements: frontend.refinements.map(serializeRefinement),
        canonicalProgram: verification.canonicalProgram ?? null,
        compiler,
        backend,
        functions: verification.canonicalProgram.functions.map((fn) => {
            const trace = verification.traceMap.get(fn.name);
            return {
                name: fn.name,
                canonical: fn,
                proof: verification.proofMap.get(fn.name) ?? null,
                metrics: metrics.get(fn.name) ?? null,
                analysis: serializeVerificationAnalysis(trace),
            };
        }),
    };
}
export function buildCompilerSemantics(rawProgram, optimized, solverOptions = {}) {
    const raw = buildIrFloorRecord("raw_ir", rawProgram, "raw_");
    const canonical = buildIrFloorRecord("canonical_ir", optimized.stages.canonical.program, "canonical_");
    const guardElided = buildIrFloorRecord("guard_elided_ir", optimized.stages.guardElided.program, "guard_");
    const finalOptimized = buildIrFloorRecord("final_optimized_ir", optimized.program, "final_");
    const closedFormProgram = buildClosedFormImplementationProgram(optimized.program, optimized.artifacts.implementations);
    const closedFormImpl = closedFormProgram
        ? buildIrFloorRecord("closed_form_impl_ir", closedFormProgram, "closed_form_")
        : null;
    const closedFormOverrides = buildClosedFormEdgeOverrides(optimized.program, optimized.artifacts.implementations);
    const lutImpl = buildLutImplementationFloor(optimized.artifacts.implementations);
    const lutEdge = buildLutImplementationEdgeRecord(optimized.program, optimized.artifacts.implementations);
    return {
        floors: {
            raw,
            canonical,
            guardElided,
            finalOptimized,
            closedFormImpl,
        },
        implementationFloors: {
            lut: lutImpl,
        },
        analyses: {
            canonicalRanges: serializeRangeAnalysis(optimized.stages.canonicalRanges),
            finalRanges: serializeRangeAnalysis(optimized.stages.finalRanges),
            guardConsumedExprIds: [...optimized.stages.guardElided.usedRangeExprIds],
            implementations: [...optimized.artifacts.implementations.entries()].map(([fnName, implementation]) => ({
                fnName,
                implementation,
            })),
            reports: optimized.reports,
        },
        edges: [
            buildIrEdgeRecord("raw_ir", "canonical_ir", rawProgram, optimized.stages.canonical.program, solverOptions),
            buildCanonicalRangeSoundnessEdgeRecord(optimized.stages.canonical.program, optimized.stages.canonicalRanges, optimized.stages.guardElided.usedRangeExprIds, solverOptions),
            buildIrEdgeRecord("canonical_ir", "guard_elided_ir", optimized.stages.canonical.program, optimized.stages.guardElided.program, solverOptions),
            buildIrEdgeRecord("guard_elided_ir", "final_optimized_ir", optimized.stages.guardElided.program, optimized.program, solverOptions),
            ...(closedFormProgram
                ? [buildIrEdgeRecord("final_optimized_ir", "closed_form_impl_ir", optimized.program, closedFormProgram, solverOptions, closedFormOverrides)]
                : []),
            ...(lutEdge ? [lutEdge] : []),
        ],
    };
}
export function renderSemanticsDebugData(data) {
    return `${JSON.stringify(data, null, 2)}\n`;
}
function buildIrFloorRecord(label, program, symbolPrefix) {
    const structDefs = new Map(program.structs.map((struct) => [struct.name, struct.fields]));
    const callSummaries = buildIrCallSummaries(program, structDefs, `${symbolPrefix}call_`);
    return {
        label,
        program,
        globals: program.globals.map((global) => ({
            name: global.name,
            rendered: renderIrExpr(global.expr),
        })),
        functions: program.functions.map((fn) => {
            const analysis = analyzeIrFunction(fn, structDefs, `${symbolPrefix}${fn.name}_`, { callSummaries });
            return {
                name: fn.name,
                rendered: renderIrFunction(fn),
                result: analysis.result ? serializeSymValue(analysis.result) : null,
                analysis: serializePlainIrAnalysis({
                    ...analysis,
                    hasRec: hasRec(fn),
                }),
            };
        }),
    };
}
function buildIrEdgeRecord(from, to, baselineProgram, refinedProgram, solverOptions, overrides = new Map()) {
    const names = [...new Set([
            ...baselineProgram.functions.map((fn) => fn.name),
            ...refinedProgram.functions.map((fn) => fn.name),
        ])].sort((left, right) => left.localeCompare(right));
    const functions = names.map((name) => {
        const override = overrides.get(name);
        if (override) {
            return {
                name,
                status: "equivalent",
                method: override.method,
                detail: override.detail,
                ...(override.equivalence ? { equivalence: override.equivalence } : {}),
            };
        }
        const check = checkIrFunctionRefinement(name, baselineProgram, refinedProgram, solverOptions, `${from}->${to}`);
        if (check.ok) {
            return {
                name,
                status: "equivalent",
                method: check.method,
                detail: check.detail,
                ...(check.equivalence ? { equivalence: check.equivalence } : {}),
            };
        }
        return {
            name,
            status: check.code === "REF_MISMATCH" ? "mismatch" : "unproven",
            detail: check.message,
        };
    });
    const summary = functions.reduce((current, fn) => ({
        equivalent: current.equivalent + (fn.status === "equivalent" ? 1 : 0),
        mismatch: current.mismatch + (fn.status === "mismatch" ? 1 : 0),
        unproven: current.unproven + (fn.status === "unproven" ? 1 : 0),
    }), { equivalent: 0, mismatch: 0, unproven: 0 });
    return {
        from,
        to,
        kind: "ir_refinement",
        ok: summary.mismatch === 0 && summary.unproven === 0,
        summary,
        functions,
    };
}
function buildCanonicalRangeSoundnessEdgeRecord(program, analysis, consumedExprIds, solverOptions) {
    const consumed = new Set(consumedExprIds);
    const seen = new Set();
    const structDefs = new Map(program.structs.map((struct) => [struct.name, struct.fields]));
    const callSummaries = buildIrCallSummaries(program, structDefs, "range_call_");
    const functions = [...program.functions]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((fn) => {
        const fnAnalysis = analyzeIrFunction(fn, structDefs, `range_${fn.name}_`, { callSummaries });
        const comparisonEnv = buildComparisonEnvFromParams(fn.params);
        for (const param of fn.params) {
            if (param.type.tag !== "array") {
                continue;
            }
            for (let dim = 0; dim < param.type.dims; dim += 1) {
                comparisonEnv.set(`jplmm_dim_${param.name}_${dim}`, {
                    lo: 1,
                    hi: INT32_MAX,
                    exact: false,
                });
            }
        }
        const relevantExprIds = [...fnAnalysis.exprSemantics.keys()]
            .filter((exprId) => consumed.has(exprId))
            .sort((left, right) => left - right);
        for (const exprId of relevantExprIds) {
            seen.add(exprId);
        }
        if (relevantExprIds.length === 0) {
            return {
                name: fn.name,
                status: "equivalent",
                method: "range_fact_vacuous",
                detail: "no downstream-consumed canonical range facts were used for this function",
            };
        }
        const failures = [];
        let proved = 0;
        for (const exprId of relevantExprIds) {
            const exprRange = analysis.rangeMap.get(exprId);
            const exprValue = fnAnalysis.exprSemantics.get(exprId);
            if (!exprRange) {
                failures.push({
                    status: "unproven",
                    detail: `consumed range fact for expr #${exprId} is missing from the canonical range map`,
                });
                continue;
            }
            if (!exprValue) {
                failures.push({
                    status: "unproven",
                    detail: `consumed range fact for expr #${exprId} is missing symbolic semantics`,
                });
                continue;
            }
            const normalizedValue = normalizeValueForComparison(exprValue, comparisonEnv);
            if (normalizedValue.kind !== "scalar") {
                failures.push({
                    status: "unproven",
                    detail: `consumed range fact for expr #${exprId} has non-scalar semantics (${normalizedValue.kind})`,
                });
                continue;
            }
            const verdict = proveScalarRangeFact(fn, fnAnalysis.callSigs, normalizedValue.expr, exprRange, solverOptions);
            if (!verdict.ok) {
                failures.push({
                    status: verdict.status,
                    detail: `expr #${exprId}: ${verdict.detail}`,
                });
                continue;
            }
            proved += 1;
        }
        const mismatch = failures.find((entry) => entry.status === "mismatch");
        if (mismatch) {
            return {
                name: fn.name,
                status: "mismatch",
                detail: mismatch.detail,
            };
        }
        if (failures.length > 0) {
            return {
                name: fn.name,
                status: "unproven",
                detail: failures.map((entry) => entry.detail).join("; "),
            };
        }
        return {
            name: fn.name,
            status: "equivalent",
            method: "range_fact_smt",
            detail: `proved ${proved} downstream-consumed canonical range fact${proved === 1 ? "" : "s"} with shared symbolic SMT`,
        };
    });
    const unseen = [...consumed].filter((exprId) => !seen.has(exprId)).sort((left, right) => left - right);
    if (unseen.length > 0) {
        functions.push({
            name: "<globals>",
            status: "unproven",
            detail: `consumed canonical range facts are not yet attached to function semantics for expr ids: ${unseen.join(", ")}`,
        });
    }
    const summary = functions.reduce((current, fn) => ({
        equivalent: current.equivalent + (fn.status === "equivalent" ? 1 : 0),
        mismatch: current.mismatch + (fn.status === "mismatch" ? 1 : 0),
        unproven: current.unproven + (fn.status === "unproven" ? 1 : 0),
    }), { equivalent: 0, mismatch: 0, unproven: 0 });
    return {
        from: "canonical_ir",
        to: "canonical_range_facts",
        kind: "analysis_soundness",
        ok: summary.mismatch === 0 && summary.unproven === 0,
        summary,
        functions,
    };
}
function proveScalarRangeFact(fn, callSigs, expr, range, solverOptions) {
    if (!canEncodeScalarExprWithSmt(expr)) {
        return {
            ok: false,
            status: "unproven",
            detail: "shared symbolic SMT cannot encode this range fact yet",
        };
    }
    const outside = buildOutsideRangeAssertion(expr, range);
    if (!outside) {
        return { ok: true };
    }
    const lines = buildJplScalarPrelude();
    for (const [name, sig] of callSigs) {
        const domain = sig.args.map((arg) => (arg === "int" ? "Int" : "Real")).join(" ");
        const sort = sig.ret === "int" ? "Int" : "Real";
        lines.push(`(declare-fun ${sanitize(name)} (${domain}) ${sort})`);
    }
    const vars = new Map();
    collectValueVars({ kind: "scalar", expr }, vars);
    for (const [name, tag] of vars) {
        lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
        const paramType = fn.params.find((param) => param.name === name)?.type;
        if (paramType) {
            appendScalarTypeConstraints(lines, name, paramType);
            continue;
        }
        if (tag === "int") {
            lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
            lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
            if (name.startsWith("jplmm_dim_")) {
                lines.push(`(assert (<= 1 ${sanitize(name)}))`);
            }
        }
    }
    const smtState = createSmtEncodingState();
    appendSmtEncodingState(lines, smtState);
    lines.push(`(assert ${outside})`);
    const result = checkSat(lines, solverOptions);
    if (!result.ok) {
        return {
            ok: false,
            status: "unproven",
            detail: result.timedOut
                ? `timed out while proving canonical range fact: ${result.error}`
                : `could not invoke z3 for canonical range fact: ${result.error}`,
        };
    }
    if (result.status === "unsat") {
        return { ok: true };
    }
    if (result.status === "sat") {
        return {
            ok: false,
            status: "mismatch",
            detail: `canonical range fact is not semantically sound: z3 found a valuation outside [${renderRangeEndpoint(expr, range.lo)}, ${renderRangeEndpoint(expr, range.hi)}]`,
        };
    }
    return {
        ok: false,
        status: "unproven",
        detail: `z3 returned '${result.output || "unknown"}' while proving the canonical range fact`,
    };
}
function buildOutsideRangeAssertion(expr, range) {
    const term = emitScalarWithOverrides(expr, { smt: createSmtEncodingState() });
    const lower = Number.isFinite(range.lo)
        ? `(< ${term} ${renderRangeEndpoint(expr, range.lo)})`
        : null;
    const upper = Number.isFinite(range.hi)
        ? `(< ${renderRangeEndpoint(expr, range.hi)} ${term})`
        : null;
    if (lower && upper) {
        return `(or ${lower} ${upper})`;
    }
    return lower ?? upper;
}
function renderRangeEndpoint(expr, value) {
    if (Number.isInteger(value)) {
        return emitScalarWithOverrides({ tag: "int_lit", value: Math.trunc(value) });
    }
    return emitScalarWithOverrides({ tag: "float_lit", value });
}
function buildLutImplementationFloor(implementations) {
    const functions = [...implementations.entries()]
        .filter((entry) => entry[1].tag === "lut")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fnName, implementation]) => ({
        name: fnName,
        parameterRanges: implementation.parameterRanges,
        table: [...implementation.table],
        resultType: implementation.resultType,
        fallback: "final_optimized_ir",
        semantics: [
            "finite LUT over the listed integer parameter ranges",
            "inside the LUT domain, result is table[flatten(args)]",
            "outside the LUT domain, execution falls back to final_optimized_ir",
        ],
    }));
    return functions.length > 0
        ? {
            label: "lut_impl_semantics",
            functions,
        }
        : null;
}
function buildLutImplementationEdgeRecord(program, implementations) {
    const functions = [...implementations.entries()]
        .filter((entry) => entry[1].tag === "lut")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fnName, implementation]) => verifyLutImplementation(program, fnName, implementation));
    if (functions.length === 0) {
        return null;
    }
    const summary = functions.reduce((current, fn) => ({
        equivalent: current.equivalent + (fn.status === "equivalent" ? 1 : 0),
        mismatch: current.mismatch + (fn.status === "mismatch" ? 1 : 0),
        unproven: current.unproven + (fn.status === "unproven" ? 1 : 0),
    }), { equivalent: 0, mismatch: 0, unproven: 0 });
    return {
        from: "final_optimized_ir",
        to: "lut_impl_semantics",
        kind: "implementation_refinement",
        ok: summary.mismatch === 0 && summary.unproven === 0,
        summary,
        functions,
    };
}
function verifyLutImplementation(program, fnName, implementation) {
    let cellIndex = 0;
    const args = new Array(implementation.parameterRanges.length);
    for (const range of implementation.parameterRanges) {
        if (!Number.isInteger(range.lo) || !Number.isInteger(range.hi) || range.hi < range.lo) {
            return {
                name: fnName,
                status: "unproven",
                detail: "LUT ranges were not finite integer intervals during semantic recheck",
            };
        }
    }
    const loop = (index) => {
        if (index === implementation.parameterRanges.length) {
            const result = executeProgram(program, fnName, [...args]).value;
            if (typeof result !== "number") {
                return {
                    ok: false,
                    status: "unproven",
                    detail: "LUT semantic recheck expected a scalar result but observed a non-scalar value",
                };
            }
            const expected = implementation.table[cellIndex];
            if (expected === undefined) {
                return {
                    ok: false,
                    status: "mismatch",
                    detail: `LUT table ended early at cell ${cellIndex}`,
                };
            }
            if (!Object.is(result, expected)) {
                return {
                    ok: false,
                    status: "mismatch",
                    detail: `LUT cell ${cellIndex} disagrees with final_optimized_ir: expected ${expected}, got ${result}`,
                };
            }
            cellIndex += 1;
            return { ok: true };
        }
        const range = implementation.parameterRanges[index];
        for (let value = range.lo; value <= range.hi; value += 1) {
            args[index] = value;
            const result = loop(index + 1);
            if (!result.ok) {
                return result;
            }
        }
        return { ok: true };
    };
    const result = loop(0);
    if (!result.ok) {
        return {
            name: fnName,
            status: result.status,
            detail: result.detail,
        };
    }
    if (cellIndex !== implementation.table.length) {
        return {
            name: fnName,
            status: "mismatch",
            detail: `LUT table has ${implementation.table.length} cells but only ${cellIndex} were justified by re-enumeration`,
        };
    }
    return {
        name: fnName,
        status: "equivalent",
        method: "lut_enumeration",
        detail: `LUT table re-enumerated exactly over ${cellIndex} in-range cells; outside that domain execution falls back to final_optimized_ir`,
    };
}
function serializeRangeAnalysis(result) {
    return {
        exprRanges: Object.fromEntries([...result.rangeMap.entries()]
            .sort(([left], [right]) => left - right)
            .map(([id, range]) => [String(id), range])),
        cardinalities: Object.fromEntries([...result.cardinalityMap.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([fnName, info]) => [
            fnName,
            {
                parameterRanges: info.parameterRanges,
                cardinality: info.cardinality,
            },
        ])),
    };
}
function serializeRefinement(refinement) {
    const { baselineSemantics: _baselineSemantics, refSemantics: _refSemantics, baselineSemanticsData, refSemanticsData, ...rest } = refinement;
    return {
        ...rest,
        baselineSemanticsData: baselineSemanticsData ?? null,
        refSemanticsData: refSemanticsData ?? null,
    };
}
function serializePlainIrAnalysis(trace) {
    return {
        hasRec: trace?.hasRec ?? false,
        params: [...(trace?.paramValues ?? new Map()).entries()].map(([name, value]) => ({
            name,
            value: serializeSymValue(value),
        })),
        statementSemantics: (trace?.stmtSemantics ?? []).map((entry) => ({
            stmtIndex: entry.stmtIndex,
            stmtTag: entry.stmtTag,
            rendered: entry.rendered,
            value: entry.value ? serializeSymValue(entry.value) : null,
        })),
        radSites: (trace?.radSites ?? []).map((rad) => ({
            stmtIndex: rad.stmtIndex,
            rendered: rad.rendered,
            source: rad.source,
        })),
        recSites: (trace?.recSites ?? []).map((site) => ({
            stmtIndex: site.stmtIndex,
            args: site.args,
            argValues: [...site.argValues.entries()].map(([index, value]) => ({
                index,
                value: serializeSymValue(value),
            })),
            issues: [...site.issues],
        })),
        callSigs: Object.fromEntries([...(trace?.callSigs ?? new Map()).entries()].map(([name, sig]) => [
            name,
            {
                args: [...sig.args],
                ret: sig.ret,
            },
        ])),
    };
}
function serializeVerificationAnalysis(trace) {
    return {
        hasRec: trace?.hasRec ?? false,
        params: [...(trace?.paramValues ?? new Map()).entries()].map(([name, value]) => ({
            name,
            value: serializeSymValue(value),
        })),
        statementSemantics: (trace?.stmtSemantics ?? []).map((entry) => ({
            stmtIndex: entry.stmtIndex,
            stmtTag: entry.stmtTag,
            rendered: entry.rendered,
            value: entry.value ? serializeSymValue(entry.value) : null,
        })),
        radSites: (trace?.radSites ?? []).map((rad) => ({
            stmtIndex: rad.stmtIndex,
            rendered: rad.rendered,
            source: rad.source,
        })),
        recSites: (trace?.proofSites ?? []).map((siteTrace) => ({
            stmtIndex: siteTrace.site.stmtIndex,
            args: siteTrace.site.args,
            argValues: [...siteTrace.site.argValues.entries()].map(([index, value]) => ({
                index,
                value: serializeSymValue(value),
            })),
            issues: [...siteTrace.site.issues],
            obligations: siteTrace.obligations.map((obligation) => ({
                rad: obligation.rad.rendered,
                structural: obligation.structural,
                smt: obligation.smt ?? {
                    ok: true,
                    method: "smt",
                    details: "not needed because structural proof succeeded",
                },
            })),
        })),
        callSigs: Object.fromEntries([...(trace?.callSigs ?? new Map()).entries()].map(([name, sig]) => [
            name,
            {
                args: [...sig.args],
                ret: sig.ret,
            },
        ])),
    };
}
function serializeSymValue(value) {
    switch (value.kind) {
        case "scalar":
            return { kind: "scalar", expr: value.expr };
        case "array":
            return { kind: "array", array: value.array };
        case "struct":
            return {
                kind: "struct",
                typeName: value.typeName,
                fields: value.fields.map((field) => ({
                    name: field.name,
                    type: field.type,
                    value: serializeSymValue(field.value),
                })),
            };
        case "void":
            return { kind: "void", type: value.type };
        case "opaque":
            return { kind: "opaque", type: value.type, label: value.label };
        default: {
            const _never = value;
            return _never;
        }
    }
}
const INT_TYPE = { tag: "int" };
function buildClosedFormImplementationProgram(program, implementations) {
    let nextId = 1_000_000_000;
    let changed = false;
    const functions = program.functions.map((fn) => {
        const implementation = implementations.get(fn.name);
        if (implementation?.tag !== "closed_form_linear_countdown") {
            return fn;
        }
        changed = true;
        return synthesizeClosedFormFunction(fn, implementation, () => nextId++);
    });
    if (!changed) {
        return null;
    }
    return {
        structs: program.structs,
        globals: program.globals,
        functions,
    };
}
function synthesizeClosedFormFunction(fn, implementation, nextId) {
    const param = fn.params[implementation.paramIndex];
    if (!param) {
        return fn;
    }
    const paramValue = varExpr(param.name, param.type, nextId);
    const zero = intLit(0, nextId);
    const one = intLit(1, nextId);
    const decrement = intLit(implementation.decrement, nextId);
    const decrementMinusOne = intLit(implementation.decrement - 1, nextId);
    const baseValue = intLit(implementation.baseValue, nextId);
    const stepValue = intLit(implementation.stepValue, nextId);
    const positiveInput = callExpr("max", [zero, paramValue], INT_TYPE, nextId);
    const numerator = satAddExpr(positiveInput, decrementMinusOne, nextId);
    const stepsMinusOne = totalDivExpr(numerator, decrement, nextId);
    const steps = satAddExpr(stepsMinusOne, one, nextId);
    const delta = satMulExpr(steps, stepValue, nextId);
    const result = satAddExpr(baseValue, delta, nextId);
    return {
        ...fn,
        body: [{
                tag: "ret",
                id: nextId(),
                expr: result,
            }],
    };
}
function intLit(value, nextId) {
    return {
        tag: "int_lit",
        value,
        id: nextId(),
        resultType: INT_TYPE,
    };
}
function varExpr(name, resultType, nextId) {
    return {
        tag: "var",
        name,
        id: nextId(),
        resultType,
    };
}
function callExpr(name, args, resultType, nextId) {
    return {
        tag: "call",
        name,
        args,
        id: nextId(),
        resultType,
    };
}
function satAddExpr(left, right, nextId) {
    return {
        tag: "sat_add",
        left,
        right,
        id: nextId(),
        resultType: INT_TYPE,
    };
}
function satMulExpr(left, right, nextId) {
    return {
        tag: "sat_mul",
        left,
        right,
        id: nextId(),
        resultType: INT_TYPE,
    };
}
function totalDivExpr(left, right, nextId) {
    return {
        tag: "total_div",
        left,
        right,
        id: nextId(),
        resultType: INT_TYPE,
        zeroDivisorValue: 0,
    };
}
function buildClosedFormEdgeOverrides(program, implementations) {
    const matched = new Map(matchClosedForms(program).map((match) => [match.fnName, match.implementation]));
    const overrides = new Map();
    for (const [fnName, implementation] of implementations.entries()) {
        if (implementation.tag !== "closed_form_linear_countdown") {
            continue;
        }
        const matchedImplementation = matched.get(fnName);
        if (!matchedImplementation || !sameClosedFormImplementation(matchedImplementation, implementation)) {
            continue;
        }
        overrides.set(fnName, {
            status: "equivalent",
            method: "closed_form_match",
            detail: "closed-form implementation is verified by the countdown matcher that synthesized it",
        });
    }
    return overrides;
}
function sameClosedFormImplementation(left, right) {
    return left.paramIndex === right.paramIndex
        && left.baseValue === right.baseValue
        && left.stepValue === right.stepValue
        && left.decrement === right.decrement;
}
//# sourceMappingURL=semantics.js.map