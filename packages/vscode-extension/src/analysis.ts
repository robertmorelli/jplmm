import { ACTIVE_KEYWORDS } from "@jplmm/grammar";

export type TokenKind =
  | "ident"
  | "int"
  | "float"
  | "string"
  | "keyword"
  | "symbol"
  | "unknown"
  | "eof";

export type Token = {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
};

export type SymbolKind = "function" | "struct" | "parameter" | "local" | "global" | "field";

export type SymbolDef = {
  name: string;
  kind: SymbolKind;
  start: number;
  end: number;
  scopeStart: number;
  scopeEnd: number;
  containerName?: string;
};

export type FunctionScope = {
  name: string;
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  params: SymbolDef[];
  locals: SymbolDef[];
};

export type StructScope = {
  name: string;
  start: number;
  end: number;
  fields: SymbolDef[];
};

export type DocumentIndex = {
  tokens: Token[];
  functions: FunctionScope[];
  structs: StructScope[];
  globals: SymbolDef[];
};

export type CompletionKind = "keyword" | "builtin" | "function" | "struct" | "variable" | "parameter" | "field";

export type CompletionEntry = {
  label: string;
  kind: CompletionKind;
  detail: string;
};

const KEYWORDS = new Set(ACTIVE_KEYWORDS);
const SYMBOLS = new Set(["(", ")", "{", "}", "[", "]", ",", ":", ";", "=", "+", "-", "*", "/", "%", "."]);
const BUILTIN_FUNCTIONS = [
  "sqrt",
  "exp",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "log",
  "pow",
  "atan2",
  "to_float",
  "to_int",
  "max",
  "min",
  "abs",
  "clamp",
] as const;
const PRIMITIVE_TYPES = ["int", "float", "void"] as const;
const CONTEXTUAL_KEYWORDS = ["out"] as const;

export function buildDocumentIndex(source: string): DocumentIndex {
  const tokens = lexDocument(source);
  const functions: FunctionScope[] = [];
  const structs: StructScope[] = [];
  const globals: SymbolDef[] = [];

  let idx = 0;
  while (idx < tokens.length) {
    const token = tokens[idx];
    if (!token || token.kind === "eof") {
      break;
    }
    if (isKeyword(token, "struct")) {
      const parsed = parseStruct(tokens, idx);
      if (parsed) {
        structs.push(parsed.structScope);
        idx = parsed.nextIndex;
        continue;
      }
    }
    if (isKeyword(token, "fun") || isKeyword(token, "fn") || isKeyword(token, "def") || isKeyword(token, "ref")) {
      const parsed = parseFunction(tokens, idx);
      if (parsed) {
        functions.push(parsed.functionScope);
        idx = parsed.nextIndex;
        continue;
      }
    }
    if (isKeyword(token, "let")) {
      const parsed = parseBindingSite(tokens, idx + 1, "global", token.start, source.length);
      globals.push(...parsed.symbols);
      idx = parsed.nextIndex;
      continue;
    }
    if (isKeyword(token, "read")) {
      const parsed = parseReadBindings(tokens, idx, source.length);
      globals.push(...parsed.symbols);
      idx = parsed.nextIndex;
      continue;
    }
    idx += 1;
  }

  return { tokens, functions, structs, globals };
}

export function findDefinition(index: DocumentIndex, offset: number): SymbolDef | null {
  const tokenIndex = findTokenIndex(index.tokens, offset);
  const token = tokenIndex >= 0 ? index.tokens[tokenIndex] : undefined;
  if (!token || token.kind !== "ident") {
    return null;
  }

  const selfDefinition = findDefinitionAt(index, token.start, token.end);
  if (selfDefinition) {
    return selfDefinition;
  }

  const context = classifyContext(index.tokens, tokenIndex);
  if (context === "field") {
    return findFieldDefinition(index, token.text);
  }
  if (context === "type") {
    return toStructSymbolDef(index.structs.find((structScope) => structScope.name === token.text));
  }
  if (context === "call") {
    return visibleFunctions(index, offset).find((def) => def.name === token.text) ?? null;
  }

  for (const symbol of visibleVariables(index, offset)) {
    if (symbol.name === token.text) {
      return symbol;
    }
  }
  return visibleFunctions(index, offset).find((def) => def.name === token.text)
    ?? toStructSymbolDef(index.structs.find((structScope) => structScope.name === token.text))
    ?? null;
}

