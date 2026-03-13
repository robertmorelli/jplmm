import type { Cmd, FunctionKeyword, Program, Type } from "@jplmm/ast";
import {
  buildCanonicalProgram,
  checkFunctionRefinement,
  computeFunctionSummary,
  type IntFunctionSummary,
  renderIrFunction,
  type RefinementCheck,
  type RefinementMethod,
} from "@jplmm/proof";

import { error, type Diagnostic } from "./errors";

export type RefinementStatus = "equivalent" | "mismatch" | "unproven" | "invalid";
export type CanonicalFunctionSemantics = ReturnType<typeof buildCanonicalProgram>["functions"][number];

export type RefinementReport = {
  fnName: string;
  baselineKeyword: Exclude<FunctionKeyword, "ref"> | null;
  status: RefinementStatus;
  method?: RefinementMethod;
  detail: string;
  equivalence?: string;
  baselineSemantics: string[];
  refSemantics: string[];
  baselineSemanticsData?: CanonicalFunctionSemantics;
  refSemanticsData?: CanonicalFunctionSemantics;
  baselineStart?: number;
  baselineEnd?: number;
  refStart?: number;
  refEnd?: number;
};

export type RefineResult = {
  program: Program;
  diagnostics: Diagnostic[];
  refinements: RefinementReport[];
};

type EffectiveFunction = {
  cmd: Cmd;
  fn: Extract<Cmd, { tag: "fn_def" }>;
  outputIndex: number;
  policyKeyword: Exclude<FunctionKeyword, "ref">;
};

export function refineProgram(program: Program, typeMap: Map<number, Type>): RefineResult {
  const diagnostics: Diagnostic[] = [];
  const refinements: RefinementReport[] = [];
  const output: Array<Cmd | null> = [];
  const effective = new Map<string, EffectiveFunction>();
  const summaries = new Map<string, IntFunctionSummary>();

  for (const cmd of program.commands) {
    const fn = unwrapTimedFnDef(cmd);
    if (!fn) {
      output.push(cmd);
      continue;
    }

    if (fn.keyword !== "ref") {
      output.push(cmd);
      effective.set(fn.name, {
        cmd,
        fn,
        outputIndex: output.length - 1,
        policyKeyword: fn.keyword,
      });
      refreshSummary(fn.name, output, typeMap, summaries);
      continue;
    }

    const current = effective.get(fn.name);
    if (!current) {
      const message = `ref '${fn.name}' requires an earlier fun/def/fn definition`;
      diagnostics.push(diagnosticForFn(fn, message, "REF_NO_BASE"));
      refinements.push({
        fnName: fn.name,
        baselineKeyword: null,
        status: "invalid",
        detail: message,
        ...captureRenderedAndStructuredSemantics(fn.name, [], [...materializeCommands(output), cmd], typeMap),
        ...optionalSpan("ref", fn.start, fn.end),
      });
      continue;
    }

    const baselineCommands = materializeCommands(output);
    const refinedCmd = rewriteFunctionKeyword(cmd, current.policyKeyword);
    const refinedCommands = materializeCommands(output, new Map([[current.outputIndex, refinedCmd]]));
    const semantics = captureRefinementSemantics(fn.name, baselineCommands, refinedCommands, typeMap);

    const signatureProblem = compareRefinementSignature(current.fn, fn);
    if (signatureProblem) {
      diagnostics.push(diagnosticForFn(fn, signatureProblem, "REF_SIGNATURE"));
      refinements.push({
        fnName: fn.name,
        baselineKeyword: current.policyKeyword,
        status: "invalid",
        detail: signatureProblem,
        ...semantics,
        ...optionalSpan("baseline", current.fn.start, current.fn.end),
        ...optionalSpan("ref", fn.start, fn.end),
      });
      continue;
    }

    const check = checkFunctionRefinement(
      fn.name,
      baselineCommands,
      refinedCommands,
      typeMap,
      summaries,
    );

    if (!check.ok) {
      diagnostics.push(diagnosticForFn(fn, check.message, check.code));
      refinements.push(reportFailedRefinement(current, fn, check, semantics));
      continue;
    }

    output[current.outputIndex] = null;
    output.push(refinedCmd);
    const rewrittenFn = unwrapTimedFnDef(refinedCmd);
    if (!rewrittenFn) {
      continue;
    }
    effective.set(fn.name, {
      cmd: refinedCmd,
      fn: rewrittenFn,
      outputIndex: output.length - 1,
      policyKeyword: current.policyKeyword,
    });
    refreshSummary(fn.name, output, typeMap, summaries);
    refinements.push({
      fnName: fn.name,
      baselineKeyword: current.policyKeyword,
      status: "equivalent",
      method: check.method,
      detail: check.detail,
      ...(check.equivalence ? { equivalence: check.equivalence } : {}),
      ...semantics,
      ...optionalSpan("baseline", current.fn.start, current.fn.end),
      ...optionalSpan("ref", fn.start, fn.end),
    });
  }

  return {
    program: { commands: materializeCommands(output) },
    diagnostics,
    refinements,
  };
}

function reportFailedRefinement(
  current: EffectiveFunction,
  fn: Extract<Cmd, { tag: "fn_def" }>,
  check: Extract<RefinementCheck, { ok: false }>,
  semantics: RefinementSemanticsCapture,
): RefinementReport {
  return {
    fnName: fn.name,
    baselineKeyword: current.policyKeyword,
    status: check.code === "REF_MISMATCH" ? "mismatch" : "unproven",
    detail: check.message,
    ...semantics,
    ...optionalSpan("baseline", current.fn.start, current.fn.end),
    ...optionalSpan("ref", fn.start, fn.end),
  };
}

