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
    expect(r.ok).toBe(true);
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
      fn safe(x:int, y:int): int {
        ret (x / y) + 1;
      }
    `;
    const r = runOnSource(src, "wat");
    expect(r.ok).toBe(true);
    expect(r.wat).toContain("(module");
    expect(r.wat).toContain("call $jplmm_total_div_i32");
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
    expect(r.nativeC).toContain("static int32_t zero");
    expect(r.nativeC).toContain("jplmm_max_i32");
  });

  it("runs print, show, time, and image I/O commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "jplmm-cli-"));
    const input = join(dir, "input.pgm");
    const output = join(dir, "output.pgm");
    writeFileSync(input, "P2\n2 2\n255\n1 2 3 4\n");

    const src = `
      print "hello";
      read image "input.pgm" to (w, h, img);
      show img[h - 1][w - 1][0];
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

  it("supports timed definitions that are used later", () => {
    const src = `
      time fn inc(x:int): int {
        ret x + 1;
      }
      show inc(4);
    `;
    const r = runOnSource(src, "run");
    expect(r.ok).toBe(true);
    expect(r.output[0]).toContain("time:");
    expect(r.output[1]).toBe("5");
  });

  it("round-trips bitmap image I/O", () => {
    const dir = mkdtempSync(join(tmpdir(), "jplmm-cli-bmp-"));
    const output = join(dir, "output.bmp");

    const src = `
      let img = [[[255, 0, 0], [0, 255, 0]]];
      write image img to "output.bmp";
      read image "output.bmp" to (w, h, loaded);
      show loaded[0][1][1] + w + h;
    `;
    const r = runOnSource(src, "run", { cwd: dir });

    expect(r.ok).toBe(true);
    expect(r.wroteFiles).toEqual([output]);
    expect(readFileSync(output).subarray(0, 2).toString("ascii")).toBe("BM");
    expect(r.output[0]).toBe("258");
  });
});
