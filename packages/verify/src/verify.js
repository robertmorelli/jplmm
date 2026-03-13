import { typecheckProgram } from "@jplmm/frontend";
import { analyzeIrFunction, analyzeIrProofSites, buildCanonicalProgram, hasRec, } from "@jplmm/proof";
export function verifyProgram(program, typeMap) {
    const proofMap = new Map();
    const diagnostics = [];
    const effectiveTypeMap = typeMap ?? typecheckProgram(program).typeMap;
    const canonical = buildCanonicalProgram(program, effectiveTypeMap);
    const canonicalFns = new Map(canonical.functions.map((fn) => [fn.name, fn]));
    const structDefs = new Map(canonical.structs.map((struct) => [struct.name, struct.fields]));
    const traceMap = new Map();
    for (const fn of canonical.functions) {
        const analysis = analyzeIrFunction(fn, structDefs);
        traceMap.set(fn.name, {
            fnName: fn.name,
            canonical: fn,
            hasRec: hasRec(fn),
            paramValues: analysis.paramValues,
            result: analysis.result,
            stmtSemantics: analysis.stmtSemantics,
            radSites: analysis.radSites,
            proofSites: analyzeIrProofSites(fn, analysis),
            callSigs: analysis.callSigs,
        });
    }
    for (const cmd of program.commands) {
        const fn = unwrapTimedDefinition(cmd, "fn_def");
        if (!fn) {
            continue;
        }
        const trace = traceMap.get(fn.name) ?? null;
        const result = verifyFunction(fn.name, canonicalFns.get(fn.name) ?? null, trace, diagnostics);
        if (result) {
            proofMap.set(fn.name, result);
        }
    }
    return { proofMap, diagnostics, canonicalProgram: canonical, traceMap };
}
function verifyFunction(fnName, fn, trace, diagnostics) {
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
    const siteTraces = trace?.proofSites ?? analyzeIrProofSites(fn, analysis);
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
function unwrapTimedDefinition(cmd, tag) {
    if (cmd.tag === tag) {
        return cmd;
    }
    if (cmd.tag === "time" && cmd.cmd.tag === tag) {
        return cmd.cmd;
    }
    return null;
}
//# sourceMappingURL=verify.js.map