type RefinementSemanticsCapture = {
  baselineSemantics: string[];
  refSemantics: string[];
  baselineSemanticsData?: CanonicalFunctionSemantics;
  refSemanticsData?: CanonicalFunctionSemantics;
};

function captureRefinementSemantics(
  fnName: string,
  baselineCommands: Cmd[],
  refinedCommands: Cmd[],
  typeMap: Map<number, Type>,
): RefinementSemanticsCapture {
  return captureRenderedAndStructuredSemantics(fnName, baselineCommands, refinedCommands, typeMap);
}

function captureRenderedAndStructuredSemantics(
  fnName: string,
  baselineCommands: Cmd[],
  refinedCommands: Cmd[],
  typeMap: Map<number, Type>,
): RefinementSemanticsCapture {
  const baseline = captureCanonicalFunctionSemantics(fnName, baselineCommands, typeMap);
  const refined = captureCanonicalFunctionSemantics(fnName, refinedCommands, typeMap);
  return {
    baselineSemantics: baseline ? renderIrFunction(baseline) : [],
    refSemantics: refined ? renderIrFunction(refined) : [],
    ...(baseline ? { baselineSemanticsData: baseline } : {}),
    ...(refined ? { refSemanticsData: refined } : {}),
  };
}

function captureCanonicalFunctionSemantics(
  fnName: string,
  commands: Cmd[],
  typeMap: Map<number, Type>,
): CanonicalFunctionSemantics | null {
  try {
    const canonical = buildCanonicalProgram({ commands }, typeMap);
    return canonical.functions.find((candidate) => candidate.name === fnName) ?? null;
  } catch {
    return null;
  }
}

function optionalSpan(
  prefix: "baseline" | "ref",
  start: number | undefined,
  end: number | undefined,
): Partial<RefinementReport> {
  return {
    ...(start !== undefined ? { [`${prefix}Start`]: start } : {}),
    ...(end !== undefined ? { [`${prefix}End`]: end } : {}),
  } as Partial<RefinementReport>;
}

function refreshSummary(
  fnName: string,
  output: Array<Cmd | null>,
  typeMap: Map<number, Type>,
  summaries: Map<string, IntFunctionSummary>,
): void {
  const summary = computeFunctionSummary(fnName, materializeCommands(output), typeMap, summaries);
  if (summary) {
    summaries.set(fnName, summary);
    return;
  }
  summaries.delete(fnName);
}

function compareRefinementSignature(
  baseline: Extract<Cmd, { tag: "fn_def" }>,
  candidate: Extract<Cmd, { tag: "fn_def" }>,
): string | null {
  if (baseline.params.length !== candidate.params.length) {
    return `ref '${candidate.name}' must keep the same arity as '${baseline.name}'`;
  }
  for (let i = 0; i < baseline.params.length; i += 1) {
    if (!sameType(baseline.params[i]!.type, candidate.params[i]!.type)) {
      return `ref '${candidate.name}' parameter ${i + 1} must keep type ${typeToString(baseline.params[i]!.type)}`;
    }
  }
  if (!sameType(baseline.retType, candidate.retType)) {
    return `ref '${candidate.name}' must keep return type ${typeToString(baseline.retType)}`;
  }
  return null;
}

function unwrapTimedFnDef(cmd: Cmd): Extract<Cmd, { tag: "fn_def" }> | null {
  if (cmd.tag === "fn_def") {
    return cmd;
  }
  if (cmd.tag === "time" && cmd.cmd.tag === "fn_def") {
    return cmd.cmd;
  }
  return null;
}

function rewriteFunctionKeyword(
  cmd: Cmd,
  keyword: Exclude<FunctionKeyword, "ref">,
): Cmd {
  if (cmd.tag === "fn_def") {
    return { ...cmd, keyword };
  }
  if (cmd.tag === "time" && cmd.cmd.tag === "fn_def") {
    return { ...cmd, cmd: { ...cmd.cmd, keyword } };
  }
  return cmd;
}

function materializeCommands(
  output: Array<Cmd | null>,
  replacements: Map<number, Cmd | null> = new Map(),
): Cmd[] {
  const commands: Cmd[] = [];
  for (let i = 0; i < output.length; i += 1) {
    const next = replacements.has(i) ? replacements.get(i)! : output[i];
    if (next) {
      commands.push(next);
    }
  }
  return commands;
}

function diagnosticForFn(
  fn: Extract<Cmd, { tag: "fn_def" }>,
  message: string,
  code: string,
): Diagnostic {
  return error(message, fn.start ?? 0, fn.end ?? fn.start ?? 0, code);
}

function sameType(left: Type, right: Type): boolean {
  if (left.tag !== right.tag) {
    return false;
  }
  switch (left.tag) {
    case "int":
    case "float":
    case "void":
      return true;
    case "named":
      return left.name === (right as typeof left).name;
    case "array":
      return left.dims === (right as typeof left).dims && sameType(left.element, (right as typeof left).element);
    default: {
      const _never: never = left;
      return _never;
    }
  }
}

function typeToString(type: Type): string {
  switch (type.tag) {
    case "int":
    case "float":
    case "void":
      return type.tag;
    case "named":
      return type.name;
    case "array":
      return `${typeToString(type.element)}${"[]".repeat(type.dims)}`;
    default: {
      const _never: never = type;
      return _never;
    }
  }
}
