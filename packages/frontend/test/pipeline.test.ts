import { describe, expect, it } from "vitest";

import { runFrontend } from "../src/pipeline.ts";

describe("runFrontend", () => {
  it("returns typed program and diagnostics for a valid core program", () => {
    const src = `
      fn abs_like(x:int): int {
        ret max(x, -x);
      }

      fn rec_ok(x:int): int {
        ret x;
        ret rec(max(0, x - 1));
        rad x;
      }
    `;
    const r = runFrontend(src);
    expect(r.diagnostics).toHaveLength(0);
    expect(r.program.commands.length).toBe(2);
    expect(r.typeMap.size).toBeGreaterThan(0);
  });

  it("accumulates diagnostics across parse/resolve/typecheck", () => {
    const src = `
      fn broken(x:int): float {
        let x = if;
        ret rec(x);
      }
    `;
    const r = runFrontend(src);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some((d) => d.code === "SHADOW")).toBe(true);
    expect(r.diagnostics.some((d) => d.code === "REC_BEFORE_RET")).toBe(true);
  });
});

