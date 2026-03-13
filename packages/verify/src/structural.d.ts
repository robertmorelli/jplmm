import type { Expr, Stmt } from "@jplmm/ast";
type StructuralCheck = {
    ok: boolean;
    reason: string;
};
export declare function checkStructuralDecrease(paramName: string, radExpr: Expr, recArgs: Expr[]): StructuralCheck;
export declare function collectRecArgs(expr: Expr, out: Expr[][]): void;
export declare function findRadExpr(stmts: Stmt[]): Expr | null;
export declare function hasRec(stmts: Stmt[]): boolean;
export declare function collectRecSites(stmts: Stmt[]): Expr[][];
export {};
//# sourceMappingURL=structural.d.ts.map