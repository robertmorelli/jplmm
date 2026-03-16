export type NodeId = number;

export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;

export type SourceSpan = {
  start?: number;
  end?: number;
};

export type ScalarBounds = {
  lo: number | null;
  hi: number | null;
};

export type ArrayExtentNames = Array<string | null>;

export type Type =
  | ({ tag: "int"; bounds?: ScalarBounds } & SourceSpan)
  | ({ tag: "float"; bounds?: ScalarBounds } & SourceSpan)
  | ({ tag: "void" } & SourceSpan)
  | ({ tag: "array"; element: Type; dims: number; extentNames?: ArrayExtentNames } & SourceSpan)
  | ({ tag: "named"; name: string } & SourceSpan);

export type BinOp = "+" | "-" | "*" | "/" | "%";

export type UnOp = "-";

export type GasLimit = number | "inf";

export function scalarTag(type: Type | undefined): "int" | "float" | null {
  if (!type) {
    return null;
  }
  return type.tag === "int" || type.tag === "float" ? type.tag : null;
}

export function isNumericType(type: Type | undefined): boolean {
  return scalarTag(type) !== null;
}

export function normalizedScalarBounds(bounds: ScalarBounds | null | undefined): ScalarBounds | undefined {
  if (!bounds) {
    return undefined;
  }
  const lo = bounds.lo ?? null;
  const hi = bounds.hi ?? null;
  if (lo === null && hi === null) {
    return undefined;
  }
  return { lo, hi };
}

export function getScalarBounds(type: Type | undefined): ScalarBounds | null {
  if (!type || (type.tag !== "int" && type.tag !== "float")) {
    return null;
  }
  return normalizedScalarBounds(type.bounds) ?? null;
}

export function hasScalarBounds(type: Type | undefined): boolean {
  return getScalarBounds(type) !== null;
}

export function normalizedArrayExtentNames(names: ArrayExtentNames | null | undefined, dims: number): ArrayExtentNames | undefined {
  if (!names || names.length === 0 || dims <= 0) {
    return undefined;
  }
  const normalized = names.slice(0, dims).map((name) => name ?? null);
  while (normalized.length < dims) {
    normalized.push(null);
  }
  return normalized.some((name) => name !== null) ? normalized : undefined;
}

export function getArrayExtentNames(type: Type | undefined): ArrayExtentNames | null {
  if (!type || type.tag !== "array") {
    return null;
  }
  return normalizedArrayExtentNames(type.extentNames, type.dims) ?? null;
}

export function sameScalarBounds(left: ScalarBounds | null | undefined, right: ScalarBounds | null | undefined): boolean {
  const a = normalizedScalarBounds(left);
  const b = normalizedScalarBounds(right);
  return (a?.lo ?? null) === (b?.lo ?? null) && (a?.hi ?? null) === (b?.hi ?? null);
}

export function sameType(left: Type, right: Type): boolean {
  if (left.tag !== right.tag) {
    return false;
  }
  if (left.tag === "array" && right.tag === "array") {
    return left.dims === right.dims && sameType(left.element, right.element);
  }
  if (left.tag === "named" && right.tag === "named") {
    return left.name === right.name;
  }
  if ((left.tag === "int" || left.tag === "float") && (right.tag === "int" || right.tag === "float")) {
    return sameScalarBounds(left.bounds, right.bounds);
  }
  return true;
}

export function sameTypeShape(left: Type, right: Type): boolean {
  if (left.tag !== right.tag) {
    return false;
  }
  if (left.tag === "array" && right.tag === "array") {
    return left.dims === right.dims && sameTypeShape(left.element, right.element);
  }
  if (left.tag === "named" && right.tag === "named") {
    return left.name === right.name;
  }
  return true;
}

export function eraseScalarBounds(type: Type): Type {
  if (type.tag === "int" || type.tag === "float") {
    return { tag: type.tag };
  }
  if (type.tag === "array") {
    return {
      tag: "array",
      element: eraseScalarBounds(type.element),
      dims: type.dims,
      ...(getArrayExtentNames(type) ? { extentNames: getArrayExtentNames(type)! } : {}),
    };
  }
  if (type.tag === "named") {
    return { tag: "named", name: type.name };
  }
  return { tag: "void" };
}

export function renderType(type: Type): string {
  switch (type.tag) {
    case "int":
    case "float": {
      const bounds = getScalarBounds(type);
      if (!bounds) {
        return type.tag;
      }
      return `${type.tag}(${renderScalarBound(bounds.lo)}, ${renderScalarBound(bounds.hi)})`;
    }
    case "void":
      return "void";
    case "named":
      return type.name;
    case "array":
      return `${renderType(type.element)}${renderArraySuffixes(type)}`;
    default: {
      const _never: never = type;
      return `${_never}`;
    }
  }
}

function renderArraySuffixes(type: Extract<Type, { tag: "array" }>): string {
  const names = getArrayExtentNames(type);
  if (!names) {
    return "[]".repeat(type.dims);
  }
  return names.map((name) => `[${name ?? ""}]`).join("");
}

function renderScalarBound(value: number | null): string {
  if (value === null) {
    return "_";
  }
  if (Object.is(value, -0)) {
    return "0";
  }
  return `${value}`;
}
