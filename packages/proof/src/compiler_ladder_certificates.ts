import type { IRExpr, IRProgram } from "@jplmm/ir";
import { isNaNlessCanonical, matchClosedForms, type OptimizeResult } from "@jplmm/optimize";

import type {
  SemanticsCertificateRecord,
  SemanticsEdgeRecord,
  SerializedRangeAnalysis,
} from "./compiler_ladder";

export function validateCanonicalizeCertificate(
  rawProgram: IRProgram,
  canonicalProgram: IRProgram,
  certificate: OptimizeResult["certificates"]["canonicalize"],
): SemanticsCertificateRecord {
  const rawCounts = countProgramOps(rawProgram);
  const canonicalCounts = countProgramOps(canonicalProgram);
  const derived = {
    totalDivInserted: canonicalCounts.totalDiv - rawCounts.totalDiv,
    totalModInserted: canonicalCounts.totalMod - rawCounts.totalMod,
    nanToZeroInserted: canonicalCounts.nanToZero - rawCounts.nanToZero,
    satAddInserted: canonicalCounts.satAdd - rawCounts.satAdd,
    satSubInserted: canonicalCounts.satSub - rawCounts.satSub,
    satMulInserted: canonicalCounts.satMul - rawCounts.satMul,
    satNegInserted: canonicalCounts.satNeg - rawCounts.satNeg,
    zeroDivisorConstantFolded: rawCounts.zeroDivisorBinops,
  };
  const stats = certificate.stats;
  const targetCanonical = isNaNlessCanonical(canonicalProgram);
  const statsMatch =
    derived.totalDivInserted === stats.totalDivInserted &&
    derived.totalModInserted === stats.totalModInserted &&
    derived.nanToZeroInserted === stats.nanToZeroInserted &&
    derived.satAddInserted === stats.satAddInserted &&
    derived.satSubInserted === stats.satSubInserted &&
    derived.satMulInserted === stats.satMulInserted &&
    derived.satNegInserted === stats.satNegInserted &&
    derived.zeroDivisorConstantFolded === stats.zeroDivisorConstantFolded;
  return {
    kind: "canonicalize",
    passOrder: certificate.passOrder,
    stats,
    validation: {
      ok: targetCanonical && statsMatch,
      detail: targetCanonical && statsMatch
        ? "target program satisfies canonical total/saturating form and derived rewrite counts match the emitted stats"
        : !targetCanonical
          ? "target program is not in the expected canonical total/saturating form"
          : "derived rewrite counts do not match the emitted canonicalization stats",
      derived,
      targetCanonical,
    },
  };
}

export function validateRangeAnalysisCertificate(
  program: IRProgram,
  certificate: OptimizeResult["certificates"]["rangeAnalysis"],
): SemanticsCertificateRecord {
  const attachedExprIds = [...collectProgramExprIds(program)].sort((left, right) => left - right);
  const attached = new Set(attachedExprIds);
  const exprIds = [...new Set(certificate.exprIds)].sort((left, right) => left - right);
  const uniqueConsumed = [...new Set(certificate.consumedExprIds)].sort((left, right) => left - right);
  const missingExprIds = exprIds.filter((exprId) => !attached.has(exprId));
  return {
    kind: "range_analysis",
    exprIds,
    consumedExprIds: uniqueConsumed,
    validation: {
      ok: missingExprIds.length === 0,
      detail: missingExprIds.length === 0
        ? "all canonical range facts are attached to canonical IR expressions"
        : `some canonical range facts are not attached to canonical IR expressions: ${missingExprIds.join(", ")}`,
      attachedExprIds,
      missingExprIds,
    },
  };
}

export function validateGuardEliminationCertificate(
  canonicalProgram: IRProgram,
  guardProgram: IRProgram,
  certificate: OptimizeResult["certificates"]["guardElimination"],
): SemanticsCertificateRecord {
  const canonicalCounts = countProgramOps(canonicalProgram);
  const guardCounts = countProgramOps(guardProgram);
  const derivedRemoved = {
    nanToZero: canonicalCounts.nanToZero - guardCounts.nanToZero,
    totalDiv: canonicalCounts.totalDiv - guardCounts.totalDiv,
    totalMod: canonicalCounts.totalMod - guardCounts.totalMod,
  };
  const attached = new Set(collectProgramExprIds(canonicalProgram));
  const usedRangeExprIds = [...new Set(certificate.usedRangeExprIds)].sort((left, right) => left - right);
  const missingExprIds = usedRangeExprIds.filter((exprId) => !attached.has(exprId));
  const removedMatch =
    derivedRemoved.nanToZero === certificate.removed.nanToZero &&
    derivedRemoved.totalDiv === certificate.removed.totalDiv &&
    derivedRemoved.totalMod === certificate.removed.totalMod;
  return {
    kind: "guard_elimination",
    usedRangeExprIds,
    removed: certificate.removed,
    validation: {
      ok: removedMatch && missingExprIds.length === 0,
      detail: removedMatch && missingExprIds.length === 0
        ? "guard-elimination counts match the structural diff and every consumed range fact is attached to canonical IR"
        : !removedMatch
          ? "guard-elimination removal counts do not match the structural diff between canonical_ir and guard_elided_ir"
          : `guard-elimination consumed unattached range facts: ${missingExprIds.join(", ")}`,
      derivedRemoved,
      missingExprIds,
    },
  };
}

export function validateIdentityCertificate(
  certificate: OptimizeResult["certificates"]["finalIdentity"],
): SemanticsCertificateRecord {
  return {
    kind: "identity",
    reason: certificate.reason,
    validation: {
      ok: true,
      detail: certificate.reason,
    },
  };
}

