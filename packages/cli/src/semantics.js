import { serializeExprSemantics, serializeSymValue, } from "@jplmm/proof";
import { analyzeProgramMetrics } from "@jplmm/verify";
export { buildCompilerSemantics } from "@jplmm/proof";
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
export function renderSemanticsDebugData(data) {
    return `${JSON.stringify(data, null, 2)}\n`;
}
function serializeRefinement(refinement) {
    const { baselineSemantics: _baselineSemantics, refSemantics: _refSemantics, baselineSemanticsData, refSemanticsData, ...rest } = refinement;
    return {
        ...rest,
        baselineSemanticsData: baselineSemanticsData ?? null,
        refSemanticsData: refSemanticsData ?? null,
    };
}
function serializeVerificationAnalysis(trace) {
    return {
        hasRec: trace?.hasRec ?? false,
        params: [...(trace?.paramValues ?? new Map()).entries()].map(([name, value]) => ({
            name,
            value: serializeSymValue(value),
        })),
        exprSemantics: serializeExprSemantics(trace?.canonical.body.filter((stmt) => stmt.tag !== "gas").map((stmt) => stmt.expr) ?? [], trace?.exprSemantics ?? new Map()),
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
//# sourceMappingURL=semantics.js.map