import { dirname } from "node:path";

import { BUILTIN_FUNCTIONS } from "@jplmm/ast";
import { runOnSource, type CliMode } from "@jplmm/cli";
import { runFrontend, type Diagnostic as FrontendDiagnostic } from "@jplmm/frontend";
import type { DisableablePassName } from "@jplmm/optimize";
import {
  analyzeProgramMetrics,
  type FunctionMetrics,
  verifyProgram,
  type VerificationDiagnostic,
  type VerificationOutput,
} from "@jplmm/verify";
import * as vscode from "vscode";

import {
  buildOutResultAnnotations,
  canAnnotateInlineOutResults,
  collectFunctionRefinementAnnotations,
  collectSourceFunctionMetricAnnotations,
  findVerificationDiagnosticAnchor,
} from "./annotations.js";
import { buildDocumentIndex, findDefinition, getCompletions, type CompletionEntry } from "./analysis.js";
import {
  analyzeFunctionOptimizations,
  collectDefinitionPolicyWarnings,
  renderFunctionOptimizationHover,
  type FunctionOptimizationInfo,
} from "./optimization_info.js";
import {
  analyzeVariableRanges,
  buildVariableRangeAnnotations,
  findVariableRangeAtOffset,
  renderVariableRangeHover,
  type VariableRangeInfo,
} from "./range_info.js";
import { renderFunctionSemanticHover } from "./semantic_info.js";

