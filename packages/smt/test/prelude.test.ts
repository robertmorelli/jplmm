import { describe, expect, it } from "vitest";

import {
  INT32_MAX,
  INT32_MIN,
  buildJplInt32Prelude,
  buildJplScalarPrelude,
  buildZ3BasePrelude,
  parseGetValueOutput,
  parseZ3Int,
  sanitizeSymbol,
} from "../src/index";

describe("buildZ3BasePrelude", () => {
  it("sets logic ALL", () => {
    expect(buildZ3BasePrelude()).toContain("(set-logic ALL)");
  });

  it("enables decimal printing", () => {
    expect(buildZ3BasePrelude()).toContain("(set-option :pp.decimal true)");
  });

  it("returns exactly 2 lines", () => {
    expect(buildZ3BasePrelude()).toHaveLength(2);
  });
});

describe("buildJplInt32Prelude", () => {
  it("includes base prelude lines", () => {
    const lines = buildJplInt32Prelude();
    expect(lines).toContain("(set-logic ALL)");
    expect(lines).toContain("(set-option :pp.decimal true)");
  });

  it("defines clamp_int with INT32_MIN and INT32_MAX", () => {
    const lines = buildJplInt32Prelude();
    const clamp = lines.find((l) => l.includes("clamp_int"));
    expect(clamp).toBeDefined();
    expect(clamp).toContain(String(INT32_MIN));
    expect(clamp).toContain(String(INT32_MAX));
  });

  it("defines sat_add_int, sat_sub_int, sat_mul_int, sat_neg_int", () => {
    const lines = buildJplInt32Prelude();
    expect(lines.some((l) => l.includes("sat_add_int"))).toBe(true);
    expect(lines.some((l) => l.includes("sat_sub_int"))).toBe(true);
    expect(lines.some((l) => l.includes("sat_mul_int"))).toBe(true);
    expect(lines.some((l) => l.includes("sat_neg_int"))).toBe(true);
  });

  it("defines total_div_int returning 0 when divisor is 0", () => {
    const lines = buildJplInt32Prelude();
    const div = lines.find((l) => l.includes("total_div_int"));
    expect(div).toBeDefined();
    expect(div).toContain("= b 0) 0");
  });

  it("defines total_mod_int", () => {
    const lines = buildJplInt32Prelude();
    expect(lines.some((l) => l.includes("total_mod_int"))).toBe(true);
  });

  it("defines positive_extent_int", () => {
    const lines = buildJplInt32Prelude();
    expect(lines.some((l) => l.includes("positive_extent_int"))).toBe(true);
  });

  it("defines abs_int and max_int and min_int", () => {
    const lines = buildJplInt32Prelude();
    expect(lines.some((l) => l.includes("abs_int"))).toBe(true);
    expect(lines.some((l) => l.includes("max_int"))).toBe(true);
    expect(lines.some((l) => l.includes("min_int"))).toBe(true);
  });
});

describe("buildJplScalarPrelude", () => {
  it("includes both int and real abs helpers", () => {
    const lines = buildJplScalarPrelude();
    expect(lines.some((l) => l.includes("abs_int"))).toBe(true);
    expect(lines.some((l) => l.includes("abs_real"))).toBe(true);
  });

  it("includes clamp_real", () => {
    const lines = buildJplScalarPrelude();
    expect(lines.some((l) => l.includes("clamp_real"))).toBe(true);
  });

  it("defines trunc_real using to_int", () => {
    const lines = buildJplScalarPrelude();
    const trunc = lines.find((l) => l.includes("trunc_real"));
    expect(trunc).toBeDefined();
    expect(trunc).toContain("to_int");
  });

  it("defines total_div_real returning 0.0 when divisor is 0.0", () => {
    const lines = buildJplScalarPrelude();
    const divReal = lines.find((l) => l.includes("total_div_real"));
    expect(divReal).toBeDefined();
    expect(divReal).toContain("= b 0.0) 0.0");
  });

  it("defines to_int_real with INT32 clamp", () => {
    const lines = buildJplScalarPrelude();
    const toInt = lines.find((l) => l.includes("to_int_real"));
    expect(toInt).toBeDefined();
    expect(toInt).toContain(String(INT32_MIN));
    expect(toInt).toContain(String(INT32_MAX));
  });
});

describe("sanitizeSymbol", () => {
  it("passes through alphanumeric and underscore", () => {
    expect(sanitizeSymbol("abc_123")).toBe("abc_123");
  });

  it("replaces dots with underscores", () => {
    expect(sanitizeSymbol("a.b")).toBe("a_b");
  });

  it("replaces hyphens with underscores", () => {
    expect(sanitizeSymbol("a-b")).toBe("a_b");
  });

  it("replaces spaces with underscores", () => {
    expect(sanitizeSymbol("my var")).toBe("my_var");
  });

  it("replaces multiple special chars in sequence", () => {
    expect(sanitizeSymbol("x.y-z w")).toBe("x_y_z_w");
  });

  it("handles empty string", () => {
    expect(sanitizeSymbol("")).toBe("");
  });
});

describe("parseZ3Int", () => {
  it("parses positive integer string", () => {
    expect(parseZ3Int("42")).toBe(42);
  });

  it("parses zero", () => {
    expect(parseZ3Int("0")).toBe(0);
  });

  it("parses negative integer string", () => {
    expect(parseZ3Int("-7")).toBe(-7);
  });

  it("parses Z3 negative notation (- n)", () => {
    expect(parseZ3Int("(- 5)")).toBe(-5);
  });

  it("returns null for float string", () => {
    expect(parseZ3Int("3.14")).toBeNull();
  });

  it("returns null for 'sat'", () => {
    expect(parseZ3Int("sat")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseZ3Int("")).toBeNull();
  });
});

describe("parseGetValueOutput", () => {
  it("returns null when output has no (( prefix", () => {
    expect(parseGetValueOutput("sat\n")).toBeNull();
    expect(parseGetValueOutput("unsat\n")).toBeNull();
  });

  it("parses a single variable binding", () => {
    const result = parseGetValueOutput("sat\n((x 42))");
    expect(result).not.toBeNull();
    expect(result?.get("x")).toBe("42");
  });

  it("parses multiple variable bindings", () => {
    const result = parseGetValueOutput("sat\n((x 1) (y 2))");
    expect(result?.get("x")).toBe("1");
    expect(result?.get("y")).toBe("2");
  });

  it("renders binary operator expressions inline", () => {
    const result = parseGetValueOutput("sat\n((z (+ 3 4)))");
    expect(result?.get("z")).toBe("3 + 4");
  });

  it("renders Z3 unary negation as -value", () => {
    const result = parseGetValueOutput("sat\n((n (- 99)))");
    expect(result?.get("n")).toBe("-99");
  });

  it("does not throw on edge-case output", () => {
    expect(() => parseGetValueOutput("sat\n(())")).not.toThrow();
    expect(() => parseGetValueOutput("")).not.toThrow();
  });
});
