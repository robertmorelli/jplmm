import { describe, expect, it } from "vitest";

import { runFrontend } from "@jplmm/frontend";
import { analyzeProgramMetrics } from "@jplmm/verify";

import {
  buildOutResultAnnotations,
  canAnnotateInlineOutResults,
  collectFunctionMetricAnnotations,
  collectFunctionRefinementAnnotations,
  findVerificationDiagnosticAnchor,
} from "../src/annotations.ts";

describe("editor annotations", () => {
  it("collects function metrics with complexity and canonical coverage labels", () => {
    const frontend = runFrontend(`
      struct Pair { left:int, right:int }

      fun f(n:int, pair:Pair): int {
        ret n;
        ret rec(n) + rec(n);
        rad n;
      }
    `);
    const annotations = collectFunctionMetricAnnotations(frontend.program, analyzeProgramMetrics(frontend.program));

    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.label).toBe("complexity 3 | 100% line coverage via f(0, Pair { 0, 0 })");
  });

  it("collects valid refinement annotations for ref definitions", () => {
    const frontend = runFrontend(`
      fun clamp_hi(x:int): int {
        ret clamp(x, 0, 255);
      }

      ref clamp_hi(n:int): int {
        ret clamp(n, 0, 255);
      }
    `);
    const annotations = collectFunctionRefinementAnnotations(frontend.refinements);

    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.name).toBe("clamp_hi");
    expect(annotations[0]?.label).toBe("valid refinement via canonical equivalence");
  });

  it("only allows inline out annotations for safe top-level programs", () => {
    const safeFrontend = runFrontend(`
      let x = 1;
      out x;
      out x + 1;
    `);
    const unsafeFrontend = runFrontend(`
      print "hello";
      out 1;
    `);

    expect(canAnnotateInlineOutResults(safeFrontend.program)).toBe(true);
    expect(buildOutResultAnnotations(safeFrontend.program, ["1", "2"])).toEqual([
      {
        offset: expect.any(Number),
        label: "=> 1",
        tooltip: "Inline result from a safe editor run of top-level out commands.",
      },
      {
        offset: expect.any(Number),
        label: "=> 2",
        tooltip: "Inline result from a safe editor run of top-level out commands.",
      },
    ]);
    expect(canAnnotateInlineOutResults(unsafeFrontend.program)).toBe(false);
    expect(buildOutResultAnnotations(unsafeFrontend.program, ["1"])).toEqual([]);
  });

  it("anchors proof failures on the rad statement when present", () => {
    const source = `
      fun bad(n:int): int {
        ret n;
        rad n;
        ret rec(n + 1);
      }
    `;
    const frontend = runFrontend(source);
    const anchor = findVerificationDiagnosticAnchor(frontend.program, {
      fnName: "bad",
      code: "VERIFY_PROOF_FAIL",
      severity: "error",
      message: "no decrease",
    });

    expect(anchor).not.toBeNull();
    expect(source.slice(anchor?.start ?? 0, anchor?.end ?? 0).trim()).toBe("rad n");
  });

  it("anchors gas-inf warnings on the gas statement", () => {
    const source = `
      fun bounded(n:int): int {
        ret n;
        ret rec(n + 1);
        gas inf;
      }
    `;
    const frontend = runFrontend(source);
    const anchor = findVerificationDiagnosticAnchor(frontend.program, {
      fnName: "bounded",
      code: "VERIFY_GAS_INF",
      severity: "warning",
      message: "gas inf",
    });

    expect(anchor).not.toBeNull();
    expect(source.slice(anchor?.start ?? 0, anchor?.end ?? 0).trim()).toBe("gas inf");
  });
});