const LANGUAGE_ID = "jplmm";
const JPLMM_EXTENSIONS = [".jplmm"];
const JPLMM_SELECTORS: vscode.DocumentSelector = [
  { language: LANGUAGE_ID },
  ...JPLMM_EXTENSIONS.map((ext) => ({ pattern: `**/*${ext}` })),
];
const OUTPUT_NAME = "JPLMM";
const DISABLEABLE_PASSES = new Set<DisableablePassName>([
  "guard_elimination",
  "closed_form",
  "lut_tabulation",
  "aitken",
  "linear_speculation",
]);
const HARD_PROOF_TIMEOUT_MS = 2000;
const DEFAULT_EDITOR_PROOF_TIMEOUT_MS = 200;
const DEFAULT_RUN_PROOF_TIMEOUT_MS = HARD_PROOF_TIMEOUT_MS;
const KEYWORD_INFO = new Map<string, string>([
  ["fun", "Function definition"],
  ["fn", "Legacy alias for fun"],
  ["def", "Function definition that blocks research-grade optimizations for this function"],
  ["ref", "Refinement candidate that must be proven equivalent to the current definition of the same function name"],
  ["let", "Variable binding"],
  ["ret", "Return expression"],
  ["res", "Previous return value inside recursive functions"],
  ["rec", "Recursive step"],
  ["rad", "Ranking-function proof annotation"],
  ["gas", "Bounded recursion fuel annotation"],
  ["inf", "Infinite gas bound"],
  ["array", "Array comprehension"],
  ["sum", "Summation comprehension"],
  ["struct", "Struct definition"],
  ["read", "Read an image from disk"],
  ["write", "Write an image to disk"],
  ["image", "Image I/O keyword"],
  ["to", "Image binding separator"],
  ["print", "Print a string literal"],
  ["out", "Show a computed value"],
  ["show", "Legacy alias for out"],
  ["time", "Measure command execution time"],
  ["throwserror", "Impossible function-throw annotation (always a compile-time error)"],
  ["int", "Primitive integer type"],
  ["float", "Primitive float type"],
  ["void", "Primitive void type"],
]);

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_NAME);
  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
  const activatedAt = new Date().toISOString();
  const indexCache = new Map<string, { version: number; index: ReturnType<typeof buildDocumentIndex> }>();
  const frontendCache = new Map<string, { version: number; frontend: ReturnType<typeof runFrontend> }>();
  const verificationCache = new Map<string, { version: number; verification: VerificationOutput | null }>();
  const inlineResultCache = new Map<string, { version: number; report: ReturnType<typeof runOnSource> | null }>();
  const optimizationCache = new Map<string, { version: number; info: Map<string, FunctionOptimizationInfo> }>();
  const variableRangeCache = new Map<string, { version: number; info: VariableRangeInfo }>();
  const metricsCache = new Map<string, { version: number; metrics: Map<string, FunctionMetrics> }>();
  const pendingRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
  const codeLensChanges = new vscode.EventEmitter<void>();
  const inlayHintChanges = new vscode.EventEmitter<void>();
  const trace = (message: string) => {
    if (!vscode.workspace.getConfiguration("jplmm").get<boolean>("debug.traceExtension", false)) {
      return;
    }
    output.appendLine(`[ext ${new Date().toISOString()}] ${message}`);
  };

  output.appendLine(`[ext ${activatedAt}] activated`);
  trace(`startup documents=${vscode.workspace.textDocuments.length}`);

  const clearCachesForDocument = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    const pending = pendingRefreshes.get(key);
    if (pending) {
      clearTimeout(pending);
      pendingRefreshes.delete(key);
    }
    indexCache.delete(key);
    frontendCache.delete(key);
    verificationCache.delete(key);
    inlineResultCache.delete(key);
    optimizationCache.delete(key);
    variableRangeCache.delete(key);
    metricsCache.delete(key);
  };

  const getIndex = (document: vscode.TextDocument) => {
    const cached = indexCache.get(document.uri.toString());
    if (cached && cached.version === document.version) {
      return cached.index;
    }
    const index = buildDocumentIndex(document.getText());
    indexCache.set(document.uri.toString(), { version: document.version, index });
    return index;
  };

  const getFrontend = (document: vscode.TextDocument) => {
    const cached = frontendCache.get(document.uri.toString());
    if (cached && cached.version === document.version) {
      return cached.frontend;
    }
    const editorProofTimeoutMs = readEditorProofTimeoutMs();
    const frontend = runFrontend(
      document.getText(),
      editorProofTimeoutMs !== undefined ? { proofTimeoutMs: editorProofTimeoutMs } : {},
    );
    trace(`frontend uri=${document.uri.toString()} diagnostics=${frontend.diagnostics.length}`);
    frontendCache.set(document.uri.toString(), { version: document.version, frontend });
    return frontend;
  };

  const getInlineResultReport = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    const cached = inlineResultCache.get(key);
    if (cached && cached.version === document.version) {
      return cached.report;
    }

    const frontend = getFrontend(document);
    if (frontend.diagnostics.some((diagnostic) => diagnostic.severity === "error") || !canAnnotateInlineOutResults(frontend.program)) {
      inlineResultCache.set(key, { version: document.version, report: null });
      return null;
    }

    const config = vscode.workspace.getConfiguration("jplmm");
    const inlineProofTimeoutMs = readEditorProofTimeoutMs(config);
    const report = runOnSource(document.getText(), "run", {
      cwd: resolveDocumentDirectory(document) ?? process.cwd(),
      experimental: config.get<boolean>("run.experimental", true),
      safe: config.get<boolean>("run.safe", false),
      disablePasses: readDisablePassesConfig(config),
      verifyBeforeRun: config.get<boolean>("run.verifyBeforeRun", true),
      ...(inlineProofTimeoutMs !== undefined ? { proofTimeoutMs: inlineProofTimeoutMs } : {}),
    });
    inlineResultCache.set(key, { version: document.version, report });
    return report;
  };

  const getVerification = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    const cached = verificationCache.get(key);
    if (cached && cached.version === document.version) {
      return cached.verification;
    }

    const frontend = getFrontend(document);
    if (frontend.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      verificationCache.set(key, { version: document.version, verification: null });
      return null;
    }

    const verifyProofTimeoutMs = readEditorProofTimeoutMs();
    const verification = verifyProgram(
      frontend.program,
      frontend.typeMap,
      verifyProofTimeoutMs !== undefined ? { proofTimeoutMs: verifyProofTimeoutMs } : {},
    );
    trace(`verify uri=${document.uri.toString()} diagnostics=${verification.diagnostics.length}`);
    verificationCache.set(key, { version: document.version, verification });
    return verification;
  };

  const getOptimizationInfo = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    const cached = optimizationCache.get(key);
    if (cached && cached.version === document.version) {
      return cached.info;
    }

    const frontend = getFrontend(document);
    if (frontend.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      const empty = new Map<string, FunctionOptimizationInfo>();
      optimizationCache.set(key, { version: document.version, info: empty });
      return empty;
    }

    const info = analyzeFunctionOptimizations(frontend);
    optimizationCache.set(key, { version: document.version, info });
    return info;
  };

  const getVariableRangeInfo = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    const cached = variableRangeCache.get(key);
    if (cached && cached.version === document.version) {
      return cached.info;
    }

    const frontend = getFrontend(document);
    if (frontend.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      const empty: VariableRangeInfo = { entries: [] };
      variableRangeCache.set(key, { version: document.version, info: empty });
      return empty;
    }

    const info = analyzeVariableRanges(frontend);
    variableRangeCache.set(key, { version: document.version, info });
    return info;
  };

  const getMetrics = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    const cached = metricsCache.get(key);
    if (cached && cached.version === document.version) {
      return cached.metrics;
    }

    const frontend = getFrontend(document);
    const metrics = analyzeProgramMetrics(frontend.program);
    metricsCache.set(key, { version: document.version, metrics });
    return metrics;
  };

  const refreshDiagnostics = (document: vscode.TextDocument) => {
    trace(`refreshDiagnostics uri=${document.uri.toString()} languageId=${document.languageId} isJplmm=${isJplmmDocument(document)}`);
    if (!isJplmmDocument(document)) {
      return;
    }
    const frontend = getFrontend(document);
    const out = frontend.diagnostics.map((diagnostic) => toVsCodeDiagnostic(document, diagnostic));
    if (!frontend.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      const verify = getVerification(document);
      out.push(
        ...(verify?.diagnostics ?? []).map((diagnostic) => toVsCodeVerificationDiagnostic(document, frontend.program, diagnostic)),
      );
      const optimizationInfo = getOptimizationInfo(document);
      out.push(
        ...collectDefinitionPolicyWarnings(frontend, optimizationInfo).map((warning) =>
          toVsCodeWarningDiagnostic(document, warning.start, warning.end, warning.message, "DEF_RESEARCH_BLOCKED")),
      );
    }
    diagnostics.set(document.uri, out);
    trace(`diagnostics uri=${document.uri.toString()} total=${out.length} frontend=${frontend.diagnostics.length}`);
  };

  const scheduleRefreshDiagnostics = (
    document: vscode.TextDocument,
    reason: string,
    delayMs = 0,
  ) => {
    const key = document.uri.toString();
    const pending = pendingRefreshes.get(key);
    if (pending) {
      clearTimeout(pending);
    }
    trace(`scheduleRefresh uri=${key} reason=${reason} delayMs=${delayMs}`);
    const handle = setTimeout(() => {
      pendingRefreshes.delete(key);
      try {
        refreshDiagnostics(document);
      } catch (error) {
        output.appendLine(`[ext ${new Date().toISOString()}] refresh failed for ${key}: ${String(error)}`);
        if (error instanceof Error && error.stack) {
          output.appendLine(error.stack);
        }
      }
    }, delayMs);
    pendingRefreshes.set(key, handle);
  };

  for (const document of vscode.workspace.textDocuments) {
    scheduleRefreshDiagnostics(document, "activate", 0);
  }

  context.subscriptions.push(
    output,
    diagnostics,
    codeLensChanges,
    inlayHintChanges,
    {
      dispose() {
        for (const handle of pendingRefreshes.values()) {
          clearTimeout(handle);
        }
        pendingRefreshes.clear();
      },
    },
    vscode.workspace.onDidOpenTextDocument((document) => {
      scheduleRefreshDiagnostics(document, "open", 0);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
      clearCachesForDocument(document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      clearCachesForDocument(event.document);
      scheduleRefreshDiagnostics(event.document, "change", 25);
      codeLensChanges.fire();
      inlayHintChanges.fire();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("jplmm")) {
        return;
      }
      for (const document of vscode.workspace.textDocuments) {
        clearCachesForDocument(document);
        scheduleRefreshDiagnostics(document, "config", 0);
      }
      codeLensChanges.fire();
      inlayHintChanges.fire();
    }),
    vscode.languages.registerDefinitionProvider(
      JPLMM_SELECTORS,
      {
        provideDefinition(document, position) {
          const index = getIndex(document);
          const offset = document.offsetAt(position);
          const definition = findDefinition(index, offset);
          if (!definition) {
            return null;
          }
          return new vscode.Location(document.uri, new vscode.Range(
            document.positionAt(definition.start),
            document.positionAt(definition.end),
          ));
        },
      },
    ),
    vscode.languages.registerCompletionItemProvider(
      JPLMM_SELECTORS,
      {
        provideCompletionItems(document, position) {
          const index = getIndex(document);
          const completions = getCompletions(index, document.offsetAt(position));
          return completions.map(toCompletionItem);
        },
      },
      ".",
      ":",
      "(",
      ",",
      " ",
    ),
    vscode.languages.registerHoverProvider(
      JPLMM_SELECTORS,
      {
        provideHover(document, position) {
          const hover = buildHover(
            document,
            position,
            getFrontend(document),
            getVerification(document),
            getIndex(document),
            diagnostics,
            getOptimizationInfo(document),
            getVariableRangeInfo(document),
            getMetrics(document),
          );
          return hover;
        },
      },
    ),
    vscode.languages.registerCodeLensProvider(
      JPLMM_SELECTORS,
      {
        onDidChangeCodeLenses: codeLensChanges.event,
        provideCodeLenses(document) {
          if (!vscode.workspace.getConfiguration("jplmm").get<boolean>("editor.functionAnnotations", true)) {
            return [];
          }
          const frontend = getFrontend(document);
          if (frontend.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
            return [];
          }
          const index = getIndex(document);

          const annotations = [
            ...collectSourceFunctionMetricAnnotations(index.functions, getMetrics(document)),
            ...collectFunctionRefinementAnnotations(frontend.refinements),
          ];
          return annotations.map((annotation) => {
            const start = clampOffset(document, annotation.start);
            const end = clampOffset(document, Math.max(annotation.end, annotation.start + 1));
            return new vscode.CodeLens(
              new vscode.Range(document.positionAt(start), document.positionAt(end)),
              {
                title: annotation.label,
                command: "jplmm.noopMeta",
              },
            );
          });
        },
      },
    ),
    vscode.languages.registerInlayHintsProvider(
      JPLMM_SELECTORS,
      {
        onDidChangeInlayHints: inlayHintChanges.event,
        provideInlayHints(document, range) {
          const config = vscode.workspace.getConfiguration("jplmm");
          const frontend = getFrontend(document);
          if (frontend.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
            return [];
          }
          const annotations = [
            ...(config.get<boolean>("editor.inlineVariableRanges", true)
              ? buildVariableRangeAnnotations(getVariableRangeInfo(document))
              : []),
            ...(config.get<boolean>("editor.inlineOutResults", true)
              ? (() => {
                const report = getInlineResultReport(document);
                return report && report.ok ? buildOutResultAnnotations(frontend.program, report.output) : [];
              })()
              : []),
          ];

          return annotations
            .filter((annotation) => positionInRange(document, clampOffset(document, annotation.offset), range))
            .map((annotation) => {
              const hint = new vscode.InlayHint(
                document.positionAt(clampOffset(document, annotation.offset)),
                annotation.label,
                vscode.InlayHintKind.Type,
              );
              hint.paddingLeft = true;
              hint.tooltip = annotation.tooltip;
              return hint;
            });
        },
      },
    ),
    vscode.commands.registerCommand("jplmm.noopMeta", () => undefined),
    vscode.commands.registerCommand("jplmm.debugExtensionState", async (uri?: vscode.Uri) => {
      output.show(true);
      output.appendLine("> extension-state");
      output.appendLine(`activatedAt=${activatedAt}`);
      output.appendLine(`workspaceFolders=${(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath).join(", ") || "<none>"}`);

      const document = await resolveDocument(uri);
      if (!document) {
        output.appendLine("activeDocument=<none>");
        return;
      }

      output.appendLine(`document.uri=${document.uri.toString()}`);
      output.appendLine(`document.fsPath=${document.uri.fsPath || "<none>"}`);
      output.appendLine(`document.scheme=${document.uri.scheme}`);
      output.appendLine(`document.languageId=${document.languageId}`);
      output.appendLine(`document.isJplmm=${String(isJplmmDocument(document))}`);
      output.appendLine(`document.version=${document.version}`);

      const config = vscode.workspace.getConfiguration("jplmm");
      output.appendLine(`config.functionAnnotations=${String(config.get<boolean>("editor.functionAnnotations", true))}`);
      output.appendLine(`config.inlineOutResults=${String(config.get<boolean>("editor.inlineOutResults", true))}`);
      output.appendLine(`config.inlineExecutableSemantics=${String(config.get<boolean>("editor.inlineExecutableSemantics", true))}`);
      output.appendLine(`config.functionSemanticHover=${String(readFunctionSemanticHoverEnabled(config))}`);
      output.appendLine(`config.inlineVariableRanges=${String(config.get<boolean>("editor.inlineVariableRanges", true))}`);
      output.appendLine(`config.verifyBeforeRun=${String(config.get<boolean>("run.verifyBeforeRun", true))}`);
      output.appendLine(`config.editorProofTimeoutMs=${String(readEditorProofTimeoutMs(config))}`);
      output.appendLine(`config.runProofTimeoutMs=${String(readRunProofTimeoutMs(config))}`);
      output.appendLine(`config.traceExtension=${String(config.get<boolean>("debug.traceExtension", false))}`);

      if (!isJplmmDocument(document)) {
        output.appendLine("note=active document is not recognized as JPLMM");
        return;
      }

      try {
        const frontend = getFrontend(document);
        const frontendErrors = frontend.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        output.appendLine(`frontend.diagnostics=${frontend.diagnostics.length}`);
        output.appendLine(`frontend.errors=${frontendErrors.length}`);
        for (const diagnostic of frontend.diagnostics.slice(0, 10)) {
          output.appendLine(`frontend.diag ${diagnostic.severity} ${diagnostic.code ?? "<no-code>"} ${diagnostic.message}`);
        }

        const verify = frontendErrors.length === 0 ? getVerification(document) : null;
        output.appendLine(`verify.ran=${String(verify !== null)}`);
        output.appendLine(`verify.diagnostics=${verify?.diagnostics.length ?? 0}`);
        for (const diagnostic of verify?.diagnostics.slice(0, 10) ?? []) {
          output.appendLine(`verify.diag ${diagnostic.severity} ${diagnostic.code} ${diagnostic.message}`);
        }

        const metrics = getMetrics(document);
        const optimizationInfo = getOptimizationInfo(document);
        const variableRangeInfo = getVariableRangeInfo(document);
        const metricAnnotations = collectSourceFunctionMetricAnnotations(getIndex(document).functions, metrics);
        const refinementAnnotations = collectFunctionRefinementAnnotations(frontend.refinements);

        output.appendLine(`functions.metrics=${metrics.size}`);
        output.appendLine(`functions.optimizationInfo=${optimizationInfo.size}`);
        output.appendLine(`ranges.entries=${variableRangeInfo.entries.length}`);
        output.appendLine(`annotations.metric=${metricAnnotations.length}`);
        output.appendLine(`annotations.refinement=${refinementAnnotations.length}`);
        output.appendLine(`hover.semanticFunctions=${verify?.traceMap.size ?? 0}`);
        output.appendLine(`frontend.refinements=${frontend.refinements.length}`);
        output.appendLine(`inline.canAnnotateOut=${String(canAnnotateInlineOutResults(frontend.program))}`);

        const inlineReport = getInlineResultReport(document);
        output.appendLine(`inline.report=${inlineReport ? (inlineReport.ok ? "ok" : "not-ok") : "none"}`);
        if (inlineReport) {
          output.appendLine(`inline.outputLines=${inlineReport.output.length}`);
          output.appendLine(`inline.diagnostics=${inlineReport.diagnostics.length}`);
        }
      } catch (error) {
        output.appendLine(`doctor.error=${String(error)}`);
        if (error instanceof Error && error.stack) {
          output.appendLine(error.stack);
        }
      }
    }),
    vscode.commands.registerCommand("jplmm.runFile", async (uri?: vscode.Uri) => {
      const document = await resolveDocument(uri);
      if (!document || !isJplmmDocument(document)) {
        void vscode.window.showErrorMessage("Open a JPLMM file to run it.");
        return;
      }

      const config = vscode.workspace.getConfiguration("jplmm");
      const mode = config.get<CliMode>("run.mode", "run");
      const experimental = config.get<boolean>("run.experimental", true);
      const safe = config.get<boolean>("run.safe", false);
      const disablePasses = readDisablePassesConfig(config);
      const clearOutput = config.get<boolean>("run.clearOutput", true);
      const verifyBeforeRun = config.get<boolean>("run.verifyBeforeRun", true);
      const cwd = resolveDocumentDirectory(document);

      if (!cwd) {
        void vscode.window.showErrorMessage("JPLMM run needs a saved file or an open workspace folder.");
        return;
      }

      if (clearOutput) {
        output.clear();
      }
      output.show(true);
      const source = document.getText();
      const entryNote = mode === "run" ? describeImplicitRunEntry(source) : null;
      const verifyNote = mode === "run" && verifyBeforeRun ? "verify first" : null;
      const notes = [entryNote, verifyNote].filter((note): note is string => note !== null);
      output.appendLine(`> ${mode} ${document.uri.fsPath || document.uri.toString()}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`);

      try {
        const runProofTimeoutMs = readRunProofTimeoutMs(config);
        const report = runOnSource(source, mode, {
          cwd,
          experimental,
          safe,
          disablePasses,
          verifyBeforeRun,
          ...(runProofTimeoutMs !== undefined ? { proofTimeoutMs: runProofTimeoutMs } : {}),
        });
        writeReport(output, report, mode);
        if (!report.ok) {
          void vscode.window.showErrorMessage(`JPLMM ${mode} failed. See the ${OUTPUT_NAME} output channel.`);
        }
      } catch (error) {
        output.appendLine(String(error));
        void vscode.window.showErrorMessage(`JPLMM ${mode} crashed. See the ${OUTPUT_NAME} output channel.`);
      }
    }),
    vscode.commands.registerCommand("jplmm.debugWat", async (uri?: vscode.Uri) => {
      await showWatDebugDocument(uri, output);
    }),
    vscode.commands.registerCommand("jplmm.showWat", async (uri?: vscode.Uri) => {
      await showWatDebugDocument(uri, output);
    }),
    vscode.commands.registerCommand("jplmm.debugSemantics", async (uri?: vscode.Uri) => {
      await showSemanticsDebugDocument(uri, output);
    }),
  );
}

