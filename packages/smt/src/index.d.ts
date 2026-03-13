export type SExpr = string | SExpr[];
export type Z3Status = "sat" | "unsat" | "unknown" | "other";
export type Z3CheckResult = {
    ok: true;
    output: string;
    status: Z3Status;
} | {
    ok: false;
    error: string;
};
export type Z3ValuesResult = {
    ok: true;
    output: string;
    status: Z3Status;
    values: Map<string, string> | null;
} | {
    ok: false;
    error: string;
};
export declare const INT32_MIN = -2147483648;
export declare const INT32_MAX = 2147483647;
export declare function buildZ3BasePrelude(): string[];
export declare function buildJplInt32Prelude(): string[];
export declare function buildJplScalarPrelude(): string[];
export declare function sanitizeSymbol(name: string): string;
export declare function checkSat(lines: string[]): Z3CheckResult;
export declare function checkSatAndGetValues(lines: string[], symbols: string[]): Z3ValuesResult;
export declare function parseGetValueOutput(output: string): Map<string, string> | null;
export declare function parseZ3Int(value: string): number | null;
//# sourceMappingURL=index.d.ts.map