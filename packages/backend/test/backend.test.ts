import { describe, expect, it } from "vitest";

import { buildIR } from "@jplmm/ir";
import { runFrontend } from "@jplmm/frontend";
import { optimizeProgram } from "@jplmm/optimize";

import {
  compileProgramToInstance,
  compileWatToWasm,
  emitWatModule,
  packageName,
} from "../src/index.ts";

function compile(source: string) {
  const frontend = runFrontend(source);
  expect(frontend.diagnostics).toEqual([]);
  return buildIR(frontend.program, frontend.typeMap);
}

async function compileInstance(
  source: string,
  optimizeOptions: Parameters<typeof optimizeProgram>[1] = {},
  emitOptions: Parameters<typeof compileProgramToInstance>[1] = {},
) {
  const ir = compile(source);
  const optimized = optimizeProgram(ir, optimizeOptions);
  const compiled = await compileProgramToInstance(optimized.program, {
    artifacts: optimized.artifacts,
    exportFunctions: true,
    ...emitOptions,
  });
  return { optimized, ...compiled };
}

function exportedFunction<T extends (...args: number[]) => number>(
  instance: WebAssembly.Instance,
  name: string,
): T {
  const value = instance.exports[name];
  expect(typeof value).toBe("function");
  return value as T;
}