export function deactivate(): void {}

function toCompletionItem(entry: CompletionEntry): vscode.CompletionItem {
  const item = new vscode.CompletionItem(entry.label, completionItemKind(entry.kind));
  item.detail = entry.detail;
  return item;
}

function completionItemKind(kind: CompletionEntry["kind"]): vscode.CompletionItemKind {
  switch (kind) {
    case "builtin":
    case "function":
      return vscode.CompletionItemKind.Function;
    case "struct":
      return vscode.CompletionItemKind.Struct;
    case "parameter":
      return vscode.CompletionItemKind.Variable;
    case "field":
      return vscode.CompletionItemKind.Field;
    case "variable":
      return vscode.CompletionItemKind.Variable;
    case "keyword":
      return vscode.CompletionItemKind.Keyword;
    default:
      return vscode.CompletionItemKind.Text;
  }
}

function toVsCodeDiagnostic(document: vscode.TextDocument, diagnostic: FrontendDiagnostic): vscode.Diagnostic {
  const start = clampOffset(document, diagnostic.start);
  const end = clampOffset(document, Math.max(diagnostic.end, diagnostic.start + 1));
  const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
  const out = new vscode.Diagnostic(
    range,
    diagnostic.message,
    diagnostic.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
  );
  out.source = "jplmm";
  if (diagnostic.code) {
    out.code = diagnostic.code;
  }
  return out;
}

