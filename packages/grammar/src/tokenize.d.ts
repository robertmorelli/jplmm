export type TokenKind = "ident" | "int" | "float" | "string" | "keyword" | "symbol" | "eof";
export type Token = {
    kind: TokenKind;
    text: string;
    start: number;
    end: number;
};
export declare function tokenize(source: string): Token[];
export declare function findRemovedKeywordUsage(source: string): string[];
//# sourceMappingURL=tokenize.d.ts.map