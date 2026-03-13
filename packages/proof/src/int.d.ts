export type IntRefineExpr = {
    tag: "int_lit";
    value: number;
} | {
    tag: "var";
    name: string;
} | {
    tag: "sat_add";
    left: IntRefineExpr;
    right: IntRefineExpr;
} | {
    tag: "sat_sub";
    left: IntRefineExpr;
    right: IntRefineExpr;
} | {
    tag: "sat_mul";
    left: IntRefineExpr;
    right: IntRefineExpr;
} | {
    tag: "sat_neg";
    operand: IntRefineExpr;
} | {
    tag: "total_div";
    left: IntRefineExpr;
    right: IntRefineExpr;
} | {
    tag: "total_mod";
    left: IntRefineExpr;
    right: IntRefineExpr;
} | {
    tag: "call";
    name: string;
    args: IntRefineExpr[];
    interpreted: boolean;
};
export type RecursiveIntRefineExpr = {
    tag: "int_lit";
    value: number;
} | {
    tag: "var";
    name: string;
} | {
    tag: "sat_add";
    left: RecursiveIntRefineExpr;
    right: RecursiveIntRefineExpr;
} | {
    tag: "sat_sub";
    left: RecursiveIntRefineExpr;
    right: RecursiveIntRefineExpr;
} | {
    tag: "sat_mul";
    left: RecursiveIntRefineExpr;
    right: RecursiveIntRefineExpr;
} | {
    tag: "sat_neg";
    operand: RecursiveIntRefineExpr;
} | {
    tag: "total_div";
    left: RecursiveIntRefineExpr;
    right: RecursiveIntRefineExpr;
} | {
    tag: "total_mod";
    left: RecursiveIntRefineExpr;
    right: RecursiveIntRefineExpr;
} | {
    tag: "call";
    name: string;
    args: RecursiveIntRefineExpr[];
    interpreted: boolean;
} | {
    tag: "rec";
    args: IntRefineExpr[];
    currentRes: RecursiveIntRefineExpr;
};
export declare function isSupportedIntBuiltin(name: string, arity: number): boolean;
export declare function substituteIntExpr(expr: IntRefineExpr, substitution: Map<string, IntRefineExpr>): IntRefineExpr;
export declare function substituteRecursiveExpr(expr: RecursiveIntRefineExpr, substitution: Map<string, RecursiveIntRefineExpr>): RecursiveIntRefineExpr;
export declare function asPlainIntExpr(expr: RecursiveIntRefineExpr): IntRefineExpr | null;
export declare function emitIntExpr(expr: IntRefineExpr): string;
export declare function emitCollapseCondition(args: IntRefineExpr[], paramNames: string[]): string;
export declare function renderIntExpr(expr: IntRefineExpr): string;
export declare function collectRecursiveSites(expr: RecursiveIntRefineExpr): Array<{
    args: IntRefineExpr[];
}>;
export declare function collectRecursiveCallPatterns(expr: RecursiveIntRefineExpr, patterns: Map<string, IntRefineExpr[]>): void;
export declare function collectCallsRecursive(expr: RecursiveIntRefineExpr, calls: Map<string, number>): void;
export declare function serializeRecArgs(args: IntRefineExpr[]): string;
export declare function uniqueExprs(exprs: IntRefineExpr[]): IntRefineExpr[];
export declare function collectSummaryVars(baselineParamNames: string[], baselineExpr: IntRefineExpr, refinedExpr: IntRefineExpr): string[];
export declare function collectExprVars(expr: IntRefineExpr, vars: Set<string>): void;
export declare function collectCalls(expr: IntRefineExpr, calls: Map<string, number>): void;
export declare function queryIntCounterexample(lines: string[], vars: string[]): string | null;
export declare function queryIntValues(lines: string[], vars: string[]): Map<string, number> | null;
export declare function formatIntAssignments(names: string[], values: Map<string, number>): string | null;
//# sourceMappingURL=int.d.ts.map