export function validateClosedFormCertificate(
  program: IRProgram,
  certificate: OptimizeResult["certificates"]["closedForm"],
): SemanticsCertificateRecord {
  const rediscovered = new Map(matchClosedForms(program).map((match) => [match.fnName, match.implementation] as const));
  const unmatched = certificate.matches
    .filter((match) => JSON.stringify(rediscovered.get(match.fnName) ?? null) !== JSON.stringify(match.implementation))
    .map((match) => match.fnName);
  return {
    kind: "closed_form",
    matches: certificate.matches,
    validation: {
      ok: unmatched.length === 0,
      detail: unmatched.length === 0
        ? "every emitted closed-form implementation is rediscovered by the local matcher"
        : `closed-form implementations could not be rediscovered for: ${unmatched.join(", ")}`,
      unmatched,
    },
  };
}

export function validateLutCertificate(certificate: OptimizeResult["certificates"]["lut"]): SemanticsCertificateRecord {
  const invalidEntries = certificate.entries
    .filter((entry) => entry.tableLength !== lutCardinality(entry.parameterRanges))
    .map((entry) => entry.fnName);
  return {
    kind: "lut",
    entries: certificate.entries,
    validation: {
      ok: invalidEntries.length === 0,
      detail: invalidEntries.length === 0
        ? "every LUT table length matches the cartesian product of its finite integer ranges"
        : `LUT table lengths do not match their declared domains for: ${invalidEntries.join(", ")}`,
      invalidEntries,
    },
  };
}

export function revalidateCertificate(
  edges: SemanticsEdgeRecord[],
  from: SemanticsEdgeRecord["from"],
  to: SemanticsEdgeRecord["to"],
  baselineProgram: IRProgram,
  refinedProgram: IRProgram | null,
  rangeAnalysis: SerializedRangeAnalysis | null = null,
): SemanticsCertificateRecord | null {
  void rangeAnalysis;
  const existing = edges.find((edge) => edge.from === from && edge.to === to)?.certificate;
  if (!existing) {
    return null;
  }
  switch (existing.kind) {
    case "ast_lowering":
      return existing;
    case "canonicalize":
      return validateCanonicalizeCertificate(baselineProgram, refinedProgram ?? baselineProgram, {
        passOrder: existing.passOrder,
        stats: existing.stats,
      });
    case "range_analysis":
      return validateRangeAnalysisCertificate(baselineProgram, {
        exprIds: existing.exprIds,
        consumedExprIds: existing.consumedExprIds,
      });
    case "guard_elimination":
      return validateGuardEliminationCertificate(baselineProgram, refinedProgram ?? baselineProgram, {
        usedRangeExprIds: existing.usedRangeExprIds,
        removed: existing.removed,
      });
    case "identity":
      return validateIdentityCertificate({
        reason: existing.reason,
      });
    case "closed_form":
      return validateClosedFormCertificate(baselineProgram, {
        matches: existing.matches,
      });
    case "lut":
      return validateLutCertificate({
        entries: existing.entries,
      });
    default: {
      const _never: never = existing;
      return _never;
    }
  }
}

type IrOpCounts = {
  totalDiv: number;
  totalMod: number;
  nanToZero: number;
  satAdd: number;
  satSub: number;
  satMul: number;
  satNeg: number;
  zeroDivisorBinops: number;
};

function lutCardinality(ranges: Array<{ lo: number; hi: number }>): number {
  return ranges.reduce((product, range) => product * (range.hi - range.lo + 1), 1);
}

function countProgramOps(program: IRProgram): IrOpCounts {
  const counts: IrOpCounts = {
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

function countExprOps(expr: IRExpr, counts: IrOpCounts): void {
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
    case "nan_to_zero":
      counts.nanToZero += 1;
      countExprOps(expr.value, counts);
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
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}

function isZeroLiteralExpr(expr: IRExpr): boolean {
  return (expr.tag === "int_lit" || expr.tag === "float_lit") && expr.value === 0;
}

function collectProgramExprIds(program: IRProgram): number[] {
  const ids = new Set<number>();
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
  return [...ids];
}

function collectExprIds(expr: IRExpr, out: Set<number>): void {
  if (out.has(expr.id)) {
    return;
  }
  out.add(expr.id);
  switch (expr.tag) {
    case "int_lit":
    case "float_lit":
    case "void_lit":
    case "var":
    case "res":
      return;
    case "unop":
      collectExprIds(expr.operand, out);
      return;
    case "nan_to_zero":
      collectExprIds(expr.value, out);
      return;
    case "sat_neg":
      collectExprIds(expr.operand, out);
      return;
    case "binop":
    case "total_div":
    case "total_mod":
    case "sat_add":
    case "sat_sub":
    case "sat_mul":
      collectExprIds(expr.left, out);
      collectExprIds(expr.right, out);
      return;
    case "call":
      for (const arg of expr.args) {
        collectExprIds(arg, out);
      }
      return;
    case "index":
      collectExprIds(expr.array, out);
      for (const index of expr.indices) {
        collectExprIds(index, out);
      }
      return;
    case "field":
      collectExprIds(expr.target, out);
      return;
    case "struct_cons":
      for (const field of expr.fields) {
        collectExprIds(field, out);
      }
      return;
    case "array_cons":
      for (const element of expr.elements) {
        collectExprIds(element, out);
      }
      return;
    case "array_expr":
    case "sum_expr":
      for (const binding of expr.bindings) {
        collectExprIds(binding.expr, out);
      }
      collectExprIds(expr.body, out);
      return;
    case "rec":
      for (const arg of expr.args) {
        collectExprIds(arg, out);
      }
      return;
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}
