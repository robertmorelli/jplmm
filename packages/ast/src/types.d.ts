export type NodeId = number;
export declare const INT32_MIN = -2147483648;
export declare const INT32_MAX = 2147483647;
export type SourceSpan = {
    start?: number;
    end?: number;
};
export type ScalarBounds = {
    lo: number | null;
    hi: number | null;
};
export type ArrayExtentNames = Array<string | null>;
export type Type = ({
    tag: "int";
    bounds?: ScalarBounds;
} & SourceSpan) | ({
    tag: "float";
    bounds?: ScalarBounds;
} & SourceSpan) | ({
    tag: "void";
} & SourceSpan) | ({
    tag: "array";
    element: Type;
    dims: number;
    extentNames?: ArrayExtentNames;
} & SourceSpan) | ({
    tag: "named";
    name: string;
} & SourceSpan);
export type BinOp = "+" | "-" | "*" | "/" | "%";
export type UnOp = "-";
export type GasLimit = number | "inf";
export declare function scalarTag(type: Type | undefined): "int" | "float" | null;
export declare function isNumericType(type: Type | undefined): boolean;
export declare function normalizedScalarBounds(bounds: ScalarBounds | null | undefined): ScalarBounds | undefined;
export declare function getScalarBounds(type: Type | undefined): ScalarBounds | null;
export declare function hasScalarBounds(type: Type | undefined): boolean;
export declare function normalizedArrayExtentNames(names: ArrayExtentNames | null | undefined, dims: number): ArrayExtentNames | undefined;
export declare function getArrayExtentNames(type: Type | undefined): ArrayExtentNames | null;
export declare function sameScalarBounds(left: ScalarBounds | null | undefined, right: ScalarBounds | null | undefined): boolean;
export declare function sameType(left: Type, right: Type): boolean;
export declare function sameTypeShape(left: Type, right: Type): boolean;
export declare function eraseScalarBounds(type: Type): Type;
export declare function renderType(type: Type): string;
//# sourceMappingURL=types.d.ts.map