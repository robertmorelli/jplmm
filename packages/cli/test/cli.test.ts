import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runOnSource } from "../src/index.ts";

describe("cli integration", () => {
  it("reports parse/typecheck success on a simple function", () => {
    const src = `
      fn sq(x:int): int {
        ret x * x;
      }
    `;
    const r = runOnSource(src, "typecheck");
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toHaveLength(0);
  });

  it("reports verify summary for bounded gas function", () => {
    const src = `
      fn f(x:int): int {
        ret x + 1;
        ret rec(res);
        gas 5;
      }
    `;
    const r = runOnSource(src, "verify");
    expect(r.proofSummary.some((s) => s.includes("bounded (gas)"))).toBe(true);
    expect(r.analysisSummary.some((s) => s.includes("source complexity 2"))).toBe(true);
    expect(r.analysisSummary.some((s) => s.includes("canonical line-coverage witness f(0)"))).toBe(true);
    expect(r.analysisSummary.some((s) => s.includes("coarse total call bound"))).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("prints successful refinement equivalence in proof summaries", () => {
    const src = `
      fun clamp_hi(x:int): int {
        ret min(max(x, 0), 255);
      }

      ref clamp_hi(n:int): int {
        ret clamp(n, 0, 255);
      }
    `;
    const r = runOnSource(src, "verify");

    expect(r.ok).toBe(true);
    expect(r.proofSummary).toContain("clamp_hi: ref equivalent (scalar_int_smt) - min(max(x, 0), 255) == clamp(x, 0, 255)");
  });

  it("returns non-ok on hard errors", () => {
    const src = `
      fn f(x:int): int {
        ret rec(x);
      }
    `;
    const r = runOnSource(src, "verify");
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.startsWith("ERROR:"))).toBe(true);
  });

  it("keeps ok=true when verify emits only warnings", () => {
    const src = `
      fn f(x:int): int {
        ret x + 1;
        ret rec(res);
        gas inf;
      }
    `;
    const r = runOnSource(src, "verify");
    expect(r.ok).toBe(true);
    expect(r.diagnostics.some((d) => d.startsWith("WARNING:"))).toBe(true);
  });

  it("does not include verify proof summary in parse mode", () => {
    const src = `
      fn sq(x:int): int {
        ret x * x;
      }
    `;
    const r = runOnSource(src, "parse");
    expect(r.ok).toBe(true);
    expect(r.proofSummary).toEqual([]);
    expect(r.analysisSummary).toEqual([]);
  });

  it("reports optimization passes and implementations in optimize mode", () => {
    const src = `
      fn steps(x:int): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad x;
      }
    `;
    const r = runOnSource(src, "optimize", { experimental: true });
    expect(r.ok).toBe(true);
    expect(r.optimizeSummary.some((line) => line.includes("closed_form"))).toBe(true);
    expect(r.implementationSummary.some((line) => line.includes("closed_form_linear_countdown"))).toBe(
      true,
    );
  });

  it("emits wat output in wat mode", () => {
    const src = `
      fn steps(x:int): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad x;
      }
    `;
    const r = runOnSource(src, "wat");
    expect(r.ok).toBe(true);
    expect(r.wat).toContain("(module");
    expect(r.wat).toContain(";; JPLMM debug WAT");
    expect(r.wat).toContain(";; optimization passes:");
    expect(r.wat).toContain(";; selected implementations:");
    expect(r.wat).not.toContain("safe mode active");
  });

  it("uses experimental lowerings by default in WAT mode", () => {
    const src = `
      fun avg(target:float, guess:float): float {
        ret guess;
        ret (res + target) / 2.0;
        ret rec(target, res);
        rad target - res;
      }
    `;
    const r = runOnSource(src, "wat");

    expect(r.ok).toBe(true);
    expect(r.implementationSummary).toContain("avg: aitken_scalar_tail");
    expect(r.wat).toContain("jplmm_aitken_pred");
    expect(r.wat).not.toContain("wat backend fallbacks");
  });

  it("safe mode disables all optional optimizer passes", () => {
    const src = `
      fun steps(x:int): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad x;
      }
    `;
    const r = runOnSource(src, "wat", { safe: true });

    expect(r.ok).toBe(true);
    expect(r.implementationSummary).toEqual([]);
    expect(r.optimizeSummary).toContain("guard_elimination: disabled by option");
    expect(r.optimizeSummary).toContain("closed_form: disabled by option");
    expect(r.optimizeSummary).toContain("lut_tabulation: disabled by option");
    expect(r.wat).toContain(";; safe mode active: all optional optimizer passes are disabled");
    expect(r.wat).toContain(";; disabled passes: guard_elimination, closed_form, lut_tabulation, aitken, linear_speculation");
  });

  it("can disable a single pass without turning off the others", () => {
    const src = `
      fun steps(x:int): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad x;
      }
    `;
    const r = runOnSource(src, "optimize", { disablePasses: ["closed_form"] });

    expect(r.ok).toBe(true);
    expect(r.optimizeSummary).toContain("closed_form: disabled by option");
    expect(r.implementationSummary).toEqual([]);
  });

  it("emits native C output in arm mode", () => {
    const src = `
      fn zero(x:int): int {
        ret x;
        ret rec(max(0, x - 1));
        rad x;
      }
    `;
    const r = runOnSource(src, "native", { experimental: true });
    expect(r.ok).toBe(true);
    expect(r.nativeC).toContain("static int32_t jplmm_fn_zero");
    expect(r.nativeC).toContain("jplmm_max_i32");
  });

  it("runs print, out, time, and image I/O commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "jplmm-cli-"));
    const input = join(dir, "input.pgm");
    const output = join(dir, "output.pgm");
    writeFileSync(input, "P2\n2 2\n255\n1 2 3 4\n");

    const src = `
      print "hello";
      read image "input.pgm" to (w, h, img);
      out img[h - 1][w - 1][0];
      time write image img to "output.pgm";
    `;
    const r = runOnSource(src, "run", { cwd: dir });

    expect(r.ok).toBe(true);
    expect(r.output[0]).toBe("hello");
    expect(r.output[1]).toBe("4");
    expect(r.output[2]).toContain("time:");
    expect(r.wroteFiles).toEqual([output]);
    expect(readFileSync(output, "utf8")).toContain("P2");
  });

  it("emits a semantics debug document with function bodies and proof obligations", () => {
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
    const r = runOnSource(src, "semantics");

    expect(r.ok).toBe(true);
    expect(r.semantics).toBeDefined();
    const data = JSON.parse(r.semantics ?? "{}");
    expect(data.kind).toBe("jplmm_semantics_debug");
    expect(data.refinements[0]?.equivalence).toContain("shared rad");
    expect(data.canonicalProgram?.functions[0]?.name).toBe("shrink");
    expect(data.functions[0]?.analysis?.recSites[0]?.obligations[0]?.rad).toBe("abs(n)");
    expect(data.backend?.wasm?.kind).toBe("jplmm_wasm_semantics");
    expect(data.backend?.optimizedProgram?.functions[0]?.name).toBe("shrink");
  });

  it("serializes structured params and symbolic statement semantics in semantics mode", () => {
    const src = `
      struct Pair { left:int, right:int }

      fun score(pair:Pair, n:int): int {
        let arr = [pair.left, pair.right];
        let total = sum[i:n] arr[0] + i;
        ret total;
      }
    `;
    const r = runOnSource(src, "semantics");

    expect(r.ok).toBe(true);
    const data = JSON.parse(r.semantics ?? "{}");
    expect(data.functions[0]?.analysis?.params[0]?.value?.kind).toBe("struct");
    expect(data.functions[0]?.analysis?.statementSemantics[0]?.value?.kind).toBe("array");
    expect(data.functions[0]?.analysis?.statementSemantics[1]?.value?.kind).toBe("scalar");
    expect(data.functions[0]?.analysis?.statementSemantics[1]?.value?.expr?.tag).toBe("sum");
  });

  it("serializes Wasm helper semantics and optimized lowering details in semantics mode", () => {
    const src = `
      fn safe(x:int, y:int): int {
        ret (x / y) + 1;
      }
    `;
    const r = runOnSource(src, "semantics");

    expect(r.ok).toBe(true);
    const data = JSON.parse(r.semantics ?? "{}");
    expect(data.backend?.optimizeSummary).toBeInstanceOf(Array);
    expect(data.backend?.wasm?.functions[0]?.helpers.some((helper: { name: string }) => helper.name === "jplmm_total_div_i32")).toBe(true);
    expect(data.backend?.wasm?.functions[0]?.statements[0]?.expr?.lowering?.helper).toBe("jplmm_sat_add_i32");
    expect(data.backend?.wasm?.helperSemantics?.jplmm_total_div_i32).toContain("returns 0");
  });

  it("supports timed definitions that are used later", () => {
    const src = `
      time fun inc(x:int): int {
        ret x + 1;
      }
      out inc(4);
    `;
    const r = runOnSource(src, "run");
    expect(r.ok).toBe(true);
    expect(r.output[0]).toContain("time:");
    expect(r.output[1]).toBe("5");
  });

  it("runs a zero-arg main as the implicit entry for function-only programs", () => {
    const src = `
      fun main(): int {
        ret 42;
      }
    `;
    const r = runOnSource(src, "run");
    expect(r.ok).toBe(true);
    expect(r.output).toEqual(["42"]);
  });

  it("can verify before run and stop on failed proof obligations", () => {
    const src = `
      fun bad(x:int): int {
        ret x;
        rad 1;
        ret rec(x + 1);
      }

      out 1;
    `;
    const r = runOnSource(src, "run", { verifyBeforeRun: true });

    expect(r.ok).toBe(false);
    expect(r.output).toEqual([]);
    expect(r.diagnostics.some((line) => line.includes("failed proof obligations"))).toBe(true);
    expect(r.diagnostics.some((line) => line.includes("counterexample:"))).toBe(true);
  });

  it("can verify before run and include proof summaries when execution succeeds", () => {
    const src = `
      fun main(): int {
        ret 42;
      }

      fun down(x:int): int {
        ret x;
        ret rec(max(0, x - 1));
        rad x;
      }

      out down(3);
    `;
    const r = runOnSource(src, "run", { verifyBeforeRun: true });

    expect(r.ok).toBe(true);
    expect(r.output).toEqual(["0"]);
    expect(r.proofSummary.some((line) => line.includes("down: verified"))).toBe(true);
  });

  it("keeps explicit top-level commands as the entry when present", () => {
    const src = `
      out 1;
      fun main(): int {
        ret 2;
      }
    `;
    const r = runOnSource(src, "run");
    expect(r.ok).toBe(true);
    expect(r.output).toEqual(["1"]);
  });

  it("round-trips bitmap image I/O", () => {
    const dir = mkdtempSync(join(tmpdir(), "jplmm-cli-bmp-"));
    const output = join(dir, "output.bmp");

    const src = `
      let img = [[[255, 0, 0], [0, 255, 0]]];
      write image img to "output.bmp";
      read image "output.bmp" to (w, h, loaded);
      out loaded[0][1][1] + w + h;
    `;
    const r = runOnSource(src, "run", { cwd: dir });

    expect(r.ok).toBe(true);
    expect(r.wroteFiles).toEqual([output]);
    expect(readFileSync(output).subarray(0, 2).toString("ascii")).toBe("BM");
    expect(r.output[0]).toBe("258");
  });
});
