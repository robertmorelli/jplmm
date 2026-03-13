import type { Type } from "@jplmm/ast";

export const INT_T: Type = { tag: "int" };
export const FLOAT_T: Type = { tag: "float" };
export const VOID_T: Type = { tag: "void" };

export function isIntType(t: Type): boolean {
  return t.tag === "int";
}

export function isFloatType(t: Type): boolean {
  return t.tag === "float";
}

export function isNumericType(t: Type): boolean {
  return t.tag === "int" || t.tag === "float";
}
