import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeDiagnosticCollection = {
  set: (uri: { toString(): string }, diagnostics: unknown[]) => void;
  delete: (uri: { toString(): string }) => void;
  clear: () => void;
  get: (uri: { toString(): string }) => unknown[] | undefined;
  dispose: () => void;
};

type FakeProviderRegistry = {
  hover: { provideHover: (document: FakeTextDocument, position: FakePosition) => unknown } | null;
  codeLens: { provideCodeLenses: (document: FakeTextDocument) => Array<{ command?: { title?: string } }> } | null;
  inlay: { provideInlayHints: (document: FakeTextDocument, range: FakeRange) => unknown[] } | null;
  commands: Map<string, (...args: unknown[]) => unknown>;
};

type FakePosition = {
  line: number;
  character: number;
};

class FakeRange {
  start: FakePosition;
  end: FakePosition;

  constructor(start: FakePosition, end: FakePosition) {
    this.start = start;
    this.end = end;
  }

  contains(position: FakePosition): boolean {
    const afterStart = position.line > this.start.line
      || (position.line === this.start.line && position.character >= this.start.character);
    const beforeEnd = position.line < this.end.line
      || (position.line === this.end.line && position.character <= this.end.character);
    return afterStart && beforeEnd;
  }
}

type FakeTextDocument = {
  languageId: string;
  version: number;
  uri: { toString(): string; fsPath: string; scheme: string };
  getText(): string;
  offsetAt(position: FakePosition): number;
  positionAt(offset: number): FakePosition;
  getWordRangeAtPosition(position: FakePosition): FakeRange | null;
};

function makeDocument(text: string, languageId = "jplmm"): FakeTextDocument {
  return {
    languageId,
    version: 1,
    uri: {
      toString: () => "file:///tmp/runtime-test.jplmm",
      fsPath: "/tmp/runtime-test.jplmm",
      scheme: "file",
    },
    getText: () => text,
    offsetAt(position) {
      const lines = text.split("\n");
      let offset = 0;
      for (let line = 0; line < position.line; line += 1) {
        offset += (lines[line] ?? "").length + 1;
      }
      return offset + position.character;
    },
    positionAt(offset) {
      const lines = text.split("\n");
      let remaining = offset;
      for (let line = 0; line < lines.length; line += 1) {
        const current = lines[line] ?? "";
        if (remaining <= current.length) {
          return { line, character: remaining };
        }
        remaining -= current.length + 1;
      }
      const last = lines[lines.length - 1] ?? "";
      return { line: Math.max(0, lines.length - 1), character: last.length };
    },
    getWordRangeAtPosition(position) {
      const offset = this.offsetAt(position);
      const isWord = (char: string | undefined) => char !== undefined && /[A-Za-z0-9_]/.test(char);
      if (!isWord(text[offset]) && !isWord(text[offset - 1])) {
        return null;
      }
      let left = offset;
      while (left > 0 && isWord(text[left - 1])) {
        left -= 1;
      }
      let right = offset;
      while (right < text.length && isWord(text[right])) {
        right += 1;
      }
      if (!/[A-Za-z_]/.test(text[left] ?? "")) {
        return null;
      }
      return new FakeRange(this.positionAt(left), this.positionAt(right));
    },
  };
}

const state = vi.hoisted(() => {
  const diagnostics = new Map<string, unknown[]>();
  const registry: FakeProviderRegistry = {
    hover: null,
    codeLens: null,
    inlay: null,
    commands: new Map(),
  };
  const workspace = {
    textDocuments: [] as FakeTextDocument[],
  };
  const windowState = {
    activeTextEditor: null as { document: FakeTextDocument } | null,
    errors: [] as string[],
  };
  return { diagnostics, registry, workspace, windowState };
});

