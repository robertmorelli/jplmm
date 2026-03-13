import { matchAitkenPass } from "./aitken";
import { canonicalizeProgram } from "./canonicalize";
import { matchClosedForms } from "./closed_form";
import { eliminateGuards } from "./guard_elimination";
import { matchLinearSpeculationPass } from "./linear_speculation";
import { tabulateLuts } from "./lut";
import { analyzeRanges } from "./range";
export function optimizeProgram(program, options = {}) {
    const reports = [];
    const canonical = canonicalizeProgram(program);
    let current = canonical.program;
    reports.push({
        name: "canonicalize",
        changed: Object.values(canonical.stats).some((value) => value > 0),
        details: [
            `total_div=${canonical.stats.totalDivInserted}`,
            `total_mod=${canonical.stats.totalModInserted}`,
            `nan_to_zero=${canonical.stats.nanToZeroInserted}`,
            `sat_int_ops=${canonical.stats.satAddInserted + canonical.stats.satSubInserted + canonical.stats.satMulInserted + canonical.stats.satNegInserted}`,
        ],
    });
    let rangeResult = analyzeRanges(current, options.parameterRangeHints);
    reports.push({
        name: "range_analysis",
        changed: true,
        details: [...rangeResult.cardinalityMap.entries()].map(([fnName, info]) => `${fnName}: cardinality=${info.cardinality}`),
    });
    const guardResult = eliminateGuards(current, rangeResult.rangeMap);
    current = guardResult.program;
    reports.push({
        name: "guard_elimination",
        changed: guardResult.changed,
        details: [
            `removed_nan_to_zero=${guardResult.removedNanToZero}`,
            `removed_total_div=${guardResult.removedTotalDiv}`,
            `removed_total_mod=${guardResult.removedTotalMod}`,
        ],
    });
    if (guardResult.changed) {
        rangeResult = analyzeRanges(current, options.parameterRangeHints);
    }
    const artifacts = {
        rangeMap: rangeResult.rangeMap,
        cardinalityMap: rangeResult.cardinalityMap,
        implementations: new Map(),
        researchCandidates: new Map(),
    };
    const closedForms = matchClosedForms(current);
    for (const match of closedForms) {
        artifacts.implementations.set(match.fnName, match.implementation);
    }
    reports.push({
        name: "closed_form",
        changed: closedForms.length > 0,
        details: closedForms.map((match) => `${match.fnName}: ${match.implementation.tag}`),
    });
    const luts = tabulateLuts(current, artifacts, options.lutThreshold ?? 256);
    for (const lut of luts) {
        artifacts.implementations.set(lut.fnName, lut.implementation);
    }
    reports.push({
        name: "lut_tabulation",
        changed: luts.length > 0,
        details: luts.map((lut) => `${lut.fnName}: ${lut.implementation.table.length} entries`),
    });
    if (options.enableResearchPasses) {
        const aitken = matchAitkenPass(current).filter((match) => !artifacts.implementations.has(match.fnName));
        for (const match of aitken) {
            artifacts.implementations.set(match.fnName, match.implementation);
            appendResearchCandidate(artifacts.researchCandidates, match.fnName, {
                pass: "aitken",
                reason: match.implementation.targetParamIndex === null
                    ? "matched scalar float tail-rec fixed-point recurrence for generalized Aitken acceleration"
                    : "matched scalar float tail-rec recurrence with a target parameter for generalized Aitken acceleration",
            });
        }
        reports.push({
            name: "aitken",
            changed: aitken.length > 0,
            details: aitken.map((match) => `${match.fnName}: state=${match.implementation.stateParamIndex}; after=${match.implementation.afterIterations}`),
            experimental: true,
        });
        const linearSpec = matchLinearSpeculationPass(current).filter((match) => !artifacts.implementations.has(match.fnName));
        for (const match of linearSpec) {
            artifacts.implementations.set(match.fnName, match.implementation);
            appendResearchCandidate(artifacts.researchCandidates, match.fnName, match.candidate);
        }
        reports.push({
            name: "linear_speculation",
            changed: linearSpec.length > 0,
            details: linearSpec.map((match) => `${match.fnName}: param=${match.implementation.varyingParamIndex}; fixed=${match.implementation.fixedPoint}; stride=${match.implementation.stride}`),
            experimental: true,
        });
    }
    return {
        program: current,
        artifacts,
        reports,
    };
}
function appendResearchCandidate(target, fnName, candidate) {
    const current = target.get(fnName) ?? [];
    target.set(fnName, [...current, candidate]);
}
//# sourceMappingURL=pipeline.js.map