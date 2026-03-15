export type ResearchBenchCase = {
  name: string;
  fnName: string;
  args: number[];
  runtimeIterations: number;
  nativeIterations: number;
  optimizeOptions: Parameters<typeof import("@jplmm/optimize").optimizeProgram>[1];
  source: string;
  dafnyFile: string;
  expectedValue: number;
};

export const RESEARCH_BENCH_CASES: ResearchBenchCase[] = [
  {
    name: "closed_form_steps",
    fnName: "steps",
    args: [400],
    runtimeIterations: 3000,
    nativeIterations: 200000,
    optimizeOptions: {},
    source: `
      fn steps(x:int(0,_)): int {
        ret 0;
        ret rec(max(0, x - 1)) + 1;
        rad x;
      }
    `,
    dafnyFile: "closed_form_steps.dfy",
    expectedValue: 401,
  },
  {
    name: "lut_poly",
    fnName: "poly",
    args: [15],
    runtimeIterations: 4000,
    nativeIterations: 300000,
    optimizeOptions: {
      parameterRangeHints: {
        poly: [{ lo: 0, hi: 15 }],
      },
    },
    source: `
      fn poly(x:int): int {
        ret x * x + 1;
      }
    `,
    dafnyFile: "lut_poly.dfy",
    expectedValue: 226,
  },
  {
    name: "linear_spec_zero",
    fnName: "zero",
    args: [400],
    runtimeIterations: 3000,
    nativeIterations: 200000,
    optimizeOptions: {
      enableResearchPasses: true,
    },
    source: `
      fn zero(x:int): int {
        ret x;
        ret rec(max(0, x - 1));
        rad x;
      }
    `,
    dafnyFile: "linear_spec_zero.dfy",
    expectedValue: 0,
  },
  {
    name: "aitken_avg",
    fnName: "avg",
    args: [100, 0],
    runtimeIterations: 2000,
    nativeIterations: 120000,
    optimizeOptions: {
      enableResearchPasses: true,
    },
    source: `
      fn avg(target:float, guess:float): float {
        ret guess;
        ret (res + target) / 2.0;
        ret rec(target, res);
        rad target - res;
      }
    `,
    dafnyFile: "aitken_avg.dfy",
    expectedValue: 100,
  },
];
