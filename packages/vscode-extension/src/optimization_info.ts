import type { Cmd } from "@jplmm/ast";
import type { FrontendResult } from "@jplmm/frontend";
import { buildIR } from "@jplmm/ir";
import { optimizeProgram, type FunctionImplementation, type OptimizePassReport, type ResearchCandidate } from "@jplmm/optimize";

export type FunctionOptimizationDetail = {
  passName: OptimizePassReport["name"];
  detail: string;
  experimental: boolean;
};

export type FunctionOptimizationInfo = {
  name: string;
  implementation: FunctionImplementation | null;
  details: FunctionOptimizationDetail[];
  researchCandidates: ResearchCandidate[];
};

export type DefinitionPolicyWarning = {
  fnName: string;
  start: number;
  end: number;
  message: string;
};

const FUNCTION_DETAIL_PASSES = new Set<OptimizePassReport["name"]>([
  "closed_form",
  "lut_tabulation",
  "aitken",
  "linear_speculation",
]);

export function analyzeFunctionOptimizations(frontend: FrontendResult): Map<string, FunctionOptimizationInfo> {
  const fnNames = collectFunctionNames(frontend.program);
  const info = new Map<string, FunctionOptimizationInfo>();

  for (const fnName of fnNames) {
    info.set(fnName, {
      name: fnName,
      implementation: null,
      details: [],
      researchCandidates: [],
    });
  }

  if (fnNames.size === 0) {
    return info;
  }

  const optimized = optimizeProgram(buildIR(frontend.program, frontend.typeMap), {
    enableResearchPasses: true,
  });

  for (const [fnName, implementation] of optimized.artifacts.implementations.entries()) {
    const current = info.get(fnName);
    if (current) {
      current.implementation = implementation;
    }
  }

  for (const [fnName, candidates] of optimized.artifacts.researchCandidates.entries()) {
    const current = info.get(fnName);
    if (current) {
      current.researchCandidates = candidates;
    }
  }

  for (const report of optimized.reports) {
    if (!FUNCTION_DETAIL_PASSES.has(report.name)) {
      continue;
    }
    for (const detail of report.details) {
      const fnName = parseLeadingFunctionName(detail, fnNames);
      if (!fnName) {
        continue;
      }
      info.get(fnName)?.details.push({
        passName: report.name,
        detail,
        experimental: report.experimental === true,
      });
    }
  }

  return info;
}

export function renderFunctionOptimizationHover(info: FunctionOptimizationInfo): string {
  const lines: string[] = ["**Optimization Outlook**"];

  if (info.implementation) {
    lines.push(`- selected lowering: \`${describeImplementation(info.implementation)}\``);
  } else {
    lines.push("- selected lowering: none yet");
  }

  if (info.details.length > 0) {
    lines.push("- matched passes:");
    for (const detail of info.details) {
      const prefix = detail.experimental ? "[experimental] " : "";
      lines.push(`  - \`${prefix}${detail.passName}\`: ${detail.detail}`);
    }
  }

  const appliedCandidates = info.researchCandidates.filter((candidate) => candidate.applied);
  const blockedCandidates = info.researchCandidates.filter((candidate) => candidate.blockedByDefinition);

  if (appliedCandidates.length > 0) {
    lines.push("");
    lines.push(renderResearchHighlight(appliedCandidates));
    for (const candidate of appliedCandidates) {
      lines.push(`- ${describeResearchCandidate(candidate)}`);
    }
  }

  if (blockedCandidates.length > 0) {
    lines.push("");
    lines.push(renderBlockedResearchHighlight(blockedCandidates));
    for (const candidate of blockedCandidates) {
      lines.push(`- ${describeResearchCandidate(candidate)} (blocked by \`def\`)`);
    }
  }

  return lines.join("\n");
}

export function collectDefinitionPolicyWarnings(
  frontend: FrontendResult,
  info: Map<string, FunctionOptimizationInfo>,
): DefinitionPolicyWarning[] {
  const warnings: DefinitionPolicyWarning[] = [];

  for (const cmd of frontend.program.commands) {
    const fn = unwrapTimedFnDef(cmd);
    if (!fn || fn.keyword !== "def") {
      continue;
    }
    const blocked = info.get(fn.name)?.researchCandidates.filter((candidate) => candidate.blockedByDefinition) ?? [];
    if (blocked.length === 0) {
      continue;
    }
    const passes = [...new Set(blocked.map((candidate) => describeResearchPass(candidate.pass)))];
    warnings.push({
      fnName: fn.name,
      start: fn.start ?? 0,
      end: (fn.start ?? 0) + fn.keyword.length,
      message: `Function '${fn.name}' is declared with 'def', so ${passes.join(" and ")} stays disabled here; use 'fun' to allow research-grade lowering.`,
    });
  }

  return warnings;
}

function renderResearchHighlight(candidates: ResearchCandidate[]): string {
  const title = candidates.length === 1
    ? `Research optimization active: ${describeResearchPass(candidates[0]!.pass)}`
    : "Research optimizations active";
  return `$(beaker) <span style="color: var(--vscode-testing-iconPassed);"><b>${title}</b></span>`;
}

function renderBlockedResearchHighlight(candidates: ResearchCandidate[]): string {
  const title = candidates.length === 1
    ? `Research optimization blocked by def: ${describeResearchPass(candidates[0]!.pass)}`
    : "Research optimizations blocked by def";
  return `$(warning) <span style="color: var(--vscode-editorWarning-foreground);"><b>${title}</b></span>`;
}

function describeImplementation(implementation: FunctionImplementation): string {
  switch (implementation.tag) {
    case "closed_form_linear_countdown":
      return "closed-form countdown";
    case "lut":
      return "LUT fast path";
    case "aitken_scalar_tail":
      return "generalized Aitken acceleration";
    case "linear_speculation":
      return "linear speculation";
    default: {
      const _never: never = implementation;
      return _never;
    }
  }
}

function describeResearchCandidate(candidate: ResearchCandidate): string {
  return `${describeResearchPass(candidate.pass)}: ${candidate.reason}`;
}

function describeResearchPass(pass: ResearchCandidate["pass"]): string {
  return pass === "aitken" ? "generalized Aitken acceleration" : "linear speculation";
}

function collectFunctionNames(program: FrontendResult["program"]): Set<string> {
  const names = new Set<string>();
  for (const cmd of program.commands) {
    const fn = unwrapTimedFnDef(cmd);
    if (fn) {
      names.add(fn.name);
    }
  }
  return names;
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

function parseLeadingFunctionName(detail: string, fnNames: Set<string>): string | null {
  const separator = detail.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  const fnName = detail.slice(0, separator).trim();
  return fnNames.has(fnName) ? fnName : null;
}