export function getCompletions(index: DocumentIndex, offset: number): CompletionEntry[] {
  const tokenIndex = findTokenIndex(index.tokens, offset);
  const context = classifyContext(index.tokens, tokenIndex);
  const out = new Map<string, CompletionEntry>();

  if (context === "field") {
    for (const structScope of index.structs) {
      for (const field of structScope.fields) {
        addCompletion(out, field.name, "field", `field on ${structScope.name}`);
      }
    }
    return sortCompletions(out);
  }

  if (context === "type") {
    for (const typeName of PRIMITIVE_TYPES) {
      addCompletion(out, typeName, "keyword", "primitive type");
    }
    for (const structScope of index.structs) {
      addCompletion(out, structScope.name, "struct", "struct type");
    }
    return sortCompletions(out);
  }

  for (const keyword of [...ACTIVE_KEYWORDS, ...CONTEXTUAL_KEYWORDS]) {
    addCompletion(out, keyword, "keyword", "keyword");
  }
  for (const builtin of BUILTIN_FUNCTIONS) {
    addCompletion(out, builtin, "builtin", "builtin function");
  }
  for (const symbol of visibleFunctions(index, offset)) {
    addCompletion(out, symbol.name, "function", "function");
  }
  for (const symbol of visibleVariables(index, offset)) {
    addCompletion(out, symbol.name, symbol.kind === "parameter" ? "parameter" : "variable", symbol.kind);
  }
  for (const structScope of index.structs) {
    addCompletion(out, structScope.name, "struct", "struct");
  }

  return sortCompletions(out);
}