vi.mock("vscode", () => {
  class FakeDiagnostic {
    range: FakeRange;
    message: string;
    severity: number;
    source?: string;
    code?: string;

    constructor(range: FakeRange, message: string, severity: number) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  }

  class FakeMarkdownString {
    value: string;
    supportHtml = false;

    constructor(value = "") {
      this.value = value;
    }

    appendMarkdown(chunk: string): void {
      this.value += chunk;
    }
  }

  class FakeHover {
    contents: FakeMarkdownString;
    range: FakeRange | null;

    constructor(contents: FakeMarkdownString, range: FakeRange | null = null) {
      this.contents = contents;
      this.range = range;
    }
  }

  class FakeCodeLens {
    range: FakeRange;
    command?: { title?: string };

    constructor(range: FakeRange, command?: { title?: string }) {
      this.range = range;
      this.command = command;
    }
  }

  class FakeInlayHint {
    position: FakePosition;
    label: string;
    kind: number;
    paddingLeft?: boolean;
    tooltip?: string;

    constructor(position: FakePosition, label: string, kind: number) {
      this.position = position;
      this.label = label;
      this.kind = kind;
    }
  }

  class FakeCompletionItem {
    label: string;
    kind: number;
    detail?: string;

    constructor(label: string, kind: number) {
      this.label = label;
      this.kind = kind;
    }
  }

  class FakeEventEmitter<T> {
    readonly event = (_listener?: (value: T) => void) => undefined;
    fire(_value?: T): void {}
    dispose(): void {}
  }

  const createDiagnosticCollection = (): FakeDiagnosticCollection => ({
    set(uri, diagnostics) {
      state.diagnostics.set(uri.toString(), diagnostics);
    },
    delete(uri) {
      state.diagnostics.delete(uri.toString());
    },
    clear() {
      state.diagnostics.clear();
    },
    get(uri) {
      return state.diagnostics.get(uri.toString());
    },
    dispose() {},
  });

  return {
    window: {
      createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
      get activeTextEditor() {
        return state.windowState.activeTextEditor;
      },
      showErrorMessage(message: string) {
        state.windowState.errors.push(message);
      },
      showTextDocument: async () => undefined,
    },
    workspace: {
      get textDocuments() {
        return state.workspace.textDocuments;
      },
      workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
      getConfiguration: () => ({
        get(key: string, fallback: unknown) {
          if (key === "editor.inlineOutResults") {
            return false;
          }
          return fallback;
        },
      }),
      onDidOpenTextDocument: () => ({ dispose() {} }),
      onDidCloseTextDocument: () => ({ dispose() {} }),
      onDidChangeTextDocument: () => ({ dispose() {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      openTextDocument: async () => undefined,
    },
    languages: {
      createDiagnosticCollection,
      registerDefinitionProvider: () => ({ dispose() {} }),
      registerCompletionItemProvider: () => ({ dispose() {} }),
      registerHoverProvider: (_selector: unknown, provider: FakeProviderRegistry["hover"]) => {
        state.registry.hover = provider;
        return { dispose() {} };
      },
      registerCodeLensProvider: (_selector: unknown, provider: FakeProviderRegistry["codeLens"]) => {
        state.registry.codeLens = provider;
        return { dispose() {} };
      },
      registerInlayHintsProvider: (_selector: unknown, provider: FakeProviderRegistry["inlay"]) => {
        state.registry.inlay = provider;
        return { dispose() {} };
      },
    },
    commands: {
      registerCommand(name: string, fn: (...args: unknown[]) => unknown) {
        state.registry.commands.set(name, fn);
        return { dispose() {} };
      },
    },
    EventEmitter: FakeEventEmitter,
    Diagnostic: FakeDiagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CompletionItem: FakeCompletionItem,
    CompletionItemKind: { Function: 1, Struct: 2, Variable: 3, Field: 4, Keyword: 5, Text: 6 },
    Location: class { constructor(public uri: unknown, public range: FakeRange) {} },
    Range: FakeRange,
    CodeLens: FakeCodeLens,
    InlayHint: FakeInlayHint,
    InlayHintKind: { Type: 1 },
    MarkdownString: FakeMarkdownString,
    Hover: FakeHover,
    ViewColumn: { Beside: 2 },
  };
});

describe("extension runtime smoke", () => {
  beforeEach(() => {
    state.diagnostics.clear();
    state.registry.hover = null;
    state.registry.codeLens = null;
    state.registry.inlay = null;
    state.registry.commands.clear();
    state.workspace.textDocuments = [];
    state.windowState.activeTextEditor = null;
    state.windowState.errors = [];
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("activates and exposes commands, code lenses, hovers, and inlay hints for jplmm documents", async () => {
    const document = makeDocument(`
      fun clamp_hi(input:int): int {
        let clipped = clamp(input, 0, 50);
        ret clipped;
      }

      ref clamp_hi(n:int): int {
        ret clamp(n, 0, 50);
      }
    `);
    state.workspace.textDocuments = [document];

    const { activate } = await import("../src/extension.ts");
    activate({ subscriptions: [] } as never);

    expect(state.registry.commands.has("jplmm.runFile")).toBe(true);
    expect(state.registry.commands.has("jplmm.debugWat")).toBe(true);
    expect(state.registry.commands.has("jplmm.debugSemantics")).toBe(true);
    expect(state.registry.commands.has("jplmm.debugExtensionState")).toBe(true);
    expect(state.registry.codeLens).not.toBeNull();
    expect(state.registry.hover).not.toBeNull();
    expect(state.registry.inlay).not.toBeNull();

    const lenses = state.registry.codeLens!.provideCodeLenses(document);
    expect(lenses.filter((lens) => lens.command?.title?.includes("valid refinement"))).toHaveLength(1);
    expect(lenses.filter((lens) => lens.command?.title?.includes("refined by later ref"))).toHaveLength(1);
    expect(lenses.filter((lens) => lens.command?.title?.includes("complexity"))).toHaveLength(2);

    expect(typeof state.registry.hover!.provideHover).toBe("function");
    const hints = state.registry.inlay!.provideInlayHints(
      document,
      new FakeRange({ line: 0, character: 0 }, { line: 20, character: 0 }),
    ) as Array<{ label?: string }>;
    expect(Array.isArray(hints)).toBe(true);
    expect(hints.some((hint) => hint.label?.includes("; sem "))).toBe(false);
  });

  it("still treats .jplmm files as JPLMM when the editor language mode is wrong", async () => {
    const document = makeDocument(`
      fun main(): int {
        ret 1;
      }
    `, "plaintext");
    state.workspace.textDocuments = [document];
    state.windowState.activeTextEditor = { document };

    const { activate } = await import("../src/extension.ts");
    activate({ subscriptions: [] } as never);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.diagnostics.has(document.uri.toString())).toBe(true);

    const runFile = state.registry.commands.get("jplmm.runFile");
    expect(runFile).toBeDefined();
    await runFile?.();

    expect(state.windowState.errors).not.toContain("Open a JPLMM file to run it.");
  });
});
