import { describe, expect, it } from "vitest";

import { runFrontend } from "@jplmm/frontend";

import {
  analyzeVariableRanges,
  buildVariableRangeAnnotations,
  findVariableRangeAtOffset,
  renderVariableRangeHover,
} from "../src/range_info.ts";

describe("variable range hover info", () => {
  it("reports optimizer ranges for local bindings and later uses", () => {
    const source = `
      fun bounded(input:int): int {
        let clipped = clamp(input, 0, 50);
        ret clipped;
      }
    `;
    const frontend = runFrontend(source);
    const info = analyzeVariableRanges(frontend);
    const binding = findVariableRangeAtOffset(info, source.indexOf("clipped ="));
    const use = findVariableRangeAtOffset(info, source.lastIndexOf("clipped;"));

    expect(frontend.diagnostics).toHaveLength(0);
    expect(binding?.kind).toBe("binding");
    expect(use?.kind).toBe("use");
    expect(renderVariableRangeHover(binding!)).toContain("int(0, 50)");
    expect(renderVariableRangeHover(use!)).toContain("int(0, 50)");
  });

  it("hides default full-domain scalar ranges", () => {
    const source = `
      fun passthrough(input:int): int {
        ret input;
      }
    `;
    const frontend = runFrontend(source);
    const info = analyzeVariableRanges(frontend);
    const inputUse = findVariableRangeAtOffset(info, source.lastIndexOf("input;"));

    expect(frontend.diagnostics).toHaveLength(0);
    expect(inputUse).toBeNull();
  });

  it("hides optimizer ranges already guaranteed by bounded parameter types", () => {
    const source = `
      fun passthrough(input:int(0, 10)): int {
        ret input;
      }
    `;
    const frontend = runFrontend(source);
    const info = analyzeVariableRanges(frontend);
    const inputUse = findVariableRangeAtOffset(info, source.lastIndexOf("input;"));

    expect(frontend.diagnostics).toHaveLength(0);
    expect(inputUse).toBeNull();
  });

  it("builds inline annotations for parameters and let bindings", () => {
    const source = `
      fun bounded(input:int): int {
        let clipped = clamp(input, 0, 50);
        ret clipped;
      }
    `;
    const frontend = runFrontend(source);
    const annotations = buildVariableRangeAnnotations(analyzeVariableRanges(frontend));

    expect(frontend.diagnostics).toHaveLength(0);
    expect(annotations.some((annotation) => annotation.label === ": int(0, 50)")).toBe(true);
    expect(annotations.every((annotation) => annotation.tooltip.includes("Optimizer-proved"))).toBe(true);
  });
});
