export type NodeId = number;
export type Type = {
    tag: "int";
} | {
    tag: "float";
} | {
    tag: "void";
} | {
    tag: "array";
    element: Type;
    dims: number;
} | {
    tag: "named";
    name: string;
};
export type BinOp = "+" | "-" | "*" | "/" | "%";
export type UnOp = "-";
export type GasLimit = number | "inf";
//# sourceMappingURL=types.d.ts.map