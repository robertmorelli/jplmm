import { REMOVED_KEYWORDS } from "./keywords";
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
function isDigit(ch) {
    return ch >= "0" && ch <= "9";
}
function isIdentStart(ch) {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}
function isIdentPart(ch) {
    return isIdentStart(ch) || isDigit(ch);
}
export function tokenize(source) {
    const out = [];
    let i = 0;
    const at = (idx) => source[idx] ?? "";
    while (i < source.length) {
        const ch = at(i);
        if (/\s/.test(ch)) {
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
        if (isDigit(ch)) {
            const start = i;
            while (i < source.length && isDigit(at(i))) {
                i += 1;
            }
            let kind = "int";
            if (at(i) === "." && isDigit(at(i + 1))) {
                kind = "float";
                i += 1;
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
            const kind = text === "fn" ||
                text === "let" ||
                text === "ret" ||
                text === "res" ||
                text === "rec" ||
                text === "rad" ||
                text === "gas" ||
                text === "inf" ||
                text === "int" ||
                text === "float" ||
                text === "void"
                ? "keyword"
                : "ident";
            out.push({ kind, text, start, end: i });
            continue;
        }
        throw new Error(`Unexpected character '${ch}' at offset ${i}`);
    }
    out.push({ kind: "eof", text: "", start: source.length, end: source.length });
    return out;
}
export function findRemovedKeywordUsage(source) {
    const seen = new Set();
    for (const t of tokenize(source)) {
        if ((t.kind === "keyword" || t.kind === "ident") && REMOVED_KEYWORDS.has(t.text)) {
            seen.add(t.text);
        }
    }
    return [...seen].sort();
}
//# sourceMappingURL=tokenize.js.map