import type { Cmd, Expr, Program, Stmt, Type } from "@jplmm/ast";
import type { FrontendResult } from "@jplmm/frontend";
import { buildIR } from "@jplmm/ir";
import { analyzeRanges, type Interval } from "@jplmm/optimize";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

export type VariableRangeEntry = {
  name: string;
  start: number;
  end: number;
  type: Type;
  interval: Interval;
  kind: "parameter" | "binding" | "use";
};

export type VariableRangeInfo = {
  entries: VariableRangeEntry[];
};

export type VariableRangeAnnotation = {
  offset: number;
  label: string;
  tooltip: string;
};

export function analyzeVariableRanges(frontend: FrontendResult): VariableRangeInfo {
  const { rangeMap, cardinalityMap } = analyzeRanges(buildIR(frontend.program, frontend.typeMap));
  const entries: VariableRangeEntry[] = [];

  walkProgram(frontend.program, {
    onFunction(fn) {
      const parameterRanges = cardinalityMap.get(fn.name)?.parameterRanges ?? [];
      for (let i = 0; i < fn.params.length; i += 1) {
        const param = fn.params[i]!;
        const interval = parameterRanges[i];
        if (!interval || !isUsefulRange(param.type, interval)) {
          continue;
        }
        entries.push({
          name: param.name,
          start: param.start ?? 0,
          end: param.end ?? param.start ?? 0,
          type: param.type,
          interval,
          kind: "parameter",
        });
      }
    },
    onBinding(name, start, end, exprId) {
      const type = frontend.typeMap.get(exprId);
      const interval = rangeMap.get(exprId);
      if (!type || !interval || !isUsefulRange(type, interval)) {
        return;
      }
      entries.push({
        name,
        start,
        end,
        type,
        interval,
        kind: "binding",
      });
    },
    onVar(expr) {
      const type = frontend.typeMap.get(expr.id);
      const interval = rangeMap.get(expr.id);
      if (!type || !interval || !isUsefulRange(type, interval)) {
        return;
      }
      entries.push({
        name: expr.name,
        start: expr.start ?? 0,
        end: expr.end ?? expr.start ?? 0,
        type,
        interval,
        kind: "use",
      });
    },
  });

  return {
    entries: entries.sort((left, right) => right.start - left.start),
  };
}

export function findVariableRangeAtOffset(info: VariableRangeInfo, offset: number): VariableRangeEntry | null {
  return info.entries.find((entry) => offset >= entry.start && offset <= entry.end) ?? null;
}

export function renderVariableRangeHover(entry: VariableRangeEntry): string {
  return `**Known range**: \`${renderRange(entry.type, entry.interval)}\`\n\nOptimizer interval for this ${entry.kind}.`;
}

export function buildVariableRangeAnnotations(info: VariableRangeInfo): VariableRangeAnnotation[] {
  const seen = new Set<string>();
  const annotations: VariableRangeAnnotation[] = [];

  for (const entry of info.entries) {
    if (entry.kind === "use") {
      continue;
    }
    const label = `: ${renderRange(entry.type, entry.interval)}`;
    const key = `${entry.kind}:${entry.name}:${entry.start}:${entry.end}:${label}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    annotations.push({
      offset: entry.end,
      label,
      tooltip: `Optimizer-proved scalar interval for this ${entry.kind}.`,
    });
  }

  return annotations;
}

function renderRange(type: Type, interval: Interval): string {
  if (type.tag === "int") {
    return `int[${formatBound(interval.lo)}, ${formatBound(interval.hi)}]`;
  }
  return `float[${formatBound(interval.lo)}, ${formatBound(interval.hi)}]`;
}

function formatBound(value: number): string {
  if (value === Infinity) {
    return "inf";
  }
  if (value === -Infinity) {
    return "-inf";
  }
  if (Object.is(value, -0)) {
    return "0";
  }
  return Number.isInteger(value) ? String(value) : String(value);
}

function isUsefulRange(type: Type, interval: Interval): boolean {
  if (type.tag === "int") {
    return interval.lo !== INT32_MIN || interval.hi !== INT32_MAX;
  }
  if (type.tag === "float") {
    return Number.isFinite(interval.lo) || Number.isFinite(interval.hi);
  }
  return false;
}

type WalkHandlers = {
  onFunction(fn: Extract<Cmd, { tag: "fn_def" }>): void;
  onBinding(name: string, start: number, end: number, exprId: number): void;
  onVar(expr: Extract<Expr, { tag: "var" }>): void;
};

function walkProgram(program: Program, handlers: WalkHandlers): void {
  for (const cmd of program.commands) {
    walkCommand(cmd, handlers);
  }
}

function walkCommand(cmd: Cmd, handlers: WalkHandlers): void {
  if (cmd.tag === "time") {
    walkCommand(cmd.cmd, handlers);
    return;
  }

  switch (cmd.tag) {
    case "fn_def":
      handlers.onFunction(cmd);
      for (const stmt of cmd.body) {
        walkStmt(stmt, handlers);
      }
      return;
    case "let_cmd":
      if (cmd.lvalue.tag === "var") {
        handlers.onBinding(cmd.lvalue.name, cmd.lvalue.start ?? 0, cmd.lvalue.end ?? cmd.lvalue.start ?? 0, cmd.expr.id);
      }
      walkExpr(cmd.expr, handlers);
      return;
    case "write_image":
    case "show":
      walkExpr(cmd.expr, handlers);
      return;
    case "struct_def":
    case "read_image":
    case "print":
      return;
    default: {
      const _never: never = cmd;
      void _never;
    }
  }
}

function walkStmt(stmt: Stmt, handlers: WalkHandlers): void {
  switch (stmt.tag) {
    case "let": {
      if (stmt.lvalue.tag === "var") {
        handlers.onBinding(stmt.lvalue.name, stmt.lvalue.start ?? 0, stmt.lvalue.end ?? stmt.lvalue.start ?? 0, stmt.expr.id);
      }
      walkExpr(stmt.expr, handlers);
      return;
    }
    case "ret":
    case "rad":
      walkExpr(stmt.expr, handlers);
      return;
    case "gas":
      return;
    default: {
      const _never: never = stmt;
      void _never;
    }
  }
}

function walkExpr(expr: Expr, handlers: WalkHandlers): void {
  switch (expr.tag) {
    case "var":
      handlers.onVar(expr);
      return;
    case "binop":
      walkExpr(expr.left, handlers);
      walkExpr(expr.right, handlers);
      return;
    case "unop":
      walkExpr(expr.operand, handlers);
      return;
    case "call":
      for (const arg of expr.args) {
        walkExpr(arg, handlers);
      }
      return;
    case "index":
      walkExpr(expr.array, handlers);
      for (const index of expr.indices) {
        walkExpr(index, handlers);
      }
      return;
    case "field":
      walkExpr(expr.target, handlers);
      return;
    case "struct_cons":
      for (const field of expr.fields) {
        walkExpr(field, handlers);
      }
      return;
    case "array_cons":
      for (const element of expr.elements) {
        walkExpr(element, handlers);
      }
      return;
    case "array_expr":
    case "sum_expr":
      for (const binding of expr.bindings) {
        walkExpr(binding.expr, handlers);
      }
      walkExpr(expr.body, handlers);
      return;
    case "rec":
      for (const arg of expr.args) {
        walkExpr(arg, handlers);
      }
      return;
    case "int_lit":
    case "float_lit":
    case "void_lit":
    case "res":
      return;
    default: {
      const _never: never = expr;
      void _never;
    }
  }
}