function toVsCodeVerificationDiagnostic(
  document: vscode.TextDocument,
  program: ReturnType<typeof runFrontend>["program"],
  diagnostic: VerificationDiagnostic,
): vscode.Diagnostic {
  const anchor = findVerificationDiagnosticAnchor(program, diagnostic);
  const start = clampOffset(document, anchor?.start ?? 0);
  const end = clampOffset(document, Math.max(anchor?.end ?? anchor?.start ?? 0, start + 1));
  const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
  const out = new vscode.Diagnostic(
    range,
    diagnostic.message,
    diagnostic.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
  );
  out.source = "jplmm";
  out.code = diagnostic.code;
  return out;
}

function toVsCodeWarningDiagnostic(
  document: vscode.TextDocument,
  startOffset: number,
  endOffset: number,
  message: string,
  code: string,
): vscode.Diagnostic {
  const start = clampOffset(document, startOffset);
  const end = clampOffset(document, Math.max(endOffset, startOffset + 1));
  const out = new vscode.Diagnostic(
    new vscode.Range(document.positionAt(start), document.positionAt(end)),
    message,
    vscode.DiagnosticSeverity.Warning,
  );
  out.source = "jplmm";
  out.code = code;
  return out;
}

function clampOffset(document: vscode.TextDocument, offset: number): number {
  return Math.max(0, Math.min(offset, document.getText().length));
}

