import type { BinOp, GasLimit, NodeId, Type, UnOp } from "./types";
export type Binding = {
    name: string;
    expr: Expr;
};
export type Param = {
    name: string;
    type: Type;
};
export type StructField = {
    name: string;
    type: Type;
};
export type LValue = {
    tag: "var";
    name: string;
} | {
    tag: "tuple";
    items: LValue[];
} | {
    tag: "field";
    base: string;
    field: string;
};
export type Argument = {
    tag: "var";
    name: string;
} | {
    tag: "tuple";
    items: Argument[];
};
export type Expr = {
    tag: "int_lit";
    value: number;
    id: NodeId;
} | {
    tag: "float_lit";
    value: number;
    id: NodeId;
} | {
    tag: "void_lit";
    id: NodeId;
} | {
    tag: "var";
    name: string;
    id: NodeId;
} | {
    tag: "binop";
    op: BinOp;
    left: Expr;
    right: Expr;
    id: NodeId;
} | {
    tag: "unop";
    op: UnOp;
    operand: Expr;
    id: NodeId;
} | {
    tag: "call";
    name: string;
    args: Expr[];
    id: NodeId;
} | {
    tag: "index";
    array: Expr;
    indices: Expr[];
    id: NodeId;
} | {
    tag: "field";
    target: Expr;
    field: string;
    id: NodeId;
} | {
    tag: "struct_cons";
    name: string;
    fields: Expr[];
    id: NodeId;
} | {
    tag: "array_cons";
    elements: Expr[];
    id: NodeId;
} | {
    tag: "array_expr";
    bindings: Binding[];
    body: Expr;
    id: NodeId;
} | {
    tag: "sum_expr";
    bindings: Binding[];
    body: Expr;
    id: NodeId;
} | {
    tag: "res";
    id: NodeId;
} | {
    tag: "rec";
    args: Expr[];
    id: NodeId;
};
export type Stmt = {
    tag: "let";
    lvalue: LValue;
    expr: Expr;
    id: NodeId;
} | {
    tag: "ret";
    expr: Expr;
    id: NodeId;
} | {
    tag: "rad";
    expr: Expr;
    id: NodeId;
} | {
    tag: "gas";
    limit: GasLimit;
    id: NodeId;
};
export type Cmd = {
    tag: "fn_def";
    name: string;
    params: Param[];
    retType: Type;
    body: Stmt[];
    id: NodeId;
} | {
    tag: "let_cmd";
    lvalue: LValue;
    expr: Expr;
    id: NodeId;
} | {
    tag: "struct_def";
    name: string;
    fields: StructField[];
    id: NodeId;
} | {
    tag: "read_image";
    filename: string;
    target: Argument;
    id: NodeId;
} | {
    tag: "write_image";
    expr: Expr;
    filename: string;
    id: NodeId;
} | {
    tag: "print";
    message: string;
    id: NodeId;
} | {
    tag: "show";
    expr: Expr;
    id: NodeId;
} | {
    tag: "time";
    cmd: Cmd;
    id: NodeId;
};
export type Program = {
    commands: Cmd[];
};
//# sourceMappingURL=nodes.d.ts.map
