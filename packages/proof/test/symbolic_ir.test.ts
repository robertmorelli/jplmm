import { describe, expect, it } from "vitest";

import type { Param, Type } from "@jplmm/ast";
import type { IRFunction, IRProgram } from "@jplmm/ir";
import { buildJplScalarPrelude, checkSat, sanitizeSymbol as sanitize } from "@jplmm/smt";

import { analyzeIrFunction, buildIrCallSummaries } from "../src/ir.ts";
import {
  appendSmtEncodingState,
  appendScalarTypeConstraints,
  collectValueVars,
  type ComparisonInterval,
  createSmtEncodingState,
  emitValueEquality,
  emitScalar,
  normalizeScalarForComparison,
  readSymbolicArray,
  type SymValue,
} from "../src/scalar.ts";

const intType: Type = { tag: "int" };
const intArrayType: Type = { tag: "array", element: intType, dims: 1 };

function param(name: string, type: Type): Param {
  return { name, type };
}

function intLit(value: number, id: number) {
  return { tag: "int_lit" as const, value, id, resultType: intType };
}

describe("shared symbolic IR semantics", () => {
  it("normalizes array literals into closure semantics and proves constant reads", () => {
    const fn: IRFunction = {
      name: "foo",
      keyword: "fun",
      params: [param("a", intType)],
      retType: intType,
      id: 1,
      body: [
        {
          tag: "let",
          name: "table",
          id: 2,
          expr: {
            tag: "array_cons",
            elements: [intLit(1, 3), intLit(1, 4), intLit(1, 5)],
            id: 6,
            resultType: intArrayType,
          },
        },
        {
          tag: "ret",
          id: 7,
          expr: {
            tag: "index",
            array: { tag: "var", name: "table", id: 8, resultType: intArrayType },
            indices: [{ tag: "var", name: "a", id: 9, resultType: intType }],
            id: 10,
            resultType: intType,
          },
        },
      ],
    };

    const analysis = analyzeIrFunction(fn);
    const tableSemantics = analysis.stmtSemantics[0]?.value;
    expect(tableSemantics?.kind).toBe("array");
    if (tableSemantics?.kind !== "array") {
      throw new Error("expected symbolic array semantics");
    }
    expect(tableSemantics.array.tag).toBe("comprehension");

    const result = analysis.result;
    expect(result?.kind).toBe("scalar");
    if (!result || result.kind !== "scalar") {
      throw new Error("expected scalar result semantics");
    }

    const oneValue: SymValue = {
      kind: "scalar",
      expr: { tag: "int_lit", value: 1 },
    };
    const equality = emitValueEquality(
      result,
      oneValue,
      intType,
    );
    expect(equality).toBeTruthy();
    if (!equality) {
      throw new Error("expected shared equality encoding");
    }

    const vars = new Map<string, "int" | "float">();
    collectValueVars(result, vars);
    const lines = buildJplScalarPrelude();
    for (const [name, tag] of vars) {
      lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
      appendScalarTypeConstraints(lines, name, fn.params.find((candidate) => candidate.name === name)?.type);
    }
    lines.push(`(assert (not ${equality}))`);

    const sat = checkSat(lines);
    expect(sat.ok).toBe(true);
    if (!sat.ok) {
      throw new Error(`expected z3 to run: ${sat.error}`);
    }
    expect(sat.status).toBe("unsat");
  });

  it("proves sum folds with free variables through shared SMT semantics", () => {
    const fn: IRFunction = {
      name: "twice",
      keyword: "fun",
      params: [param("a", intType)],
      retType: intType,
      id: 11,
      body: [
        {
          tag: "ret",
          id: 12,
          expr: {
            tag: "sum_expr",
            bindings: [{ name: "i", expr: intLit(2, 13) }],
            body: { tag: "var", name: "a", id: 14, resultType: intType },
            id: 15,
            resultType: intType,
          },
        },
      ],
    };

    const analysis = analyzeIrFunction(fn);
    const result = analysis.result;
    expect(result?.kind).toBe("scalar");
    if (!result || result.kind !== "scalar") {
      throw new Error("expected scalar sum result semantics");
    }

    const expected: SymValue = {
      kind: "scalar",
      expr: {
        tag: "sat_add",
        left: { tag: "var", name: "a", valueType: "int" },
        right: { tag: "var", name: "a", valueType: "int" },
      },
    };
    const smtState = createSmtEncodingState();
    const equality = emitValueEquality(result, expected, intType, { smt: smtState });
    expect(equality).toBeTruthy();
    if (!equality) {
      throw new Error("expected sum fold equality encoding");
    }

    const vars = new Map<string, "int" | "float">();
    collectValueVars(result, vars);
    collectValueVars(expected, vars);
    const lines = buildJplScalarPrelude();
    for (const [name, tag] of vars) {
      lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
      appendScalarTypeConstraints(lines, name, fn.params.find((candidate) => candidate.name === name)?.type);
    }
    appendSmtEncodingState(lines, smtState);
    lines.push(`(assert (not ${equality}))`);

    const sat = checkSat(lines);
    expect(sat.ok).toBe(true);
    if (!sat.ok) {
      throw new Error(`expected z3 to run: ${sat.error}`);
    }
    expect(sat.status).toBe("unsat");
  });

  it("beta-reduces non-recursive helper calls with array arguments", () => {
    const dot: IRFunction = {
      name: "dot",
      keyword: "fun",
      params: [
        param("A", intArrayType),
        param("i", intType),
      ],
      retType: intType,
      id: 20,
      body: [
        {
          tag: "ret",
          id: 21,
          expr: {
            tag: "binop",
            op: "+",
            left: {
              tag: "index",
              array: { tag: "var", name: "A", id: 22, resultType: intArrayType },
              indices: [{ tag: "var", name: "i", id: 23, resultType: intType }],
              id: 24,
              resultType: intType,
            },
            right: intLit(1, 25),
            id: 26,
            resultType: intType,
          },
        },
      ],
    };

    const caller: IRFunction = {
      name: "caller",
      keyword: "fun",
      params: [param("A", intArrayType)],
      retType: intType,
      id: 27,
      body: [
        {
          tag: "ret",
          id: 28,
          expr: {
            tag: "call",
            name: "dot",
            args: [
              { tag: "var", name: "A", id: 29, resultType: intArrayType },
              intLit(0, 30),
            ],
            id: 31,
            resultType: intType,
          },
        },
      ],
    };

    const program: IRProgram = {
      structs: [],
      globals: [],
      functions: [dot, caller],
    };
    const summaries = buildIrCallSummaries(program);
    const analysis = analyzeIrFunction(caller, new Map(), "", { callSummaries: summaries });
    const result = analysis.result;
    expect(result?.kind).toBe("scalar");
    if (!result || result.kind !== "scalar") {
      throw new Error("expected scalar result semantics");
    }

    const arrayValue = analysis.paramValues.get("A");
    expect(arrayValue?.kind).toBe("array");
    if (!arrayValue || arrayValue.kind !== "array") {
      throw new Error("expected array parameter semantics");
    }

    const expectedRead = readSymbolicArray(
      arrayValue.array,
      [{ tag: "int_lit", value: 0 }],
      intType,
      -1,
      -1,
    );
    expect(expectedRead.kind).toBe("scalar");
    if (expectedRead.kind !== "scalar") {
      throw new Error("expected scalar array read");
    }

    const expected: SymValue = {
      kind: "scalar",
      expr: {
        tag: "sat_add",
        left: expectedRead.expr,
        right: { tag: "int_lit", value: 1 },
      },
    };
    const equality = emitValueEquality(result, expected, intType);
    expect(equality).toBeTruthy();
    if (!equality) {
      throw new Error("expected helper beta-reduced equality encoding");
    }

    const vars = new Map<string, "int" | "float">();
    collectValueVars(result, vars);
    collectValueVars(expected, vars);
    const lines = buildJplScalarPrelude();
    for (const [name, sig] of analysis.callSigs) {
      const domain = sig.args.map((arg) => (arg === "int" ? "Int" : "Real")).join(" ");
      const sort = sig.ret === "int" ? "Int" : "Real";
      lines.push(`(declare-fun ${sanitize(name)} (${domain}) ${sort})`);
    }
    for (const [name, tag] of vars) {
      lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
      appendScalarTypeConstraints(lines, name, caller.params.find((candidate) => candidate.name === name)?.type);
    }
    lines.push(`(assert (not ${equality}))`);

    const sat = checkSat(lines);
    expect(sat.ok).toBe(true);
    if (!sat.ok) {
      throw new Error(`expected z3 to run: ${sat.error}`);
    }
    expect(sat.status).toBe("unsat");
  });

  it("normalizes affine div/mod patterns when binder remainders are bounded by a positive extent", () => {
    const sharedVar = { tag: "var" as const, name: "shared", valueType: "int" as const };
    const jVar = { tag: "var" as const, name: "j", valueType: "int" as const };
    const kVar = { tag: "var" as const, name: "k", valueType: "int" as const };

    const env = new Map<string, ComparisonInterval>([
      ["shared", { lo: 1, hi: 32, exact: true }],
      ["j", { lo: 0, hi: 31, exact: false }],
      [
        "k",
        {
          lo: 0,
          hi: 31,
          exact: false,
          boundBy: { tag: "positive_extent", value: sharedVar },
        },
      ],
    ]);

    const affineBase = {
      tag: "sat_add" as const,
      left: {
        tag: "sat_mul" as const,
        left: jVar,
        right: { tag: "positive_extent" as const, value: sharedVar },
      },
      right: kVar,
    };

    const div = normalizeScalarForComparison(
      {
        tag: "total_div",
        left: affineBase,
        right: sharedVar,
        valueType: "int",
      },
      env,
    );
    const mod = normalizeScalarForComparison(
      {
        tag: "total_mod",
        left: affineBase,
        right: sharedVar,
        valueType: "int",
      },
      env,
    );

    expect(emitScalar(div)).toBe(emitScalar(jVar));
    expect(emitScalar(mod)).toBe(emitScalar(kVar));
  });
});
