import type { Param, Program, Type } from "@jplmm/ast";
import { type IRExpr, type IRFunction, type IRProgram, type IRStmt, type IRStructDef } from "@jplmm/ir";
import { type ScalarExpr, type ScalarTag, type SymValue } from "./scalar";
export type IrRadWitness = {
    stmtIndex: number;
    source: IRExpr;
    measure: ScalarExpr;
    rendered: string;
};
export type IrRecSite = {
    stmtIndex: number;
    args: IRExpr[];
    argValues: Map<number, SymValue>;
    issues: string[];
    resultSymbol?: string;
    currentRes?: SymValue | null;
};
export type IrSiteProof = {
    ok: true;
    method: "smt";
    details: string;
} | {
    ok: false;
    reasons: string[];
};
export type IrProofObligation = {
    rad: IrRadWitness;
    structural: {
        ok: boolean;
        reason: string;
    };
    smt: IrSiteProof | null;
    proved: boolean;
    method: "structural" | "smt" | null;
    details: string | null;
    reasons: string[];
};
export type IrProofSiteTrace = {
    siteIndex: number;
    site: IrRecSite;
    obligations: IrProofObligation[];
    proved: boolean;
    reasons: string[];
};
export type IrStmtSemantics = {
    stmtIndex: number;
    stmtTag: IRStmt["tag"];
    rendered: string;
    value: SymValue | null;
};
export type IrFunctionAnalysis = {
    paramValues: Map<string, SymValue>;
    result: SymValue | null;
    stmtSemantics: IrStmtSemantics[];
    radSites: IrRadWitness[];
    recSites: IrRecSite[];
    callSigs: Map<string, {
        args: ScalarTag[];
        ret: ScalarTag;
    }>;
};
export declare function buildCanonicalProgram(program: Program, typeMap: Map<number, Type>): IRProgram;
export declare function functionsAlphaEquivalent(left: IRFunction, right: IRFunction): boolean;
export declare function hasRec(fn: IRFunction): boolean;
export declare function analyzeIrFunction(fn: IRFunction, structDefs?: Map<string, IRStructDef["fields"]>): IrFunctionAnalysis;
export declare function proveIrSiteWithSmt(fn: IRFunction, rad: IrRadWitness, site: IrRecSite, analysis: IrFunctionAnalysis): IrSiteProof;
export declare function checkIrStructuralDecrease(params: Param[], radExpr: IRExpr, recArgs: IRExpr[]): {
    ok: boolean;
    reason: string;
};
export declare function analyzeIrProofSites(fn: IRFunction, analysis?: IrFunctionAnalysis): IrProofSiteTrace[];
export declare function renderIrFunctionHeader(fn: IRFunction): string;
export declare function renderIrFunction(fn: IRFunction): string[];
export declare function renderIrStmt(stmt: IRStmt): string;
export declare function renderIrExpr(expr: IRExpr): string;
export declare function renderType(type: Type): string;
//# sourceMappingURL=ir.d.ts.map