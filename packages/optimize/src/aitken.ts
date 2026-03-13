import type { IRExpr, IRFunction, IRProgram } from "@jplmm/ir";

import type { AitkenImplementation, AitkenMatch } from "./types";
import { stripNanToZero } from "./utils";

export function matchAitkenPass(program: IRProgram): AitkenMatch[] {
  const matches: AitkenMatch[] = [];
  for (const fn of program.functions) {
    const implementation = matchScalarTailAitken(fn);
    if (implementation) {
      matches.push({ fnName: fn.name, implementation });
    }
  }
  return matches;
}

function matchScalarTailAitken(fn: IRFunction): AitkenImplementation | null {
  if (fn.retType.tag !== "float" || fn.params.length === 0) {
    return null;
  }

  const retStmts = fn.body.filter((stmt) => stmt.tag === "ret");
  const tailRet = retStmts.find(
    (stmt) => stmt.expr.tag === "rec" && stmt.expr.tailPosition,
  );
  if (!tailRet || tailRet.expr.tag !== "rec" || retStmts.length < 2) {
    return null;
  }

  const invariantParamIndices: number[] = [];
  let stateParamIndex: number | null = null;

  for (let i = 0; i < fn.params.length; i += 1) {
    const param = fn.params[i];
    const arg = tailRet.expr.args[i];
    if (!param || !arg) {
      return null;
    }
    if (arg.tag === "var" && arg.name === param.name) {
      invariantParamIndices.push(i);
      continue;
    }
    if (stateParamIndex !== null) {
      return null;
    }
    if (param.type.tag !== "float" || arg.resultType.tag !== "float") {
      return null;
    }
    stateParamIndex = i;
  }

  if (stateParamIndex === null) {
    return null;
  }

  const targetParamIndex = inferTargetParamIndex(fn, stateParamIndex);
  if (targetParamIndex !== null && fn.params[targetParamIndex]?.type.tag !== "float") {
    return null;
  }

  return {
    tag: "aitken_scalar_tail",
    stateParamIndex,
    afterIterations: 3,
    invariantParamIndices,
    targetParamIndex,
  };
}

function inferTargetParamIndex(fn: IRFunction, stateParamIndex: number): number | null {
  const radStmt = fn.body.find((stmt) => stmt.tag === "rad");
  if (radStmt && radStmt.tag === "rad") {
    for (let i = 0; i < fn.params.length; i += 1) {
      if (i === stateParamIndex || fn.params[i]?.type.tag !== "float") {
        continue;
      }
      if (matchesRadTargetMinusRes(radStmt.expr, fn.params[i]!.name)) {
        return i;
      }
      if (matchesRadStateDelta(radStmt.expr, fn.params[stateParamIndex]!.name)) {
        return null;
      }
    }
  }

  const floatInvariants = fn.params
    .map((param, idx) => ({ param, idx }))
    .filter(
      ({ param, idx }) =>
        idx !== stateParamIndex &&
        param.type.tag === "float" &&
        tailArgIsInvariant(fn, idx),
    );
  if (floatInvariants.length === 1) {
    return floatInvariants[0]!.idx;
  }
  return null;
}

function tailArgIsInvariant(fn: IRFunction, index: number): boolean {
  const tailRet = fn.body.find(
    (stmt) => stmt.tag === "ret" && stmt.expr.tag === "rec" && stmt.expr.tailPosition,
  );
  if (!tailRet || tailRet.tag !== "ret" || tailRet.expr.tag !== "rec") {
    return false;
  }
  const arg = tailRet.expr.args[index];
  const param = fn.params[index];
  return Boolean(arg && param && arg.tag === "var" && arg.name === param.name);
}

function matchesRadTargetMinusRes(expr: IRExpr, targetParamName: string): boolean {
  const stripped = stripNanToZero(expr);
  if (stripped.tag !== "binop" || stripped.op !== "-") {
    return false;
  }
  return (
    (stripped.left.tag === "var" &&
      stripped.left.name === targetParamName &&
      stripped.right.tag === "res") ||
    (stripped.right.tag === "var" &&
      stripped.right.name === targetParamName &&
      stripped.left.tag === "res")
  );
}

function matchesRadStateDelta(expr: IRExpr, stateParamName: string): boolean {
  const stripped = stripNanToZero(expr);
  if (stripped.tag !== "binop" || stripped.op !== "-") {
    return false;
  }
  return (
    (stripped.left.tag === "var" &&
      stripped.left.name === stateParamName &&
      stripped.right.tag === "res") ||
    (stripped.right.tag === "var" &&
      stripped.right.name === stateParamName &&
      stripped.left.tag === "res")
  );
}
