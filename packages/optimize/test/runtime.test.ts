import { describe, expect, it } from "vitest";

import { buildIR } from "@jplmm/ir";
import { runFrontend } from "@jplmm/frontend";

import { executeProgram } from "../src/runtime.ts";
import { optimizeProgram } from "../src/pipeline.ts";

function compile(source: string) {
  const frontend = runFrontend(source);
  expect(frontend.diagnostics).toEqual([]);
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
});
