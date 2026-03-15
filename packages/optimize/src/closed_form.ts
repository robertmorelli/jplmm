import { getScalarBounds } from "@jplmm/ast";
import type { IRExpr, IRFunction, IRProgram } from "@jplmm/ir";

import type { ClosedFormMatch, ClosedFormImplementation } from "./types";

export function matchClosedForms(program: IRProgram): ClosedFormMatch[] {
  const matches: ClosedFormMatch[] = [];
  for (const fn of program.functions) {
    const implementation = matchLinearCountdown(fn);
    if (implementation) {
      matches.push({ fnName: fn.name, implementation });
    }
  }
  return matches;
}

function matchLinearCountdown(fn: IRFunction): ClosedFormImplementation | null {
  if (fn.params.length !== 1 || fn.params[0]?.type.tag !== "int" || fn.retType.tag !== "int") {
    return null;
  }
  const bounds = getScalarBounds(fn.params[0]?.type);
  if (bounds?.lo === null || bounds?.lo === undefined || bounds.lo < 0) {
    return null;
  }

  const retStmts = fn.body.filter((stmt) => stmt.tag === "ret");
  const radStmt = fn.body.find((stmt) => stmt.tag === "rad");
  if (retStmts.length < 2 || !radStmt || radStmt.tag !== "rad") {
    return null;
  }
  if (radStmt.expr.tag !== "var" || radStmt.expr.name !== fn.params[0].name) {
    return null;
  }

  const baseRet = retStmts[0]!;
  const recRet = retStmts[1]!;
  if (baseRet.expr.tag !== "int_lit") {
    return null;
  }

  const step = matchLinearStep(recRet.expr);
  if (!step) {
    return null;
  }
  if (step.rec.args.length !== 1) {
    return null;
  }

  const decrement = matchCountdownArg(step.rec.args[0]!, fn.params[0].name);
  if (!decrement) {
    return null;
  }

  return {
    tag: "closed_form_linear_countdown",
    paramIndex: 0,
    baseValue: baseRet.expr.value,
    stepValue: step.step,
    decrement,
  };
}

function matchLinearStep(
  expr: IRExpr,
): { rec: Extract<IRExpr, { tag: "rec" }>; step: number } | null {
  if (expr.tag !== "sat_add") {
    return null;
  }
  if (expr.left.tag === "rec" && expr.right.tag === "int_lit") {
    return { rec: expr.left, step: expr.right.value };
  }
  if (expr.right.tag === "rec" && expr.left.tag === "int_lit") {
    return { rec: expr.right, step: expr.left.value };
  }
  return null;
}

function matchCountdownArg(expr: IRExpr, paramName: string): number | null {
  if (expr.tag !== "call" || expr.name !== "max" || expr.args.length !== 2) {
    return null;
  }
  const [a, b] = expr.args;
  if (!a || !b || a.tag !== "int_lit" || a.value !== 0) {
    return null;
  }

  if (b.tag === "sat_sub" && b.left.tag === "var" && b.left.name === paramName && b.right.tag === "int_lit" && b.right.value > 0) {
    return b.right.value;
  }
  if (b.tag === "binop" && b.op === "-" && b.left.tag === "var" && b.left.name === paramName && b.right.tag === "int_lit" && b.right.value > 0) {
    return b.right.value;
  }
  return null;
}