function readDisablePassesConfig(config: vscode.WorkspaceConfiguration): DisableablePassName[] {
  return config
    .get<string[]>("run.disablePasses", [])
    .filter((pass): pass is DisableablePassName => DISABLEABLE_PASSES.has(pass as DisableablePassName));
}

function readEditorProofTimeoutMs(config = vscode.workspace.getConfiguration("jplmm")): number | undefined {
  return readPositiveTimeoutMs(config, "editor.proofTimeoutMs", DEFAULT_EDITOR_PROOF_TIMEOUT_MS);
}

function readRunProofTimeoutMs(config = vscode.workspace.getConfiguration("jplmm")): number | undefined {
  return readPositiveTimeoutMs(config, "run.proofTimeoutMs", DEFAULT_RUN_PROOF_TIMEOUT_MS);
}

function readFunctionSemanticHoverEnabled(config = vscode.workspace.getConfiguration("jplmm")): boolean {
  const explicit = config.get<boolean>("editor.functionSemanticHover");
  if (explicit !== undefined) {
    return explicit;
  }
  return config.get<boolean>("editor.inlineExecutableSemantics", true);
}

function readPositiveTimeoutMs(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
): number | undefined {
  const raw = config.get<number>(key, fallback);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(HARD_PROOF_TIMEOUT_MS, Math.max(1, Math.floor(raw)));
}