function sortCompletions(entries: Map<string, CompletionEntry>): CompletionEntry[] {
  return [...entries.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function addCompletion(
  entries: Map<string, CompletionEntry>,
  label: string,
  kind: CompletionKind,
  detail: string,
): void {
  if (!entries.has(label)) {
    entries.set(label, { label, kind, detail });
  }
}

function visibleVariables(index: DocumentIndex, offset: number): SymbolDef[] {
  const currentFunction = index.functions.find((fn) => offset >= fn.bodyStart && offset <= fn.bodyEnd);
  const variables: SymbolDef[] = [];
  if (currentFunction) {
    for (const param of currentFunction.params) {
      variables.push(param);
    }
    for (const local of currentFunction.locals) {
      if (local.start < offset) {
        variables.push(local);
      }
    }
  }
  for (const global of index.globals) {
    if (global.start < offset) {
      variables.push(global);
    }
  }
  return variables.sort((left, right) => right.start - left.start);
}

function visibleFunctions(index: DocumentIndex, offset: number): SymbolDef[] {
  const defs = index.functions
    .filter((fn) => fn.start < offset || (offset >= fn.bodyStart && offset <= fn.bodyEnd))
    .map((fn) => toSymbolDef(fn));
  return defs.sort((left, right) => right.start - left.start);
}

function findDefinitionAt(index: DocumentIndex, start: number, end: number): SymbolDef | null {
  for (const fn of index.functions) {
    if (fn.start === start && fn.end === end) {
      return toSymbolDef(fn);
    }
    for (const param of fn.params) {
      if (param.start === start && param.end === end) {
        return param;
      }
    }
    for (const local of fn.locals) {
      if (local.start === start && local.end === end) {
        return local;
      }
    }
  }
  for (const structScope of index.structs) {
    if (structScope.start === start && structScope.end === end) {
      return toStructSymbolDef(structScope);
    }
    for (const field of structScope.fields) {
      if (field.start === start && field.end === end) {
        return field;
      }
    }
  }
  return index.globals.find((global) => global.start === start && global.end === end) ?? null;
}

function findFieldDefinition(index: DocumentIndex, name: string): SymbolDef | null {
  const matches = index.structs.flatMap((structScope) => structScope.fields.filter((field) => field.name === name));
  return matches.length === 1 ? matches[0] ?? null : null;
}

function classifyContext(tokens: Token[], tokenIndex: number): "value" | "type" | "call" | "field" {
  const token = tokenIndex >= 0 ? tokens[tokenIndex] : undefined;
  const previous = previousToken(tokens, tokenIndex);
  const next = nextToken(tokens, tokenIndex);
  if (!token) {
    return "value";
  }
  if (previous?.text === ".") {
    return "field";
  }
  if (previous?.text === ":") {
    return "type";
  }
  if (next?.text === "(") {
    return "call";
  }
  return "value";
}

function parseStruct(tokens: Token[], startIndex: number): { structScope: StructScope; nextIndex: number } | null {
  const nameToken = nextIdent(tokens, startIndex + 1);
  if (!nameToken) {
    return null;
  }
  const openBraceIndex = findNextSymbol(tokens, startIndex + 1, "{");
  if (openBraceIndex < 0) {
    return null;
  }
  const closeBraceIndex = findMatching(tokens, openBraceIndex, "{", "}");
  if (closeBraceIndex < 0) {
    return null;
  }
  const fields: SymbolDef[] = [];
  let idx = openBraceIndex + 1;
  while (idx < closeBraceIndex) {
    const token = tokens[idx];
    const next = nextToken(tokens, idx);
    if (token?.kind === "ident" && next?.text === ":") {
      fields.push({
        name: token.text,
        kind: "field",
        start: token.start,
        end: token.end,
        scopeStart: tokens[openBraceIndex]?.start ?? token.start,
        scopeEnd: tokens[closeBraceIndex]?.end ?? token.end,
        containerName: nameToken.text,
      });
    }
    idx += 1;
  }

  return {
    structScope: {
      name: nameToken.text,
      start: nameToken.start,
      end: nameToken.end,
      fields,
    },
    nextIndex: closeBraceIndex + 1,
  };
}

function parseFunction(tokens: Token[], startIndex: number): { functionScope: FunctionScope; nextIndex: number } | null {
  const nameToken = nextIdent(tokens, startIndex + 1);
  if (!nameToken) {
    return null;
  }
  const openParenIndex = findNextSymbol(tokens, startIndex + 1, "(");
  if (openParenIndex < 0) {
    return null;
  }
  const closeParenIndex = findMatching(tokens, openParenIndex, "(", ")");
  if (closeParenIndex < 0) {
    return null;
  }
  const bodyOpenIndex = findNextSymbol(tokens, closeParenIndex + 1, "{");
  if (bodyOpenIndex < 0) {
    return null;
  }
  const bodyCloseIndex = findMatching(tokens, bodyOpenIndex, "{", "}");
  if (bodyCloseIndex < 0) {
    return null;
  }

  const params = parseParameters(tokens, openParenIndex + 1, closeParenIndex, nameToken.text, tokens[bodyCloseIndex]?.end ?? nameToken.end);
  const locals = parseLocalBindings(
    tokens,
    bodyOpenIndex + 1,
    bodyCloseIndex,
    nameToken.text,
    tokens[bodyOpenIndex]?.end ?? nameToken.end,
    tokens[bodyCloseIndex]?.start ?? nameToken.end,
  );

  return {
    functionScope: {
      name: nameToken.text,
      start: nameToken.start,
      end: nameToken.end,
      bodyStart: tokens[bodyOpenIndex]?.end ?? nameToken.end,
      bodyEnd: tokens[bodyCloseIndex]?.start ?? nameToken.end,
      params,
      locals,
    },
    nextIndex: bodyCloseIndex + 1,
  };
}

function parseParameters(
  tokens: Token[],
  startIndex: number,
  endIndex: number,
  fnName: string,
  scopeEnd: number,
): SymbolDef[] {
  const params: SymbolDef[] = [];
  for (let idx = startIndex; idx < endIndex; idx += 1) {
    const token = tokens[idx];
    const previous = previousToken(tokens, idx);
    const next = nextToken(tokens, idx);
    if (token?.kind === "ident" && next?.text === ":") {
      params.push({
        name: token.text,
        kind: "parameter",
        start: token.start,
        end: token.end,
        scopeStart: token.start,
        scopeEnd,
        containerName: fnName,
      });
      continue;
    }
    if (token?.kind === "ident" && previous?.text === "[" && next?.text === "]") {
      params.push({
        name: token.text,
        kind: "parameter",
        start: token.start,
        end: token.end,
        scopeStart: token.start,
        scopeEnd,
        containerName: fnName,
      });
    }
  }
  return params;
}

function parseLocalBindings(
  tokens: Token[],
  startIndex: number,
  endIndex: number,
  fnName: string,
  scopeStart: number,
  scopeEnd: number,
): SymbolDef[] {
  const locals: SymbolDef[] = [];
  let idx = startIndex;
  while (idx < endIndex) {
    const token = tokens[idx];
    if (isKeyword(token, "let")) {
      const parsed = parseBindingSite(tokens, idx + 1, "local", scopeStart, scopeEnd, fnName);
      locals.push(...parsed.symbols);
      idx = parsed.nextIndex;
      continue;
    }
    idx += 1;
  }
  return locals;
}

function parseReadBindings(
  tokens: Token[],
  startIndex: number,
  scopeEnd: number,
): { symbols: SymbolDef[]; nextIndex: number } {
  let idx = startIndex + 1;
  while (idx < tokens.length && !isKeyword(tokens[idx], "to") && tokens[idx]?.kind !== "eof") {
    idx += 1;
  }
  if (!isKeyword(tokens[idx], "to")) {
    return { symbols: [], nextIndex: startIndex + 1 };
  }
  return parseBindingSite(tokens, idx + 1, "global", tokens[startIndex]?.start ?? 0, scopeEnd);
}

function parseBindingSite(
  tokens: Token[],
  startIndex: number,
  kind: "local" | "global",
  scopeStart: number,
  scopeEnd: number,
  containerName?: string,
): { symbols: SymbolDef[]; nextIndex: number } {
  const parsed = parseBindingPattern(tokens, startIndex);
  return {
    symbols: parsed.names.map((token) =>
      makeSymbolDef(token.text, kind, token.start, token.end, scopeStart, scopeEnd, containerName)),
    nextIndex: parsed.nextIndex,
  };
}

function parseBindingPattern(tokens: Token[], startIndex: number): { names: Token[]; nextIndex: number } {
  const token = tokens[startIndex];
  if (!token) {
    return { names: [], nextIndex: startIndex };
  }
  if (token.text === "(") {
    let idx = startIndex + 1;
    const names: Token[] = [];
    while (idx < tokens.length && tokens[idx]?.text !== ")") {
      const inner = parseBindingPattern(tokens, idx);
      names.push(...inner.names);
      idx = inner.nextIndex;
      if (tokens[idx]?.text === ",") {
        idx += 1;
      }
    }
    return { names, nextIndex: idx + 1 };
  }
  if (token.kind === "ident") {
    if (tokens[startIndex + 1]?.text === ".") {
      return { names: [], nextIndex: startIndex + 3 };
    }
    return { names: [token], nextIndex: startIndex + 1 };
  }
  return { names: [], nextIndex: startIndex + 1 };
}

function toSymbolDef(fn: FunctionScope): SymbolDef {
  return {
    name: fn.name,
    kind: "function",
    start: fn.start,
    end: fn.end,
    scopeStart: fn.start,
    scopeEnd: fn.bodyEnd,
  };
}

function toStructSymbolDef(structScope: StructScope | undefined): SymbolDef | null {
  if (!structScope) {
    return null;
  }
  return {
    name: structScope.name,
    kind: "struct",
    start: structScope.start,
    end: structScope.end,
    scopeStart: structScope.start,
    scopeEnd: structScope.end,
  };
}

function lexDocument(source: string): Token[] {
  const tokens: Token[] = [];
  let idx = 0;
  while (idx < source.length) {
    const char = source[idx] ?? "";
    if (/\s/.test(char)) {
      idx += 1;
      continue;
    }
    if (char === "/" && source[idx + 1] === "/") {
      idx += 2;
      while (idx < source.length && source[idx] !== "\n") {
        idx += 1;
      }
      continue;
    }
    if (SYMBOLS.has(char)) {
      tokens.push({ kind: "symbol", text: char, start: idx, end: idx + 1 });
      idx += 1;
      continue;
    }
    if (char === "\"") {
      const start = idx;
      idx += 1;
      while (idx < source.length) {
        const current = source[idx] ?? "";
        if (current === "\\") {
          idx += 2;
          continue;
        }
        idx += 1;
        if (current === "\"") {
          break;
        }
      }
      tokens.push({ kind: "string", text: source.slice(start, idx), start, end: idx });
      continue;
    }
    if (isDigit(char)) {
      const start = idx;
      idx += 1;
      while (idx < source.length && isDigit(source[idx] ?? "")) {
        idx += 1;
      }
      let kind: TokenKind = "int";
      if (source[idx] === ".") {
        kind = "float";
        idx += 1;
        while (idx < source.length && isDigit(source[idx] ?? "")) {
          idx += 1;
        }
      }
      if ((source[idx] === "e" || source[idx] === "E")
        && (isDigit(source[idx + 1] ?? "")
          || ((source[idx + 1] === "+" || source[idx + 1] === "-") && isDigit(source[idx + 2] ?? "")))) {
        kind = "float";
        idx += 1;
        if (source[idx] === "+" || source[idx] === "-") {
          idx += 1;
        }
        while (idx < source.length && isDigit(source[idx] ?? "")) {
          idx += 1;
        }
      }
      tokens.push({ kind, text: source.slice(start, idx), start, end: idx });
      continue;
    }
    if (isIdentStart(char)) {
      const start = idx;
      idx += 1;
      while (idx < source.length && isIdentPart(source[idx] ?? "")) {
        idx += 1;
      }
      const text = source.slice(start, idx);
      tokens.push({
        kind: KEYWORDS.has(text) ? "keyword" : "ident",
        text,
        start,
        end: idx,
      });
      continue;
    }
    tokens.push({ kind: "unknown", text: char, start: idx, end: idx + 1 });
    idx += 1;
  }
  tokens.push({ kind: "eof", text: "", start: source.length, end: source.length });
  return tokens;
}

function findTokenIndex(tokens: Token[], offset: number): number {
  const inside = tokens.findIndex((token) => offset >= token.start && offset < token.end);
  if (inside >= 0) {
    return inside;
  }
  return tokens.findIndex((token) => offset > token.start && offset <= token.end);
}

function previousToken(tokens: Token[], index: number): Token | undefined {
  for (let idx = index - 1; idx >= 0; idx -= 1) {
    const token = tokens[idx];
    if (token?.kind !== "eof") {
      return token;
    }
  }
  return undefined;
}

function nextToken(tokens: Token[], index: number): Token | undefined {
  for (let idx = index + 1; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (token?.kind !== "eof") {
      return token;
    }
  }
  return undefined;
}

function nextIdent(tokens: Token[], startIndex: number): Token | undefined {
  for (let idx = startIndex; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (token?.kind === "ident") {
      return token;
    }
    if (token?.kind === "eof") {
      return undefined;
    }
  }
  return undefined;
}

function findNextSymbol(tokens: Token[], startIndex: number, symbol: string): number {
  for (let idx = startIndex; idx < tokens.length; idx += 1) {
    if (tokens[idx]?.text === symbol) {
      return idx;
    }
  }
  return -1;
}

function findMatching(tokens: Token[], startIndex: number, openText: string, closeText: string): number {
  let depth = 0;
  for (let idx = startIndex; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (token?.text === openText) {
      depth += 1;
    } else if (token?.text === closeText) {
      depth -= 1;
      if (depth === 0) {
        return idx;
      }
    }
  }
  return -1;
}

function isKeyword(token: Token | undefined, keyword: string): boolean {
  return token?.kind === "keyword" && token.text === keyword;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isIdentStart(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_";
}

function isIdentPart(char: string): boolean {
  return isIdentStart(char) || isDigit(char);
}

function makeSymbolDef(
  name: string,
  kind: SymbolKind,
  start: number,
  end: number,
  scopeStart: number,
  scopeEnd: number,
  containerName?: string,
): SymbolDef {
  return {
    name,
    kind,
    start,
    end,
    scopeStart,
    scopeEnd,
    ...(containerName ? { containerName } : {}),
  };
}
