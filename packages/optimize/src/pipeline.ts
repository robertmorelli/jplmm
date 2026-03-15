import type { IRProgram } from "@jplmm/ir";

import { matchAitkenPass } from "./aitken";
import { canonicalizeProgram } from "./canonicalize";
import {
  validateCanonicalizePassCertificate,
  validateClosedFormPassCertificate,
  validateGuardEliminationPassCertificate,
  validateLutPassCertificate,
} from "./certificates";
import { matchClosedForms } from "./closed_form";
import { eliminateGuards } from "./guard_elimination";
import { matchLinearSpeculationPass } from "./linear_speculation";
import { tabulateLuts } from "./lut";
import { buildExprProvenance } from "./provenance";
import { analyzeRanges } from "./range";
import type {
  OptimizeArtifacts,
  OptimizeCertificates,
  OptimizeOptions,
  OptimizePassReport,
  OptimizeResult,
  ResearchCandidate,
} from "./types";

export function optimizeProgram(program: IRProgram, options: OptimizeOptions = {}): OptimizeResult {
  const reports: OptimizePassReport[] = [];
  const proofGate = options.proofGateCertificates === true;
  const canonicalCandidate = canonicalizeProgram(program);
  let canonical = canonicalCandidate;
  const canonicalCertificate: OptimizeCertificates["canonicalize"] = {
    passOrder: canonicalCandidate.passOrder,
    stats: canonicalCandidate.stats,
  };
  const canonicalValidation = validateCanonicalizePassCertificate(
    program,
    canonicalCandidate.program,
    canonicalCertificate,
  );
  if (proofGate && !canonicalValidation.ok) {
    canonical = {
      program,
      passOrder: [],
      stats: {
        totalDivInserted: 0,
        totalModInserted: 0,
        nanToZeroInserted: 0,
        satAddInserted: 0,
        satSubInserted: 0,
        satMulInserted: 0,
        satNegInserted: 0,
        zeroDivisorConstantFolded: 0,
      },
    };
  }
  let current = canonical.program;
  const disabledPasses = new Set(options.disabledPasses ?? []);
  const fnByName = new Map(current.functions.map((fn) => [fn.name, fn] as const));
  let closedFormsMatched: ReturnType<typeof matchClosedForms> = [];
  let lutsMatched: ReturnType<typeof tabulateLuts> = [];
  let guardCertificate: OptimizeCertificates["guardElimination"] = {
    usedRangeExprIds: [],
    removed: {
      nanToZero: 0,
      totalDiv: 0,
      totalMod: 0,
    },
  };

  reports.push({
    name: "canonicalize",
    changed: Object.values(canonical.stats).some((value) => value > 0),
    details: [
      `total_div=${canonical.stats.totalDivInserted}`,
      `total_mod=${canonical.stats.totalModInserted}`,
      `nan_to_zero=${canonical.stats.nanToZeroInserted}`,
      `sat_int_ops=${canonical.stats.satAddInserted + canonical.stats.satSubInserted + canonical.stats.satMulInserted + canonical.stats.satNegInserted}`,
      proofGate
        ? canonicalValidation.ok
          ? "proof_gate=accepted"
          : `proof_gate=rejected: ${canonicalValidation.detail}`
        : `certificate=${canonicalValidation.ok ? "ok" : `invalid: ${canonicalValidation.detail}`}`,
    ],
  });

  const canonicalRangeResult = analyzeRanges(current, options.parameterRangeHints);
  let rangeResult = canonicalRangeResult;
  reports.push({
    name: "range_analysis",
    changed: true,
    details: [...rangeResult.cardinalityMap.entries()].map(
      ([fnName, info]) => `${fnName}: cardinality=${info.cardinality}`,
    ),
  });

  let guardResult = {
    program: current,
    changed: false,
    removedNanToZero: 0,
    removedTotalDiv: 0,
    removedTotalMod: 0,
    usedRangeExprIds: [] as number[],
  };
  if (!disabledPasses.has("guard_elimination")) {
    const guardCandidate = eliminateGuards(current, rangeResult.rangeMap);
    const guardCandidateCertificate: OptimizeCertificates["guardElimination"] = {
      usedRangeExprIds: [...guardCandidate.usedRangeExprIds],
      removed: {
        nanToZero: guardCandidate.removedNanToZero,
        totalDiv: guardCandidate.removedTotalDiv,
        totalMod: guardCandidate.removedTotalMod,
      },
    };
    const guardValidation = validateGuardEliminationPassCertificate(
      current,
      guardCandidate.program,
      guardCandidateCertificate,
    );
    if (proofGate && !guardValidation.ok) {
      guardResult = {
        program: current,
        changed: false,
        removedNanToZero: 0,
        removedTotalDiv: 0,
        removedTotalMod: 0,
        usedRangeExprIds: [],
      };
      guardCertificate = {
        usedRangeExprIds: [],
        removed: {
          nanToZero: 0,
          totalDiv: 0,
          totalMod: 0,
        },
      };
    } else {
      guardResult = guardCandidate;
      guardCertificate = guardCandidateCertificate;
      current = guardResult.program;
    }
    reports.push({
      name: "guard_elimination",
      changed: guardResult.changed,
      details: [
        `removed_nan_to_zero=${guardResult.removedNanToZero}`,
        `removed_total_div=${guardResult.removedTotalDiv}`,
        `removed_total_mod=${guardResult.removedTotalMod}`,
        proofGate
          ? guardValidation.ok
            ? "proof_gate=accepted"
            : `proof_gate=rejected: ${guardValidation.detail}`
          : `certificate=${guardValidation.ok ? "ok" : `invalid: ${guardValidation.detail}`}`,
      ],
    });

    if (guardResult.changed) {
      rangeResult = analyzeRanges(current, options.parameterRangeHints);
    }
  } else {
    reports.push({
      name: "guard_elimination",
      changed: false,
      details: ["disabled by option"],
    });
  }

  const artifacts: OptimizeArtifacts = {
    rangeMap: rangeResult.rangeMap,
    cardinalityMap: rangeResult.cardinalityMap,
    implementations: new Map(),
    researchCandidates: new Map(),
  };

  if (!disabledPasses.has("closed_form")) {
    const closedFormCandidate = matchClosedForms(current);
    const closedFormCertificate: OptimizeCertificates["closedForm"] = {
      matches: closedFormCandidate.map((match) => ({
        fnName: match.fnName,
        implementation: match.implementation,
        assumptions: [
          `param ${match.implementation.paramIndex} is an int countdown with lower bound >= 0`,
          `closed form is base ${match.implementation.baseValue} + step ${match.implementation.stepValue} * floor_div(param, ${match.implementation.decrement})`,
        ],
      })),
    };
    const closedFormValidation = validateClosedFormPassCertificate(current, closedFormCertificate);
    closedFormsMatched = proofGate && !closedFormValidation.ok ? [] : closedFormCandidate;
    for (const match of closedFormsMatched) {
      artifacts.implementations.set(match.fnName, match.implementation);
    }
    reports.push({
      name: "closed_form",
      changed: closedFormsMatched.length > 0,
      details: [
        ...closedFormsMatched.map((match) => `${match.fnName}: ${match.implementation.tag}`),
        proofGate
          ? closedFormValidation.ok
            ? "proof_gate=accepted"
            : `proof_gate=rejected: ${closedFormValidation.detail}`
          : `certificate=${closedFormValidation.ok ? "ok" : `invalid: ${closedFormValidation.detail}`}`,
      ],
    });
  } else {
    reports.push({
      name: "closed_form",
      changed: false,
      details: ["disabled by option"],
    });
  }

  if (!disabledPasses.has("lut_tabulation")) {
    const lutCandidate = tabulateLuts(current, artifacts, options.lutThreshold ?? 256);
    const lutCertificate: OptimizeCertificates["lut"] = {
      entries: lutCandidate.map((lut) => ({
        fnName: lut.fnName,
        parameterRanges: lut.implementation.parameterRanges,
        tableLength: lut.implementation.table.length,
        fallback: "final_optimized_ir" as const,
      })),
    };
    const lutValidation = validateLutPassCertificate(lutCertificate);
    lutsMatched = proofGate && !lutValidation.ok ? [] : lutCandidate;
    for (const lut of lutsMatched) {
      artifacts.implementations.set(lut.fnName, lut.implementation);
    }
    reports.push({
      name: "lut_tabulation",
      changed: lutsMatched.length > 0,
      details: [
        ...lutsMatched.map((lut) => `${lut.fnName}: ${lut.implementation.table.length} entries`),
        proofGate
          ? lutValidation.ok
            ? "proof_gate=accepted"
            : `proof_gate=rejected: ${lutValidation.detail}`
          : `certificate=${lutValidation.ok ? "ok" : `invalid: ${lutValidation.detail}`}`,
      ],
    });
  } else {
    reports.push({
      name: "lut_tabulation",
      changed: false,
      details: ["disabled by option"],
    });
  }

  if (options.enableResearchPasses) {
    if (!disabledPasses.has("aitken")) {
      const aitkenMatches = matchAitkenPass(current);
      const details: string[] = [];
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
            reason:
              match.implementation.targetParamIndex === null
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
            reason:
              match.implementation.targetParamIndex === null
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
    } else {
      reports.push({
        name: "aitken",
        changed: false,
        details: ["disabled by option"],
        experimental: true,
      });
    }

    if (!disabledPasses.has("linear_speculation")) {
      const linearMatches = matchLinearSpeculationPass(current);
      const details: string[] = [];
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
    } else {
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
    stages: {
      rawProgram: program,
      canonical,
      canonicalRanges: canonicalRangeResult,
      guardElided: guardResult,
      finalRanges: rangeResult,
    },
    certificates: {
      canonicalize: {
        passOrder: canonical.passOrder,
        stats: canonical.stats,
      },
      rangeAnalysis: {
        consumedExprIds: [...guardResult.usedRangeExprIds],
      },
      guardElimination: guardCertificate,
      finalIdentity: {
        reason: "final optimized IR reuses the guard-elided program; later optimization choices are emitted as implementation artifacts",
      },
      closedForm: {
        matches: closedFormsMatched.map((match) => ({
          fnName: match.fnName,
          implementation: match.implementation,
          assumptions: [
            `param ${match.implementation.paramIndex} is an int countdown with lower bound >= 0`,
            `closed form is base ${match.implementation.baseValue} + step ${match.implementation.stepValue} * floor_div(param, ${match.implementation.decrement})`,
          ],
        })),
      },
      lut: {
        entries: lutsMatched.map((lut) => ({
          fnName: lut.fnName,
          parameterRanges: lut.implementation.parameterRanges,
          tableLength: lut.implementation.table.length,
          fallback: "final_optimized_ir" as const,
        })),
      },
    },
    provenance: {
      rawToCanonical: buildExprProvenance(program, canonical.program),
      canonicalToGuardElided: buildExprProvenance(canonical.program, guardResult.program),
      guardElidedToFinalOptimized: buildExprProvenance(guardResult.program, current),
    },
  };
}

function appendResearchCandidate(
  target: Map<string, ResearchCandidate[]>,
  fnName: string,
  candidate: ResearchCandidate,
): void {
  const current = target.get(fnName) ?? [];
  target.set(fnName, [...current, candidate]);
}
