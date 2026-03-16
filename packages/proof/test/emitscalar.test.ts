import { describe, expect, it } from "vitest";

import {
  appendScalarTypeConstraints,
  emitScalar,
  normalizeScalarForComparison,
  type ComparisonInterval,
  type ScalarExpr,
} from "../src/scalar.ts";

// Helpers
const intVar = (name: string): ScalarExpr => ({ tag: "var", name, valueType: "int" });
const intLit = (value: number): ScalarExpr => ({ tag: "int_lit", value });
const floatLit = (value: number): ScalarExpr => ({ tag: "float_lit", value });

describe("emitScalar — literals", () => {
  it("emits positive integer literal", () => {
    expect(emitScalar(intLit(7))).toBe("7");
  });

  it("emits zero", () => {
    expect(emitScalar(intLit(0))).toBe("0");
  });

  it("emits negative integer literal", () => {
    expect(emitScalar(intLit(-3))).toBe("-3");
  });

  it("emits float literal", () => {
    const result = emitScalar(floatLit(1.5));
    expect(result).toContain("1.5");
  });

  it("emits variable reference as sanitized name", () => {
    expect(emitScalar(intVar("x"))).toBe("x");
  });

  it("sanitizes variable names with dots", () => {
    expect(emitScalar(intVar("a.b"))).toBe("a_b");
  });
});

describe("emitScalar — saturating arithmetic", () => {
  it("emits sat_add as sat_add_int", () => {
    const expr: ScalarExpr = { tag: "sat_add", left: intVar("a"), right: intLit(1) };
    const result = emitScalar(expr);
    expect(result).toBe("(sat_add_int a 1)");
  });

  it("emits sat_sub as sat_sub_int", () => {
    const expr: ScalarExpr = { tag: "sat_sub", left: intVar("a"), right: intVar("b") };
    expect(emitScalar(expr)).toBe("(sat_sub_int a b)");
  });

  it("emits sat_mul as sat_mul_int", () => {
    const expr: ScalarExpr = { tag: "sat_mul", left: intVar("x"), right: intVar("y") };
    expect(emitScalar(expr)).toBe("(sat_mul_int x y)");
  });

  it("emits sat_neg as sat_neg_int", () => {
    const expr: ScalarExpr = { tag: "sat_neg", operand: intVar("n") };
    expect(emitScalar(expr)).toBe("(sat_neg_int n)");
  });
});

describe("emitScalar — total division and modulo", () => {
  it("emits total_div for int as total_div_int", () => {
    const expr: ScalarExpr = { tag: "total_div", left: intVar("a"), right: intVar("b"), valueType: "int" };
    expect(emitScalar(expr)).toBe("(total_div_int a b)");
  });

  it("emits total_mod for int as total_mod_int", () => {
    const expr: ScalarExpr = { tag: "total_mod", left: intVar("a"), right: intVar("b"), valueType: "int" };
    expect(emitScalar(expr)).toBe("(total_mod_int a b)");
  });

  it("emits total_div for float as total_div_real", () => {
    const expr: ScalarExpr = { tag: "total_div", left: { tag: "var", name: "a", valueType: "float" }, right: { tag: "var", name: "b", valueType: "float" }, valueType: "float" };
    expect(emitScalar(expr)).toBe("(total_div_real a b)");
  });
});

describe("emitScalar — binop", () => {
  it("emits int binop + as SMT +", () => {
    const expr: ScalarExpr = { tag: "binop", op: "+", left: intVar("a"), right: intVar("b"), valueType: "int" };
    expect(emitScalar(expr)).toBe("(+ a b)");
  });

  it("emits int binop - as SMT -", () => {
    const expr: ScalarExpr = { tag: "binop", op: "-", left: intVar("a"), right: intVar("b"), valueType: "int" };
    expect(emitScalar(expr)).toBe("(- a b)");
  });

  it("emits int binop * as SMT *", () => {
    const expr: ScalarExpr = { tag: "binop", op: "*", left: intVar("a"), right: intVar("b"), valueType: "int" };
    expect(emitScalar(expr)).toBe("(* a b)");
  });

  it("emits int binop / as total_div_int", () => {
    const expr: ScalarExpr = { tag: "binop", op: "/", left: intVar("a"), right: intVar("b"), valueType: "int" };
    expect(emitScalar(expr)).toBe("(total_div_int a b)");
  });
});

