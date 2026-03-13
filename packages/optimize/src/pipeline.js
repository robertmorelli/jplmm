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
    const disabledPasses = new Set(options.disabledPasses ?? []);
    const fnByName = new Map(current.functions.map((fn) => [fn.name, fn]));
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
    if (!disabledPasses.has("guard_elimination")) {
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
    }
    else {
        reports.push({
            name: "guard_elimination",
            changed: false,
            details: ["disabled by option"],
        });
    }
    const artifacts = {
        rangeMap: rangeResult.rangeMap,
        cardinalityMap: rangeResult.cardinalityMap,
        implementations: new Map(),
        researchCandidates: new Map(),
    };
    if (!disabledPasses.has("closed_form")) {
        const closedForms = matchClosedForms(current);
        for (const match of closedForms) {
            artifacts.implementations.set(match.fnName, match.implementation);
        }
        reports.push({
            name: "closed_form",
            changed: closedForms.length > 0,
            details: closedForms.map((match) => `${match.fnName}: ${match.implementation.tag}`),
        });
    }
    else {
        reports.push({
            name: "closed_form",
            changed: false,
            details: ["disabled by option"],
        });
    }
    if (!disabledPasses.has("lut_tabulation")) {
        const luts = tabulateLuts(current, artifacts, options.lutThreshold ?? 256);
        for (const lut of luts) {
            artifacts.implementations.set(lut.fnName, lut.implementation);
        }
        reports.push({
            name: "lut_tabulation",
            changed: luts.length > 0,
            details: luts.map((lut) => `${lut.fnName}: ${lut.implementation.table.length} entries`),
        });
    }
    else {
        reports.push({
            name: "lut_tabulation",
            changed: false,
            details: ["disabled by option"],
        });
    }
    if (options.enableResearchPasses) {
        if (!disabledPasses.has("aitken")) {
            const aitkenMatches = matchAitkenPass(current);
            const details = [];
            let changed = false;
            for (const match of aitkenMatches) {
                const fn = fnByName.get(match.fnName);
                const allowExperimental = fn?.keyword !== "def";
                if (allowExperimental && !artifacts.implementations.has(match.fnName)) {
                    artifacts.implementations.set(match.fnName, match.implementation);
                    changed = true;
                    details.push(`${match.fnName}: state=${match.implementation.stateParamIndex}; after=${match.implementation.afterIterations}`);
                    appendResearchCandidate(artifacts.researchCandidates, match.fnName, {
                        pass: "aitken",
                        reason: match.implementation.targetParamIndex === null
                            ? "matched scalar float tail-rec fixed-point recurrence for generalized Aitken acceleration"
                            : "matched scalar float tail-rec recurrence with a target parameter for generalized Aitken acceleration",
                        applied: true,
                    });
                    continue;
                }
                if (!allowExperimental) {
                    details.push(`${match.fnName}: blocked by def`);
                    appendResearchCandidate(artifacts.researchCandidates, match.fnName, {
                        pass: "aitken",
                        reason: match.implementation.targetParamIndex === null
                            ? "matched scalar float tail-rec fixed-point recurrence for generalized Aitken acceleration"
                            : "matched scalar float tail-rec recurrence with a target parameter for generalized Aitken acceleration",
                        blockedByDefinition: true,
                    });
                }
            }
            reports.push({
                name: "aitken",
                changed,
                details,
                experimental: true,
            });
        }
        else {
            reports.push({
                name: "aitken",
                changed: false,
                details: ["disabled by option"],
                experimental: true,
            });
        }
        if (!disabledPasses.has("linear_speculation")) {
            const linearMatches = matchLinearSpeculationPass(current);
            const details = [];
            let changed = false;
            for (const match of linearMatches) {
                const fn = fnByName.get(match.fnName);
                const allowExperimental = fn?.keyword !== "def";
                if (allowExperimental && !artifacts.implementations.has(match.fnName)) {
                    artifacts.implementations.set(match.fnName, match.implementation);
                    changed = true;
                    details.push(`${match.fnName}: param=${match.implementation.varyingParamIndex}; fixed=${match.implementation.fixedPoint}; stride=${match.implementation.stride}`);
                    appendResearchCandidate(artifacts.researchCandidates, match.fnName, {
                        ...match.candidate,
                        applied: true,
                    });
                    continue;
                }
                if (!allowExperimental) {
                    details.push(`${match.fnName}: blocked by def`);
                    appendResearchCandidate(artifacts.researchCandidates, match.fnName, {
                        ...match.candidate,
                        blockedByDefinition: true,
                    });
                }
            }
            reports.push({
                name: "linear_speculation",
                changed,
                details,
                experimental: true,
            });
        }
        else {
            reports.push({
                name: "linear_speculation",
                changed: false,
                details: ["disabled by option"],
                experimental: true,
            });
        }
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