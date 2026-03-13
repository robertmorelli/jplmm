export type NodeId = number;
export type SourceSpan = {
    start?: number;
    end?: number;
};
export type Type = ({
    tag: "int";
} & SourceSpan) | ({
    tag: "float";
} & SourceSpan) | ({
    tag: "void";
} & SourceSpan) | ({
    tag: "array";
    element: Type;
    dims: number;
} & SourceSpan) | ({
    tag: "named";
    name: string;
} & SourceSpan);
export type BinOp = "+" | "-" | "*" | "/" | "%";
export type UnOp = "-";
export type GasLimit = number | "inf";
//# sourceMappingURL=types.d.ts.map