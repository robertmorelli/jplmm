import type { IRExpr, IRFunction, IRGlobalLet, IRProgram, IRStmt } from "@jplmm/ir";
export declare function mapProgramExprs(program: IRProgram, visit: (expr: IRExpr) => IRExpr): IRProgram;
export declare function mapFunction(fn: IRFunction, visit: (expr: IRExpr) => IRExpr): IRFunction;
export declare function mapStmt(stmt: IRStmt, visit: (expr: IRExpr) => IRExpr): IRStmt;
export declare function mapExpr(expr: IRExpr, visit: (expr: IRExpr) => IRExpr): IRExpr;
export declare function mapExprChildren(expr: IRExpr, f: (expr: IRExpr) => IRExpr): IRExpr;
export declare function makeSyntheticIdFactory(program: IRProgram): () => number;
export declare function mapGlobal(global: IRGlobalLet, visit: (expr: IRExpr) => IRExpr): IRGlobalLet;
export declare function stripNanToZero(expr: IRExpr): IRExpr;
export declare function isNumericLiteral(expr: IRExpr, value?: number): boolean;
//# sourceMappingURL=utils.d.ts.map