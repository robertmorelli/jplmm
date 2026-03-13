import { describe, expect, it } from "vitest";

import { findRemovedKeywordUsage, tokenize } from "../src/tokenize.ts";

describe("tokenize", () => {
  it("tokenizes a simple function body", () => {
    const tokens = tokenize("fn f(x:int):int { ret x + 1; }");
    expect(tokens.at(-1)?.kind).toBe("eof");
    expect(tokens.some((t) => t.text === "fn" && t.kind === "keyword")).toBe(true);
    expect(tokens.some((t) => t.text === "ret" && t.kind === "keyword")).toBe(true);
    expect(tokens.some((t) => t.text === "+" && t.kind === "symbol")).toBe(true);
  });

  it("skips // comments", () => {
    const tokens = tokenize("let x = 1 // hi\nlet y = x");
    expect(tokens.some((t) => t.text === "hi")).toBe(false);
    expect(tokens.filter((t) => t.text === "let").length).toBe(2);
  });

  it("distinguishes int and float literals", () => {
    const tokens = tokenize("1 2.5");
    expect(tokens[0]?.kind).toBe("int");
    expect(tokens[1]?.kind).toBe("float");
  });

  it("tokenizes scientific-notation and trailing-dot floats", () => {
    const tokens = tokenize("1e-3 2. 3E+4");
    expect(tokens[0]?.kind).toBe("float");
    expect(tokens[1]?.kind).toBe("float");
    expect(tokens[2]?.kind).toBe("float");
  });

  it("tokenizes escaped string literals for command syntax", () => {
    const tokens = tokenize('print "hello\\nworld"');
    expect(tokens[0]?.kind).toBe("keyword");
    expect(tokens[1]?.kind).toBe("string");
    expect(tokens[1]?.text).toBe("hello\nworld");
  });

  it("throws on unexpected characters", () => {
    expect(() => tokenize("@")).toThrow(/Unexpected character/);
  });

  it("tracks token source offsets", () => {
    const src = "fn f(x:int):int { ret x; }";
    const tokens = tokenize(src);
    const fnTok = tokens[0];
    const xTok = tokens.find((t) => t.text === "x");
    expect(fnTok?.start).toBe(0);
    expect(fnTok?.end).toBe(2);
    expect(xTok?.start).toBeGreaterThan(0);
    expect(xTok?.end).toBeGreaterThan(xTok?.start ?? 0);
  });

  it("treats removed keywords as identifiers", () => {
    const tokens = tokenize("if then else");
    expect(tokens[0]?.kind).toBe("ident");
    expect(tokens[1]?.kind).toBe("ident");
    expect(tokens[2]?.kind).toBe("ident");
  });
});

describe("findRemovedKeywordUsage", () => {
  it("returns unique sorted removed keywords", () => {
    const found = findRemovedKeywordUsage("if then else if bool return assert true false");
    expect(found).toEqual(["assert", "bool", "else", "false", "if", "return", "then", "true"]);
  });

  it("ignores non-removed identifiers", () => {
    const found = findRemovedKeywordUsage("fn main ret value");
    expect(found).toEqual([]);
  });
});
