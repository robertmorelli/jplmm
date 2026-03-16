import { ACTIVE_KEYWORDS, REMOVED_KEYWORDS } from "./keywords";

export type TokenKind =
  | "ident"
  | "int"
  | "float"
  | "string"
  | "keyword"
  | "symbol"
  | "eof";

export type Token = {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
};

const SYMBOLS = new Set([
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ",",
  ":",
  ";",
  "=",
  "+",
  "-",
  "*",
  "/",
  "%",
  ".",
]);

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

export function tokenize(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const at = (idx: number): string => source[idx] ?? "";

  while (i < source.length) {
    const ch = at(i);
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }

    if (ch === "/" && at(i + 1) === "/") {
      i += 2;
      while (i < source.length && at(i) !== "\n") {
        i += 1;
      }
      continue;
    }

    if (SYMBOLS.has(ch)) {
      out.push({ kind: "symbol", text: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    if (ch === "\"") {
      const start = i;
      i += 1;
      let text = "";
      while (i < source.length) {
        const current = at(i);
        if (current === "\"") {
          i += 1;
          out.push({ kind: "string", text, start, end: i });
          break;
        }
        if (current === "\\") {
          const escaped = at(i + 1);
          if (escaped === "n") {
            text += "\n";
            i += 2;
            continue;
          }
          if (escaped === "r") {
            text += "\r";
            i += 2;
            continue;
          }
          if (escaped === "t") {
            text += "\t";
            i += 2;
            continue;
          }
          if (escaped === "\\" || escaped === "\"") {
            text += escaped;
            i += 2;
            continue;
          }
          throw new Error(`Unsupported string escape '\\${escaped}' at offset ${i}`);
        }
        if (current === "\n" || current === "\r") {
          throw new Error(`Unterminated string literal at offset ${start}`);
        }
        text += current;
        i += 1;
      }
      if (out[out.length - 1]?.kind !== "string") {
        throw new Error(`Unterminated string literal at offset ${start}`);
      }
      continue;
    }

    if (isDigit(ch)) {
      const start = i;
      while (i < source.length && isDigit(at(i))) {
        i += 1;
      }
      let kind: TokenKind = "int";
      if (at(i) === ".") {
        kind = "float";
        i += 1;
        while (i < source.length && isDigit(at(i))) {
          i += 1;
        }
      }
      if ((at(i) === "e" || at(i) === "E") && (isDigit(at(i + 1)) || ((at(i + 1) === "+" || at(i + 1) === "-") && isDigit(at(i + 2))))) {
        kind = "float";
        i += 1;
        if (at(i) === "+" || at(i) === "-") {
          i += 1;
        }
        while (i < source.length && isDigit(at(i))) {
          i += 1;
        }
      }
      out.push({ kind, text: source.slice(start, i), start, end: i });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && isIdentPart(at(i))) {
        i += 1;
      }
      const text = source.slice(start, i);
      const kind: TokenKind = ACTIVE_KEYWORDS.has(text) ? "keyword" : "ident";
      out.push({ kind, text, start, end: i });
      continue;
    }

    throw new Error(`Unexpected character '${ch}' at offset ${i}`);
  }

  out.push({ kind: "eof", text: "", start: source.length, end: source.length });
  return out;
}

export function findRemovedKeywordUsage(source: string): string[] {
  const seen = new Set<string>();
  for (const t of tokenize(source)) {
    if ((t.kind === "keyword" || t.kind === "ident") && REMOVED_KEYWORDS.has(t.text)) {
      seen.add(t.text);
    }
  }
  return [...seen].sort();
}
