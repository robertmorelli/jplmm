export const INT_T = { tag: "int" };
export const FLOAT_T = { tag: "float" };
export const VOID_T = { tag: "void" };
export function isIntType(t) {
    return t.tag === "int";
}
export function isFloatType(t) {
    return t.tag === "float";
}
export function isNumericType(t) {
    return t.tag === "int" || t.tag === "float";
}
//# sourceMappingURL=types.js.map