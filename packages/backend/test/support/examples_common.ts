import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Cmd, Program, StructField, Type } from "@jplmm/ast";

export const examplesRoot = fileURLToPath(new URL("../../../../examples", import.meta.url));
export const ENTRY_NAME = "__codex_examples_entry";
export const DIGEST_SCALE = 1024;
export const DEFAULT_EXECUTION_SEEDS = [3, 7];

export type WrappedExample = {
  source: string;
  wrappedSource: string;
};

type GenContext = {
  program: Program;
  structDefs: Map<string, StructField[]>;
  counter: number;
};

export function collectExampleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectExampleFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jplmm")) {
      out.push(full);
    }
  }
  return out.sort();
}

export function buildWrapperSource(source: string, program: Program): string {
  const entry = findWrapperEntry(program);
  if (!entry) {
    return source;
  }

  const ctx: GenContext = {
    program,
    structDefs: new Map(program.commands.filter(isStructDef).map((cmd) => [cmd.name, cmd.fields] as const)),
    counter: 0,
  };

  const dimensionNames = collectDimensionNames(entry);
  const lines = ["", `fun ${ENTRY_NAME}(seed:int): int {`];

  for (const param of entry.params) {
    if (param.type.tag === "int" && dimensionNames.has(param.name)) {
      lines.push(`  let ${param.name} = ${dimensionValueExpr(param.name)};`);
    }
  }

  for (const param of entry.params) {
    if (param.type.tag === "array") {
      continue;
    }
    if (param.type.tag === "int" && dimensionNames.has(param.name)) {
      continue;
    }
    lines.push(`  let ${param.name} = ${valueExprForParam(param.name, param.type, ctx, [] as string[])};`);
  }

  for (let i = 0; i < entry.params.length; i += 1) {
    const param = entry.params[i]!;
    if (param.type.tag !== "array") {
      continue;
    }
    const dims = dimensionExprsForTarget(entry, param.type.dims, i + 1);
    lines.push(`  let ${param.name} = ${arrayExprForParam(param.name, param.type, dims, ctx)};`);
  }

  lines.push(`  let out = ${entry.name}(${entry.params.map((param) => param.name).join(", ")});`);
  lines.push(
    `  ret ${digestExpr(
      "out",
      entry.retType,
      dimensionExprsForTarget(entry, entry.retType.tag === "array" ? entry.retType.dims : 0),
      ctx,
    )};`,
  );
  lines.push("}");

  return `${source.trimEnd()}\n${lines.join("\n")}\n`;
}

function isFnDef(cmd: Cmd): cmd is Extract<Cmd, { tag: "fn_def" }> {
  return cmd.tag === "fn_def";
}

function isStructDef(cmd: Cmd): cmd is Extract<Cmd, { tag: "struct_def" }> {
  return cmd.tag === "struct_def";
}

function findWrapperEntry(program: Program): Extract<Cmd, { tag: "fn_def" }> | undefined {
  const functions = program.commands.filter(isFnDef);
  return functions.findLast((cmd) => cmd.name !== "main") ?? functions.at(-1);
}

function collectDimensionNames(fn: Extract<Cmd, { tag: "fn_def" }>): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < fn.params.length; i += 1) {
    const param = fn.params[i]!;
    if (param.type.tag === "array") {
      for (const name of dimensionExprsForTarget(fn, param.type.dims, i + 1)) {
        if (isIdentifier(name)) {
          out.add(name);
        }
      }
    }
  }
  if (fn.retType.tag === "array") {
    for (const name of dimensionExprsForTarget(fn, fn.retType.dims)) {
      if (isIdentifier(name)) {
        out.add(name);
      }
    }
  }
  return out;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function dimensionExprsForTarget(fn: Extract<Cmd, { tag: "fn_def" }>, dims: number, start = 0): string[] {
  if (dims === 0) {
    return [];
  }
  const intsAfter = fn.params.slice(start).filter((param) => param.type.tag === "int").map((param) => param.name);
  const intsAll = fn.params.filter((param) => param.type.tag === "int").map((param) => param.name);
  const out: string[] = [];
  for (const name of intsAfter) {
    if (out.length === dims) {
      break;
    }
    out.push(name);
  }
  for (const name of intsAll) {
    if (out.length === dims) {
      break;
    }
    if (!out.includes(name)) {
      out.push(name);
    }
  }
  while (out.length < dims) {
    out.push(String(defaultDimensionValue(`fallback_${out.length}`)));
  }
  return out;
}

function dimensionValueExpr(name: string): string {
  return String(defaultDimensionValue(name));
}

