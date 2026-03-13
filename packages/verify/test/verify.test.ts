import { describe, expect, it } from "vitest";

import { runFrontend } from "@jplmm/frontend";

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
});
