import { describe, expect, it } from "vitest";

import { runFrontend } from "../src/pipeline.ts";

describe("runFrontend", () => {
  it("returns typed program and diagnostics for a valid core program", () => {
    const src = `
      fn abs_like(x:int): int {
        ret max(x, -x);
      }

      fn rec_ok(x:int): int {
        ret x;
        ret rec(max(0, x - 1));
        rad x;
      }
    `;
    const r = runFrontend(src);
    expect(r.diagnostics).toHaveLength(0);
    expect(r.program.commands.length).toBe(2);
    expect(r.typeMap.size).toBeGreaterThan(0);
  });

  it("accumulates diagnostics across parse/resolve/typecheck", () => {
    const src = `
      fn broken(x:int): float {
        let x = if;
        ret rec(x);
      }
    `;
    const r = runFrontend(src);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some((d) => d.code === "SHADOW")).toBe(true);
    expect(r.diagnostics.some((d) => d.code === "REC_BEFORE_RET")).toBe(true);
  });

  it("accepts a proven ref and keeps the refined body under the original policy keyword", () => {
    const src = `
      def clamp_hi(x:int): int {
        ret min(max(x, 0), 255);
      }

      ref clamp_hi(n:int): int {
        ret clamp(n, 0, 255);
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("scalar_int_smt");
    expect(r.refinements[0]?.equivalence).toContain("clamp");
    expect(r.refinements[0]?.baselineSemanticsData?.name).toBe("clamp_hi");
    expect(r.refinements[0]?.refSemanticsData?.name).toBe("clamp_hi");
    expect(r.program.commands).toHaveLength(1);
    const fn = r.program.commands[0];
    expect(fn?.tag).toBe("fn_def");
    if (fn?.tag === "fn_def") {
      expect(fn.keyword).toBe("def");
      expect(fn.params[0]?.name).toBe("n");
    }
  });

  it("accepts a recursive ref when a shared rad closes the inductive proof", () => {
    const src = `
      fun shrink(x:int): int {
        ret 0;
        ret rec(x / 2) + 1;
        rad abs(x);
      }

      ref shrink(n:int): int {
        ret 0;
        let next = n / 2;
        ret 1 + rec(next);
        rad abs(n);
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("scalar_int_recursive_induction");
    expect(r.refinements[0]?.equivalence).toContain("shared rad");
    expect(r.program.commands).toHaveLength(1);
    const fn = r.program.commands[0];
    expect(fn?.tag).toBe("fn_def");
    if (fn?.tag === "fn_def") {
      expect(fn.keyword).toBe("fun");
      expect(fn.params[0]?.name).toBe("n");
    }
  });

  it("accepts recursive refs when recursive results are wrapped in interpreted calls", () => {
    const src = `
      fun fib(x:int): int {
        let a = max(0, x);
        let b = min(1, a);
        ret b;
        ret max(res, rec(max(0, x - 1)) + rec(max(0, x - 2)));
        rad abs(x);
      }

      ref fib(x:int): int {
        let a = max(0, x);
        let b = min(1, a);
        ret b;
        ret max(res, rec(max(0, x - 1)) + rec(max(0, x - 2))) - 1 + 1;
        rad abs(x);
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("scalar_int_recursive_induction");
  });

  it("accepts recursive refs when recursive arguments flow through array closures", () => {
    const src = `
      fun countdown(n:int): int {
        ret 0;
        ret rec(max(0, n - 1)) + 1;
        rad abs(n);
      }

      ref countdown(n:int): int {
        let nexts = array[i:1] max(0, n - 1);
        ret 0;
        ret rec(nexts[0]) + 1;
        rad abs(n);
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("scalar_int_recursive_induction");
  });

  it("accepts recursive refs when an array literal acts as a lookup closure", () => {
    const src = `
      fun fib(x:int): int {
        let a = max(0, x);
        let b = min(1, a);
        ret b;
        ret max(res, rec(max(0, x - 1)) + rec(max(0, x - 2)));
        rad abs(x);
      }

      ref fib(x:int): int {
        let safe_x = clamp(x, 0, 47);
        let table = [
          0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610,
          987, 1597, 2584, 4181, 6765, 10946, 17711, 28657, 46368, 75025,
          121393, 196418, 317811, 514229, 832040, 1346269, 2178309,
          3524578, 5702887, 9227465, 14930352, 24157817, 39088169,
          63245986, 102334155, 165580141, 267914296, 433494437,
          701408733, 1134903170, 1836311903, 2147483647
        ];
        ret table[safe_x];
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("scalar_int_recursive_induction");
  });

  it("rejects a ref that changes behavior and keeps the baseline implementation", () => {
    const src = `
      fun add_one(x:int): int {
        ret x + 1;
      }

      ref add_one(x:int): int {
        ret x + 2;
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics.some((d) => d.code === "REF_MISMATCH")).toBe(true);
    expect(r.refinements[0]?.status).toBe("mismatch");
    expect(r.refinements[0]?.refSemantics.join("\n")).toContain("ret sat_add(x, 2)");
    expect(r.refinements[0]?.refSemanticsData?.body.some((stmt) => stmt.tag === "ret")).toBe(true);
    expect(r.program.commands).toHaveLength(1);
    const fn = r.program.commands[0];
    expect(fn?.tag).toBe("fn_def");
    if (fn?.tag === "fn_def") {
      expect(fn.keyword).toBe("fun");
    }
  });

  it("rejects a recursive ref that changes behavior with a real counterexample", () => {
    const src = `
      fun shrink(x:int): int {
        ret 0;
        ret rec(x / 2) + 1;
        rad abs(x);
      }

      ref shrink(n:int): int {
        ret 0;
        let next = n / 2;
        ret rec(next) + 2;
        rad abs(n);
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics.some((d) => d.code === "REF_MISMATCH")).toBe(true);
    expect(r.refinements[0]?.status).toBe("mismatch");
  });

  it("rejects a ref with a different signature", () => {
    const src = `
      fun add_one(x:int): int {
        ret x + 1;
      }

      ref add_one(x:float): int {
        ret 1;
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics.some((d) => d.code === "REF_SIGNATURE")).toBe(true);
    expect(r.refinements[0]?.status).toBe("invalid");
  });
});
