import { unwrapTimedDefinition } from "@jplmm/ast";
import { typecheckProgram } from "@jplmm/frontend";
import { analyzeIrFunction, analyzeIrProofSites, buildIrCallSummaries, buildCanonicalProgram, hasRec, } from "@jplmm/proof";
const DEFAULT_PROOF_TIMEOUT_MS = 2000;
export function verifyProgram(program, typeMap, options = {}) {
    const proofMap = new Map();
    const diagnostics = [];
    const effectiveTypeMap = typeMap ?? typecheckProgram(program).typeMap;
    const canonical = buildCanonicalProgram(program, effectiveTypeMap);
    const canonicalFns = new Map(canonical.functions.map((fn) => [fn.name, fn]));
    const structDefs = new Map(canonical.structs.map((struct) => [struct.name, struct.fields]));
    const callSummaries = buildIrCallSummaries(canonical, structDefs, "verify_call_");
    const traceMap = new Map();
    const proofTimeoutMs = resolveProofTimeoutMs(options.proofTimeoutMs);
    const solverOptions = proofTimeoutMs === undefined ? {} : { timeoutMs: proofTimeoutMs };
    for (const fn of canonical.functions) {
        const analysis = analyzeIrFunction(fn, structDefs, "", { callSummaries });
        traceMap.set(fn.name, {
            fnName: fn.name,
            canonical: fn,
            hasRec: hasRec(fn),
            paramValues: analysis.paramValues,
            exprSemantics: analysis.exprSemantics,
            result: analysis.result,
            stmtSemantics: analysis.stmtSemantics,
            radSites: analysis.radSites,
            proofSites: analyzeIrProofSites(fn, analysis, solverOptions),
            callSigs: analysis.callSigs,
        });
    }
    for (const cmd of program.commands) {
        const fn = unwrapTimedDefinition(cmd, "fn_def");
        if (!fn) {
            continue;
        }
        const trace = traceMap.get(fn.name) ?? null;
        const result = verifyFunction(fn.name, canonicalFns.get(fn.name) ?? null, trace, diagnostics, solverOptions);
        if (result) {
            proofMap.set(fn.name, result);
        }
    }
    return { proofMap, diagnostics, canonicalProgram: canonical, traceMap };
}
function verifyFunction(fnName, fn, trace, diagnostics, solverOptions) {
    if (!fn || !hasRec(fn)) {
        return null;
    }
    const gas = fn.body.find((s) => s.tag === "gas");
    if (gas) {
        if (gas.limit === "inf") {
            diagnostics.push({
                fnName,
                code: "VERIFY_GAS_INF",
                severity: "warning",
                message: `${fnName}: gas inf disables totality guarantee`,
            });
            return {
                status: "unverified",
                method: "gas_inf",
                details: "unverified due to gas inf",
            };
        }
        return {
            status: "bounded",
            method: "gas",
            details: `bounded by gas ${gas.limit}`,
        };
    }
    const analysis = trace
        ? {
            paramValues: trace.paramValues,
            exprSemantics: trace.exprSemantics,
            result: trace.result,
            stmtSemantics: trace.stmtSemantics,
            radSites: trace.radSites,
            recSites: trace.proofSites.map((site) => site.site),
            callSigs: trace.callSigs,
        }
        : analyzeIrFunction(fn);
    if (analysis.radSites.length === 0) {
        diagnostics.push({
            fnName,
            code: "VERIFY_NO_PROOF",
            severity: "error",
            message: `${fnName}: rec used without rad or gas`,
        });
        return {
            status: "rejected",
            method: "none",
            details: "no proof annotation",
        };
    }
    const methods = [];
    const details = [];
    const siteTraces = trace?.proofSites ?? analyzeIrProofSites(fn, analysis, solverOptions);
    for (const trace of siteTraces) {
        const winner = trace.obligations.find((obligation) => obligation.proved) ?? null;
        if (!winner) {
            diagnostics.push({
                fnName,
                code: "VERIFY_PROOF_FAIL",
                severity: "error",
                message: `${fnName}: rec site ${trace.siteIndex + 1} failed proof obligations; ${trace.reasons.join("; ")}; consider using gas N if a convergence proof is not possible`,
            });
            return {
                status: "rejected",
                method: "none",
                details: trace.reasons.join("; "),
            };
        }
        methods.push(winner.method ?? "structural");
        details.push(winner.details ?? `rec site ${trace.siteIndex + 1}: proof succeeded`);
    }
    return {
        status: "verified",
        method: methods.some((method) => method === "smt") ? "smt" : "structural",
        details: details.join("; "),
    };
}
function resolveProofTimeoutMs(proofTimeoutMs) {
    if (proofTimeoutMs === undefined) {
        return DEFAULT_PROOF_TIMEOUT_MS;
    }
    if (!Number.isFinite(proofTimeoutMs) || proofTimeoutMs <= 0) {
        return DEFAULT_PROOF_TIMEOUT_MS;
    }
    return Math.min(2000, Math.max(1, Math.floor(proofTimeoutMs)));
}
//# sourceMappingURL=verify.js.map