import { describe, expect, it } from "vitest";

import { parseSource } from "../src/parse.ts";
import { resolveProgram } from "../src/resolve.ts";

function resolve(src: string) {
  const parsed = parseSource(src);
  const resolved = resolveProgram(parsed.program);
  return [...parsed.diagnostics, ...resolved.diagnostics];
}

describe("resolveProgram", () => {
  it("allows valid rec usage after a base ret", () => {
    const ds = resolve(`
      fn f(x:int): int {
        ret x;
        ret rec(res);
        rad x;
      }
    `);
    expect(ds).toHaveLength(0);
  });

  it("flags res before first ret", () => {
    const ds = resolve(`
      fn f(x:int): int {
        let y = res;
        ret x;
      }
    `);
    expect(ds.some((d) => d.code === "RES_BEFORE_RET")).toBe(true);
  });

  it("flags rec before first ret", () => {
    const ds = resolve(`
      fn f(x:int): int {
        ret rec(x);
        rad x;
      }
    `);
    expect(ds.some((d) => d.code === "REC_BEFORE_RET")).toBe(true);
  });

  it("flags rec without rad/gas", () => {
    const ds = resolve(`
      fn f(x:int): int {
        ret x;
        ret rec(res);
      }
    `);
    expect(ds.some((d) => d.code === "REC_NO_PROOF")).toBe(true);
  });

  it("flags mixed rad and gas", () => {
    const ds = resolve(`
      fn f(x:int): int {
        ret x;
        rad x;
        gas 10;
      }
    `);
    expect(ds.some((d) => d.code === "RAD_GAS_MIX")).toBe(true);
  });

  it("flags multiple gas statements", () => {
    const ds = resolve(`
      fn f(x:int): int {
        ret x;
        gas 1;
        gas 2;
      }
    `);
    expect(ds.some((d) => d.code === "MULTI_GAS")).toBe(true);
  });

  it("warns on gas inf", () => {
    const ds = resolve(`
      fn f(x:int): int {
        ret x;
        ret rec(x + 1);
        gas inf;
      }
    `);
    expect(ds.some((d) => d.code === "GAS_INF" && d.severity === "warning")).toBe(true);
  });

  it("flags direct self-call via name", () => {
    const ds = resolve(`
      fn f(x:int): int {
        ret f(x);
      }
    `);
    expect(ds.some((d) => d.message.includes("Direct self-call"))).toBe(true);
  });

  it("enforces single-pass function visibility", () => {
    const ds = resolve(`
      fn a(x:int): int { ret b(x); }
      fn b(x:int): int { ret x; }
    `);
    expect(ds.some((d) => d.message.includes("single-pass binding"))).toBe(true);
  });

  it("flags local shadowing", () => {
    const ds = resolve(`
      fn f(x:int): int {
        let x = 1;
        ret x;
      }
    `);
    expect(ds.some((d) => d.code === "SHADOW")).toBe(true);
  });

  it("flags duplicate function names", () => {
    const ds = resolve(`
      fn f(x:int): int { ret x; }
      fn f(y:int): int { ret y; }
    `);
    expect(ds.some((d) => d.code === "DUP_FN")).toBe(true);
  });

  it("flags duplicate parameters", () => {
    const ds = resolve(`
      fn f(x:int, x:int): int {
        ret x;
      }
    `);
    expect(ds.some((d) => d.code === "DUP_PARAM")).toBe(true);
  });

  it("flags top-level shadowing across let commands", () => {
    const ds = resolve(`
      let x = 1;
      let x = 2;
    `);
    expect(ds.some((d) => d.code === "SHADOW")).toBe(true);
  });

  it("resolves structs and comprehension binders in order", () => {
    const ds = resolve(`
      struct Pair { left:int, right:int }

      fn f(n:int): int {
        let grid = array [i:n, j:i + 1] i + j;
        let pair = Pair { grid[0][0], grid[1][1] };
        ret pair.right + sum [k:n] k;
      }
    `);
    expect(ds).toHaveLength(0);
  });

  it("binds read image tuple targets for later commands", () => {
    const ds = resolve(`
      read image "demo.ppm" to (w, h, img);
      show img[0][0][0] + w + h;
    `);
    expect(ds).toHaveLength(0);
  });

  it("allows field reassignment lvalues inside functions", () => {
    const ds = resolve(`
      struct Pair { left:int, right:int }

      fn f(p:Pair): Pair {
        let p.right = p.left + 1;
        ret p;
      }
    `);
    expect(ds).toHaveLength(0);
  });

  it("propagates parser diagnostics for non-spec array-index lvalues", () => {
    const ds = resolve(`
      fn f(a:int[][]): int[][] {
        let a[0] = [1, 2];
        ret a;
      }
    `);
    expect(ds.some((d) => d.code === "IMMUTABLE_LVALUE")).toBe(true);
  });

  it("allows timing wrappers around definitions", () => {
    const ds = resolve(`
      time fn f(x:int): int { ret x; }
    `);
    expect(ds).toHaveLength(0);
  });
});
