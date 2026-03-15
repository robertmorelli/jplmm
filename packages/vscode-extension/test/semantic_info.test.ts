import { describe, expect, it } from "vitest";

import { runFrontend } from "@jplmm/frontend";
import { verifyProgram } from "@jplmm/verify";

import { renderFunctionSemanticHover } from "../src/semantic_info.ts";

describe("function semantic hover", () => {
  it("renders Lisp-style executable semantics on the function hover", () => {
    const frontend = runFrontend(`
      fun clamp_hi(input:int): int {
        let clipped = clamp(input, 0, 50);
        ret clipped;
      }
    `);
    const verification = verifyProgram(frontend.program, frontend.typeMap);
    const hover = renderFunctionSemanticHover(frontend, verification, "clamp_hi");

    expect(frontend.diagnostics).toHaveLength(0);
    expect(hover).toContain("**Executable Semantics**");
    expect(hover).toContain("```lisp");
    expect(hover).toContain("(clamp_int input 0 50)");
    expect(hover).toContain("Result:");
  });

  it("shows array comprehensions as closures in the function hover", () => {
    const frontend = runFrontend(`
      fun ones(a:int): int {
        let table = array[i:10] 1;
        ret table[a];
      }
    `);
    const verification = verifyProgram(frontend.program, frontend.typeMap);
    const hover = renderFunctionSemanticHover(frontend, verification, "ones");

    expect(frontend.diagnostics).toHaveLength(0);
    expect(hover).toContain("(array:closure (bindings (i 10)) 1)");
  });

  it("shows baseline and ref semantics separately when hovering different refinement sites", () => {
    const frontend = runFrontend(`
      fun clamp_hi(input:int): int {
        let clipped = clamp(input, 0, 50);
        ret clipped;
      }

      ref clamp_hi(n:int): int {
        ret clamp(n, 0, 50);
      }
    `);
    const verification = verifyProgram(frontend.program, frontend.typeMap);
    const refinement = frontend.refinements[0]!;

    const baselineHover = renderFunctionSemanticHover(
      frontend,
      verification,
      "clamp_hi",
      refinement.baselineStart,
    );
    const refHover = renderFunctionSemanticHover(
      frontend,
      verification,
      "clamp_hi",
      refinement.refStart,
    );

    expect(frontend.diagnostics).toHaveLength(0);
    expect(baselineHover).toContain("Canonical semantics captured for this baseline definition before refinement.");
    expect(baselineHover).toContain(refinement.baselineSemantics[0]!);
    expect(refHover).toContain("Canonical semantics captured for this refinement step.");
    expect(refHover).toContain(refinement.refSemantics[0]!);
  });
});
