import { describe, expect, it } from "vitest";

import { buildIR } from "@jplmm/ir";
import { runFrontend } from "@jplmm/frontend";

import { optimizeProgram } from "../src/pipeline.ts";
import { executeProgram } from "../src/runtime.ts";

function compile(source: string) {
  const frontend = runFrontend(source);
  expect(frontend.diagnostics).toEqual([]);
  return buildIR(frontend.program, frontend.typeMap);
}

describe("optimization performance characteristics", () => {
  it("uses closed-form lowering to remove recursive work", () => {
    const program = compile(`
      fn steps(x:int): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad x;
      }
    `);

    const baseline = executeProgram(program, "steps", [40]);
    const optimized = optimizeProgram(program);
    const accelerated = executeProgram(optimized.program, "steps", [40], {
      artifacts: optimized.artifacts,
    });

    expect(accelerated.value).toBe(baseline.value);
    expect(optimized.artifacts.implementations.get("steps")?.tag).toBe("closed_form_linear_countdown");
    expect(accelerated.stats.functionCalls).toBeLessThan(baseline.stats.functionCalls);
    expect(accelerated.stats.implementationHits.closed_form_linear_countdown).toBe(1);
  });

  it("uses LUT tabulation when a finite parameter domain is available", () => {
    const program = compile(`
      fn poly(x:int): int {
        ret x * x + 1;
      }
    `);

    const optimized = optimizeProgram(program, {
      parameterRangeHints: {
        poly: [{ lo: 0, hi: 15 }],
      },
    });

    for (let x = 0; x <= 15; x += 1) {
      const baseline = executeProgram(program, "poly", [x]);
      const accelerated = executeProgram(optimized.program, "poly", [x], {
        artifacts: optimized.artifacts,
      });
      expect(accelerated.value).toBe(baseline.value);
      expect(accelerated.stats.exprEvaluations).toBeLessThan(baseline.stats.exprEvaluations);
    }

    expect(optimized.artifacts.implementations.get("poly")?.tag).toBe("lut");
  });

  it("uses experimental Aitken acceleration for average-to-target convergence", () => {
    const program = compile(`
      fn avg(target:float, guess:float): float {
        ret guess;
        ret (res + target) / 2.0;
        ret rec(target, res);
        rad target - res;
      }
    `);

    const baseline = executeProgram(program, "avg", [100, 0]);
    const optimized = optimizeProgram(program, {
      enableResearchPasses: true,
    });
    const accelerated = executeProgram(optimized.program, "avg", [100, 0], {
      artifacts: optimized.artifacts,
    });

    expect(Math.abs(accelerated.value - baseline.value)).toBeLessThan(0.0001);
    expect(accelerated.stats.iterations).toBeLessThan(baseline.stats.iterations);
    expect(optimized.artifacts.implementations.get("avg")?.tag).toBe("aitken_scalar_tail");
    expect(accelerated.stats.implementationHits.aitken_scalar_tail).toBeGreaterThan(0);
  });

  it("uses linear speculation to jump directly to a monotone fixed point", () => {
    const program = compile(`
      fn zero(x:int): int {
        ret x;
        ret rec(max(0, x - 1));
        rad x;
      }
    `);

    const baseline = executeProgram(program, "zero", [100]);
    const optimized = optimizeProgram(program, {
      enableResearchPasses: true,
    });
    const accelerated = executeProgram(optimized.program, "zero", [100], {
      artifacts: optimized.artifacts,
    });

    expect(accelerated.value).toBe(baseline.value);
    expect(optimized.artifacts.implementations.get("zero")?.tag).toBe("linear_speculation");
    expect(accelerated.stats.iterations).toBeLessThan(baseline.stats.iterations);
    expect(accelerated.stats.implementationHits.linear_speculation).toBeGreaterThan(0);
  });
});