function positionInRange(document: vscode.TextDocument, offset: number, range: vscode.Range): boolean {
  const position = document.positionAt(offset);
  return range.contains(position);
}

async function resolveDocument(uri: vscode.Uri | undefined): Promise<vscode.TextDocument | undefined> {
  if (uri) {
    return vscode.workspace.openTextDocument(uri);
  }
  return vscode.window.activeTextEditor?.document;
}

async function showWatDebugDocument(uri: vscode.Uri | undefined, output: vscode.OutputChannel): Promise<void> {
  const document = await resolveDocument(uri);
  if (!document || !isJplmmDocument(document)) {
    void vscode.window.showErrorMessage("Open a JPLMM file to inspect its WAT.");
    return;
  }

  const cwd = resolveDocumentDirectory(document);
  if (!cwd) {
    void vscode.window.showErrorMessage("JPLMM WAT inspection needs a saved file or an open workspace folder.");
    return;
  }

  const watConfig = vscode.workspace.getConfiguration("jplmm");
  const watProofTimeoutMs = readRunProofTimeoutMs(watConfig);
  const report = runOnSource(document.getText(), "wat", {
    cwd,
    experimental: watConfig.get<boolean>("run.experimental", true),
    safe: watConfig.get<boolean>("run.safe", false),
    disablePasses: readDisablePassesConfig(watConfig),
    ...(watProofTimeoutMs !== undefined ? { proofTimeoutMs: watProofTimeoutMs } : {}),
  });
  if (!report.ok || !report.wat) {
    output.show(true);
    output.appendLine("> wat");
    writeReport(output, report, "wat");
    void vscode.window.showErrorMessage("JPLMM WAT inspection failed. See the output channel for details.");
    return;
  }

  const watDocument = await vscode.workspace.openTextDocument({
    content: report.wat,
    language: "wat",
  });
  await vscode.window.showTextDocument(watDocument, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside,
  });
}

