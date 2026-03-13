import type { BinOp, GasLimit, NodeId, SourceSpan, Type, UnOp } from "./types";
export type FunctionKeyword = "fun" | "fn" | "def" | "ref";
export type Binding = SourceSpan & {
    name: string;
    expr: Expr;
};
export type Param = SourceSpan & {
    name: string;
    type: Type;
};
export type StructField = SourceSpan & {
    name: string;
    type: Type;
};
export type LValue = (SourceSpan & {
    tag: "var";
    name: string;
}) | (SourceSpan & {
    tag: "tuple";
    items: LValue[];
}) | (SourceSpan & {
    tag: "field";
    base: string;
    field: string;
});
export type Argument = (SourceSpan & {
    tag: "var";
    name: string;
}) | (SourceSpan & {
    tag: "tuple";
    items: Argument[];
});
export type Expr = (SourceSpan & {
    tag: "int_lit";
    value: number;
    id: NodeId;
}) | (SourceSpan & {
    tag: "float_lit";
    value: number;
    id: NodeId;
}) | (SourceSpan & {
    tag: "void_lit";
    id: NodeId;
}) | (SourceSpan & {
    tag: "var";
    name: string;
    id: NodeId;
}) | (SourceSpan & {
    tag: "binop";
    op: BinOp;
    left: Expr;
    right: Expr;
    id: NodeId;
}) | (SourceSpan & {
    tag: "unop";
    op: UnOp;
    operand: Expr;
    id: NodeId;
}) | (SourceSpan & {
    tag: "call";
    name: string;
    args: Expr[];
    id: NodeId;
}) | (SourceSpan & {
    tag: "index";
    array: Expr;
    indices: Expr[];
    id: NodeId;
}) | (SourceSpan & {
    tag: "field";
    target: Expr;
    field: string;
    id: NodeId;
}) | (SourceSpan & {
    tag: "struct_cons";
    name: string;
    fields: Expr[];
    id: NodeId;
}) | (SourceSpan & {
    tag: "array_cons";
    elements: Expr[];
    id: NodeId;
}) | (SourceSpan & {
    tag: "array_expr";
    bindings: Binding[];
    body: Expr;
    id: NodeId;
}) | (SourceSpan & {
    tag: "sum_expr";
    bindings: Binding[];
    body: Expr;
    id: NodeId;
}) | (SourceSpan & {
    tag: "res";
    id: NodeId;
}) | (SourceSpan & {
    tag: "rec";
    args: Expr[];
    id: NodeId;
});
export type Stmt = (SourceSpan & {
    tag: "let";
    lvalue: LValue;
    expr: Expr;
    id: NodeId;
}) | (SourceSpan & {
    tag: "ret";
    expr: Expr;
    id: NodeId;
}) | (SourceSpan & {
    tag: "rad";
    expr: Expr;
    id: NodeId;
}) | (SourceSpan & {
    tag: "gas";
    limit: GasLimit;
    id: NodeId;
});
export type Cmd = (SourceSpan & {
    tag: "fn_def";
    keyword: FunctionKeyword;
    name: string;
    params: Param[];
    retType: Type;
    body: Stmt[];
    id: NodeId;
}) | (SourceSpan & {
    tag: "let_cmd";
    lvalue: LValue;
    expr: Expr;
    id: NodeId;
}) | (SourceSpan & {
    tag: "struct_def";
    name: string;
    fields: StructField[];
    id: NodeId;
}) | (SourceSpan & {
    tag: "read_image";
    filename: string;
    target: Argument;
    id: NodeId;
}) | (SourceSpan & {
    tag: "write_image";
    expr: Expr;
    filename: string;
    id: NodeId;
}) | (SourceSpan & {
    tag: "print";
    message: string;
    id: NodeId;
}) | (SourceSpan & {
    tag: "show";
    expr: Expr;
    id: NodeId;
}) | (SourceSpan & {
    tag: "time";
    cmd: Cmd;
    id: NodeId;
});
export type Program = {
    commands: Cmd[];
};
//# sourceMappingURL=nodes.d.ts.map