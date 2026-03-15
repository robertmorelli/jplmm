import { describe, expect, it } from "vitest";

import { parseSource } from "../src/parse.ts";
import { resolveProgram } from "../src/resolve.ts";
import { typecheckProgram } from "../src/typecheck.ts";

function typecheck(src: string) {
  const parsed = parseSource(src);
  const resolved = resolveProgram(parsed.program);
  const typed = typecheckProgram(resolved.program);
  return [...parsed.diagnostics, ...resolved.diagnostics, ...typed.diagnostics];
}

describe("typecheckProgram", () => {
  it("accepts consistent int arithmetic and return type", () => {
    const ds = typecheck(`
      fn f(x:int): int {
        ret x + 1;
      }
    `);
    expect(ds).toHaveLength(0);
  });

  it("rejects ret type mismatch", () => {
    const ds = typecheck(`
      fn f(x:int): float {
        ret x + 1;
      }
    `);
    expect(ds.some((d) => d.code === "RET_TYPE")).toBe(true);
  });

  it("rejects rad on non-scalar", () => {
    const ds = typecheck(`
      fn f(x:int[]): int[] {
        ret x;
        rad x;
      }
    `);
    expect(ds.some((d) => d.code === "RAD_TYPE")).toBe(true);
  });

  it("checks rec arity and argument types", () => {
    const ds = typecheck(`
      fn f(x:int, y:float): int {
        ret 0;
        ret rec(x);
        rad x;
      }
    `);
    expect(ds.some((d) => d.code === "REC_ARITY")).toBe(true);
  });

  it("checks rec argument type mismatch", () => {
    const ds = typecheck(`
      fn f(x:int): int {
        ret x;
        ret rec(1.5);
        rad x;
      }
    `);
    expect(ds.some((d) => d.code === "REC_ARG_TYPE")).toBe(true);
  });

  it("checks builtin signatures", () => {
    const ds = typecheck(`
      fn f(x:int): int {
        ret to_float(x);
      }
    `);
    expect(ds.some((d) => d.code === "RET_TYPE")).toBe(true);
  });

  it("checks clamp typing", () => {
    const ds = typecheck(`
      fn f(x:int): int {
        ret clamp(x, 0, 255);
      }
    `);
    expect(ds).toHaveLength(0);
  });

  it("rejects unknown calls", () => {
    const ds = typecheck(`
      fn f(x:int): int {
        ret mystery(x);
      }
    `);
    expect(ds.some((d) => d.code === "CALL_UNKNOWN")).toBe(true);
  });

  it("checks array indexing constraints", () => {
    const ds = typecheck(`
      fn f(a:int[], i:float): int {
        ret a[i];
      }
    `);
    expect(ds.some((d) => d.code === "INDEX_TYPE")).toBe(true);
  });

  it("attaches index type diagnostics to the offending index expression", () => {
    const src = `
      fun f(a:int[], i:float): int {
        ret a[i];
      }
    `;
    const diagnostic = typecheck(src).find((d) => d.code === "INDEX_TYPE");

    expect(diagnostic).toBeDefined();
    expect(src.slice(diagnostic!.start, diagnostic!.end)).toBe("i");
  });

  it("rejects non-numeric binops", () => {
    const ds = typecheck(`
      fn f(a:int[], b:int[]): int[] {
        ret a + b;
      }
    `);
    expect(ds.some((d) => d.code === "BINOP_NUM")).toBe(true);
  });

  it("validates gas literal bounds form", () => {
    const ds = typecheck(`
      fn f(x:int): int {
        ret x;
        gas 4294967297;
      }
    `);
    expect(ds.some((d) => d.code === "GAS_LIT")).toBe(true);
  });

  it("accepts float unary and builtin math calls", () => {
    const ds = typecheck(`
      fn f(x:float): float {
        ret sqrt(-x);
      }
    `);
    expect(ds).toHaveLength(0);
  });

  it("flags res at top level", () => {
    const ds = typecheck(`
      let x = res;
    `);
    expect(ds.some((d) => d.code === "RES_TOP")).toBe(true);
  });

  it("flags rec at top level", () => {
    const ds = typecheck(`
      let x = rec(1);
    `);
    expect(ds.some((d) => d.code === "REC_TOP")).toBe(true);
  });

  it("accepts structs, array comprehensions, and sums", () => {
    const ds = typecheck(`
      struct Pair { left:int, right:int }

      fn f(n:int): int {
        let pair = Pair { n, n + 1 };
        let grid = array [i:n, j:2] pair.left + i + j;
        let row = grid[n - 1];
        ret row[0] + row[1] + sum [i:n] i;
      }
    `);
    expect(ds).toHaveLength(0);
  });

  it("rejects constant array bounds below one", () => {
    const ds = typecheck(`
      fn f(): int[] {
        ret array [i:0] i;
      }
    `);
    expect(ds.some((d) => d.code === "CONST_BOUND_CLAMP")).toBe(true);
  });

  it("rejects constant sum bounds below one", () => {
    const ds = typecheck(`
      fn f(): int {
        ret sum [i:max(-3, -1)] i;
      }
    `);
    expect(ds.some((d) => d.code === "CONST_BOUND_CLAMP")).toBe(true);
  });

  it("rejects struct constructor arity mismatches", () => {
    const ds = typecheck(`
      struct Pair { left:int, right:int }

      fn f(n:int): Pair {
        ret Pair { n };
      }
    `);
    expect(ds.some((d) => d.code === "STRUCT_ARITY")).toBe(true);
  });

  it("types read image tuple targets and write image commands", () => {
    const ds = typecheck(`
      read image "demo.ppm" to (w, h, img);
      let px = img[h - 1][w - 1][0];
      write image img to "out.ppm";
      out px;
    `);
    expect(ds).toHaveLength(0);
  });

  it("types struct field let targets", () => {
    const ds = typecheck(`
      struct Pair { left:int, right:int }

      fn f(p:Pair): Pair {
        let p.right = p.left + 1;
        ret p;
      }
    `);
    expect(ds).toHaveLength(0);
  });

  it("propagates parser diagnostics for non-spec array-index lvalues", () => {
    const ds = typecheck(`
      fn f(a:int[][]): int[][] {
        let a[0] = [1, 2];
        ret a;
      }
    `);
    expect(ds.some((d) => d.code === "IMMUTABLE_LVALUE")).toBe(true);
  });

  it("typechecks named array extents as implicit int binders", () => {
    const ds = typecheck(`
      fn dims(a:int[n][m]): int {
        let area = n * m;
        ret area + a[0][0];
      }
    `);
    expect(ds).toHaveLength(0);
  });
});
