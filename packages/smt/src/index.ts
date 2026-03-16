import { spawnSync } from "node:child_process";

export type SExpr = string | SExpr[];
export type Z3RunOptions = {
  timeoutMs?: number;
  deadlineAtMs?: number;
};

export const HARD_Z3_TIMEOUT_MS = 2000;

export type Z3Status = "sat" | "unsat" | "unknown" | "other";

export type Z3CheckResult =
  | {
      ok: true;
      output: string;
      status: Z3Status;
    }
  | {
      ok: false;
      error: string;
      timedOut: boolean;
    };

export type Z3ValuesResult =
  | {
      ok: true;
      output: string;
      status: Z3Status;
      values: Map<string, string> | null;
    }
  | {
      ok: false;
      error: string;
      timedOut: boolean;
    };

export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;

const Z3_PATH = "z3";

export function buildZ3BasePrelude(): string[] {
  return [
    "(set-logic ALL)",
    "(set-option :pp.decimal true)",
  ];
}

export function buildJplInt32Prelude(): string[] {
  return [
    ...buildZ3BasePrelude(),
    `(define-fun clamp_int ((x Int)) Int (ite (< x ${INT32_MIN}) ${INT32_MIN} (ite (> x ${INT32_MAX}) ${INT32_MAX} x)))`,
    "(define-fun abs_int ((x Int)) Int (ite (< x 0) (- x) x))",
    "(define-fun max_int ((a Int) (b Int)) Int (ite (< a b) b a))",
    "(define-fun min_int ((a Int) (b Int)) Int (ite (< a b) a b))",
    "(define-fun positive_extent_int ((x Int)) Int (max_int 1 (clamp_int x)))",
    "(define-fun clamp_range_int ((x Int) (lo Int) (hi Int)) Int (min_int (max_int x lo) hi))",
    "(define-fun clamp_index_int ((idx Int) (dim Int)) Int (ite (<= dim 1) 0 (let ((sidx (clamp_int idx))) (ite (< sidx 0) 0 (ite (>= sidx dim) (- dim 1) sidx)))))",
    "(define-fun sat_add_int ((a Int) (b Int)) Int (clamp_int (+ a b)))",
    "(define-fun sat_sub_int ((a Int) (b Int)) Int (clamp_int (- a b)))",
    "(define-fun sat_mul_int ((a Int) (b Int)) Int (clamp_int (* a b)))",
    "(define-fun sat_neg_int ((a Int)) Int (clamp_int (- a)))",
    "(define-fun trunc_div_int ((a Int) (b Int)) Int (ite (= b 0) 0 (let ((q (div (abs_int a) (abs_int b)))) (ite (= (< a 0) (< b 0)) q (- q)))))",
    "(define-fun total_div_int ((a Int) (b Int)) Int (ite (= b 0) 0 (trunc_div_int a b)))",
    "(define-fun total_mod_int ((a Int) (b Int)) Int (ite (= b 0) 0 (- a (* b (trunc_div_int a b)))))",
  ];
}

export function buildJplScalarPrelude(): string[] {
  return [
    ...buildZ3BasePrelude(),
    "(define-fun abs_int ((x Int)) Int (ite (< x 0) (- x) x))",
    "(define-fun abs_real ((x Real)) Real (ite (< x 0.0) (- x) x))",
    "(define-fun max_int ((a Int) (b Int)) Int (ite (< a b) b a))",
    "(define-fun min_int ((a Int) (b Int)) Int (ite (< a b) a b))",
    "(define-fun clamp_int ((x Int) (lo Int) (hi Int)) Int (min_int (max_int x lo) hi))",
    `(define-fun clamp_int32 ((x Int)) Int (clamp_int x ${INT32_MIN} ${INT32_MAX}))`,
    "(define-fun positive_extent_int ((x Int)) Int (max_int 1 (clamp_int32 x)))",
    "(define-fun clamp_index_int ((idx Int) (dim Int)) Int (ite (<= dim 1) 0 (let ((sidx (clamp_int32 idx))) (ite (< sidx 0) 0 (ite (>= sidx dim) (- dim 1) sidx)))))",
    "(define-fun sat_add_int ((a Int) (b Int)) Int (clamp_int32 (+ a b)))",
    "(define-fun sat_sub_int ((a Int) (b Int)) Int (clamp_int32 (- a b)))",
    "(define-fun sat_mul_int ((a Int) (b Int)) Int (clamp_int32 (* a b)))",
    "(define-fun sat_neg_int ((a Int)) Int (clamp_int32 (- a)))",
    "(define-fun max_real ((a Real) (b Real)) Real (ite (< a b) b a))",
    "(define-fun min_real ((a Real) (b Real)) Real (ite (< a b) a b))",
    "(define-fun clamp_real ((x Real) (lo Real) (hi Real)) Real (min_real (max_real x lo) hi))",
    "(define-fun trunc_div_int ((a Int) (b Int)) Int (ite (= b 0) 0 (let ((q (div (abs_int a) (abs_int b)))) (ite (= (< a 0) (< b 0)) q (- q)))))",
    "(define-fun total_div_int ((a Int) (b Int)) Int (ite (= b 0) 0 (trunc_div_int a b)))",
    "(define-fun total_mod_int ((a Int) (b Int)) Int (ite (= b 0) 0 (- a (* b (trunc_div_int a b)))))",
    "(define-fun total_div_real ((a Real) (b Real)) Real (ite (= b 0.0) 0.0 (/ a b)))",
    "(define-fun trunc_real ((x Real)) Int (ite (>= x 0.0) (to_int x) (- (to_int (- x)))))",
    `(define-fun to_int_real ((x Real)) Int (clamp_int (trunc_real x) ${INT32_MIN} ${INT32_MAX}))`,
  ];
}

