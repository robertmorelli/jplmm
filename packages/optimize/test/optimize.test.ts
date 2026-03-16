import { describe, expect, it } from "vitest";

import type { IRExpr, IRProgram } from "@jplmm/ir";
import type { Type } from "@jplmm/ast";
import { buildIR } from "@jplmm/ir";
import { runFrontend } from "@jplmm/frontend";

import {
  canonicalizeProgram,
  isNaNlessCanonical,
  optimizeProgram,
  packageName,
  validateOptimizeCertificates,
} from "../src/index.ts";

const INT_T: Type = { tag: "int" };
const FLOAT_T: Type = { tag: "float" };

function wrapInProgram(expr: IRExpr, retType: Type = expr.resultType): IRProgram {
  return {
    globals: [],
    functions: [
      {
        name: "f",
        params: [],
        retType,
        body: [{ tag: "ret", expr, id: 1000 }],
        id: 999,
      },
    ],
  };
}

function compile(source: string) {
  const frontend = runFrontend(source);
  expect(frontend.diagnostics).toEqual([]);
  return buildIR(frontend.program, frontend.typeMap);
}

describe("@jplmm/optimize", () => {
  it("exports its package identity", () => {
    expect(packageName).toBe("@jplmm/optimize");
  });

  it("runs total arithmetic before saturating arithmetic", () => {
    const expr: IRExpr = {
      tag: "binop",
      op: "+",
      left: {
        tag: "binop",
        op: "/",
        left: { tag: "int_lit", value: 10, id: 1, resultType: INT_T },
        right: { tag: "var", name: "x", id: 2, resultType: INT_T },
        id: 3,
        resultType: INT_T,
      },
      right: { tag: "int_lit", value: 1, id: 4, resultType: INT_T },
      id: 5,
      resultType: INT_T,
    };
    const result = canonicalizeProgram(wrapInProgram(expr));
    expect(result.passOrder).toEqual(["total_arithmetic", "saturating_arithmetic"]);

    const outExpr = result.program.functions[0]?.body[0];
    expect(outExpr?.tag).toBe("ret");
    if (outExpr?.tag === "ret") {
      expect(outExpr.expr.tag).toBe("sat_add");
      if (outExpr.expr.tag === "sat_add") {
        expect([outExpr.expr.left.tag, outExpr.expr.right.tag].sort()).toEqual(["int_lit", "total_div"]);
      }
    }
  });

  it("constant-folds zero-divisor integer division to 0", () => {
    const expr: IRExpr = {
      tag: "binop",
      op: "/",
      left: { tag: "var", name: "x", id: 1, resultType: INT_T },
      right: { tag: "int_lit", value: 0, id: 2, resultType: INT_T },
      id: 3,
      resultType: INT_T,
    };
    const result = canonicalizeProgram(wrapInProgram(expr));
    const ret = result.program.functions[0]?.body[0];
    expect(ret?.tag).toBe("ret");
    if (ret?.tag === "ret") {
      expect(ret.expr.tag).toBe("int_lit");
      if (ret.expr.tag === "int_lit") {
        expect(ret.expr.value).toBe(0);
      }
    }
    expect(result.stats.zeroDivisorConstantFolded).toBe(1);
  });

  it("rewrites float division to NanToZero(TotalDiv) with zero-yield semantics", () => {
    const expr: IRExpr = {
      tag: "binop",
      op: "/",
      left: { tag: "var", name: "a", id: 1, resultType: FLOAT_T },
      right: { tag: "var", name: "b", id: 2, resultType: FLOAT_T },
      id: 3,
      resultType: FLOAT_T,
    };
    const result = canonicalizeProgram(wrapInProgram(expr, FLOAT_T));
    const ret = result.program.functions[0]?.body[0];
    expect(ret?.tag).toBe("ret");
    if (ret?.tag === "ret") {
      expect(ret.expr.tag).toBe("nan_to_zero");
      if (ret.expr.tag === "nan_to_zero") {
        expect(ret.expr.value.tag).toBe("total_div");
        if (ret.expr.value.tag === "total_div") {
          expect(ret.expr.value.zeroDivisorValue).toBe(0);
        }
      }
    }
  });

  it("wraps NaN-sensitive float arithmetic and builtins", () => {
    const expr: IRExpr = {
      tag: "binop",
      op: "+",
      left: {
        tag: "call",
        name: "sqrt",
        args: [{ tag: "var", name: "x", id: 1, resultType: FLOAT_T }],
        id: 2,
        resultType: FLOAT_T,
      },
      right: { tag: "float_lit", value: 1, id: 3, resultType: FLOAT_T },
      id: 4,
      resultType: FLOAT_T,
    };
    const result = canonicalizeProgram(wrapInProgram(expr, FLOAT_T));
    expect(isNaNlessCanonical(result.program)).toBe(true);
    expect(result.stats.nanToZeroInserted).toBeGreaterThan(0);
  });

  it("rewrites int add/sub/mul/neg to saturating nodes", () => {
    const expr: IRExpr = {
      tag: "binop",
      op: "*",
      left: {
        tag: "binop",
        op: "-",
        left: {
          tag: "unop",
          op: "-",
          operand: { tag: "var", name: "x", id: 1, resultType: INT_T },
          id: 2,
          resultType: INT_T,
        },
        right: { tag: "int_lit", value: 7, id: 3, resultType: INT_T },
        id: 4,
        resultType: INT_T,
      },
      right: { tag: "int_lit", value: 2, id: 5, resultType: INT_T },
      id: 6,
      resultType: INT_T,
    };
    const result = canonicalizeProgram(wrapInProgram(expr, INT_T));
    const ret = result.program.functions[0]?.body[0];
    expect(ret?.tag).toBe("ret");
    if (ret?.tag === "ret") {
      expect(ret.expr.tag).toBe("sat_mul");
      if (ret.expr.tag === "sat_mul") {
        const nested = ret.expr.left.tag === "sat_sub" ? ret.expr.left : ret.expr.right.tag === "sat_sub" ? ret.expr.right : null;
        expect(nested?.tag).toBe("sat_sub");
        if (nested?.tag === "sat_sub") {
          expect([nested.left.tag, nested.right.tag].sort()).toContain("sat_neg");
        }
      }
    }
  });

  it("sorts commutative operands in canonical IR for scalar and saturating arithmetic", () => {
    const intExpr: IRExpr = {
      tag: "binop",
      op: "+",
      left: { tag: "var", name: "b", id: 1, resultType: INT_T },
      right: { tag: "var", name: "a", id: 2, resultType: INT_T },
      id: 3,
      resultType: INT_T,
    };
    const floatExpr: IRExpr = {
      tag: "binop",
      op: "*",
      left: { tag: "var", name: "rhs", id: 4, resultType: FLOAT_T },
      right: { tag: "var", name: "lhs", id: 5, resultType: FLOAT_T },
      id: 6,
      resultType: FLOAT_T,
    };

    const intResult = canonicalizeProgram(wrapInProgram(intExpr, INT_T));
    const floatResult = canonicalizeProgram(wrapInProgram(floatExpr, FLOAT_T));

    const intRet = intResult.program.functions[0]?.body[0];
    expect(intRet?.tag).toBe("ret");
    if (intRet?.tag === "ret") {
      expect(intRet.expr.tag).toBe("sat_add");
      if (intRet.expr.tag === "sat_add") {
        expect(intRet.expr.left.tag).toBe("var");
        expect(intRet.expr.right.tag).toBe("var");
        if (intRet.expr.left.tag === "var" && intRet.expr.right.tag === "var") {
          expect(intRet.expr.left.name).toBe("a");
          expect(intRet.expr.right.name).toBe("b");
        }
      }
    }

    const floatRet = floatResult.program.functions[0]?.body[0];
    expect(floatRet?.tag).toBe("ret");
    if (floatRet?.tag === "ret") {
      expect(floatRet.expr.tag).toBe("nan_to_zero");
      if (floatRet.expr.tag === "nan_to_zero") {
        expect(floatRet.expr.value.tag).toBe("binop");
        if (floatRet.expr.value.tag === "binop") {
          expect(floatRet.expr.value.left.tag).toBe("var");
          expect(floatRet.expr.value.right.tag).toBe("var");
          if (floatRet.expr.value.left.tag === "var" && floatRet.expr.value.right.tag === "var") {
            expect(floatRet.expr.value.left.name).toBe("lhs");
            expect(floatRet.expr.value.right.name).toBe("rhs");
          }
        }
      }
    }
  });

  it("builds a pipeline report with research-pass candidates", () => {
    const program = compile(`
      fn zero(x:int): int {
        ret x;
        ret rec(max(0, x - 1));
        rad x;
      }
    `);
    const result = optimizeProgram(program, {
      enableResearchPasses: true,
    });

    expect(result.reports.some((report) => report.name === "range_analysis")).toBe(true);
    expect(result.reports.some((report) => report.name === "linear_speculation" && report.experimental)).toBe(true);
    expect(result.artifacts.implementations.get("zero")?.tag).toBe("linear_speculation");
    expect(result.artifacts.researchCandidates.get("zero")?.some((c) => c.pass === "linear_speculation")).toBe(
      true,
    );
  });

  it("eliminates redundant NaN guards when ranges prove the domain", () => {
    const program = compile(`
      fn rootish(x:float): float {
        ret sqrt(max(0.0, x));
      }
    `);
    const result = optimizeProgram(program);
    const guardReport = result.reports.find((report) => report.name === "guard_elimination");
    expect(guardReport?.changed).toBe(true);
    expect(guardReport?.details.some((detail) => detail.includes("removed_nan_to_zero=1"))).toBe(true);
  });

  it("exports independently checkable pass certificates", () => {
    const program = compile(`
      fn steps(x:int(0,_)): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad x;
      }
    `);
    const result = optimizeProgram(program);
    const checks = validateOptimizeCertificates(result);

    expect(checks.canonicalize.ok).toBe(true);
    expect(checks.rangeAnalysis.ok).toBe(true);
    expect(checks.guardElimination.ok).toBe(true);
    expect(checks.finalIdentity.ok).toBe(true);
    expect(checks.closedForm.ok).toBe(true);
    expect(checks.lut.ok).toBe(true);
  });

  it("can proof-gate locally checkable optimization certificates", () => {
    const program = compile(`
      fn steps(x:int(0,_)): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad x;
      }
    `);
    const result = optimizeProgram(program, { proofGateCertificates: true });

    expect(result.artifacts.implementations.get("steps")?.tag).toBe("closed_form_linear_countdown");
    expect(result.reports.find((report) => report.name === "canonicalize")?.details).toContain("proof_gate=accepted");
    expect(result.reports.find((report) => report.name === "guard_elimination")?.details).toContain("proof_gate=accepted");
    expect(result.reports.find((report) => report.name === "closed_form")?.details).toContain("proof_gate=accepted");
    expect(result.reports.find((report) => report.name === "lut_tabulation")?.details).toContain("proof_gate=accepted");
  });

  it("records rule-level provenance for rewritten IR nodes", () => {
    const program = compile(`
      fn safe_div(x:int): int {
        ret (x / 1) + 1;
      }
    `);
    const result = optimizeProgram(program);
    const entries = [...result.provenance.rawToCanonical.byOutputExprId.values()];

    expect(entries.some((entry) => entry.rule === "canonicalize_total_div")).toBe(true);
    expect(entries.every((entry) => Object.prototype.hasOwnProperty.call(entry, "rule"))).toBe(true);
  });
});