describe("emitScalar — special ops", () => {
  it("emits positive_extent as positive_extent_int", () => {
    const expr: ScalarExpr = { tag: "positive_extent", value: intVar("n") };
    expect(emitScalar(expr)).toBe("(positive_extent_int n)");
  });

  it("emits unop negation", () => {
    const expr: ScalarExpr = { tag: "unop", op: "-", operand: intVar("x"), valueType: "int" };
    expect(emitScalar(expr)).toBe("(- x)");
  });

  it("emits clamp_index as clamp_index_int", () => {
    const expr: ScalarExpr = { tag: "clamp_index", index: intVar("i"), dim: intVar("n") };
    expect(emitScalar(expr)).toBe("(clamp_index_int i n)");
  });

  it("nan_to_zero passes through the inner expr", () => {
    const expr: ScalarExpr = { tag: "nan_to_zero", value: { tag: "var", name: "f", valueType: "float" } };
    expect(emitScalar(expr)).toBe("f");
  });
});

describe("emitScalar — interpreted calls", () => {
  it("emits max as max_int for int args", () => {
    const expr: ScalarExpr = {
      tag: "call",
      name: "max",
      args: [intVar("a"), intVar("b")],
      valueType: "int",
      interpreted: true,
    };
    expect(emitScalar(expr)).toBe("(max_int a b)");
  });

  it("emits min as min_int for int args", () => {
    const expr: ScalarExpr = {
      tag: "call",
      name: "min",
      args: [intVar("a"), intVar("b")],
      valueType: "int",
      interpreted: true,
    };
    expect(emitScalar(expr)).toBe("(min_int a b)");
  });

  it("emits abs as abs_int for int", () => {
    const expr: ScalarExpr = {
      tag: "call",
      name: "abs",
      args: [intVar("x")],
      valueType: "int",
      interpreted: true,
    };
    expect(emitScalar(expr)).toBe("(abs_int x)");
  });

  it("emits uninterpreted call as (name args)", () => {
    const expr: ScalarExpr = {
      tag: "call",
      name: "myFunc",
      args: [intVar("x")],
      valueType: "int",
      interpreted: false,
    };
    expect(emitScalar(expr)).toBe("(myFunc x)");
  });

  it("emits zero-arg uninterpreted call as bare name", () => {
    const expr: ScalarExpr = {
      tag: "call",
      name: "getVal",
      args: [],
      valueType: "int",
      interpreted: false,
    };
    expect(emitScalar(expr)).toBe("getVal");
  });
});

describe("normalizeScalarForComparison", () => {
  it("returns literals unchanged", () => {
    const env = new Map<string, ComparisonInterval>();
    expect(emitScalar(normalizeScalarForComparison(intLit(5), env))).toBe("5");
  });

  it("returns unknown variable unchanged", () => {
    const env = new Map<string, ComparisonInterval>();
    const expr = intVar("x");
    expect(emitScalar(normalizeScalarForComparison(expr, env))).toBe(emitScalar(expr));
  });

  it("normalizes affine div pattern to the binder variable", () => {
    // (j * pe(n) + k) / n  →  j   when k is bounded by pe(n)
    const nVar = intVar("n");
    const jVar = intVar("j");
    const kVar = intVar("k");

    const env = new Map<string, ComparisonInterval>([
      ["n", { lo: 1, hi: 32, exact: true }],
      ["j", { lo: 0, hi: 31, exact: false }],
      ["k", { lo: 0, hi: 31, exact: false, boundBy: { tag: "positive_extent", value: nVar } }],
    ]);

    const affineBase: ScalarExpr = {
      tag: "sat_add",
      left: { tag: "sat_mul", left: jVar, right: { tag: "positive_extent", value: nVar } },
      right: kVar,
    };

    const div = normalizeScalarForComparison(
      { tag: "total_div", left: affineBase, right: nVar, valueType: "int" },
      env,
    );
    const mod = normalizeScalarForComparison(
      { tag: "total_mod", left: affineBase, right: nVar, valueType: "int" },
      env,
    );

    expect(emitScalar(div)).toBe(emitScalar(jVar));
    expect(emitScalar(mod)).toBe(emitScalar(kVar));
  });
});

describe("appendScalarTypeConstraints", () => {
  it("adds no lines for undefined type", () => {
    const lines: string[] = [];
    appendScalarTypeConstraints(lines, "x", undefined);
    expect(lines).toHaveLength(0);
  });

  it("adds INT32 range assertions for int type", () => {
    const lines: string[] = [];
    appendScalarTypeConstraints(lines, "myVar", { tag: "int" });
    const joined = lines.join("\n");
    expect(joined).toContain("myVar");
    expect(joined).toContain("-2147483648");
    expect(joined).toContain("2147483647");
    expect(lines.filter((l) => l.includes("assert"))).toHaveLength(2);
  });

  it("adds no assertions for void type", () => {
    const lines: string[] = [];
    appendScalarTypeConstraints(lines, "v", { tag: "void" });
    expect(lines).toHaveLength(0);
  });
});
