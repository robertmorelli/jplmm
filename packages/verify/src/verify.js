import { checkStructuralDecrease, collectRecSites, findRadExpr, hasRec } from "./structural";
export function verifyProgram(program) {
    const proofMap = new Map();
    const diagnostics = [];
    for (const cmd of program.commands) {
        if (cmd.tag !== "fn_def") {
            continue;
        }
        const result = verifyFunction(cmd, diagnostics);
        if (result) {
            proofMap.set(cmd.name, result);
        }
    }
    return { proofMap, diagnostics };
}
function verifyFunction(fn, diagnostics) {
    const recPresent = hasRec(fn.body);
    if (!recPresent) {
        return null;
    }
    const gas = fn.body.find((s) => s.tag === "gas");
    if (gas) {
        if (gas.limit === "inf") {
            diagnostics.push({
                fnName: fn.name,
                code: "VERIFY_GAS_INF",
                severity: "warning",
                message: `${fn.name}: gas inf disables totality guarantee`,
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
    const rad = findRadExpr(fn.body);
    if (!rad) {
        diagnostics.push({
            fnName: fn.name,
            code: "VERIFY_NO_PROOF",
            severity: "error",
            message: `${fn.name}: rec used without rad or gas`,
        });
        return {
            status: "rejected",
            method: "none",
            details: "no proof annotation",
        };
    }
    if (fn.params.length !== 1 || fn.params[0]?.type.tag !== "int") {
        diagnostics.push({
            fnName: fn.name,
            code: "VERIFY_STRUCTURAL_UNSUPPORTED",
            severity: "error",
            message: `${fn.name}: structural verifier currently supports one int parameter`,
        });
        return {
            status: "rejected",
            method: "structural",
            details: "unsupported shape for structural verifier",
        };
    }
    const paramName = fn.params[0].name;
    const recSites = collectRecSites(fn.body);
    for (const site of recSites) {
        const check = checkStructuralDecrease(paramName, rad, site);
        if (!check.ok) {
            diagnostics.push({
                fnName: fn.name,
                code: "VERIFY_STRUCTURAL_FAIL",
                severity: "error",
                message: `${fn.name}: ${check.reason}`,
            });
            return {
                status: "rejected",
                method: "structural",
                details: check.reason,
            };
        }
    }
    return {
        status: "verified",
        method: "structural",
        details: "all rec sites structurally decrease",
    };
}
//# sourceMappingURL=verify.js.map