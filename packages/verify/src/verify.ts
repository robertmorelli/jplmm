import type { Cmd, Program, Type } from "@jplmm/ast";
import { typecheckProgram } from "@jplmm/frontend";

import { analyzeFunction, proveWithSmt } from "./prover";
import { checkStructuralDecrease, findRadExprs, hasRec } from "./structural";
import type { ProofMethod, ProofResult, VerificationDiagnostic, VerificationOutput } from "./types";

export function verifyProgram(program: Program, typeMap?: Map<number, Type>): VerificationOutput {
  const proofMap = new Map<string, ProofResult>();
  const diagnostics: VerificationDiagnostic[] = [];
  const effectiveTypeMap = typeMap ?? typecheckProgram(program).typeMap;

  for (const cmd of program.commands) {
    const fn = unwrapTimedDefinition(cmd, "fn_def");
    if (!fn) {
      continue;
    }
    const result = verifyFunction(fn, effectiveTypeMap, diagnostics);
    if (result) {
      proofMap.set(fn.name, result);
    }
  }

  return { proofMap, diagnostics };
}

function verifyFunction(
  fn: Extract<Cmd, { tag: "fn_def" }>,
  typeMap: Map<number, Type>,
  diagnostics: VerificationDiagnostic[],
): ProofResult | null {
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

  const rads = findRadExprs(fn.body);
  if (rads.length === 0) {
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

  const analysis = analyzeFunction(fn, typeMap);
  const methods: ProofMethod[] = [];
  const details: string[] = [];

  for (let siteIndex = 0; siteIndex < analysis.recSites.length; siteIndex += 1) {
    const site = analysis.recSites[siteIndex]!;
    const candidateRads = analysis.radSites;
    if (candidateRads.length === 0) {
      diagnostics.push({
        fnName: fn.name,
        code: "VERIFY_PROOF_FAIL",
        severity: "error",
        message: `${fn.name}: rec site ${siteIndex + 1} has no preceding rad expression`,
      });
      return {
        status: "rejected",
        method: "none",
        details: `rec site ${siteIndex + 1} has no preceding rad expression`,
      };
    }

    let proved = false;
    const reasons: string[] = [];

    for (const rad of candidateRads) {
      const structural = checkStructuralDecrease(fn.params, rad.source, site.args);
      if (structural.ok) {
        proved = true;
        methods.push("structural");
        details.push(`rec site ${siteIndex + 1}: structural via '${rad.rendered}'`);
        break;
      }
      reasons.push(structural.reason);

      const smt = proveWithSmt(fn, rad, site, analysis.callSigs);
      if (smt.ok) {
        proved = true;
        methods.push("smt");
        details.push(`rec site ${siteIndex + 1}: ${smt.details}`);
        break;
      }
      reasons.push(...smt.reasons);
    }

    if (!proved) {
      diagnostics.push({
        fnName: fn.name,
        code: "VERIFY_PROOF_FAIL",
        severity: "error",
        message: `${fn.name}: rec site ${siteIndex + 1} failed proof obligations; ${unique(reasons).join("; ")}; consider using gas N if a convergence proof is not possible`,
      });
      return {
        status: "rejected",
        method: "none",
        details: unique(reasons).join("; "),
      };
    }
  }

  return {
    status: "verified",
    method: methods.some((method) => method === "smt") ? "smt" : "structural",
    details: details.join("; "),
  };
}

function unwrapTimedDefinition<TTag extends "fn_def">(
  cmd: Cmd,
  tag: TTag,
): Extract<Cmd, { tag: TTag }> | null {
  if (cmd.tag === tag) {
    return cmd as Extract<Cmd, { tag: TTag }>;
  }
  if (cmd.tag === "time" && cmd.cmd.tag === tag) {
    return cmd.cmd as Extract<Cmd, { tag: TTag }>;
  }
  return null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