export function sanitizeSymbol(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

export function checkSat(lines: string[], options: Z3RunOptions = {}): Z3CheckResult {
  const result = runZ3(lines, ["(check-sat)"], options);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    output: result.output,
    status: classifyZ3Output(result.output),
  };
}

export function checkSatAndGetValues(lines: string[], symbols: string[], options: Z3RunOptions = {}): Z3ValuesResult {
  if (symbols.length === 0) {
    const result = checkSat(lines, options);
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      output: result.output,
      status: result.status,
      values: result.status === "sat" ? new Map() : null,
    };
  }

  const result = runZ3(lines, [
    "(check-sat)",
    `(get-value (${symbols.join(" ")}))`,
  ], options);
  if (!result.ok) {
    return result;
  }

  const status = classifyZ3Output(result.output);
  return {
    ok: true,
    output: result.output,
    status,
    values: status === "sat" ? parseGetValueOutput(result.output) : null,
  };
}

export function withHardTimeout(options: Z3RunOptions = {}, nowMs = Date.now()): Z3RunOptions {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const deadlineAtMs = options.deadlineAtMs === undefined
    ? nowMs + timeoutMs
    : Math.min(options.deadlineAtMs, nowMs + timeoutMs);
  return {
    ...options,
    timeoutMs,
    deadlineAtMs,
  };
}

export function parseGetValueOutput(output: string): Map<string, string> | null {
  const start = output.indexOf("((");
  if (start < 0) {
    return null;
  }
  const parsed = parseSExpr(output.slice(start));
  if (!parsed || !Array.isArray(parsed)) {
    return null;
  }

  const values = new Map<string, string>();
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      continue;
    }
    values.set(entry[0], renderSExpr(entry[1]!));
  }
  return values;
}

export function parseZ3Int(value: string): number | null {
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  const neg = /^\(-\s+(\d+)\)$/.exec(value);
  if (neg) {
    return -Number(neg[1]);
  }
  return null;
}

function runZ3(
  lines: string[],
  commands: string[],
  options: Z3RunOptions = {},
): { ok: true; output: string } | { ok: false; error: string; timedOut: boolean } {
  const budget = resolveRunBudget(options);
  if (budget.remainingTimeoutMs <= 0) {
    return {
      ok: false,
      error: `z3 timed out after ${budget.timeoutMs}ms`,
      timedOut: true,
    };
  }
  const inputLines = [`(set-option :timeout ${budget.remainingTimeoutMs})`, ...lines, ...commands];
  const result = spawnSync(Z3_PATH, ["-in"], {
    input: `${inputLines.join("\n")}\n`,
    encoding: "utf8",
    timeout: budget.remainingTimeoutMs + 250,
    killSignal: "SIGKILL" as const,
  });
  if (result.error) {
    const timedOut = isTimeoutError(result.error);
    return {
      ok: false,
      error: timedOut
        ? `z3 timed out after ${budget.timeoutMs}ms`
        : result.error.message,
      timedOut,
    };
  }
  return {
    ok: true,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
  };
}

function classifyZ3Output(output: string): Z3Status {
  if (output.startsWith("unsat")) {
    return "unsat";
  }
  if (output.startsWith("sat")) {
    return "sat";
  }
  if (output.startsWith("unknown")) {
    return "unknown";
  }
  return "other";
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return HARD_Z3_TIMEOUT_MS;
  }
  return Math.min(HARD_Z3_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)));
}

function resolveRunBudget(options: Z3RunOptions, nowMs = Date.now()): {
  timeoutMs: number;
  deadlineAtMs: number;
  remainingTimeoutMs: number;
} {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const deadlineAtMs = options.deadlineAtMs === undefined
    ? nowMs + timeoutMs
    : Math.min(options.deadlineAtMs, nowMs + timeoutMs);
  return {
    timeoutMs,
    deadlineAtMs,
    remainingTimeoutMs: Math.max(0, Math.floor(deadlineAtMs - nowMs)),
  };
}

function isTimeoutError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ETIMEDOUT";
}

function parseSExpr(source: string): SExpr | null {
  const tokens = tokenizeSExpr(source);
  let idx = 0;

  function parse(): SExpr | null {
    const token = tokens[idx];
    if (!token) {
      return null;
    }
    if (token === "(") {
      idx += 1;
      const items: SExpr[] = [];
      while (idx < tokens.length && tokens[idx] !== ")") {
        const item = parse();
        if (item === null) {
          return null;
        }
        items.push(item);
      }
      if (tokens[idx] !== ")") {
        return null;
      }
      idx += 1;
      return items;
    }
    if (token === ")") {
      return null;
    }
    idx += 1;
    return token;
  }

  return parse();
}

function tokenizeSExpr(source: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (const char of source) {
    if (char === "(" || char === ")") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      tokens.push(char);
      continue;
    }
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

const INFIX_OPS = new Set(["+", "-", "*", "/"]);

function renderSExpr(expr: SExpr): string {
  if (typeof expr === "string") {
    return expr;
  }
  if (expr.length === 2 && expr[0] === "-") {
    return `-${renderSExpr(expr[1]!)}`;
  }
  if (expr.length === 3 && typeof expr[0] === "string" && INFIX_OPS.has(expr[0])) {
    return `${renderSExpr(expr[1]!)} ${expr[0]} ${renderSExpr(expr[2]!)}`;
  }
  return `(${expr.map((item) => renderSExpr(item)).join(" ")})`;
}
