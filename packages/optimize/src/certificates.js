import { isNaNlessCanonical } from "./canonicalize";
import { matchClosedForms } from "./closed_form";
export function validateOptimizeCertificates(result) {
    return {
        canonicalize: validateCanonicalizePassCertificate(result.stages.rawProgram, result.stages.canonical.program, result.certificates.canonicalize),
        rangeAnalysis: validateRangeAnalysisPassCertificate(result.stages.canonical.program, result.certificates.rangeAnalysis),
        guardElimination: validateGuardEliminationPassCertificate(result.stages.canonical.program, result.stages.guardElided.program, result.certificates.guardElimination),
        finalIdentity: validateFinalIdentityPassCertificate(result.certificates.finalIdentity),
        closedForm: validateClosedFormPassCertificate(result.program, result.certificates.closedForm),
        lut: validateLutPassCertificate(result.certificates.lut),
    };
}
export function validateCanonicalizePassCertificate(rawProgram, canonicalProgram, certificate) {
    const rawCounts = countProgramOps(rawProgram);
    const canonicalCounts = countProgramOps(canonicalProgram);
    const stats = certificate.stats;
    const statsMatch = canonicalCounts.totalDiv - rawCounts.totalDiv === stats.totalDivInserted &&
        canonicalCounts.totalMod - rawCounts.totalMod === stats.totalModInserted &&
        canonicalCounts.nanToZero - rawCounts.nanToZero === stats.nanToZeroInserted &&
        canonicalCounts.satAdd - rawCounts.satAdd === stats.satAddInserted &&
        canonicalCounts.satSub - rawCounts.satSub === stats.satSubInserted &&
        canonicalCounts.satMul - rawCounts.satMul === stats.satMulInserted &&
        canonicalCounts.satNeg - rawCounts.satNeg === stats.satNegInserted &&
        rawCounts.zeroDivisorBinops === stats.zeroDivisorConstantFolded;
    if (!isNaNlessCanonical(canonicalProgram)) {
        return {
            ok: false,
            detail: "target program is not in canonical total/saturating form",
        };
    }
    return {
        ok: statsMatch,
        detail: statsMatch
            ? "canonicalization certificate matches the emitted canonical program"
            : "canonicalization certificate stats do not match the emitted canonical program",
    };
}
export function validateRangeAnalysisPassCertificate(program, certificate) {
    const attached = new Set(collectProgramExprIds(program));
    const missing = [...new Set(certificate.exprIds)].filter((exprId) => !attached.has(exprId));
    return {
        ok: missing.length === 0,
        detail: missing.length === 0
            ? "all emitted canonical range facts attach to canonical expressions"
            : `range certificate references unattached expr ids: ${missing.join(", ")}`,
    };
}
export function validateGuardEliminationPassCertificate(canonicalProgram, guardProgram, certificate) {
    const canonicalCounts = countProgramOps(canonicalProgram);
    const guardCounts = countProgramOps(guardProgram);
    const removedMatch = canonicalCounts.nanToZero - guardCounts.nanToZero === certificate.removed.nanToZero &&
        canonicalCounts.totalDiv - guardCounts.totalDiv === certificate.removed.totalDiv &&
        canonicalCounts.totalMod - guardCounts.totalMod === certificate.removed.totalMod;
    if (!removedMatch) {
        return {
            ok: false,
            detail: "guard elimination counts do not match the structural diff between floors",
        };
    }
    return validateRangeAnalysisPassCertificate(canonicalProgram, {
        exprIds: certificate.usedRangeExprIds,
        consumedExprIds: certificate.usedRangeExprIds,
    });
}
export function validateFinalIdentityPassCertificate(certificate) {
    return {
        ok: true,
        detail: certificate.reason,
    };
}
export function validateClosedFormPassCertificate(program, certificate) {
    const rediscovered = new Map(matchClosedForms(program).map((match) => [match.fnName, match.implementation]));
    const unmatched = certificate.matches
        .filter((match) => JSON.stringify(rediscovered.get(match.fnName) ?? null) !== JSON.stringify(match.implementation))
        .map((match) => match.fnName);
    return {
        ok: unmatched.length === 0,
        detail: unmatched.length === 0
            ? "every closed-form implementation is rediscovered by the local matcher"
            : `closed-form implementations could not be rediscovered for: ${unmatched.join(", ")}`,
    };
}
export function validateLutPassCertificate(certificate) {
    const invalid = certificate.entries
        .filter((entry) => entry.tableLength !== lutCardinality(entry.parameterRanges))
        .map((entry) => entry.fnName);
    return {
        ok: invalid.length === 0,
        detail: invalid.length === 0
            ? "every LUT table length matches its finite integer domain"
            : `LUT table lengths do not match their declared domains for: ${invalid.join(", ")}`,
    };
}
function countProgramOps(program) {
    const counts = {
        totalDiv: 0,
        totalMod: 0,
        nanToZero: 0,
        satAdd: 0,
        satSub: 0,
        satMul: 0,
        satNeg: 0,
        zeroDivisorBinops: 0,
    };
    for (const global of program.globals) {
        countExprOps(global.expr, counts);
    }
    for (const fn of program.functions) {
        for (const stmt of fn.body) {
            if (stmt.tag !== "gas") {
                countExprOps(stmt.expr, counts);
            }
        }
    }
    return counts;
}
function countExprOps(expr, counts) {
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
        case "void_lit":
        case "var":
        case "res":
            return;
        case "unop":
            countExprOps(expr.operand, counts);
            return;
        case "binop":
            if ((expr.op === "/" || expr.op === "%") && isZeroLiteralExpr(expr.right)) {
                counts.zeroDivisorBinops += 1;
            }
            countExprOps(expr.left, counts);
            countExprOps(expr.right, counts);
            return;
        case "call":
            for (const arg of expr.args) {
                countExprOps(arg, counts);
            }
            return;
        case "index":
            countExprOps(expr.array, counts);
            for (const index of expr.indices) {
                countExprOps(index, counts);
            }
            return;
        case "field":
            countExprOps(expr.target, counts);
            return;
        case "struct_cons":
            for (const field of expr.fields) {
                countExprOps(field, counts);
            }
            return;
        case "array_cons":
            for (const element of expr.elements) {
                countExprOps(element, counts);
            }
            return;
        case "array_expr":
        case "sum_expr":
            for (const binding of expr.bindings) {
                countExprOps(binding.expr, counts);
            }
            countExprOps(expr.body, counts);
            return;
        case "rec":
            for (const arg of expr.args) {
                countExprOps(arg, counts);
            }
            return;
        case "total_div":
            counts.totalDiv += 1;
            countExprOps(expr.left, counts);
            countExprOps(expr.right, counts);
            return;
        case "total_mod":
            counts.totalMod += 1;
            countExprOps(expr.left, counts);
            countExprOps(expr.right, counts);
            return;
        case "sat_add":
            counts.satAdd += 1;
            countExprOps(expr.left, counts);
            countExprOps(expr.right, counts);
            return;
        case "sat_sub":
            counts.satSub += 1;
            countExprOps(expr.left, counts);
            countExprOps(expr.right, counts);
            return;
        case "sat_mul":
            counts.satMul += 1;
            countExprOps(expr.left, counts);
            countExprOps(expr.right, counts);
            return;
        case "sat_neg":
            counts.satNeg += 1;
            countExprOps(expr.operand, counts);
            return;
        case "nan_to_zero":
            counts.nanToZero += 1;
            countExprOps(expr.value, counts);
            return;
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function isZeroLiteralExpr(expr) {
    return (expr.tag === "int_lit" || expr.tag === "float_lit") && expr.value === 0;
}
function collectProgramExprIds(program) {
    const ids = new Set();
    for (const global of program.globals) {
        collectExprIds(global.expr, ids);
    }
    for (const fn of program.functions) {
        for (const stmt of fn.body) {
            if (stmt.tag !== "gas") {
                collectExprIds(stmt.expr, ids);
            }
        }
    }
    return [...ids].sort((left, right) => left - right);
}
function collectExprIds(expr, ids) {
    if (ids.has(expr.id)) {
        return;
    }
    ids.add(expr.id);
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
        case "void_lit":
        case "var":
        case "res":
            return;
        case "unop":
            collectExprIds(expr.operand, ids);
            return;
        case "nan_to_zero":
            collectExprIds(expr.value, ids);
            return;
        case "sat_neg":
            collectExprIds(expr.operand, ids);
            return;
        case "binop":
        case "total_div":
        case "total_mod":
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
            collectExprIds(expr.left, ids);
            collectExprIds(expr.right, ids);
            return;
        case "call":
            for (const arg of expr.args) {
                collectExprIds(arg, ids);
            }
            return;
        case "index":
            collectExprIds(expr.array, ids);
            for (const index of expr.indices) {
                collectExprIds(index, ids);
            }
            return;
        case "field":
            collectExprIds(expr.target, ids);
            return;
        case "struct_cons":
            for (const field of expr.fields) {
                collectExprIds(field, ids);
            }
            return;
        case "array_cons":
            for (const element of expr.elements) {
                collectExprIds(element, ids);
            }
            return;
        case "array_expr":
        case "sum_expr":
            for (const binding of expr.bindings) {
                collectExprIds(binding.expr, ids);
            }
            collectExprIds(expr.body, ids);
            return;
        case "rec":
            for (const arg of expr.args) {
                collectExprIds(arg, ids);
            }
            return;
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function lutCardinality(ranges) {
    return ranges.reduce((product, range) => product * (range.hi - range.lo + 1), 1);
}
//# sourceMappingURL=certificates.js.map