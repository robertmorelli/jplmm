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

  it("warns when rec uses the current parameters unchanged", () => {
    const src = `
      fun f(x:int, y:int): int {
        ret x + y;
        ret rec(x, y);
        rad x;
      }
    `;
    const diagnostic = resolve(src).find((d) => d.code === "REC_STATIC_COLLAPSE");

    expect(diagnostic?.severity).toBe("warning");
    expect(src.slice(diagnostic!.start, diagnostic!.end)).toBe("rec(x, y)");
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

  it("allows ref definitions to follow an earlier baseline definition", () => {
    const ds = resolve(`
      fun f(x:int): int { ret x; }
      ref f(y:int): int { ret y; }
    `);
    expect(ds.some((d) => d.code === "DUP_FN")).toBe(false);
    expect(ds.some((d) => d.code === "REF_NO_BASE")).toBe(false);
  });

  it("flags ref definitions without an earlier baseline", () => {
    const ds = resolve(`
      ref f(x:int): int { ret x; }
    `);
    expect(ds.some((d) => d.code === "REF_NO_BASE")).toBe(true);
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

  it("attaches unbound-variable diagnostics to the offending reference", () => {
    const src = `
      fun f(x:int): int {
        ret missing;
      }
    `;
    const diagnostic = resolve(src).find((d) => d.code === "UNBOUND_VAR");

    expect(diagnostic).toBeDefined();
    expect(src.slice(diagnostic!.start, diagnostic!.end)).toBe("missing");
  });

  it("flags unused local lets", () => {
    const ds = resolve(`
      fn f(x:int): int {
        let y = x + 1;
        ret x;
      }
    `);
    expect(ds.some((d) => d.code === "UNUSED_LET")).toBe(true);
  });

  it("flags unused top-level lets", () => {
    const ds = resolve(`
      let x = 1;
      print "ready";
    `);
    expect(ds.some((d) => d.code === "UNUSED_LET")).toBe(true);
  });

  it("requires main to be zero-argument", () => {
    const ds = resolve(`
      fn main(x:int): int {
        ret x;
      }
    `);
    expect(ds.some((d) => d.code === "MAIN_ARITY")).toBe(true);
  });

  it("flags ret values overwritten before rec or res can observe them", () => {
    const ds = resolve(`
      fn f(x:int): int {
        ret x;
        let y = x + 1;
        ret y;
      }
    `);
    expect(ds.some((d) => d.code === "IGNORED_RET")).toBe(true);
  });

  it("allows res to observe the previous ret before the next ret", () => {
    const ds = resolve(`
      fn f(x:int): int {
        ret x;
        let y = res + 1;
        ret y;
      }
    `);
    expect(ds.some((d) => d.code === "IGNORED_RET")).toBe(false);
  });

  it("allows rec to observe the previous ret at the next ret", () => {
    const ds = resolve(`
      fn f(x:int): int {
        ret x;
        ret rec(x + 1);
        gas 1;
      }
    `);
    expect(ds.some((d) => d.code === "IGNORED_RET")).toBe(false);
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
      out img[0][0][0] + w + h;
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
