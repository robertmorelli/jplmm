import { describe, expect, it } from "vitest";

import { runFrontend } from "@jplmm/frontend";
import { buildIR } from "@jplmm/ir";
import { optimizeProgram } from "@jplmm/optimize";

import { emitNativeRunnerSource, runNativeFunction } from "../src/native.ts";

function compile(source: string) {
  const frontend = runFrontend(source);
  expect(frontend.diagnostics).toEqual([]);
  return buildIR(frontend.program, frontend.typeMap);
}

describe("native arm64 backend", () => {
  it("runs closed-form lowering through a native arm64 binary", () => {
    const program = compile(`
      fn steps(x:int): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad x;
      }
    `);
    const optimized = optimizeProgram(program);
    const run = runNativeFunction(optimized.program, "steps", [40], {
      artifacts: optimized.artifacts,
    });

    try {
      expect(run.value).toBe(41);
      expect(run.stdout).toBe("41");
    } finally {
      run.cleanup();
    }
  });

  it("runs linear speculation through a native arm64 binary", () => {
    const program = compile(`
      fn zero(x:int): int {
        ret x;
        ret rec(max(0, x - 1));
        rad x;
      }
    `);
    const optimized = optimizeProgram(program, {
      enableResearchPasses: true,
    });
    const source = emitNativeRunnerSource(optimized.program, "zero", {
      artifacts: optimized.artifacts,
    });
    const run = runNativeFunction(optimized.program, "zero", [100], {
      artifacts: optimized.artifacts,
    });

    try {
      expect(optimized.artifacts.implementations.get("zero")?.tag).toBe("linear_speculation");
      expect(source).toContain("zero__generic");
      expect(source).toContain("x = 0;");
      expect(run.value).toBe(0);
    } finally {
      run.cleanup();
    }
  });

  it("runs generalized Aitken acceleration through a native arm64 binary", () => {
    const program = compile(`
      fn avg(target:float, guess:float): float {
        ret guess;
        ret (res + target) / 2.0;
        ret rec(target, res);
        rad target - res;
      }
    `);
    const optimized = optimizeProgram(program, {
      enableResearchPasses: true,
    });
    const source = emitNativeRunnerSource(optimized.program, "avg", {
      artifacts: optimized.artifacts,
    });
    const run = runNativeFunction(optimized.program, "avg", [100, 0], {
      artifacts: optimized.artifacts,
      iterations: 1,
    });

    try {
      expect(optimized.artifacts.implementations.get("avg")?.tag).toBe("aitken_scalar_tail");
      expect(source).toContain("jplmm_aitken_pred");
      expect(run.value).toBeCloseTo(100, 2);
    } finally {
      run.cleanup();
    }
  });

  it("runs struct construction and field access through native code", () => {
    const program = compile(`
      struct Pair { left:int, right:int }

      fn right(x:int): int {
        let p = Pair { x, x + 1 };
        ret p.right;
      }
    `);
    const run = runNativeFunction(program, "right", [9]);

    try {
      expect(run.value).toBe(10);
      expect(run.source).toContain("jplmm_word_store_i32");
      expect(run.source).toContain("jplmm_word_load_i32");
    } finally {
      run.cleanup();
    }
  });

  it("runs arrays, comprehensions, and sums through native code", () => {
    const program = compile(`
      fn checksum(n:int): int {
        let grid = array [i:n, j:2] i + j;
        let row = grid[n - 1];
        ret row[0] + row[1] + sum [i:n] i;
      }
    `);
    const run = runNativeFunction(program, "checksum", [4]);

    try {
      expect(run.value).toBe(13);
      expect(run.source).toContain("jplmm_array_alloc_r2");
      expect(run.source).toContain("jplmm_array_slice");
    } finally {
      run.cleanup();
    }
  });
});