async function showSemanticsDebugDocument(uri: vscode.Uri | undefined, output: vscode.OutputChannel): Promise<void> {
  const document = await resolveDocument(uri);
  if (!document || !isJplmmDocument(document)) {
    void vscode.window.showErrorMessage("Open a JPLMM file to inspect its semantics.");
    return;
  }

  const cwd = resolveDocumentDirectory(document);
  if (!cwd) {
    void vscode.window.showErrorMessage("JPLMM semantics inspection needs a saved file or an open workspace folder.");
    return;
  }

  const semConfig = vscode.workspace.getConfiguration("jplmm");
  const semProofTimeoutMs = readRunProofTimeoutMs(semConfig);
  const report = runOnSource(document.getText(), "semantics", {
    cwd,
    experimental: semConfig.get<boolean>("run.experimental", true),
    safe: semConfig.get<boolean>("run.safe", false),
    disablePasses: readDisablePassesConfig(semConfig),
    verifyBeforeRun: true,
    ...(semProofTimeoutMs !== undefined ? { proofTimeoutMs: semProofTimeoutMs } : {}),
  });
  if (!report.semantics) {
    output.show(true);
    output.appendLine("> semantics");
    writeReport(output, report, "run");
    void vscode.window.showErrorMessage("JPLMM semantics inspection failed. See the output channel for details.");
    return;
  }

  const semanticsDocument = await vscode.workspace.openTextDocument({
    content: report.semantics,
    language: "json",
  });
  await vscode.window.showTextDocument(semanticsDocument, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside,
  });
}

function resolveDocumentDirectory(document: vscode.TextDocument): string | undefined {
  if (document.uri.scheme === "file") {
    return dirname(document.uri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function isJplmmDocument(document: vscode.TextDocument): boolean {
  return document.languageId === LANGUAGE_ID || hasJplmmExtension(document.uri);
}

function hasJplmmExtension(uri: vscode.Uri): boolean {
  const path = uri.fsPath || uri.path || uri.toString();
  const lowerPath = path.toLowerCase();
  return JPLMM_EXTENSIONS.some((ext) => lowerPath.endsWith(ext));
}

function describeImplicitRunEntry(source: string): string | null {
  const frontend = runFrontend(source);
  if (frontend.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return null;
  }
  const main = findImplicitMain(frontend.program);
  if (main && !hasExplicitTopLevelExecution(frontend.program)) {
    return "implicit main()";
  }
  return null;
}

function findImplicitMain(program: ReturnType<typeof runFrontend>["program"]): { name: string } | null {
  for (const cmd of program.commands) {
    const fn = unwrapTimedFnDef(cmd);
    if (fn && fn.name === "main" && fn.params.length === 0) {
      return fn;
    }
  }
  return null;
}

function hasExplicitTopLevelExecution(program: ReturnType<typeof runFrontend>["program"]): boolean {
  return program.commands.some((cmd) => {
    if (cmd.tag === "fn_def" || cmd.tag === "struct_def") {
      return false;
    }
    if (cmd.tag === "time" && (cmd.cmd.tag === "fn_def" || cmd.cmd.tag === "struct_def")) {
      return false;
    }
    return true;
  });
}

function unwrapTimedFnDef(
  cmd: ReturnType<typeof runFrontend>["program"]["commands"][number],
): {
  tag: "fn_def";
  name: string;
  params: Array<{ name: string }>;
  retType: unknown;
  body: Array<{ tag: string; expr?: unknown; limit?: unknown; start?: number; end?: number }>;
  start?: number;
  end?: number;
} | null {
  if (cmd.tag === "fn_def") {
    return cmd;
  }
  if (cmd.tag === "time" && cmd.cmd.tag === "fn_def") {
    return cmd.cmd;
  }
  return null;
}

function buildHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  frontend: ReturnType<typeof runFrontend>,
  verification: VerificationOutput | null,
  index: ReturnType<typeof buildDocumentIndex>,
  diagnostics: vscode.DiagnosticCollection,
  optimizationInfo: Map<string, FunctionOptimizationInfo>,
  variableRangeInfo: VariableRangeInfo,
  metrics: Map<string, FunctionMetrics>,
): vscode.Hover | null {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  const offset = document.offsetAt(position);
  const lines: string[] = [];

  const diagnosticAtPosition = diagnostics.get(document.uri)?.find((item) => item.range.contains(position));
  if (diagnosticAtPosition) {
    lines.push(`**${diagnosticSeverityLabel(diagnosticAtPosition.severity)}**: ${diagnosticAtPosition.message}`);
  }

  if (!range) {
    return lines.length > 0 ? new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n"))) : null;
  }

  const word = document.getText(range);
  const definition = findDefinition(index, offset);
  const rangeInfo = findVariableRangeAtOffset(variableRangeInfo, offset);
  if (definition && definition.name === word) {
    lines.unshift(renderDefinitionHover(definition));
    if (rangeInfo) {
      lines.push(renderVariableRangeHover(rangeInfo));
    }
    if (definition.kind === "function") {
      if (readFunctionSemanticHoverEnabled()) {
        const semanticHover = renderFunctionSemanticHover(frontend, verification, definition.name, offset);
        if (semanticHover) {
          lines.push(semanticHover);
        }
      }
      const refinement = latestRefinementFor(frontend, definition.name);
      if (refinement) {
        lines.push(renderRefinementHover(refinement));
      }
      const metric = metrics.get(definition.name);
      if (metric) {
        lines.push(renderFunctionMetricHover(metric));
      }
      const info = optimizationInfo.get(definition.name);
      if (info) {
        lines.push(renderFunctionOptimizationHover(info));
      }
    }
  } else if (BUILTIN_FUNCTIONS.has(word)) {
    lines.unshift(`\`${word}(...)\`\n\nBuilt-in JPLMM function.`);
  } else {
    const keywordInfo = KEYWORD_INFO.get(word);
    if (keywordInfo) {
      lines.unshift(`\`${word}\`\n\n${keywordInfo}.`);
    } else if (rangeInfo) {
      lines.unshift(`\`${word}\`\n\nVariable.`);
      lines.push(renderVariableRangeHover(rangeInfo));
    }
  }

  if (lines.length === 0) {
    return null;
  }
  const markdown = new vscode.MarkdownString("", true);
  markdown.supportHtml = true;
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) {
      markdown.appendMarkdown("\n\n");
    }
    markdown.appendMarkdown(lines[i]!);
  }
  return new vscode.Hover(markdown, range);
}

