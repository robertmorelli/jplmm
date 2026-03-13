import { describe, expect, it } from "vitest";

import { parseSource } from "../src/parse.ts";

describe("parseSource", () => {
  it("parses a core function", () => {
    const src = `
      fun sq(x: int): int {
        ret x * x;
        rad x;
      }
    `;
    const r = parseSource(src);
    expect(r.diagnostics).toHaveLength(0);
    expect(r.program.commands).toHaveLength(1);
    const fn = r.program.commands[0];
    expect(fn?.tag).toBe("fn_def");
    if (fn?.tag === "fn_def") {
      expect(fn.keyword).toBe("fun");
      expect(fn.name).toBe("sq");
      expect(fn.params).toHaveLength(1);
      expect(fn.body.map((s) => s.tag)).toEqual(["ret", "rad"]);
    }
  });

  it("parses rec and res expressions", () => {
    const src = `
      fun f(x: int): int {
        ret x;
        ret rec(res);
        gas 10;
      }
    `;
    const r = parseSource(src);
    expect(r.diagnostics).toHaveLength(0);
    const fn = r.program.commands[0];
    if (fn?.tag === "fn_def") {
      expect(fn.body[1]?.tag).toBe("ret");
    }
  });

  it("parses def functions and remembers the keyword", () => {
    const r = parseSource(`
      def settle(x: float): float {
        ret x;
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
    const fn = r.program.commands[0];
    expect(fn?.tag).toBe("fn_def");
    if (fn?.tag === "fn_def") {
      expect(fn.keyword).toBe("def");
      expect(fn.name).toBe("settle");
    }
  });

  it("parses ref functions and remembers the keyword", () => {
    const r = parseSource(`
      ref settle(x: int): int {
        ret x;
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
    const fn = r.program.commands[0];
    expect(fn?.tag).toBe("fn_def");
    if (fn?.tag === "fn_def") {
      expect(fn.keyword).toBe("ref");
      expect(fn.name).toBe("settle");
    }
  });

  it("treats throwserror as a compile-time joke annotation and still parses the function", () => {
    const src = `
      throwserror fun f(x: int): int {
        ret x;
      }
    `;
    const r = parseSource(src);
    expect(r.diagnostics.some((d) => d.code === "THROWS_ERROR_IMPOSSIBLE")).toBe(true);
    expect(r.program.commands[0]?.tag).toBe("fn_def");
  });

  it("rejects throwserror on non-function commands", () => {
    const r = parseSource('throwserror out 1;');
    expect(r.diagnostics.some((d) => d.code === "THROWS_ERROR_TARGET")).toBe(true);
  });

  it("rejects removed keywords in expression position", () => {
    const r = parseSource("fun f(x:int):int { ret if; }");
    expect(r.diagnostics.some((d) => d.message.includes("not a keyword in JPL--"))).toBe(true);
  });

  it("rejects removed keywords as identifiers", () => {
    const r = parseSource("fun if(x:int):int { ret x; }");
    expect(r.diagnostics.some((d) => d.message.includes("not a valid identifier"))).toBe(true);
  });

  it("reports out-of-range integer literal", () => {
    const r = parseSource("fun f(): int { ret 9999999999; }");
    expect(r.diagnostics.some((d) => d.message.includes("out of 32-bit range"))).toBe(true);
  });

  it("accepts the minimum 32-bit signed integer literal", () => {
    const r = parseSource("fun f(): int { ret -2147483648; }");
    expect(r.diagnostics).toHaveLength(0);
  });

  it("parses scientific-notation floats and rejects f32 overflow", () => {
    const ok = parseSource("fun f(): float { ret 1e-3 + 2.; }");
    expect(ok.diagnostics).toHaveLength(0);

    const bad = parseSource("fun f(): float { ret 1e50; }");
    expect(bad.diagnostics.some((d) => d.code === "FLOAT_RANGE")).toBe(true);
  });

  it("parses array return type rank", () => {
    const r = parseSource("fun f(x:int): float[][] { ret void; }");
    const fn = r.program.commands[0];
    expect(fn?.tag).toBe("fn_def");
    if (fn?.tag === "fn_def") {
      expect(fn.retType.tag).toBe("array");
      if (fn.retType.tag === "array") {
        expect(fn.retType.dims).toBe(2);
      }
    }
  });

  it("parses top-level let commands", () => {
    const r = parseSource("let x = 1;");
    expect(r.diagnostics).toHaveLength(0);
    expect(r.program.commands[0]?.tag).toBe("let_cmd");
  });

  it("parses structs, comprehensions, and nested array literals", () => {
    const r = parseSource(`
      struct Pair { left:int, right:int }

      fun f(n:int): int[][] {
        let pair = Pair { n, n + 1 };
        let grid = [[n, n + 1], [pair.left, pair.right]];
        ret array [i:n, j:2] grid[1][j] + i;
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(r.program.commands[0]?.tag).toBe("struct_def");
    const fn = r.program.commands[1];
    expect(fn?.tag).toBe("fn_def");
    if (fn?.tag === "fn_def") {
      expect(fn.body[0]?.tag).toBe("let");
      expect(fn.body[2]?.tag).toBe("ret");
    }
  });

  it("parses command-surface strings and timing wrappers", () => {
    const r = parseSource(`
      print "hello";
      out [1, 2, 3];
      time write image [[1, 2], [3, 4]] to "grid.pgm";
      read image "grid.pgm" to (w, h, img);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(r.program.commands.map((cmd) => cmd.tag)).toEqual(["print", "show", "time", "read_image"]);
  });

  it("parses field lvalues and rejects array-index lvalues", () => {
    const r = parseSource(`
      struct Pair { left:int, right:int }

      fun f(p:Pair): Pair {
        let p.right = 7;
        ret p;
      }

      let grid = [[1, 2], [3, 4]];
      let grid[1] = [9, 9];
    `);
    expect(r.diagnostics.some((d) => d.code === "IMMUTABLE_LVALUE")).toBe(true);
    const fn = r.program.commands[1];
    expect(fn?.tag).toBe("fn_def");
    if (fn?.tag === "fn_def") {
      expect(fn.body[0]?.tag).toBe("let");
      if (fn.body[0]?.tag === "let") {
        expect(fn.body[0].lvalue.tag).toBe("field");
      }
    }
    const top = r.program.commands[3];
    expect(top?.tag).toBe("let_cmd");
  });

  it("recovers from tokenizer failures as parse diagnostics", () => {
    const r = parseSource("fun f(x:int): int { ret @; }");
    expect(r.diagnostics.some((d) => d.code === "PARSE_CRASH")).toBe(true);
  });
});