describe("@jplmm/backend", () => {
  it("exports its package identity", () => {
    expect(packageName).toBe("@jplmm/backend");
  });

  it("executes sentinel helper lowering in compiled wasm", async () => {
    const { wat, instance } = await compileInstance(`
      fn safe(x:int, y:int): int {
        ret (x / y) + 1;
      }
    `);
    const safe = exportedFunction(instance, "safe");

    expect(safe(9, 0)).toBe(1);
    expect(safe(10, 2)).toBe(6);
    expect(wat).toContain("call $jplmm_total_div_i32");
    expect(wat).toContain("call $jplmm_sat_add_i32");
  });

  it("executes loop-lowered tail recursion when tail calls are disabled", async () => {
    const { wat, instance } = await compileInstance(
      `
        fn zero(x:int): int {
          ret x;
          ret rec(max(0, x - 1));
          rad x;
        }
      `,
      {},
      {
        tailCalls: false,
      },
    );
    const zero = exportedFunction(instance, "zero");

    expect(zero(4)).toBe(0);
    expect(wat).toContain("loop $zero__loop");
    expect(wat).toContain("br $zero__loop");
    expect(wat).not.toContain("return_call $zero");
  });

  it("parses tail-call lowering with a real wasm toolchain", () => {
    const optimized = optimizeProgram(
      compile(`
        fn zero(x:int): int {
          ret x;
          ret rec(max(0, x - 1));
          rad x;
        }
      `),
      {
        enableResearchPasses: true,
      },
    );
    const wat = emitWatModule(optimized.program, {
      artifacts: optimized.artifacts,
      tailCalls: true,
      exportFunctions: true,
    });
    const wasm = compileWatToWasm(wat, {
      tailCalls: true,
    });

    expect(wasm.byteLength).toBeGreaterThan(0);
    expect(wat).toContain("return_call $zero");
    expect(wat).toContain("call $jplmm_max_i32");
  });

  it("executes gas-bounded tail recursion in compiled wasm", async () => {
    const { wat, instance } = await compileInstance(
      `
        fn spin(x:int): int {
          ret x + 1;
          ret rec(res);
          gas 2;
        }
      `,
      {},
      {
        tailCalls: false,
      },
    );
    const spin = exportedFunction(instance, "spin");

    expect(spin(0)).toBe(3);
    expect(wat).toContain("local.get $jplmm_fuel");
  });

  it("executes non-tail rec with gas exhaustion and 1-ULP float equality", async () => {
    const { wat, instance } = await compileInstance(`
      fn near(x:float): float {
        ret x;
        ret rec(1.0000001192092896) + 1.0;
        gas 0;
      }
    `);
    const near = exportedFunction(instance, "near");

    expect(near(1.0)).toBeCloseTo(2.0, 6);
    expect(wat).toContain("(func $jplmm_eq_f32_ulp1");
    expect(wat).toContain("if (result f32)");
    expect(wat).toContain("local.get $jplmm_fuel");
  });

  it("lowers closed-form implementations into specialized backend code", async () => {
    const { optimized, wat, instance } = await compileInstance(`
      fn steps(x:int): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad x;
      }
    `);
    const steps = exportedFunction(instance, "steps");

    expect(optimized.artifacts.implementations.get("steps")?.tag).toBe("closed_form_linear_countdown");
    expect(steps(40)).toBe(41);
    expect(wat).toContain("local $jplmm_steps");
    expect(wat).not.toContain("call $steps");
  });

  it("lowers LUT implementations into wasm memory-backed fast paths with fallback", async () => {
    const { optimized, wat, instance } = await compileInstance(
      `
        fn poly(x:int): int {
          ret x * x + 1;
        }
      `,
      {
        parameterRangeHints: {
          poly: [{ lo: 0, hi: 15 }],
        },
      },
    );
    const poly = exportedFunction(instance, "poly");

    expect(optimized.artifacts.implementations.get("poly")?.tag).toBe("lut");
    expect(poly(7)).toBe(50);
    expect(poly(20)).toBe(401);
    expect(wat).toContain("(memory $jplmm_mem");
    expect(wat).toContain("(data (i32.const");
    expect(wat).toContain("call $poly__generic");
  });

  it("executes struct construction, field access, and struct fixed-point equality in wasm", async () => {
    const { wat, instance } = await compileInstance(`
      struct Pair { left:int, right:int }

      fn make_pair(x:int): Pair {
        ret Pair { x, x + 1 };
      }

      fn use_pair(p:Pair): int {
        ret p.right;
      }

      fn settle(p:Pair): int {
        ret p.right;
        ret rec(Pair { p.left, p.right });
        gas 1;
      }
    `, {}, { tailCalls: false });
    const makePair = exportedFunction<(x: number) => number>(instance, "make_pair");
    const usePair = exportedFunction<(p: number) => number>(instance, "use_pair");
    const settle = exportedFunction<(p: number) => number>(instance, "settle");

    const handle = makePair(4);
    expect(handle).toBeGreaterThan(0);
    expect(usePair(handle)).toBe(5);
    expect(settle(handle)).toBe(5);
    expect(wat).toContain("call $jplmm_eq_struct_Pair");
    expect(wat).toContain("call $jplmm_word_load_i32");
  });

  it("executes struct field let-target updates in compiled wasm", async () => {
    const { instance } = await compileInstance(`
      struct Pair { left:int, right:int }

      fn bump(x:int): int {
        let p = Pair { x, x };
        let p.right = x + 3;
        ret p.right;
      }
    `);
    const bump = exportedFunction<(x: number) => number>(instance, "bump");

    expect(bump(4)).toBe(7);
  });

  it("executes arrays, comprehensions, slicing, and array equality in wasm", async () => {
    const { wat, instance } = await compileInstance(`
      fn make_grid(n:int): int[][] {
        ret array [i:n, j:2] i + j;
      }

      fn peek(grid:int[][], row:int): int {
        ret grid[row][1];
      }

      fn row_sum(grid:int[][], row:int): int {
        let slice = grid[row];
        ret slice[0] + slice[1];
      }

      fn settle(grid:int[][]): int {
        ret 9;
        ret rec(grid);
        gas 1;
      }
    `, {}, { tailCalls: false });
    const makeGrid = exportedFunction<(n: number) => number>(instance, "make_grid");
    const peek = exportedFunction<(grid: number, row: number) => number>(instance, "peek");
    const rowSum = exportedFunction<(grid: number, row: number) => number>(instance, "row_sum");
    const settle = exportedFunction<(grid: number) => number>(instance, "settle");

    const handle = makeGrid(4);
    expect(handle).toBeGreaterThan(0);
    expect(peek(handle, 2)).toBe(3);
    expect(rowSum(handle, 3)).toBe(7);
    expect(settle(handle)).toBe(9);
    expect(wat).toContain("call $jplmm_array_slice");
    expect(wat).toContain("call $jplmm_eq_array_arr2_i32");
  });
});