function renderDefinitionHover(definition: ReturnType<typeof findDefinition> extends infer T ? Exclude<T, null> : never): string {
  const kind = definition.kind === "parameter"
    ? "Parameter"
    : definition.kind === "local"
      ? "Local"
      : definition.kind === "global"
        ? "Global"
        : definition.kind === "field"
          ? "Field"
          : definition.kind === "struct"
            ? "Struct"
            : "Function";
  const suffix = definition.containerName ? ` in \`${definition.containerName}\`` : "";
  return `\`${definition.name}\`\n\n${kind}${suffix}.`;
}

function renderFunctionMetricHover(metric: FunctionMetrics): string {
  return [
    "**Function Metrics**",
    `- source complexity: \`${metric.sourceComplexity}\``,
    `- canonical witness: \`${metric.canonicalWitness}\``,
    `- coarse total call bound: \`${metric.coarseTotalCallBound}\``,
  ].join("\n");
}

function renderRefinementHover(refinement: ReturnType<typeof runFrontend>["refinements"][number]): string {
  return [
    "**Refinement**",
    `- status: \`${refinement.status}\`${refinement.method ? ` via \`${refinement.method}\`` : ""}`,
    `- detail: ${refinement.detail}`,
    ...(refinement.equivalence ? [`- equivalence: \`${refinement.equivalence}\``] : []),
  ].join("\n");
}

function diagnosticSeverityLabel(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "Error";
    case vscode.DiagnosticSeverity.Warning:
      return "Warning";
    case vscode.DiagnosticSeverity.Information:
      return "Info";
    case vscode.DiagnosticSeverity.Hint:
      return "Hint";
    default:
      return "Diagnostic";
  }
}

function writeReport(output: vscode.OutputChannel, report: ReturnType<typeof runOnSource>, mode: CliMode | "wat"): void {
  for (const diagnostic of report.diagnostics) {
    output.appendLine(diagnostic);
  }
  for (const line of report.proofSummary) {
    output.appendLine(line);
  }
  for (const line of report.analysisSummary) {
    output.appendLine(line);
  }
  for (const line of report.optimizeSummary) {
    output.appendLine(line);
  }
  for (const line of report.implementationSummary) {
    output.appendLine(line);
  }
  if (report.semantics) {
    output.appendLine(report.semantics);
  }
  if (report.wat && mode !== "wat") {
    output.appendLine(report.wat);
  }
  if (report.nativeC) {
    output.appendLine(report.nativeC);
  }
  for (const line of report.output) {
    output.appendLine(line);
  }
  for (const file of report.wroteFiles) {
    output.appendLine(`wrote ${file}`);
  }
  if (
    report.diagnostics.length === 0
    && report.output.length === 0
    && report.proofSummary.length === 0
    && report.analysisSummary.length === 0
    && report.optimizeSummary.length === 0
    && report.implementationSummary.length === 0
    && !report.semantics
    && !report.nativeC
    && !report.wat
  ) {
    output.appendLine("ok");
  }
}

function latestRefinementFor(
  frontend: ReturnType<typeof runFrontend>,
  fnName: string,
): ReturnType<typeof runFrontend>["refinements"][number] | null {
  const matches = frontend.refinements.filter((refinement) => refinement.fnName === fnName);
  return matches.length > 0 ? matches[matches.length - 1]! : null;
}
