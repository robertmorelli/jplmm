import type { BinOp, FunctionKeyword, GasLimit, NodeId, Param, StructField, Type, UnOp } from "@jplmm/ast";
export type IRBinding = {
    name: string;
    expr: IRExpr;
};
export type IRExpr = {
    tag: "int_lit";
    value: number;
    id: NodeId;
    resultType: Type;
} | {
    tag: "float_lit";
    value: number;
    id: NodeId;
    resultType: Type;
} | {
    tag: "void_lit";
    id: NodeId;
    resultType: Type;
} | {
    tag: "var";
    name: string;
    id: NodeId;
    resultType: Type;
} | {
    tag: "binop";
    op: BinOp;
    left: IRExpr;
    right: IRExpr;
    id: NodeId;
    resultType: Type;
} | {
    tag: "unop";
    op: UnOp;
    operand: IRExpr;
    id: NodeId;
    resultType: Type;
} | {
    tag: "call";
    name: string;
    args: IRExpr[];
    id: NodeId;
    resultType: Type;
} | {
    tag: "index";
    array: IRExpr;
    indices: IRExpr[];
    id: NodeId;
    resultType: Type;
} | {
    tag: "field";
    target: IRExpr;
    field: string;
    id: NodeId;
    resultType: Type;
} | {
    tag: "struct_cons";
    name: string;
    fields: IRExpr[];
    id: NodeId;
    resultType: Type;
} | {
    tag: "array_cons";
    elements: IRExpr[];
    id: NodeId;
    resultType: Type;
} | {
    tag: "array_expr";
    bindings: IRBinding[];
    body: IRExpr;
    id: NodeId;
    resultType: Type;
} | {
    tag: "sum_expr";
    bindings: IRBinding[];
    body: IRExpr;
    id: NodeId;
    resultType: Type;
} | {
    tag: "res";
    id: NodeId;
    resultType: Type;
} | {
    tag: "rec";
    args: IRExpr[];
    id: NodeId;
    resultType: Type;
    tailPosition: boolean;
} | {
    tag: "total_div";
    left: IRExpr;
    right: IRExpr;
    id: NodeId;
    resultType: Type;
    zeroDivisorValue: 0;
} | {
    tag: "total_mod";
    left: IRExpr;
    right: IRExpr;
    id: NodeId;
    resultType: Type;
    zeroDivisorValue: 0;
} | {
    tag: "nan_to_zero";
    value: IRExpr;
    id: NodeId;
    resultType: Type;
} | {
    tag: "sat_add";
    left: IRExpr;
    right: IRExpr;
    id: NodeId;
    resultType: Type;
} | {
    tag: "sat_sub";
    left: IRExpr;
    right: IRExpr;
    id: NodeId;
    resultType: Type;
} | {
    tag: "sat_mul";
    left: IRExpr;
    right: IRExpr;
    id: NodeId;
    resultType: Type;
} | {
    tag: "sat_neg";
    operand: IRExpr;
    id: NodeId;
    resultType: Type;
};
export type IRStmt = {
    tag: "let";
    name: string;
    expr: IRExpr;
    id: NodeId;
} | {
    tag: "ret";
    expr: IRExpr;
    id: NodeId;
} | {
    tag: "rad";
    expr: IRExpr;
    id: NodeId;
} | {
    tag: "gas";
    limit: GasLimit;
    id: NodeId;
};
export type IRFunction = {
    name: string;
    keyword: FunctionKeyword;
    params: Param[];
    retType: Type;
    body: IRStmt[];
    id: NodeId;
};
export type IRGlobalLet = {
    tag: "let_cmd";
    name: string;
    expr: IRExpr;
    id: NodeId;
};
export type IRStructDef = {
    name: string;
    fields: StructField[];
    id: NodeId;
};
export type IRProgram = {
    structs: IRStructDef[];
    functions: IRFunction[];
    globals: IRGlobalLet[];
};
//# sourceMappingURL=nodes.d.ts.map