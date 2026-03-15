import { describe, expect, it } from "vitest";

import { buildIR } from "@jplmm/ir";
import { runFrontend } from "@jplmm/frontend";
import { optimizeProgram } from "@jplmm/optimize";

import {
  buildWatSemantics,
  compileProgramToInstance,
  compileWatToWasm,
  emitWatModule,
  packageName,
} from "../src/index.ts";

function compile(source: string) {
  const frontend = runFrontend(source);
  expect(frontend.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
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

  it("describes Wasm lowering in terms of total arithmetic helpers and recursion strategy", () => {
    const optimized = optimizeProgram(compile(`
      fn safe(x:int, y:int): int {
        ret (x / y) + 1;
      }

      fn zero(x:int): int {
        ret x;
        ret rec(max(0, x - 1));
        rad x;
      }
    `), {
      disabledPasses: ["closed_form"],
    });
    const semantics = buildWatSemantics(optimized.program, {
      artifacts: optimized.artifacts,
      tailCalls: false,
      exportFunctions: true,
    });

    const safe = semantics.functions.find((fn) => fn.name === "safe");
    const zero = semantics.functions.find((fn) => fn.name === "zero");

    expect(safe?.helpers.map((helper) => helper.name)).toContain("jplmm_total_div_i32");
    expect(safe?.helpers.map((helper) => helper.name)).toContain("jplmm_sat_add_i32");
    expect(safe?.statements[0]?.expr?.lowering.kind).toBe("helper_call");
    expect(zero?.recursion.tailStrategy).toBe("loop_branch");
    expect(zero?.statements[1]?.expr?.lowering.kind).toBe("tail_recursion");
    expect(semantics.helperSemantics.jplmm_total_div_i32).toContain("returns 0");
  });

  it("materializes named array extents as Wasm locals", () => {
    const wat = emitWatModule(compile(`
      fn shape(a:int[n][m]): int {
        ret n * 100 + m;
      }
    `), {
      exportFunctions: true,
    });

    expect(wat).toContain("(local $n i32)");
    expect(wat).toContain("(local $m i32)");
    expect(wat).toContain("call $jplmm_array_dim");
    expect(wat).toContain("local.set $n");
    expect(wat).toContain("local.set $m");
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

  it("includes debug comments in emitted wat when requested", () => {
    const optimized = optimizeProgram(
      compile(`
        fn steps(x:int(0,_)): int {
          ret 0;
          ret rec(max(0, x - 1)) + 1;
          rad x;
        }
      `),
    );
    const wat = emitWatModule(optimized.program, {
      artifacts: optimized.artifacts,
      exportFunctions: true,
      moduleComments: [
        "JPLMM debug WAT",
        "optimization passes:",
        "  closed_form: specialized steps",
      ],
    });

    expect(wat).toContain(";; JPLMM debug WAT");
    expect(wat).toContain(";; optimization passes:");
    expect(wat).toContain(";;   closed_form: specialized steps");
    expect(compileWatToWasm(wat).byteLength).toBeGreaterThan(0);
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
      fn steps(x:int(0,_)): int {
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

  it("compiles proven ref definitions down to the refined implementation", async () => {
    const { wat, instance } = await compileInstance(`
      def clamp_hi(x:int): int {
        ret min(max(x, 0), 255);
      }

      ref clamp_hi(n:int): int {
        ret clamp(n, 0, 255);
      }
    `);
    const clampHi = exportedFunction<(x: number) => number>(instance, "clamp_hi");

    expect(clampHi(-5)).toBe(0);
    expect(clampHi(300)).toBe(255);
    expect(wat.match(/\(func \$clamp_hi/g)?.length ?? 0).toBe(1);
  });

  it("compiles non-recursive shared-symbolic refs that use array closures", async () => {
    const { wat, instance } = await compileInstance(`
      fun foo(a:int): int {
        ret 1;
      }

      ref foo(a:int): int {
        ret (array[i:10] 1)[a];
      }
    `);
    const foo = exportedFunction<(x: number) => number>(instance, "foo");

    expect(foo(-5)).toBe(1);
    expect(foo(3)).toBe(1);
    expect(foo(999)).toBe(1);
    expect(wat.match(/\(func \$foo/g)?.length ?? 0).toBe(1);
  });

  it("compiles recursively-proven ref definitions down to the refined implementation", async () => {
    const { wat, instance } = await compileInstance(`
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
    `);
    const shrink = exportedFunction<(x: number) => number>(instance, "shrink");

    expect(shrink(0)).toBe(1);
    expect(shrink(8)).toBe(5);
    expect(shrink(-8)).toBe(5);
    expect(wat.match(/\(func \$shrink/g)?.length ?? 0).toBe(1);
  });

  it("compiles recursive refs that wrap recursive results in interpreted calls", async () => {
    const { wat, instance } = await compileInstance(`
      fun fib(x:int): int {
        let a = max(0, x);
        let b = min(1, a);
        ret b;
        ret max(res, rec(max(0, x - 1)) + rec(max(0, x - 2)));
        rad abs(x);
      }

      ref fib(x:int): int {
        let a = max(0, x);
        let b = min(1, a);
        ret b;
        ret max(res, rec(max(0, x - 1)) + rec(max(0, x - 2))) - 1 + 1;
        rad abs(x);
      }
    `);
    const fib = exportedFunction<(x: number) => number>(instance, "fib");

    expect(fib(0)).toBe(0);
    expect(fib(1)).toBe(1);
    expect(fib(6)).toBe(8);
    expect(wat.match(/\(func \$fib/g)?.length ?? 0).toBe(1);
  });

  it("compiles recursive refs that route recursive arguments through array closures", async () => {
    const { wat, instance } = await compileInstance(`
      fun countdown(n:int): int {
        ret 0;
        ret rec(max(0, n - 1)) + 1;
        rad abs(n);
      }

      ref countdown(n:int): int {
        let nexts = array[i:1] max(0, n - 1);
        ret 0;
        ret rec(nexts[0]) + 1;
        rad abs(n);
      }
    `);
    const countdown = exportedFunction<(x: number) => number>(instance, "countdown");

    expect(countdown(0)).toBe(1);
    expect(countdown(5)).toBe(6);
    expect(wat.match(/\(func \$countdown/g)?.length ?? 0).toBe(1);
  });

  it("compiles bounded recursive refs with post-normalized collapse semantics", async () => {
    const { wat, instance } = await compileInstance(`
      fun fib(x:int(0,_)): int {
        ret clamp(x, 0, 1);
        ret max(res, rec(max(0, x - 1)) + rec(max(0, x - 2)));
        rad x;
      }

      ref fib(x:int(0,_)): int {
        ret min(1, x);
        ret max(res, rec(x - 1) + rec(x - 2));
        rad x;
      }
    `);
    const fib = exportedFunction<(x: number) => number>(instance, "fib");

    expect(fib(-5)).toBe(0);
    expect(fib(0)).toBe(0);
    expect(fib(1)).toBe(1);
    expect(fib(6)).toBe(8);
    expect(wat.match(/\(func \$fib/g)?.length ?? 0).toBe(1);
  });

  it("compiles recursive refs that express sibling recurrences with sum folds", async () => {
    const { wat, instance } = await compileInstance(`
      fun fib(x:int(0,_)): int {
        ret clamp(x, 0, 1);
        ret max(res, rec(x - 1) + rec(x - 2));
        rad x;
      }

      ref fib(x:int(0,_)): int {
        ret min(1, x);
        ret max(res, sum [i:2] rec(x - (i + 1)));
        rad x;
      }
    `);
    const fib = exportedFunction<(x: number) => number>(instance, "fib");

    expect(fib(-5)).toBe(0);
    expect(fib(0)).toBe(0);
    expect(fib(1)).toBe(1);
    expect(fib(7)).toBe(13);
    expect(wat.match(/\(func \$fib/g)?.length ?? 0).toBe(1);
  });

  it("compiles recursive float refs through shared symbolic induction", async () => {
    const { wat, instance } = await compileInstance(`
      fun cool(x:int, y:float): float {
        ret y;
        ret rec(max(0, x - 1), y) + (y - y) + 1.0;
        rad abs(x);
      }

      ref cool(n:int, z:float): float {
        ret z;
        let next = max(0, n - 1);
        ret 1.0 + rec(next, z) + (z - z);
        rad abs(n);
      }
    `);
    const cool = exportedFunction<(x: number, y: number) => number>(instance, "cool");

    expect(cool(0, 3.5)).toBeCloseTo(4.5, 6);
    expect(cool(3, 3.5)).toBeCloseTo(7.5, 6);
    expect(wat.match(/\(func \$cool/g)?.length ?? 0).toBe(1);
  });

  it("compiles recursive refs that use helper calls in the symbolic induction path", async () => {
    const { wat, instance } = await compileInstance(`
      fun helper(x:int): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad abs(x);
      }

      fun top(x:int): int {
        ret 0;
        ret helper(x) + rec(max(0, x - 1));
        rad abs(x);
      }

      ref top(n:int): int {
        ret 0;
        let helper_now = helper(n);
        let next = max(0, n - 1);
        ret rec(next) + helper_now;
        rad abs(n);
      }
    `);
    const top = exportedFunction<(x: number) => number>(instance, "top");

    expect(top(0)).toBe(1);
    expect(top(4)).toBe(15);
    expect(wat.match(/\(func \$top/g)?.length ?? 0).toBe(1);
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

  it("describes LUT-backed Wasm lowering with a generic fallback body", () => {
    const optimized = optimizeProgram(
      compile(`
        fn poly(x:int): int {
          ret x * x + 1;
        }
      `),
      {
        parameterRangeHints: {
          poly: [{ lo: 0, hi: 7 }],
        },
      },
    );
    const semantics = buildWatSemantics(optimized.program, {
      artifacts: optimized.artifacts,
      exportFunctions: true,
    });
    const poly = semantics.functions.find((fn) => fn.name === "poly");

    expect(poly?.implementation.loweredAs).toBe("lut_wrapper");
    expect(poly?.fallback?.wasmName).toBe("poly__generic");
    expect(semantics.memory.luts[0]?.fnName).toBe("poly");
    expect(semantics.memory.luts[0]?.cells).toBeGreaterThan(0);
  });

  it("lowers generalized Aitken acceleration directly into wasm", async () => {
    const { optimized, wat, instance } = await compileInstance(
      `
        fun avg(target:float, guess:float): float {
          ret guess;
          ret (res + target) / 2.0;
          ret rec(target, res);
          rad target - res;
        }
      `,
      {
        enableResearchPasses: true,
      },
      {
        tailCalls: true,
      },
    );
    const avg = exportedFunction<(target: number, guess: number) => number>(instance, "avg");

    expect(optimized.artifacts.implementations.get("avg")?.tag).toBe("aitken_scalar_tail");
    expect(avg(100, 0)).toBeCloseTo(100, 2);
    expect(wat).toContain("jplmm_aitken_pred");
    expect(wat).toContain("call $jplmm_isfinite_f32");
    expect(wat).toContain("loop $avg__loop");
    expect(wat).not.toContain("return_call $avg");
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

  it("clamps comprehension bounds and array indices in compiled wasm", async () => {
    const { wat, instance } = await compileInstance(`
      fn sample(n:int): int {
        let grid = array [i:n - 5, j:2] i + j + 10;
        let row = grid[n + 7];
        ret row[0 - 3] + sum [k:n - 20] (k + 1);
      }
    `);
    const sample = exportedFunction(instance, "sample");

    expect(sample(4)).toBe(11);
    expect(wat).toContain("call $jplmm_clamp_i32");
    expect(wat).toContain("call $jplmm_max_i32");
  });

  it("exports a wasm heap reset helper for repeated host-driven execution", async () => {
    const { instance } = await compileInstance(`
      struct Pair { left:int, right:int }

      fn make_pair(x:int): Pair {
        ret Pair { x, x + 1 };
      }

      fn use_pair(p:Pair): int {
        ret p.right;
      }
    `);
    const makePair = exportedFunction<(x: number) => number>(instance, "make_pair");
    const usePair = exportedFunction<(p: number) => number>(instance, "use_pair");
    const resetHeap = exportedFunction<() => void>(instance, "__jplmm_reset_heap");

    const first = makePair(4);
    expect(usePair(first)).toBe(5);

    resetHeap();

    const second = makePair(9);
    expect(usePair(second)).toBe(10);
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

  it("normalizes bounded scalar parameters in compiled wasm", async () => {
    const { instance } = await compileInstance(`
      fn clamp_in(x:int(0, 10), y:float(0.0, 1.0)): float {
        ret to_float(x) + y;
      }
    `);
    const clampIn = exportedFunction<(x: number, y: number) => number>(instance, "clamp_in");

    expect(clampIn(-5, 2.5)).toBeCloseTo(1.0, 6);
    expect(clampIn(20, -3)).toBeCloseTo(10.0, 6);
  });

  it("normalizes bounded recursive arguments before wasm tail-rec collapse", async () => {
    const { instance } = await compileInstance(
      `
        fn zero(x:int(0,_)): int {
          ret x;
          ret rec(x - 1);
          rad x;
        }
      `,
      {},
      {
        tailCalls: false,
      },
    );
    const zero = exportedFunction<(x: number) => number>(instance, "zero");

    expect(zero(-3)).toBe(0);
  });
});