function defaultDimensionValue(name: string): number {
  if (name === "h" || name === "height" || name === "rows") {
    return 4;
  }
  if (name === "w" || name === "width" || name === "cols") {
    return 5;
  }
  if (name === "shared") {
    return 4;
  }
  return 6;
}

function valueExprForParam(name: string, type: Type, ctx: GenContext, indices: string[]): string {
  if (type.tag === "int") {
    return intValueExpr(name, indices);
  }
  if (type.tag === "float") {
    return floatValueExpr(name, indices);
  }
  if (type.tag === "named") {
    return structExpr(type.name, `${name}_value`, ctx, indices);
  }
  if (type.tag === "array") {
    const dims = new Array(type.dims).fill(0).map((_, idx) => String(defaultDimensionValue(`nested_${idx}`)));
    return arrayExprForParam(name, type, dims, ctx);
  }
  return "0";
}

function arrayExprForParam(name: string, type: Extract<Type, { tag: "array" }>, dims: string[], ctx: GenContext): string {
  const bindings = dims.map((extent, idx) => {
    const binder = `__${sanitize(name)}_${ctx.counter}_${idx}`;
    return { binder, extent };
  });
  ctx.counter += 1;
  const body = valueExprForParam(name, type.element, ctx, bindings.map((binding) => binding.binder));
  return `array [${bindings.map((binding) => `${binding.binder}:${binding.extent}`).join(", ")}] ${body}`;
}

function structExpr(name: string, salt: string, ctx: GenContext, indices: string[]): string {
  const fields = ctx.structDefs.get(name) ?? [];
  return `${name} { ${fields.map((field) => valueExprForField(name, field, salt, ctx, indices)).join(", ")} }`;
}

function valueExprForField(
  structName: string,
  field: StructField,
  salt: string,
  ctx: GenContext,
  indices: string[],
): string {
  if (field.type.tag === "int") {
    if (structName === "Pixel" || field.name === "r" || field.name === "g" || field.name === "b") {
      return intValueExpr(`${salt}_${field.name}`, indices);
    }
    return intValueExpr(`${salt}_${field.name}`, indices);
  }
  if (field.type.tag === "float") {
    return floatValueExpr(`${salt}_${field.name}`, indices);
  }
  if (field.type.tag === "named") {
    return structExpr(field.type.name, `${salt}_${field.name}`, ctx, indices);
  }
  if (field.type.tag === "array") {
    const dims = new Array(field.type.dims).fill(0).map((_, idx) => String(defaultDimensionValue(`${field.name}_${idx}`)));
    return arrayExprForParam(field.name, field.type, dims, ctx);
  }
  return "0";
}

function digestExpr(expr: string, type: Type, dims: string[], ctx: GenContext): string {
  switch (type.tag) {
    case "int":
      return expr;
    case "float":
      return `to_int((${expr}) * ${DIGEST_SCALE}.0)`;
    case "void":
      return "0";
    case "named": {
      const fields = ctx.structDefs.get(type.name) ?? [];
      if (fields.length === 0) {
        return "0";
      }
      return fields
        .map((field) => digestExpr(`${expr}.${field.name}`, field.type, dims, ctx))
        .reduce((left, right) => `(${left} + ${right})`);
    }
    case "array": {
      const extents = dims.length >= type.dims ? dims.slice(0, type.dims) : [...dims];
      while (extents.length < type.dims) {
        extents.push(String(defaultDimensionValue(`digest_${extents.length}`)));
      }
      const binders = extents.map((extent, idx) => ({
        name: `__sum_${ctx.counter}_${idx}`,
        extent,
      }));
      ctx.counter += 1;
      const indexed = `${expr}${binders.map((binder) => `[${binder.name}]`).join("")}`;
      return `sum [${binders.map((binder) => `${binder.name}:${binder.extent}`).join(", ")}] ${digestExpr(indexed, type.element, [], ctx)}`;
    }
  }
}

function intValueExpr(salt: string, indices: string[]): string {
  const value = hashedOffset(salt);
  const terms = [`abs(seed + ${value})`, ...indices.map((index, idx) => `${index} * ${idx + 2}`)];
  return `clamp(${terms.join(" + ")}, 0, 255)`;
}

function floatValueExpr(salt: string, indices: string[]): string {
  const value = hashedOffset(salt);
  const terms = [`to_float(abs(seed + ${value})) / 3.0`, ...indices.map((index, idx) => `to_float(${index}) / ${idx + 2}.0`)];
  return terms.reduce((left, right) => `(${left} + ${right})`);
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

export function hashedOffset(value: string): number {
  let hash = 17;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash % 23) + 1;
}
