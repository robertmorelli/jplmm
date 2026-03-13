import { describe, expect, it } from "vitest";

import { runFrontend } from "@jplmm/frontend";

import {
  analyzeFunctionOptimizations,
  collectDefinitionPolicyWarnings,
  renderFunctionOptimizationHover,
} from "../src/optimization_info.ts";

describe("function optimization hover info", () => {
  it("reports closed-form optimizations for eligible functions", () => {
    const frontend = runFrontend(`
      fun steps(x:int): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad x;
      }
    `);
    const info = analyzeFunctionOptimizations(frontend).get("steps");

    expect(info?.implementation?.tag).toBe("closed_form_linear_countdown");
    expect(renderFunctionOptimizationHover(info!)).toContain("selected lowering: `closed-form countdown`");
    expect(renderFunctionOptimizationHover(info!)).toContain("`closed_form`");
  });

  it("highlights research-grade optimizations in hover info", () => {
    const frontend = runFrontend(`
      fun contract(scale:float, x:float): float {
        ret x;
        ret rec(scale, res * 0.75);
        rad x - res;
      }
    `);
    const info = analyzeFunctionOptimizations(frontend).get("contract");
    const hover = renderFunctionOptimizationHover(info!);

    expect(info?.implementation?.tag).toBe("aitken_scalar_tail");
    expect(info?.researchCandidates.some((candidate) => candidate.pass === "aitken")).toBe(true);
    expect(hover).toContain("Research optimization active");
    expect(hover).toContain("generalized Aitken acceleration");
    expect(hover).toContain("var(--vscode-testing-iconPassed)");
  });

  it("warns when def blocks a research-grade lowering that fun would use", () => {
    const frontend = runFrontend(`
      def contract(scale:float, x:float): float {
        ret x;
        ret rec(scale, res * 0.75);
        rad x - res;
      }
    `);
    const info = analyzeFunctionOptimizations(frontend);
    const contract = info.get("contract");
    const warnings = collectDefinitionPolicyWarnings(frontend, info);
    const hover = renderFunctionOptimizationHover(contract!);

    expect(contract?.implementation).toBeNull();
    expect(contract?.researchCandidates.some((candidate) => candidate.pass === "aitken" && candidate.blockedByDefinition)).toBe(true);
    expect(hover).toContain("blocked by `def`");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("use 'fun' to allow research-grade lowering");
  });
});
