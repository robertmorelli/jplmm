import { describe, expect, it } from "vitest";

import { runFrontend } from "@jplmm/frontend";

import { analyzeProgramMetrics } from "../src/metrics.ts";
import { verifyProgram } from "../src/verify.ts";

function verify(src: string) {
  const f = runFrontend(src);
  const v = verifyProgram(f.program, f.typeMap);
  return { frontendDiagnostics: f.diagnostics, ...v };
}

describe("verifyProgram", () => {
  it("verifies structural decrease for max(0, x-1)", () => {
    const { proofMap, diagnostics } = verify(`
      fn f(x:int): int {
        ret x;
        ret rec(max(0, x - 1));
        rad x;
      }
    `);
    expect(diagnostics).toHaveLength(0);
    expect(proofMap.get("f")?.status).toBe("verified");
  });

  it("rejects structural non-decrease", () => {
    const { proofMap, diagnostics } = verify(`
      fn f(x:int): int {
        ret x;
        ret rec(x + 1);
        rad x;
      }
    `);
    expect(proofMap.get("f")?.status).toBe("rejected");
    expect(diagnostics.some((d) => d.code === "VERIFY_PROOF_FAIL")).toBe(true);
  });

  it("marks gas N functions as bounded", () => {
    const { proofMap } = verify(`
      fn f(x:int): int {
        ret x + 1;
        ret rec(res);
        gas 100;
      }
    `);
    expect(proofMap.get("f")?.status).toBe("bounded");
  });

  it("marks gas inf functions as unverified with warning", () => {
    const { proofMap, diagnostics } = verify(`
      fn f(x:int): int {
        ret x + 1;
        ret rec(res);
        gas inf;
      }
    `);
    expect(proofMap.get("f")?.status).toBe("unverified");
    expect(diagnostics.some((d) => d.code === "VERIFY_GAS_INF" && d.severity === "warning")).toBe(true);
  });

  it("rejects rec with no rad or gas", () => {
    const { proofMap, diagnostics } = verify(`
      fn f(x:int): int {
        ret x;
        ret rec(x - 1);
      }
    `);
    expect(proofMap.get("f")?.status).toBe("rejected");
    expect(diagnostics.some((d) => d.code === "VERIFY_NO_PROOF")).toBe(true);
  });

  it("verifies multi-parameter structural decrease when one tracked int parameter shrinks", () => {
    const { proofMap, diagnostics } = verify(`
      fn f(x:int, y:int): int {
        ret x;
        ret rec(x, max(0, y - 1));
        rad y;
      }
    `);
    expect(proofMap.get("f")?.status).toBe("verified");
    expect(diagnostics).toHaveLength(0);
  });

  it("does not produce proofs for non-recursive functions", () => {
    const { proofMap, diagnostics } = verify(`
      fn f(x:int): int {
        ret x + 1;
      }
    `);
    expect(diagnostics).toHaveLength(0);
    expect(proofMap.has("f")).toBe(false);
  });

  it("rejects linear rad expressions that are not globally decreasing", () => {
    const { proofMap, diagnostics } = verify(`
      fn f(x:int): int {
        ret x;
        ret rec(x - 1);
        rad x - 1;
      }
    `);
    expect(proofMap.get("f")?.status).toBe("rejected");
    expect(diagnostics.some((d) => d.code === "VERIFY_PROOF_FAIL")).toBe(true);
  });

  it("accepts unchanged recursive arguments as fixed-point collapse sites", () => {
    const { proofMap, diagnostics } = verify(`
      fn f(x:int): int {
        ret x;
        ret rec(x);
        rad x;
      }
    `);
    expect(proofMap.get("f")?.status).toBe("verified");
    expect(diagnostics).toHaveLength(0);
  });

  it("rejects function if any recursive site fails decrease", () => {
    const { proofMap, diagnostics } = verify(`
      fn f(x:int): int {
        ret x;
        let a = rec(x - 1);
        ret rec(x + 1);
        rad x;
      }
    `);
    expect(proofMap.get("f")?.status).toBe("rejected");
    expect(diagnostics.some((d) => d.code === "VERIFY_PROOF_FAIL")).toBe(true);
  });

  it("accepts abs-wrapped rad on a shrinking int parameter", () => {
    const { proofMap, diagnostics } = verify(`
      fn f(x:int): int {
        ret x;
        ret rec(max(0, x - 1));
        rad abs(x);
      }
    `);
    expect(proofMap.get("f")?.status).toBe("verified");
    expect(diagnostics).toHaveLength(0);
  });

  it("verifies float contraction measures via SMT", () => {
    const { proofMap, diagnostics } = verify(`
      fn settle(target : float, g : float) : float {
        ret (g + target) / 2.0;
        rad g - res;
        ret rec(target, res);
      }
    `);
    expect(proofMap.get("settle")?.status).toBe("verified");
    expect(proofMap.get("settle")?.method).toBe("smt");
    expect(diagnostics).toHaveLength(0);
  });

  it("checks changed array arguments semantically instead of rejecting them as opaque", () => {
    const { proofMap, diagnostics } = verify(`
      fn shrink(buf:int[], n:int): int {
        ret n;
        let next = array[i:1] n;
        ret rec(next, max(0, n - 1));
        rad abs(n) + 1;
      }
    `);
    expect(proofMap.get("shrink")?.status).toBe("rejected");
    const failure = diagnostics.find((d) => d.code === "VERIFY_PROOF_FAIL");
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("counterexample:");
    expect(failure?.message).not.toContain("non-scalar recursive arguments changed");
  });

  it("reduces array comprehensions to read functions inside rad expressions", () => {
    const { proofMap, diagnostics } = verify(`
      fn shrink(n:int): int {
        let buf = array[i:1] n;
        ret n;
        ret rec(max(0, n - 1));
        rad buf[0];
      }
    `);
    expect(proofMap.get("shrink")?.status).toBe("verified");
    expect(proofMap.get("shrink")?.method).toBe("smt");
    expect(diagnostics).toHaveLength(0);
  });

  it("reduces array literals to semantic reads inside rad expressions", () => {
    const { proofMap, diagnostics } = verify(`
      fn shrink(n:int): int {
        let buf = [n, max(0, n - 1)];
        ret n;
        ret rec(max(0, n - 1));
        rad buf[0];
      }
    `);
    expect(proofMap.get("shrink")?.status).toBe("verified");
    expect(proofMap.get("shrink")?.method).toBe("smt");
    expect(diagnostics).toHaveLength(0);
  });

  it("tracks struct field semantics across recursive arguments", () => {
    const { proofMap, diagnostics } = verify(`
      struct Pair { left:int, right:int }

      fn settle(p:Pair): Pair {
        ret p;
        ret rec(Pair { p.left, max(0, p.right - 1) });
        rad p.right;
      }
    `);
    expect(proofMap.get("settle")?.status).toBe("verified");
    expect(proofMap.get("settle")?.method).toBe("smt");
    expect(diagnostics).toHaveLength(0);
  });

  it("rejects constant rad expressions that cannot strictly decrease", () => {
    const { proofMap, diagnostics } = verify(`
      fn my_sqrt(x: float, g: float): float {
        ret (g + x / g) / 2.0;
        rad 1;
        ret rec(x, res);
      }
    `);
    expect(proofMap.get("my_sqrt")?.status).toBe("rejected");
    const failure = diagnostics.find((d) => d.code === "VERIFY_PROOF_FAIL");
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("counterexample:");
    expect(failure?.message).toContain("x =");
    expect(failure?.message).toContain("next g =");
    expect(failure?.message).toContain("|rad|");
  });

  it("reports source complexity and canonical witnesses", () => {
    const frontend = runFrontend(`
      struct Pair { left:int, right:int }

      fn f(n:int, pair:Pair, grid:int[][]): int {
        ret n;
        ret rec(max(0, n - 1)) + rec(n);
        rad n;
      }
    `);
    const metrics = analyzeProgramMetrics(frontend.program);

    expect(metrics.get("f")).toEqual({
      sourceComplexity: 3,
      recSites: 2,
      canonicalWitness: "f(0, Pair { 0, 0 }, [[0]])",
      coarseTotalCallBound: "sum_{i=0..2^32} 2^i",
    });
  });
});
