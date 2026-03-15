import type { FrontendResult } from "@jplmm/frontend";
import { emitValueSexpr, type IrStmtSemantics } from "@jplmm/proof";
import type { VerificationOutput } from "@jplmm/verify";

export function renderFunctionSemanticHover(
  frontend: FrontendResult,
  verification: VerificationOutput | null,
  fnName: string,
  hoveredOffset?: number,
): string | null {
  const siteSpecific = hoveredOffset === undefined ? null : findSemanticHoverSite(frontend, fnName, hoveredOffset);
  const lines: string[] = [];

  if (siteSpecific && siteSpecific.semantics.length > 0) {
    lines.push(
      `**${siteSpecific.title}**`,
      siteSpecific.description,
      "",
      "```lisp",
      ...siteSpecific.semantics,
      "```",
    );
  }

  const traceSection = renderAcceptedFunctionSemantics(frontend, verification, fnName);
  if (traceSection) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(traceSection);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function renderStatementSemanticLine(index: number, semantics: IrStmtSemantics): string | null {
  const sexpr = emitStatementSemanticsSexpr(semantics);
  if (!sexpr) {
    return null;
  }
  return `; stmt ${index + 1} ${semantics.stmtTag} :: ${semantics.rendered}\n${sexpr}`;
}

function emitStatementSemanticsSexpr(semantics: IrStmtSemantics): string | null {
  if (semantics.value) {
    return emitValueSexpr(semantics.value);
  }
  if (semantics.stmtTag === "gas") {
    return `(gas ${semantics.rendered})`;
  }
  return null;
}

function renderAcceptedFunctionSemantics(
  frontend: FrontendResult,
  verification: VerificationOutput | null,
  fnName: string,
): string | null {
  if (!verification) {
    return null;
  }
  const trace = verification.traceMap.get(fnName);
  if (!trace) {
    return null;
  }

  const stmtLines = trace.stmtSemantics
    .map((semantics, index) => renderStatementSemanticLine(index, semantics))
    .filter((line): line is string => line !== null);
  const resultLine = trace.result ? emitValueSexpr(trace.result) : null;

  if (stmtLines.length === 0 && !resultLine) {
    return null;
  }

  const lines = [
    "**Executable Semantics**",
    "Shared proof semantics for the currently accepted function after canonical lowering.",
  ];

  if (stmtLines.length > 0) {
    lines.push(
      "",
      "```lisp",
      ...stmtLines,
      "```",
    );
  }

  if (resultLine) {
    lines.push(
      "",
      `Result: \`${resultLine}\``,
    );
  }

  const refinement = latestRefinementFor(frontend, fnName);
  if (refinement?.baselineSemanticsData && refinement.refSemanticsData) {
    lines.push(
      "",
      "Refinement semantics captured for this function are available in the semantics debug view.",
    );
  }

  return lines.join("\n");
}

type SemanticHoverSite = {
  title: string;
  description: string;
  semantics: string[];
};

function findSemanticHoverSite(frontend: FrontendResult, fnName: string, hoveredOffset: number): SemanticHoverSite | null {
  const matches = frontend.refinements.filter((refinement) => refinement.fnName === fnName);
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const refinement = matches[i]!;
    if (containsOffset(refinement.refStart, refinement.refEnd, hoveredOffset) && refinement.refSemantics.length > 0) {
      return {
        title: "Definition Semantics",
        description: "Canonical semantics captured for this refinement step.",
        semantics: refinement.refSemantics,
      };
    }
    if (containsOffset(refinement.baselineStart, refinement.baselineEnd, hoveredOffset) && refinement.baselineSemantics.length > 0) {
      return {
        title: "Definition Semantics",
        description: "Canonical semantics captured for this baseline definition before refinement.",
        semantics: refinement.baselineSemantics,
      };
    }
  }
  return null;
}

function containsOffset(start: number | undefined, end: number | undefined, offset: number): boolean {
  if (start === undefined) {
    return false;
  }
  return offset >= start && offset <= (end ?? start);
}

function latestRefinementFor(
  frontend: FrontendResult,
  fnName: string,
): FrontendResult["refinements"][number] | null {
  const matches = frontend.refinements.filter((refinement) => refinement.fnName === fnName);
  return matches.length > 0 ? matches[matches.length - 1]! : null;
}
