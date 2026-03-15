import { describe, expect, it } from "vitest";

import { runFrontend } from "../src/pipeline.ts";

describe("runFrontend", () => {
  it("accepts bounded scalar parameters", () => {
    const src = `
      fun clamp_in(x:int(0,_), y:float(0.0, 1.0)): int {
        ret x + to_int(y);
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    const fn = r.program.commands[0];
    expect(fn?.tag).toBe("fn_def");
    if (fn?.tag === "fn_def") {
      expect(fn.params[0]?.type).toMatchObject({ tag: "int", bounds: { lo: 0, hi: null } });
      expect(fn.params[1]?.type).toMatchObject({ tag: "float", bounds: { lo: 0, hi: 1 } });
    }
  });

  it("rejects bounded scalar types outside direct parameters", () => {
    const src = `
      fun nope(x:int): int(0, 10) {
        ret x;
      }

      struct Box { value:int(0, 10) }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics.some((d) => d.code === "TYPE_BOUND_TARGET")).toBe(true);
  });

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
    expect(r.refinements[0]?.method).toBe("symbolic_value_smt");
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
    expect(r.refinements[0]?.method).toBe("symbolic_recursive_induction");
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
    expect(r.refinements[0]?.method).toBe("symbolic_recursive_induction");
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
    expect(r.refinements[0]?.method).toBe("symbolic_recursive_induction");
  });

  it("treats bounded scalar recursive arguments as post-normalization at collapse", () => {
    const src = `
      fun fib(x:int(0,_)): int {
        ret clamp(x, 0, 1);
        ret max(res, rec(max(0, x - 1)) + rec(max(0, x - 2)));
        rad x;
      }

      ref fib(x:int(0,_)): int {
        ret min(1, x);
        ret max(res, rec(x - 1) + rec(x - 2));
        rad x;
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("symbolic_recursive_induction");
  });

  it("accepts recursive float refs through the shared symbolic induction path", () => {
    const src = `
      fun cool(x:int, y:float): float {
        ret y;
        ret rec(max(0, x - 1), y) + (y - y) + 1.0;
        rad abs(x);
      }

      ref cool(n:int, z:float): float {
        ret z;
        let next = max(0, n - 1);
        ret 1.0 + rec(next, z) + (z - z);
        rad abs(n);
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("symbolic_recursive_induction");
  });

  it("accepts recursive refs that call recursive helpers through the shared symbolic path", () => {
    const src = `
      fun helper(x:int): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad abs(x);
      }

      fun top(x:int): int {
        ret 0;
        ret helper(x) + rec(max(0, x - 1));
        rad abs(x);
      }

      ref top(n:int): int {
        ret 0;
        let helper_now = helper(n);
        let next = max(0, n - 1);
        ret rec(next) + helper_now;
        rad abs(n);
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("symbolic_recursive_induction");
  });

  it("accepts recursive refs that express sibling recursive calls with sum folds", () => {
    const src = `
      fun fib(x:int(0,_)): int {
        ret clamp(x, 0, 1);
        ret max(res, rec(x - 1) + rec(x - 2));
        rad x;
      }

      ref fib(x:int(0,_)): int {
        ret min(1, x);
        ret max(res, sum [i:2] rec(x - (i + 1)));
        rad x;
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("symbolic_recursive_induction");
  });

  it("accepts recursive array-return refs through closure semantics", () => {
    const src = `
      fun grow(x:int): int[] {
        ret array[i:2] 0;
        let prev = rec(max(0, x - 1));
        ret array[i:2] prev[i] + 1;
        rad abs(x);
      }

      ref grow(n:int): int[] {
        ret array[i:2] 0;
        let next = max(0, n - 1);
        let prev = rec(next);
        ret array[i:2] 1 + prev[i];
        rad abs(n);
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("symbolic_recursive_induction");
  });

  it("accepts non-recursive refs through shared symbolic array closure semantics", () => {
    const src = `
      fun foo(a:int): int {
        ret 1;
      }

      ref foo(a:int): int {
        ret (array[i:10] 1)[a];
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("symbolic_value_alpha");
    expect(r.refinements[0]?.equivalence).toBe("1 == 1");
  });

  it("accepts matrix-style commutative refs by canonical equivalence after operand sorting", () => {
    const src = `
      fun matmul(A:int[], B:int[], rows:int, cols:int, shared:int): int[] {
        ret array[idx:rows * cols]
          sum [k:shared] A[(idx / cols) * shared + k] * B[k * cols + (idx % cols)];
      }

      ref matmul(A:int[], B:int[], rows:int, cols:int, shared:int): int[] {
        ret array[idx:rows * cols]
          sum [k:shared] B[k * cols + (idx % cols)] * A[(idx / cols) * shared + k];
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("canonical");
    expect(r.refinements[0]?.detail).toContain("alpha-equivalent");
  });

  it("accepts helper-factored matrix refs by beta-reducing array-valued helper arguments", () => {
    const src = `
      fun dot(A:int[], B:int[], shared:int, cols:int, i:int, j:int): int {
        ret sum [k:shared] A[i * shared + k] * B[k * cols + j];
      }

      fun matmul(A:int[], B:int[], rows:int, cols:int, shared:int): int[] {
        ret array[idx:rows * cols]
          sum [k:shared] A[(idx / cols) * shared + k] * B[k * cols + (idx % cols)];
      }

      ref matmul(A:int[], B:int[], rows:int, cols:int, shared:int): int[] {
        ret array[idx:rows * cols]
          dot(A, B, shared, cols, idx / cols, idx % cols);
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("symbolic_value_alpha");
    expect(r.refinements[0]?.equivalence).toContain("array[");
  });

  it("accepts transpose-view matrix refs after array beta reduction and bounded index normalization", () => {
    const src = `
      fun transpose(B:int[], shared:int(1,32), cols:int(1,32)): int[] {
        ret array[idx:cols * shared]
          B[(idx % shared) * cols + (idx / shared)];
      }

      fun dot_transposed(A:int[], B_T:int[], shared:int(1,32), i:int, j:int): int {
        ret sum [k:shared] A[i * shared + k] * B_T[j * shared + k];
      }

      fun matmul(A:int[], B:int[], rows:int(1,32), cols:int(1,32), shared:int(1,32)): int[] {
        ret array[idx:rows * cols]
          sum [k:shared] A[(idx / cols) * shared + k] * B[k * cols + (idx % cols)];
      }

      ref matmul(A:int[], B:int[], rows:int(1,32), cols:int(1,32), shared:int(1,32)): int[] {
        let B_T = transpose(B, shared, cols);
        ret array[idx:rows * cols]
          dot_transposed(A, B_T, shared, idx / cols, idx % cols);
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics).toHaveLength(0);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("equivalent");
    expect(r.refinements[0]?.method).toBe("symbolic_value_alpha");
    expect(r.refinements[0]?.equivalence).toContain("array[");
  });

  it("fails fast with an unproven recursive array-literal lookup ref under a tight proof budget", () => {
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
    const r = runFrontend(src, { proofTimeoutMs: 200 });

    expect(r.diagnostics.some((d) => d.code === "REF_UNPROVEN")).toBe(true);
    expect(r.refinements).toHaveLength(1);
    expect(r.refinements[0]?.status).toBe("unproven");
    expect(
      r.refinements[0]?.detail.includes("timed out")
      || r.refinements[0]?.detail.includes("did not admit an inductive proof"),
    ).toBe(true);
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
    expect(r.refinements[0]?.refSemantics.join("\n")).toContain("ret sat_add(2, x)");
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

  it("rejects a ref that changes declared scalar bounds", () => {
    const src = `
      fun clamp_in(x:int(0,_)): int {
        ret x;
      }

      ref clamp_in(x:int): int {
        ret x;
      }
    `;
    const r = runFrontend(src);

    expect(r.diagnostics.some((d) => d.code === "REF_SIGNATURE")).toBe(true);
    expect(r.refinements[0]?.status).toBe("invalid");
  });
});
