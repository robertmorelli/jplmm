import type { Expr, Param, Stmt } from "@jplmm/ast";
type StructuralCheck = {
    ok: boolean;
    reason: string;
};
export declare function checkStructuralDecrease(params: Param[], radExpr: Expr, recArgs: Expr[]): StructuralCheck;
export declare function collectRecArgs(expr: Expr, out: Expr[][]): void;
export declare function findRadExprs(stmts: Stmt[]): Expr[];
export declare function hasRec(stmts: Stmt[]): boolean;
export declare function collectRecSites(stmts: Stmt[]): Expr[][];
export {};
//# sourceMappingURL=structural.d.ts.map