import { describe, expect, it } from "vitest";

import { buildIR } from "@jplmm/ir";
import { runFrontend } from "@jplmm/frontend";

import { executeProgram } from "../src/runtime.ts";
import { optimizeProgram } from "../src/pipeline.ts";

function compile(source: string) {
  const frontend = runFrontend(source);
  expect(frontend.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  return buildIR(frontend.program, frontend.typeMap);
}

describe("IR runtime semantics", () => {
  it("uses total arithmetic for integer division by zero", () => {
    const program = compile(`
      fn safe_div(x:int): int {
        ret x / 0;
      }
    `);
    const result = executeProgram(program, "safe_div", [123]);
    expect(result.value).toBe(0);
  });

  it("uses saturating arithmetic for int overflow", () => {
    const program = compile(`
      fn sat(x:int): int {
        ret x + 2000000000 + 2000000000;
      }
    `);
    const result = executeProgram(program, "sat", [100]);
    expect(result.value).toBe(2147483647);
  });

  it("collapses fixed points without taking a recursive transition", () => {
    const program = compile(`
      fn stable(x:int): int {
        ret x * 2;
        ret rec(x);
        gas 10;
      }
    `);
    const result = executeProgram(program, "stable", [4]);
    expect(result.value).toBe(8);
    expect(result.stats.recCollapses).toBe(1);
    expect(result.stats.tailRecTransitions).toBe(0);
  });

  it("returns current res when gas is exhausted in tail recursion", () => {
    const program = compile(`
      fn spin(x:int): int {
        ret x + 1;
        ret rec(res);
        gas 2;
      }
    `);
    const result = executeProgram(program, "spin", [0]);
    expect(result.value).toBe(3);
    expect(result.stats.tailRecTransitions).toBe(2);
    expect(result.stats.gasExhaustions).toBe(1);
  });

  it("charges gas for non-tail rec before spawning a fresh instance", () => {
    const program = compile(`
      fn bump(x:int): int {
        ret x;
        ret rec(x - 1) + 1;
        gas 0;
      }
    `);
    const result = executeProgram(program, "bump", [4]);
    expect(result.value).toBe(5);
    expect(result.stats.tailRecTransitions).toBe(0);
    expect(result.stats.gasExhaustions).toBe(1);
  });

  it("treats 1-ULP float changes as fixed-point collapse", () => {
    const program = compile(`
      fn near(x:float): float {
        ret x;
        ret rec(1.0000001192092896);
        gas 1;
      }
    `);
    const result = executeProgram(program, "near", [1.0]);
    expect(result.value).toBe(1.0);
    expect(result.stats.recCollapses).toBe(1);
    expect(result.stats.tailRecTransitions).toBe(0);
  });

  it("supports generalized Aitken acceleration on scalar float tail recurrences", () => {
    const program = compile(`
      fn contract(scale:float, x:float): float {
        ret x;
        ret rec(scale, res * 0.75);
        rad x - res;
      }
    `);
    const optimized = optimizeProgram(program, {
      enableResearchPasses: true,
    });
    const baseline = executeProgram(program, "contract", [1.0, 64.0]);
    const accelerated = executeProgram(optimized.program, "contract", [1.0, 64.0], {
      artifacts: optimized.artifacts,
    });

    expect(optimized.artifacts.implementations.get("contract")?.tag).toBe("aitken_scalar_tail");
    expect(Math.abs(accelerated.value - baseline.value)).toBeLessThan(0.0001);
    expect(accelerated.stats.implementationHits.aitken_scalar_tail).toBeGreaterThan(0);
  });

  it("evaluates structs, fields, and nested array literals", () => {
    const program = compile(`
      struct Pair { left:int, right:int }

      fn sample(x:int): int {
        let pair = Pair { x, x + 1 };
        let grid = [[x, x + 1], [x + 2, x + 3]];
        ret pair.right + grid[1][0];
      }
    `);
    const result = executeProgram(program, "sample", [5]);
    expect(result.value).toBe(13);
  });

  it("preserves struct fields when normalizing function arguments", () => {
    const program = compile(`
      struct Tracker { pos:float, vel:float, target:float, gain:float }

      fn step(state:Tracker): Tracker {
        ret Tracker {
          (state.pos * state.gain + state.target) / (state.gain + 1.0),
          (state.vel + (state.target - state.pos) / 2.0) / 2.0,
          state.target,
          state.gain
        };
      }

      fn iterate(state:Tracker): Tracker {
        ret state;
        ret rec(step(state));
        gas 4;
      }

      fn score(state:Tracker): float {
        let out = iterate(state);
        ret out.pos + out.vel / 4.0;
      }
    `);
    const result = executeProgram(program, "score", [
      { kind: "struct", typeName: "Tracker", fields: [2.0, 3.0, 7.0, 4.0] },
    ]);
    expect(result.value).toBeTypeOf("number");
    expect(result.stats.recCalls).toBeGreaterThan(0);
  });

  it("evaluates array comprehensions, slices, and sums", () => {
    const program = compile(`
      fn score(n:int): int {
        let grid = array [i:n, j:2] i + j;
        let row = grid[n - 1];
        ret row[0] + row[1] + sum [i:n] i;
      }
    `);
    const result = executeProgram(program, "score", [4]);
    expect(result.value).toBe(13);
  });

  it("clamps comprehension bounds to one and indices to the nearest cell", () => {
    const program = compile(`
      fn sample(n:int): int {
        let grid = array [i:n - 5, j:2] i + j + 10;
        let row = grid[n + 7];
        ret row[0 - 3] + sum [k:n - 20] (k + 1);
      }
    `);
    const result = executeProgram(program, "sample", [4]);
    expect(result.value).toBe(11);
  });

  it("indexes arrays of structs without dropping field data", () => {
    const program = compile(`
      struct Pixel { r:int, g:int, b:int }

      fn first(img:Pixel[][], h:int, w:int): int {
        ret img[0][0].r;
      }

      fn make(seed:int): Pixel[][] {
        let h = 2;
        let w = 3;
        let img = array [y:h, x:w] Pixel { x + 1, y + 2, 7 };
        ret img;
      }
    `);
    const made = executeProgram(program, "make", [0]).value;
    const result = executeProgram(program, "first", [made, 2, 3]);
    expect(result.value).toBe(1);
  });

  it("normalizes bounded scalar parameters at function entry", () => {
    const program = compile(`
      fn clamp_in(x:int(0, 10), y:float(0.0, 1.0)): float {
        ret to_float(x) + y;
      }
    `);
    const result = executeProgram(program, "clamp_in", [-5, 2.5]);

    expect(result.value).toBeCloseTo(1.0, 6);
  });

  it("normalizes bounded scalar recursive arguments before collapse", () => {
    const program = compile(`
      fn zero(x:int(0,_)): int {
        ret x;
        ret rec(x - 1);
        rad x;
      }
    `);
    const result = executeProgram(program, "zero", [-3]);

    expect(result.value).toBe(0);
    expect(result.stats.recCollapses).toBe(1);
  });

  it("binds named array extents to runtime dimensions at function entry", () => {
    const program = compile(`
      fn make(seed:int): int[][] {
        ret array [i:2, j:3] seed + i + j;
      }

      fn shape(a:int[n][m]): int {
        ret n * 100 + m;
      }
    `);
    const made = executeProgram(program, "make", [7]).value;
    const result = executeProgram(program, "shape", [made]);

    expect(result.value).toBe(203);
  });
});
