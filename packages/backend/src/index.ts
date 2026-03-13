import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Param, Type } from "@jplmm/ast";
import type { IRExpr, IRFunction, IRProgram, IRStmt, IRStructDef } from "@jplmm/ir";
import type {
  ClosedFormImplementation,
  LutImplementation,
  OptimizeArtifacts,
} from "@jplmm/optimize";

export * from "./native";

export type EmitWatOptions = {
  tailCalls?: boolean;
  artifacts?: OptimizeArtifacts;
  exportFunctions?: boolean;
  exportMemory?: boolean;
};

type FuelStorage =
  | {
      kind: "local" | "param";
      name: string;
      limit: number;
    }
  | null;

type EmitFunctionContext = {
  fn: IRFunction;
  wasmName: string;
  publicName: string;
  tailTargetName: string;
  exportName: string | undefined;
  useTailCalls: boolean;
  loopLabel: string | null;
  fuel: FuelStorage;
  structs: Map<string, IRStructDef>;
};

type LutLayout = {
  impl: LutImplementation;
  offset: number;
};

type MemoryPlan = {
  lutLayouts: Map<string, LutLayout>;
  heapBase: number;
  initialPages: number;
  dataLines: string[];
};

export type CompileWatOptions = {
  tailCalls?: boolean;
  wat2wasmPath?: string;
};

export type InstantiateWatOptions = CompileWatOptions & {
  imports?: WebAssembly.Imports;
};

const FUEL_NAME = "jplmm_fuel";

export function emitWatModule(program: IRProgram, options: EmitWatOptions = {}): string {
  const structs = new Map(program.structs.map((struct) => [struct.name, struct] as const));
  const memoryPlan = planMemory(options.artifacts);
  const importBlock = emitMathImports();
  const helperBlock = emitHelpers(program, memoryPlan.heapBase);
  const memoryBlock = emitMemoryBlock(memoryPlan, options.exportMemory === true);
  const functions = program.functions
    .map((fn) => emitFunctionSet(fn, options, memoryPlan.lutLayouts, structs))
    .filter(Boolean)
    .join("\n\n");
  return `(module
${importBlock ? `${indent(importBlock, 1)}\n` : ""}\
${indent(helperBlock, 1)}
${memoryBlock ? `\n${indent(memoryBlock, 1)}` : ""}
${functions ? `\n${indent(functions, 1)}` : ""}
)`;
}

export const packageName = "@jplmm/backend";

function emitFunctionSet(
  fn: IRFunction,
  options: EmitWatOptions,
  lutLayouts: Map<string, LutLayout>,
  structs: Map<string, IRStructDef>,
): string {
  const implementation = options.artifacts?.implementations.get(fn.name);
  if (implementation?.tag === "closed_form_linear_countdown") {
    return emitClosedFormFunction(fn, implementation, options);
  }
  if (implementation?.tag === "lut") {
    const layout = lutLayouts.get(fn.name);
    if (layout) {
      return emitLutFunctionSet(fn, layout, options, structs);
    }
  }
  return emitPlainFunctionSet(fn, options, {
    wasmName: fn.name,
    publicName: fn.name,
    exportName: options.exportFunctions === true ? fn.name : undefined,
    allowTailCalls: true,
    structs,
  });
}

function emitPlainFunctionSet(
  fn: IRFunction,
  options: EmitWatOptions,
  target: {
    wasmName: string;
    publicName: string;
    exportName: string | undefined;
    allowTailCalls: boolean;
    structs: Map<string, IRStructDef>;
  },
): string {
  const gasLimit = getFiniteGasLimit(fn);
  const hasTailRec = findTailRecStmt(fn.body) !== null;
  const wantTailCalls = target.allowTailCalls && hasTailRec && options.tailCalls !== false;

  if (wantTailCalls && gasLimit !== null) {
    const helperName = `${target.wasmName}__tail`;
    return [emitGasTailWrapper(fn, target.wasmName, target.exportName, helperName, gasLimit), emitFunctionBody({
      fn,
      wasmName: helperName,
      publicName: target.publicName,
      tailTargetName: helperName,
      exportName: undefined,
      useTailCalls: true,
      loopLabel: null,
      fuel: {
        kind: "param",
        name: FUEL_NAME,
        limit: gasLimit,
      },
      structs: target.structs,
    })].join("\n\n");
  }

  return emitFunctionBody({
    fn,
    wasmName: target.wasmName,
    publicName: target.publicName,
    tailTargetName: target.wasmName,
    exportName: target.exportName,
    useTailCalls: wantTailCalls,
    loopLabel: wantTailCalls ? null : hasTailRec ? `${target.wasmName}__loop` : null,
    fuel: gasLimit === null ? null : { kind: "local", name: FUEL_NAME, limit: gasLimit },
    structs: target.structs,
  });
}

function emitClosedFormFunction(
  fn: IRFunction,
  implementation: ClosedFormImplementation,
  options: EmitWatOptions,
): string {
  const param = fn.params[implementation.paramIndex];
  if (!param) {
    throw new Error(`Closed-form lowering failed for '${fn.name}'`);
  }

  const exportClause = options.exportFunctions === true ? ` (export "${fn.name}")` : "";
  const body = `
local.get $${param.name}
i32.const 0
i32.le_s
if (result i32)
  i32.const 1
else
  local.get $${param.name}
  i32.const ${implementation.decrement - 1}
  call $jplmm_sat_add_i32
  i32.const ${implementation.decrement}
  call $jplmm_total_div_i32
  i32.const 1
  call $jplmm_sat_add_i32
end
local.set $jplmm_steps
i32.const ${implementation.baseValue}
i32.const ${implementation.stepValue}
local.get $jplmm_steps
call $jplmm_sat_mul_i32
call $jplmm_sat_add_i32`.trim();

  return `(func $${fn.name}${exportClause} (param $${param.name} i32) (result i32)
  (local $jplmm_steps i32)
${indent(body, 1)}
)`;
}

function emitLutFunctionSet(
  fn: IRFunction,
  layout: LutLayout,
  options: EmitWatOptions,
  structs: Map<string, IRStructDef>,
): string {
  const genericName = `${fn.name}__generic`;
  const exportClause = options.exportFunctions === true ? ` (export "${fn.name}")` : "";
  const wrapper = `(func $${fn.name}${exportClause} ${fn.params
    .map((param) => `(param $${param.name} ${wasmType(param.type)})`)
    .join(" ")} (result ${wasmType(fn.retType)})
  (local $jplmm_lut_index i32)
${indent(emitLutWrapperBody(fn, layout), 1)}
)`;

  const fallback = emitPlainFunctionSet(
    fn,
    {
      ...options,
      tailCalls: false,
    },
    {
      wasmName: genericName,
      publicName: fn.name,
      exportName: undefined,
      allowTailCalls: false,
      structs,
    },
  );

  return [wrapper, fallback].join("\n\n");
}

function emitGasTailWrapper(
  fn: IRFunction,
  wasmName: string,
  exportName: string | undefined,
  helperName: string,
  gasLimit: number,
): string {
  const params = fn.params.map((param) => `(param $${param.name} ${wasmType(param.type)})`).join(" ");
  const result = fn.retType.tag === "void" ? "" : ` (result ${wasmType(fn.retType)})`;
  const exportClause = exportName ? ` (export "${exportName}")` : "";
  const body = [
    ...fn.params.map((param) => `local.get $${param.name}`),
    `i32.const ${gasLimit}`,
    `call $${helperName}`,
  ].join("\n");

  return `(func $${wasmName}${exportClause} ${params}${result}
${indent(body, 1)}
)`;
}

function emitFunctionBody(ctx: EmitFunctionContext): string {
  const params = emitParamDecls(ctx);
  const result = ctx.fn.retType.tag === "void" ? "" : ` (result ${wasmType(ctx.fn.retType)})`;
  const localDecls = collectLocalDecls(ctx);
  const exportClause = ctx.exportName ? ` (export "${ctx.exportName}")` : "";
  const lines: string[] = [];

  if (ctx.fuel?.kind === "local") {
    lines.push(`i32.const ${ctx.fuel.limit}`);
    lines.push(`local.set $${ctx.fuel.name}`);
  }

  const stmtBody = emitStatements(ctx);
  if (ctx.loopLabel) {
    lines.push(`loop $${ctx.loopLabel}`);
    lines.push(indent(stmtBody, 1));
    lines.push("end");
  } else if (stmtBody) {
    lines.push(stmtBody);
  }

  if (ctx.fn.retType.tag !== "void") {
    lines.push("local.get $res");
  }

  return `(func $${ctx.wasmName}${exportClause} ${params}${result}
${localDecls ? `${indent(localDecls, 1)}\n` : ""}${indent(lines.join("\n"), 1)}
)`;
}

function emitStatements(ctx: EmitFunctionContext): string {
  const chunks: string[] = [];

  for (const stmt of ctx.fn.body) {
    if (stmt.tag === "gas" || stmt.tag === "rad") {
      continue;
    }

    if (stmt.tag === "let") {
      chunks.push(`${emitExpr(stmt.expr, ctx)}\nlocal.set $${stmt.name}`);
      continue;
    }

    if (stmt.tag === "ret" && stmt.expr.tag === "rec" && stmt.expr.tailPosition) {
      chunks.push(emitTailRecStmt(stmt.expr, ctx));
      break;
    }

    if (stmt.tag === "ret") {
      chunks.push(`${emitExpr(stmt.expr, ctx)}\nlocal.set $res`);
    }
  }

  return chunks.filter(Boolean).join("\n");
}

function emitTailRecStmt(expr: Extract<IRExpr, { tag: "rec" }>, ctx: EmitFunctionContext): string {
  const lines: string[] = [];

  lines.push(emitRecArgStores(expr, ctx));
  lines.push(emitRecCollapseCondition(expr, ctx));
  lines.push("if");
  lines.push(indent(emitReturnCurrentRes(ctx.fn.retType), 1));
  lines.push("end");

  if (ctx.fuel) {
    lines.push(`local.get $${ctx.fuel.name}`);
    lines.push("i32.eqz");
    lines.push("if");
    lines.push(indent(emitReturnCurrentRes(ctx.fn.retType), 1));
    lines.push("end");
    lines.push(`local.get $${ctx.fuel.name}`);
    lines.push("i32.const 1");
    lines.push("i32.sub");
    lines.push(`local.set $${ctx.fuel.name}`);
  }

  if (ctx.useTailCalls) {
    lines.push(...emitRecArgLoads(expr));
    if (ctx.fuel?.kind === "param") {
      lines.push(`local.get $${ctx.fuel.name}`);
    }
    lines.push(`return_call $${ctx.tailTargetName}`);
    return lines.join("\n");
  }

  for (let i = 0; i < ctx.fn.params.length; i += 1) {
    lines.push(`local.get $${recArgLocal(expr.id, i)}`);
    lines.push(`local.set $${ctx.fn.params[i]!.name}`);
  }
  if (!ctx.loopLabel) {
    throw new Error(`Internal error: explicit loop lowering missing loop label for '${ctx.fn.name}'`);
  }
  lines.push(`br $${ctx.loopLabel}`);
  return lines.join("\n");
}

function emitExpr(expr: IRExpr, ctx: EmitFunctionContext): string {
  switch (expr.tag) {
    case "int_lit":
      return `i32.const ${expr.value}`;
    case "float_lit":
      return `f32.const ${Number.isFinite(expr.value) ? expr.value : 0}`;
    case "void_lit":
      return expr.resultType.tag === "float" ? "f32.const 0" : "i32.const 0";
    case "var":
      return `local.get $${expr.name}`;
    case "res":
      return "local.get $res";
    case "binop":
      return `${emitExpr(expr.left, ctx)}
${emitExpr(expr.right, ctx)}
${rawBinop(expr.op, expr.resultType)}`;
    case "unop":
      return `${emitExpr(expr.operand, ctx)}
${expr.resultType.tag === "int" ? "i32.const -1\ni32.mul" : "f32.neg"}`;
    case "call":
      return emitCall(expr.name, expr.args.map((arg) => emitExpr(arg, ctx)), expr.resultType);
    case "rec":
      return emitNonTailRecExpr(expr, ctx);
    case "total_div":
      return `${emitExpr(expr.left, ctx)}
${emitExpr(expr.right, ctx)}
call $${expr.resultType.tag === "float" ? "jplmm_total_div_f32" : "jplmm_total_div_i32"}`;
    case "total_mod":
      return `${emitExpr(expr.left, ctx)}
${emitExpr(expr.right, ctx)}
call $${expr.resultType.tag === "float" ? "jplmm_total_mod_f32" : "jplmm_total_mod_i32"}`;
    case "nan_to_zero":
      return `${emitExpr(expr.value, ctx)}
call $jplmm_nan_to_zero_f32`;
    case "sat_add":
      return `${emitExpr(expr.left, ctx)}
${emitExpr(expr.right, ctx)}
call $jplmm_sat_add_i32`;
    case "sat_sub":
      return `${emitExpr(expr.left, ctx)}
${emitExpr(expr.right, ctx)}
call $jplmm_sat_sub_i32`;
    case "sat_mul":
      return `${emitExpr(expr.left, ctx)}
${emitExpr(expr.right, ctx)}
call $jplmm_sat_mul_i32`;
    case "sat_neg":
      return `${emitExpr(expr.operand, ctx)}
call $jplmm_sat_neg_i32`;
    case "field":
      return emitFieldExpr(expr, ctx);
    case "struct_cons":
      return emitStructConsExpr(expr, ctx);
    case "array_cons":
      return emitArrayConsExpr(expr, ctx);
    case "array_expr":
      return emitArrayExpr(expr, ctx);
    case "sum_expr":
      return emitSumExpr(expr, ctx);
    case "index":
      return emitIndexExpr(expr, ctx);
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}

function emitFieldExpr(expr: Extract<IRExpr, { tag: "field" }>, ctx: EmitFunctionContext): string {
  const targetType = expr.target.resultType;
  if (targetType.tag !== "named") {
    throw new Error(`Field access requires a struct target in '${ctx.fn.name}'`);
  }
  const structDef = ctx.structs.get(targetType.name);
  if (!structDef) {
    throw new Error(`Unknown struct '${targetType.name}' in WAT lowering`);
  }
  const fieldIndex = structDef.fields.findIndex((field) => field.name === expr.field);
  if (fieldIndex < 0) {
    throw new Error(`Unknown field '${expr.field}' on struct '${targetType.name}'`);
  }
  const baseLocal = tempLocal(expr.id, "field_base");
  return `${emitExpr(expr.target, ctx)}
local.set $${baseLocal}
local.get $${baseLocal}
i32.eqz
if
  unreachable
end
${emitLoadWord(expr.resultType, `local.get $${baseLocal}`, `i32.const ${fieldIndex}`)}`;
}

function emitStructConsExpr(expr: Extract<IRExpr, { tag: "struct_cons" }>, ctx: EmitFunctionContext): string {
  const structDef = ctx.structs.get(expr.name);
  if (!structDef) {
    throw new Error(`Unknown struct '${expr.name}' in WAT lowering`);
  }
  const handleLocal = tempLocal(expr.id, "struct");
  const lines = [`i32.const ${structDef.fields.length}`, "call $jplmm_alloc_words", `local.set $${handleLocal}`];
  for (let i = 0; i < structDef.fields.length; i += 1) {
    lines.push(
      emitStoreWord(structDef.fields[i]!.type, `local.get $${handleLocal}`, `i32.const ${i}`, emitExpr(expr.fields[i]!, ctx)),
    );
  }
  lines.push(`local.get $${handleLocal}`);
  return lines.join("\n");
}

function emitArrayConsExpr(expr: Extract<IRExpr, { tag: "array_cons" }>, ctx: EmitFunctionContext): string {
  const arrayType = expectArrayType(expr.resultType, "array literal");
  const rank = arrayType.dims;
  const handleLocal = tempLocal(expr.id, "array");
  const lines: string[] = [];

  if (expr.elements.length === 0) {
    return "i32.const 0\ncall $jplmm_array_alloc_r1";
  }

  if (expr.elements[0]!.resultType.tag === "array") {
    const childType = expectArrayType(expr.elements[0]!.resultType, "nested array literal");
    const childRank = childType.dims;
    for (let i = 0; i < expr.elements.length; i += 1) {
      lines.push(emitExpr(expr.elements[i]!, ctx));
      lines.push(`local.set $${tempIndexedLocal(expr.id, "child", i)}`);
      lines.push(`local.get $${tempIndexedLocal(expr.id, "child", i)}`);
      lines.push("i32.eqz");
      lines.push("if");
      lines.push(indent("unreachable", 1));
      lines.push("end");
      lines.push(`local.get $${tempIndexedLocal(expr.id, "child", i)}`);
      lines.push("call $jplmm_array_rank");
      lines.push(`i32.const ${childRank}`);
      lines.push("i32.ne");
      lines.push("if");
      lines.push(indent("unreachable", 1));
      lines.push("end");
    }
    for (let i = 0; i < childRank; i += 1) {
      lines.push(`local.get $${tempIndexedLocal(expr.id, "child", 0)}`);
      lines.push(`i32.const ${i}`);
      lines.push("call $jplmm_array_dim");
      lines.push(`local.set $${tempIndexedLocal(expr.id, "dim", i + 1)}`);
    }
    for (let i = 1; i < expr.elements.length; i += 1) {
      for (let j = 0; j < childRank; j += 1) {
        lines.push(`local.get $${tempIndexedLocal(expr.id, "child", i)}`);
        lines.push(`i32.const ${j}`);
        lines.push("call $jplmm_array_dim");
        lines.push(`local.get $${tempIndexedLocal(expr.id, "dim", j + 1)}`);
        lines.push("i32.ne");
        lines.push("if");
        lines.push(indent("unreachable", 1));
        lines.push("end");
      }
    }
    lines.push(`local.get $${tempIndexedLocal(expr.id, "child", 0)}`);
    lines.push("call $jplmm_array_total_cells");
    lines.push(`local.set $${tempLocal(expr.id, "child_cells")}`);
    lines.push(`i32.const ${expr.elements.length}`);
    for (let i = 0; i < childRank; i += 1) {
      lines.push(`local.get $${tempIndexedLocal(expr.id, "dim", i + 1)}`);
    }
    lines.push(`call $jplmm_array_alloc_r${rank}`);
    lines.push(`local.set $${handleLocal}`);
    lines.push("i32.const 0");
    lines.push(`local.set $${tempLocal(expr.id, "dst")}`);
    for (let i = 0; i < expr.elements.length; i += 1) {
      lines.push(`local.get $${handleLocal}`);
      lines.push(`i32.const ${1 + rank}`);
      lines.push(`local.get $${tempLocal(expr.id, "dst")}`);
      lines.push("i32.add");
      lines.push(`local.get $${tempIndexedLocal(expr.id, "child", i)}`);
      lines.push(`i32.const ${1 + childRank}`);
      lines.push(`local.get $${tempLocal(expr.id, "child_cells")}`);
      lines.push("call $jplmm_copy_words");
      lines.push(`local.get $${tempLocal(expr.id, "dst")}`);
      lines.push(`local.get $${tempLocal(expr.id, "child_cells")}`);
      lines.push("i32.add");
      lines.push(`local.set $${tempLocal(expr.id, "dst")}`);
    }
    lines.push(`local.get $${handleLocal}`);
    return lines.join("\n");
  }

  lines.push(`i32.const ${expr.elements.length}`);
  lines.push("call $jplmm_array_alloc_r1");
  lines.push(`local.set $${handleLocal}`);
  for (let i = 0; i < expr.elements.length; i += 1) {
    lines.push(
      emitStoreWord(arrayType.element, `local.get $${handleLocal}`, `i32.const ${1 + rank + i}`, emitExpr(expr.elements[i]!, ctx)),
    );
  }
  lines.push(`local.get $${handleLocal}`);
  return lines.join("\n");
}

function emitArrayExpr(expr: Extract<IRExpr, { tag: "array_expr" }>, ctx: EmitFunctionContext): string {
  const resultType = expectArrayType(expr.resultType, "array comprehension");
  const dimLocals = Array.from({ length: resultType.dims }, (_, idx) => tempIndexedLocal(expr.id, "dim", idx));
  const lines: string[] = [];
  lines.push("i32.const 0");
  lines.push(`local.set $${tempLocal(expr.id, "total")}`);
  lines.push("i32.const 0");
  lines.push(`local.set $${tempLocal(expr.id, "body_cells")}`);
  for (const dimLocal of dimLocals) {
    lines.push("i32.const 0");
    lines.push(`local.set $${dimLocal}`);
  }
  lines.push(emitBindingLoopTree(expr.bindings, ctx, expr.id, dimLocals, 0, emitArrayLeaf(expr, ctx, dimLocals, "prepass")));
  for (const dimLocal of dimLocals) {
    lines.push(`local.get $${dimLocal}`);
  }
  lines.push(`call $jplmm_array_alloc_r${resultType.dims}`);
  lines.push(`local.set $${tempLocal(expr.id, "array")}`);
  lines.push("i32.const 0");
  lines.push(`local.set $${tempLocal(expr.id, "cursor")}`);
  lines.push(emitBindingLoopTree(expr.bindings, ctx, expr.id, dimLocals, 0, emitArrayLeaf(expr, ctx, dimLocals, "fill")));
  lines.push(`local.get $${tempLocal(expr.id, "array")}`);
  return lines.join("\n");
}

function emitSumExpr(expr: Extract<IRExpr, { tag: "sum_expr" }>, ctx: EmitFunctionContext): string {
  const sumLocal = tempLocal(expr.id, "sum");
  const body = `${emitLoadLocal(sumLocal, expr.resultType)}
${emitExpr(expr.body, ctx)}
${rawSumOp(expr.resultType)}
local.set $${sumLocal}`;
  return `${emitZero(expr.resultType)}
local.set $${sumLocal}
${emitBindingLoopTree(expr.bindings, ctx, expr.id, [], 0, body)}
${emitLoadLocal(sumLocal, expr.resultType)}`;
}

function emitIndexExpr(expr: Extract<IRExpr, { tag: "index" }>, ctx: EmitFunctionContext): string {
  const arrayType = expectArrayType(expr.array.resultType, "array indexing");
  const baseLocal = tempLocal(expr.id, "index_base");
  const offsetLocal = tempLocal(expr.id, "offset");
  const lines = [`${emitExpr(expr.array, ctx)}`, `local.set $${baseLocal}`, `local.get $${baseLocal}`, "i32.eqz", "if", indent("unreachable", 1), "end"];
  lines.push(`local.get $${baseLocal}`);
  lines.push("call $jplmm_array_rank");
  lines.push(`i32.const ${expr.indices.length}`);
  lines.push("i32.lt_s");
  lines.push("if");
  lines.push(indent("unreachable", 1));
  lines.push("end");
  lines.push("i32.const 0");
  lines.push(`local.set $${offsetLocal}`);
  for (let i = 0; i < expr.indices.length; i += 1) {
    const idxLocal = tempIndexedLocal(expr.id, "idx", i);
    lines.push(emitExpr(expr.indices[i]!, ctx));
    lines.push(`local.set $${idxLocal}`);
    lines.push(`local.get $${idxLocal}`);
    lines.push("i32.const 0");
    lines.push("i32.lt_s");
    lines.push("if");
    lines.push(indent("unreachable", 1));
    lines.push("end");
    lines.push(`local.get $${idxLocal}`);
    lines.push(`local.get $${baseLocal}`);
    lines.push(`i32.const ${i}`);
    lines.push("call $jplmm_array_dim");
    lines.push("i32.ge_s");
    lines.push("if");
    lines.push(indent("unreachable", 1));
    lines.push("end");
    lines.push(`local.get $${offsetLocal}`);
    lines.push(`local.get $${idxLocal}`);
    lines.push(`local.get $${baseLocal}`);
    lines.push(`i32.const ${i}`);
    lines.push("call $jplmm_array_stride");
    lines.push("i32.mul");
    lines.push("i32.add");
    lines.push(`local.set $${offsetLocal}`);
  }
  if (expr.indices.length === arrayType.dims) {
    lines.push(
      emitLoadWord(expr.resultType, `local.get $${baseLocal}`, `i32.const ${1 + arrayType.dims}\nlocal.get $${offsetLocal}\ni32.add`),
    );
  } else {
    lines.push(`local.get $${baseLocal}`);
    lines.push(`i32.const ${expr.indices.length}`);
    lines.push(`local.get $${offsetLocal}`);
    lines.push("call $jplmm_array_slice");
  }
  return lines.join("\n");
}

function emitNonTailRecExpr(expr: Extract<IRExpr, { tag: "rec" }>, ctx: EmitFunctionContext): string {
  const resultType = wasmType(expr.resultType);
  const callLines = [...emitRecArgLoads(expr), `call $${ctx.publicName}`].join("\n");
  const lines: string[] = [];

  lines.push(emitRecArgStores(expr, ctx));
  lines.push(emitRecCollapseCondition(expr, ctx));
  lines.push(`if (result ${resultType})`);
  lines.push(indent("local.get $res", 1));
  lines.push("else");

  if (!ctx.fuel) {
    lines.push(indent(callLines, 1));
    lines.push("end");
    return lines.join("\n");
  }

  lines.push(indent(`local.get $${ctx.fuel.name}
i32.eqz
if (result ${resultType})
  local.get $res
else
  local.get $${ctx.fuel.name}
  i32.const 1
  i32.sub
  local.set $${ctx.fuel.name}
${indent(callLines, 1)}
end`, 1));
  lines.push("end");
  return lines.join("\n");
}

function emitRecArgStores(expr: Extract<IRExpr, { tag: "rec" }>, ctx: EmitFunctionContext): string {
  return expr.args
    .map((arg, idx) => `${emitExpr(arg, ctx)}\nlocal.set $${recArgLocal(expr.id, idx)}`)
    .join("\n");
}

function emitRecArgLoads(expr: Extract<IRExpr, { tag: "rec" }>): string[] {
  return expr.args.map((_, idx) => `local.get $${recArgLocal(expr.id, idx)}`);
}

function emitRecCollapseCondition(expr: Extract<IRExpr, { tag: "rec" }>, ctx: EmitFunctionContext): string {
  if (expr.args.length === 0) {
    return "i32.const 1";
  }

  const lines: string[] = [];
  for (let i = 0; i < expr.args.length; i += 1) {
    const param = ctx.fn.params[i];
    if (!param) {
      throw new Error(`Rec arity mismatch while emitting '${ctx.fn.name}'`);
    }
    lines.push(`local.get $${recArgLocal(expr.id, i)}`);
    lines.push(`local.get $${param.name}`);
    lines.push(emitParamEquality(param));
    if (i > 0) {
      lines.push("i32.and");
    }
  }
  return lines.join("\n");
}

function emitParamEquality(param: Param): string {
  if (param.type.tag === "float") {
    return "call $jplmm_eq_f32_ulp1";
  }
  if (param.type.tag === "int" || param.type.tag === "void") {
    return "i32.eq";
  }
  if (param.type.tag === "named") {
    return `call $${structEqHelperName(param.type.name)}`;
  }
  if (param.type.tag === "array") {
    return `call $${arrayEqHelperName(param.type)}`;
  }
  const _never: never = param.type;
  throw new Error(`WAT emission for an unexpected parameter type is not implemented: ${_never}`);
}

function emitReturnCurrentRes(retType: Type): string {
  if (retType.tag === "void") {
    return "return";
  }
  return "local.get $res\nreturn";
}

function emitParamDecls(ctx: EmitFunctionContext): string {
  const params = ctx.fn.params.map((param) => `(param $${param.name} ${wasmType(param.type)})`);
  if (ctx.fuel?.kind === "param") {
    params.push(`(param $${ctx.fuel.name} i32)`);
  }
  return params.join(" ");
}

function emitLutWrapperBody(fn: IRFunction, layout: LutLayout): string {
  const resultType = wasmType(fn.retType);
  const fallbackCall = `${fn.params.map((param) => `local.get $${param.name}`).join("\n")}
call $${fn.name}__generic`;

  return `${emitLutRangeCondition(fn, layout.impl)}
if (result ${resultType})
${indent(emitLutFastPath(fn, layout), 1)}
else
${indent(fallbackCall, 1)}
end`;
}

function emitLutRangeCondition(fn: IRFunction, impl: LutImplementation): string {
  if (fn.params.length === 0) {
    return "i32.const 1";
  }

  const lines: string[] = [];
  for (let i = 0; i < fn.params.length; i += 1) {
    const range = impl.parameterRanges[i];
    const param = fn.params[i];
    if (!range || !param) {
      throw new Error(`LUT lowering arity mismatch for '${fn.name}'`);
    }
    lines.push(`local.get $${param.name}`);
    lines.push(`i32.const ${range.lo}`);
    lines.push("i32.ge_s");
    lines.push(`local.get $${param.name}`);
    lines.push(`i32.const ${range.hi}`);
    lines.push("i32.le_s");
    lines.push("i32.and");
    if (i > 0) {
      lines.push("i32.and");
    }
  }
  return lines.join("\n");
}

function emitLutFastPath(fn: IRFunction, layout: LutLayout): string {
  const lines: string[] = ["i32.const 0", "local.set $jplmm_lut_index"];
  let stride = 1;

  for (let i = fn.params.length - 1; i >= 0; i -= 1) {
    const range = layout.impl.parameterRanges[i];
    const param = fn.params[i];
    if (!range || !param) {
      throw new Error(`LUT lowering arity mismatch for '${fn.name}'`);
    }
    lines.push("local.get $jplmm_lut_index");
    lines.push(`local.get $${param.name}`);
    lines.push(`i32.const ${range.lo}`);
    lines.push("i32.sub");
    if (stride !== 1) {
      lines.push(`i32.const ${stride}`);
      lines.push("i32.mul");
    }
    lines.push("i32.add");
    lines.push("local.set $jplmm_lut_index");
    stride *= range.hi - range.lo + 1;
  }

  lines.push("local.get $jplmm_lut_index");
  lines.push("i32.const 4");
  lines.push("i32.mul");
  lines.push(`i32.const ${layout.offset}`);
  lines.push("i32.add");
  lines.push(layout.impl.resultType.tag === "float" ? "f32.load" : "i32.load");
  return lines.join("\n");
}

function planLutLayouts(artifacts: OptimizeArtifacts | undefined): Map<string, LutLayout> {
  const layouts = new Map<string, LutLayout>();
  if (!artifacts) {
    return layouts;
  }

  let offset = 0;
  const lutEntries = [...artifacts.implementations.entries()]
    .filter((entry): entry is [string, LutImplementation] => entry[1].tag === "lut")
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [fnName, impl] of lutEntries) {
    offset = alignTo(offset, 4);
    layouts.set(fnName, { impl, offset });
    offset += impl.table.length * 4;
  }

  return layouts;
}

function planMemory(artifacts: OptimizeArtifacts | undefined): MemoryPlan {
  const lutLayouts = planLutLayouts(artifacts);
  let totalBytes = 0;
  const dataLines: string[] = [];
  const ordered = [...lutLayouts.entries()].sort(([, a], [, b]) => a.offset - b.offset);
  for (const [, layout] of ordered) {
    const bytes = encodeLutBytes(layout.impl);
    totalBytes = Math.max(totalBytes, layout.offset + layout.impl.table.length * 4);
    dataLines.push(`(data (i32.const ${layout.offset}) "${bytes}")`);
  }
  const heapBase = Math.max(8, alignTo(totalBytes, 8));
  return {
    lutLayouts,
    heapBase,
    initialPages: Math.max(1, Math.ceil(heapBase / 65536)),
    dataLines,
  };
}

function emitMemoryBlock(plan: MemoryPlan, exportMemory: boolean): string {
  const memoryLines = [`(memory $jplmm_mem ${plan.initialPages})`, `(global $jplmm_heap_top (mut i32) (i32.const ${plan.heapBase}))`];
  if (exportMemory) {
    memoryLines.push(`(export "memory" (memory $jplmm_mem))`);
  }
  return [...memoryLines, ...plan.dataLines].join("\n");
}

function encodeLutBytes(impl: LutImplementation): string {
  return impl.table.map((value) => encodeScalar4(value, impl.resultType)).join("");
}

function encodeScalar4(value: number, type: Type): string {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  if (type.tag === "float") {
    view.setFloat32(0, value, true);
  } else {
    view.setInt32(0, value | 0, true);
  }
  let out = "";
  for (let i = 0; i < 4; i += 1) {
    out += `\\${view.getUint8(i).toString(16).padStart(2, "0")}`;
  }
  return out;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function collectLocalDecls(ctx: EmitFunctionContext): string {
  const locals = new Map<string, string>();

  locals.set("res", wasmType(ctx.fn.retType));

  if (ctx.fuel?.kind === "local") {
    locals.set(ctx.fuel.name, "i32");
  }

  for (const stmt of ctx.fn.body) {
    if (stmt.tag === "let") {
      locals.set(stmt.name, wasmType(stmt.expr.resultType));
    }
    if (stmt.tag === "let" || stmt.tag === "ret" || stmt.tag === "rad") {
      collectRecTemps(stmt.expr, locals);
      collectExprTemps(stmt.expr, locals);
    }
  }

  return [...locals.entries()]
    .filter(([name]) => !ctx.fn.params.some((param) => param.name === name))
    .map(([name, type]) => `(local $${name} ${type})`)
    .join(" ");
}

function collectRecTemps(expr: IRExpr, locals: Map<string, string>): void {
  if (expr.tag === "rec") {
    for (let i = 0; i < expr.args.length; i += 1) {
      locals.set(recArgLocal(expr.id, i), wasmType(expr.args[i]!.resultType));
      collectRecTemps(expr.args[i]!, locals);
    }
    return;
  }

  switch (expr.tag) {
    case "binop":
      collectRecTemps(expr.left, locals);
      collectRecTemps(expr.right, locals);
      return;
    case "unop":
      collectRecTemps(expr.operand, locals);
      return;
    case "call":
      for (const arg of expr.args) {
        collectRecTemps(arg, locals);
      }
      return;
    case "index":
      collectRecTemps(expr.array, locals);
      for (const arg of expr.indices) {
        collectRecTemps(arg, locals);
      }
      return;
    case "field":
      collectRecTemps(expr.target, locals);
      return;
    case "struct_cons":
      for (const field of expr.fields) {
        collectRecTemps(field, locals);
      }
      return;
    case "array_cons":
      for (const element of expr.elements) {
        collectRecTemps(element, locals);
      }
      return;
    case "array_expr":
    case "sum_expr":
      for (const binding of expr.bindings) {
        collectRecTemps(binding.expr, locals);
      }
      collectRecTemps(expr.body, locals);
      return;
    case "total_div":
    case "total_mod":
    case "sat_add":
    case "sat_sub":
    case "sat_mul":
      collectRecTemps(expr.left, locals);
      collectRecTemps(expr.right, locals);
      return;
    case "nan_to_zero":
      collectRecTemps(expr.value, locals);
      return;
    case "sat_neg":
      collectRecTemps(expr.operand, locals);
      return;
    default:
      return;
  }
}

function collectExprTemps(expr: IRExpr, locals: Map<string, string>): void {
  switch (expr.tag) {
    case "field":
      locals.set(tempLocal(expr.id, "field_base"), "i32");
      collectExprTemps(expr.target, locals);
      return;
    case "struct_cons":
      locals.set(tempLocal(expr.id, "struct"), "i32");
      for (const field of expr.fields) {
        collectExprTemps(field, locals);
      }
      return;
    case "array_cons":
      locals.set(tempLocal(expr.id, "array"), "i32");
      if (expr.elements[0]?.resultType.tag === "array") {
        locals.set(tempLocal(expr.id, "child_cells"), "i32");
        locals.set(tempLocal(expr.id, "dst"), "i32");
        const childRank = expectArrayType(expr.elements[0].resultType, "nested array literal").dims;
        for (let i = 0; i < expr.elements.length; i += 1) {
          locals.set(tempIndexedLocal(expr.id, "child", i), "i32");
        }
        for (let i = 0; i < childRank; i += 1) {
          locals.set(tempIndexedLocal(expr.id, "dim", i + 1), "i32");
        }
      }
      for (const element of expr.elements) {
        collectExprTemps(element, locals);
      }
      return;
    case "array_expr": {
      locals.set(tempLocal(expr.id, "array"), "i32");
      locals.set(tempLocal(expr.id, "total"), "i32");
      locals.set(tempLocal(expr.id, "body_cells"), "i32");
      locals.set(tempLocal(expr.id, "cursor"), "i32");
      if (expr.body.resultType.tag === "array") {
        locals.set(tempLocal(expr.id, "body"), "i32");
      }
      const rank = expectArrayType(expr.resultType, "array comprehension").dims;
      for (let i = 0; i < rank; i += 1) {
        locals.set(tempIndexedLocal(expr.id, "dim", i), "i32");
      }
      for (let i = 0; i < expr.bindings.length; i += 1) {
        locals.set(expr.bindings[i]!.name, "i32");
        locals.set(tempIndexedLocal(expr.id, "extent", i), "i32");
        collectExprTemps(expr.bindings[i]!.expr, locals);
      }
      collectExprTemps(expr.body, locals);
      return;
    }
    case "sum_expr":
      locals.set(tempLocal(expr.id, "sum"), wasmType(expr.resultType));
      for (let i = 0; i < expr.bindings.length; i += 1) {
        locals.set(expr.bindings[i]!.name, "i32");
        locals.set(tempIndexedLocal(expr.id, "extent", i), "i32");
        collectExprTemps(expr.bindings[i]!.expr, locals);
      }
      collectExprTemps(expr.body, locals);
      return;
    case "index":
      locals.set(tempLocal(expr.id, "index_base"), "i32");
      locals.set(tempLocal(expr.id, "offset"), "i32");
      for (let i = 0; i < expr.indices.length; i += 1) {
        locals.set(tempIndexedLocal(expr.id, "idx", i), "i32");
        collectExprTemps(expr.indices[i]!, locals);
      }
      collectExprTemps(expr.array, locals);
      return;
    case "binop":
    case "total_div":
    case "total_mod":
    case "sat_add":
    case "sat_sub":
    case "sat_mul":
      collectExprTemps(expr.left, locals);
      collectExprTemps(expr.right, locals);
      return;
    case "unop":
    case "sat_neg":
      collectExprTemps(expr.operand, locals);
      return;
    case "call":
      for (const arg of expr.args) {
        collectExprTemps(arg, locals);
      }
      return;
    case "rec":
      for (const arg of expr.args) {
        collectExprTemps(arg, locals);
      }
      return;
    case "nan_to_zero":
      collectExprTemps(expr.value, locals);
      return;
    default:
      return;
  }
}

function findTailRecStmt(stmts: IRStmt[]): IRStmt | null {
  for (const stmt of stmts) {
    if (stmt.tag === "ret" && stmt.expr.tag === "rec" && stmt.expr.tailPosition) {
      return stmt;
    }
  }
  return null;
}

function getFiniteGasLimit(fn: IRFunction): number | null {
  const gas = fn.body.find((stmt) => stmt.tag === "gas");
  if (!gas || gas.limit === "inf") {
    return null;
  }
  return gas.limit;
}

function recArgLocal(id: number, index: number): string {
  return `jplmm_rec_${id}_${index}`;
}

function emitCall(name: string, argExprs: string[], resultType: Type): string {
  const args = argExprs.join("\n");
  switch (name) {
    case "sqrt":
      return `${args}\nf32.sqrt`;
    case "exp":
      return `${args}\ncall $jplmm_exp_f32\ncall $jplmm_nan_to_zero_f32`;
    case "sin":
      return `${args}\ncall $jplmm_sin_f32\ncall $jplmm_nan_to_zero_f32`;
    case "cos":
      return `${args}\ncall $jplmm_cos_f32\ncall $jplmm_nan_to_zero_f32`;
    case "tan":
      return `${args}\ncall $jplmm_tan_f32\ncall $jplmm_nan_to_zero_f32`;
    case "asin":
      return `${args}\ncall $jplmm_asin_f32\ncall $jplmm_nan_to_zero_f32`;
    case "acos":
      return `${args}\ncall $jplmm_acos_f32\ncall $jplmm_nan_to_zero_f32`;
    case "atan":
      return `${args}\ncall $jplmm_atan_f32\ncall $jplmm_nan_to_zero_f32`;
    case "log":
      return `${args}\ncall $jplmm_log_f32\ncall $jplmm_nan_to_zero_f32`;
    case "pow":
      return `${args}\ncall $jplmm_pow_f32\ncall $jplmm_nan_to_zero_f32`;
    case "atan2":
      return `${args}\ncall $jplmm_atan2_f32\ncall $jplmm_nan_to_zero_f32`;
    case "abs":
      return `${args}\n${resultType.tag === "float" ? "f32.abs" : "call $jplmm_abs_i32"}`;
    case "max":
      return `${args}\ncall $${resultType.tag === "float" ? "jplmm_max_f32" : "jplmm_max_i32"}`;
    case "min":
      return `${args}\ncall $${resultType.tag === "float" ? "jplmm_min_f32" : "jplmm_min_i32"}`;
    case "clamp":
      return `${args}\ncall $${resultType.tag === "float" ? "jplmm_clamp_f32" : "jplmm_clamp_i32"}`;
    case "to_float":
      return `${args}\nf32.convert_i32_s`;
    case "to_int":
      return `${args}\ni32.trunc_sat_f32_s`;
    default:
      return `${args}\ncall $${name}`;
  }
}

function rawBinop(op: string, type: Type): string {
  if (type.tag === "float") {
    if (op === "+") {
      return "f32.add";
    }
    if (op === "-") {
      return "f32.sub";
    }
    if (op === "*") {
      return "f32.mul";
    }
    if (op === "/") {
      return "f32.div";
    }
    if (op === "%") {
      throw new Error("Raw float '%' must be canonicalized before WAT emission");
    }
  }
  if (op === "+") {
    return "i32.add";
  }
  if (op === "-") {
    return "i32.sub";
  }
  if (op === "*") {
    return "i32.mul";
  }
  if (op === "/") {
    return "i32.div_s";
  }
  if (op === "%") {
    return "i32.rem_s";
  }
  throw new Error(`Unsupported raw binop '${op}'`);
}

function wasmType(type: Type): string {
  if (type.tag === "float") {
    return "f32";
  }
  if (type.tag === "int" || type.tag === "void" || type.tag === "array" || type.tag === "named") {
    return "i32";
  }
  const _never: never = type;
  throw new Error(`WAT emission for an unexpected type is not implemented: ${_never}`);
}

function tempLocal(id: number, label: string): string {
  return `jplmm_${label}_${id}`;
}

function tempIndexedLocal(id: number, label: string, index: number): string {
  return `jplmm_${label}_${id}_${index}`;
}

function emitZero(type: Type): string {
  return type.tag === "float" ? "f32.const 0" : "i32.const 0";
}

function emitLoadLocal(name: string, type: Type): string {
  return type.tag === "float" ? `local.get $${name}` : `local.get $${name}`;
}

function rawSumOp(type: Type): string {
  return type.tag === "float" ? "f32.add\ncall $jplmm_nan_to_zero_f32" : "call $jplmm_sat_add_i32";
}

function emitLoadWord(type: Type, handleInstr: string, wordInstr: string): string {
  return `${handleInstr}
${wordInstr}
call $${type.tag === "float" ? "jplmm_word_load_f32" : "jplmm_word_load_i32"}`;
}

function emitStoreWord(type: Type, handleInstr: string, wordInstr: string, valueInstr: string): string {
  return `${handleInstr}
${wordInstr}
${valueInstr}
call $${type.tag === "float" ? "jplmm_word_store_f32" : "jplmm_word_store_i32"}`;
}

function emitBindingLoopTree(
  bindings: Array<{ name: string; expr: IRExpr }>,
  ctx: EmitFunctionContext,
  exprId: number,
  dimLocals: string[],
  index: number,
  leafBody: string,
): string {
  if (index === bindings.length) {
    return leafBody;
  }
  const binding = bindings[index]!;
  const extentLocal = tempIndexedLocal(exprId, "extent", index);
  const exitLabel = `${extentLocal}_exit`;
  const loopLabel = `${extentLocal}_loop`;
  const lines = [
    emitExpr(binding.expr, ctx),
    `local.set $${extentLocal}`,
    `local.get $${extentLocal}`,
    "i32.const 0",
    "i32.le_s",
    "if",
    indent("unreachable", 1),
    "end",
  ];
  if (dimLocals[index]) {
    lines.push(`local.get $${dimLocals[index]}`);
    lines.push("i32.eqz");
    lines.push("if");
    lines.push(indent(`local.get $${extentLocal}\nlocal.set $${dimLocals[index]}`, 1));
    lines.push("else");
    lines.push(indent(`local.get $${dimLocals[index]}\nlocal.get $${extentLocal}\ni32.ne\nif\n  unreachable\nend`, 1));
    lines.push("end");
  }
  lines.push("i32.const 0");
  lines.push(`local.set $${binding.name}`);
  lines.push(`block $${exitLabel}`);
  lines.push(`  loop $${loopLabel}`);
  lines.push(`    local.get $${binding.name}`);
  lines.push(`    local.get $${extentLocal}`);
  lines.push("    i32.ge_s");
  lines.push(`    br_if $${exitLabel}`);
  lines.push(indent(emitBindingLoopTree(bindings, ctx, exprId, dimLocals, index + 1, leafBody), 2));
  lines.push(`    local.get $${binding.name}`);
  lines.push("    i32.const 1");
  lines.push("    i32.add");
  lines.push(`    local.set $${binding.name}`);
  lines.push(`    br $${loopLabel}`);
  lines.push("  end");
  lines.push("end");
  return lines.join("\n");
}

function emitArrayLeaf(
  expr: Extract<IRExpr, { tag: "array_expr" }>,
  ctx: EmitFunctionContext,
  dimLocals: string[],
  mode: "prepass" | "fill",
): string {
  const resultType = expectArrayType(expr.resultType, "array comprehension");
  const suffixRank = resultType.dims - expr.bindings.length;
  const headerWords = 1 + resultType.dims;
  if (expr.body.resultType.tag === "array") {
    const bodyLocal = tempLocal(expr.id, "body");
    const lines = [emitExpr(expr.body, ctx), `local.set $${bodyLocal}`, `local.get $${bodyLocal}`, "i32.eqz", "if", indent("unreachable", 1), "end"];
    lines.push(`local.get $${bodyLocal}`);
    lines.push("call $jplmm_array_rank");
    lines.push(`i32.const ${suffixRank}`);
    lines.push("i32.ne");
    lines.push("if");
    lines.push(indent("unreachable", 1));
    lines.push("end");
    for (let i = 0; i < suffixRank; i += 1) {
      const dimLocal = dimLocals[expr.bindings.length + i]!;
      lines.push(`local.get $${dimLocal}`);
      lines.push("i32.eqz");
      lines.push("if");
      lines.push(indent(`local.get $${bodyLocal}\ni32.const ${i}\ncall $jplmm_array_dim\nlocal.set $${dimLocal}`, 1));
      lines.push("else");
      lines.push(
        indent(
          `local.get $${dimLocal}
local.get $${bodyLocal}
i32.const ${i}
call $jplmm_array_dim
i32.ne
if
  unreachable
end`,
          1,
        ),
      );
      lines.push("end");
    }
    lines.push(`local.get $${tempLocal(expr.id, "body_cells")}`);
    lines.push("i32.eqz");
    lines.push("if");
    lines.push(indent(`local.get $${bodyLocal}\ncall $jplmm_array_total_cells\nlocal.set $${tempLocal(expr.id, "body_cells")}`, 1));
    lines.push("else");
    lines.push(
      indent(
        `local.get $${tempLocal(expr.id, "body_cells")}
local.get $${bodyLocal}
call $jplmm_array_total_cells
i32.ne
if
  unreachable
end`,
        1,
      ),
    );
    lines.push("end");
    if (mode === "prepass") {
      lines.push(`local.get $${tempLocal(expr.id, "total")}`);
      lines.push(`local.get $${tempLocal(expr.id, "body_cells")}`);
      lines.push("i32.add");
      lines.push(`local.set $${tempLocal(expr.id, "total")}`);
    } else {
      lines.push(`local.get $${tempLocal(expr.id, "array")}`);
      lines.push(`i32.const ${headerWords}`);
      lines.push(`local.get $${tempLocal(expr.id, "cursor")}`);
      lines.push("i32.add");
      lines.push(`local.get $${bodyLocal}`);
      lines.push(`i32.const ${1 + suffixRank}`);
      lines.push(`local.get $${tempLocal(expr.id, "body_cells")}`);
      lines.push("call $jplmm_copy_words");
      lines.push(`local.get $${tempLocal(expr.id, "cursor")}`);
      lines.push(`local.get $${tempLocal(expr.id, "body_cells")}`);
      lines.push("i32.add");
      lines.push(`local.set $${tempLocal(expr.id, "cursor")}`);
    }
    return lines.join("\n");
  }

  if (mode === "prepass") {
    return `local.get $${tempLocal(expr.id, "total")}
i32.const 1
i32.add
local.set $${tempLocal(expr.id, "total")}`;
  }

  return `${emitStoreWord(
    arrayLeafType(expr.resultType),
    `local.get $${tempLocal(expr.id, "array")}`,
    `i32.const ${headerWords}
local.get $${tempLocal(expr.id, "cursor")}
i32.add`,
    emitExpr(expr.body, ctx),
  )}
local.get $${tempLocal(expr.id, "cursor")}
i32.const 1
i32.add
local.set $${tempLocal(expr.id, "cursor")}`;
}

function expectArrayType(type: Type, context: string): Extract<Type, { tag: "array" }> {
  if (type.tag !== "array") {
    throw new Error(`${context} requires an array type`);
  }
  return type;
}

function arrayLeafType(type: Type): Type {
  return type.tag === "array" ? arrayLeafType(type.element) : type;
}

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function structEqHelperName(name: string): string {
  return `jplmm_eq_struct_${sanitizeName(name)}`;
}

function arrayEqHelperName(type: Type): string {
  return `jplmm_eq_array_${typeKey(type)}`;
}

function typeKey(type: Type): string {
  switch (type.tag) {
    case "int":
      return "i32";
    case "float":
      return "f32";
    case "void":
      return "void";
    case "named":
      return `named_${sanitizeName(type.name)}`;
    case "array":
      return `arr${type.dims}_${typeKey(type.element)}`;
    default: {
      const _never: never = type;
      return `${_never}`;
    }
  }
}

function collectArrayTypes(program: IRProgram): Extract<Type, { tag: "array" }>[] {
  const types: Extract<Type, { tag: "array" }>[] = [];
  for (const struct of program.structs) {
    for (const field of struct.fields) {
      collectArrayTypesFromType(field.type, types);
    }
  }
  for (const fn of program.functions) {
    collectArrayTypesFromType(fn.retType, types);
    for (const param of fn.params) {
      collectArrayTypesFromType(param.type, types);
    }
    for (const stmt of fn.body) {
      if (stmt.tag !== "gas") {
        collectArrayTypesFromExpr(stmt.expr, types);
      }
    }
  }
  for (const global of program.globals) {
    collectArrayTypesFromExpr(global.expr, types);
  }
  return types;
}

function collectArrayTypesFromExpr(expr: IRExpr, out: Extract<Type, { tag: "array" }>[]): void {
  collectArrayTypesFromType(expr.resultType, out);
  switch (expr.tag) {
    case "binop":
    case "total_div":
    case "total_mod":
    case "sat_add":
    case "sat_sub":
    case "sat_mul":
      collectArrayTypesFromExpr(expr.left, out);
      collectArrayTypesFromExpr(expr.right, out);
      return;
    case "unop":
    case "sat_neg":
      collectArrayTypesFromExpr(expr.operand, out);
      return;
    case "call":
    case "rec":
      for (const arg of expr.args) {
        collectArrayTypesFromExpr(arg, out);
      }
      return;
    case "field":
      collectArrayTypesFromExpr(expr.target, out);
      return;
    case "struct_cons":
      for (const field of expr.fields) {
        collectArrayTypesFromExpr(field, out);
      }
      return;
    case "array_cons":
      for (const element of expr.elements) {
        collectArrayTypesFromExpr(element, out);
      }
      return;
    case "array_expr":
    case "sum_expr":
      for (const binding of expr.bindings) {
        collectArrayTypesFromExpr(binding.expr, out);
      }
      collectArrayTypesFromExpr(expr.body, out);
      return;
    case "index":
      collectArrayTypesFromExpr(expr.array, out);
      for (const index of expr.indices) {
        collectArrayTypesFromExpr(index, out);
      }
      return;
    case "nan_to_zero":
      collectArrayTypesFromExpr(expr.value, out);
      return;
    default:
      return;
  }
}

function collectArrayTypesFromType(type: Type, out: Extract<Type, { tag: "array" }>[]): void {
  if (type.tag === "array") {
    out.push(type);
    collectArrayTypesFromType(type.element, out);
  }
}

function dedupeTypes(types: Extract<Type, { tag: "array" }>[]): Extract<Type, { tag: "array" }>[] {
  const seen = new Set<string>();
  const out: Extract<Type, { tag: "array" }>[] = [];
  for (const type of types) {
    const key = typeKey(type);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(type);
  }
  return out;
}

function emitHelpers(program: IRProgram, _heapBase: number): string {
  const arrayTypes = dedupeTypes(collectArrayTypes(program));
  const maxRank = arrayTypes.reduce((acc, type) => Math.max(acc, type.dims), 0);
  const structHelpers = program.structs.map((struct) => emitWasmStructEqualityHelper(struct)).join("\n\n");
  const arrayHelpers = arrayTypes.map((type) => emitWasmArrayEqualityHelper(type)).join("\n\n");
  return [emitCoreHelpers(), emitHeapHelpers(), emitWasmArrayAllocHelpers(maxRank), structHelpers, arrayHelpers]
    .filter(Boolean)
    .join("\n\n");
}

function emitCoreHelpers(): string {
  return `
(func $jplmm_eq_f32_ulp1 (param $a f32) (param $b f32) (result i32)
  (local $ua i32) (local $ub i32) (local $oa i32) (local $ob i32)
  local.get $a
  i32.reinterpret_f32
  local.set $ua
  local.get $b
  i32.reinterpret_f32
  local.set $ub
  local.get $ua
  i32.const -2147483648
  i32.and
  if (result i32)
    local.get $ua
    i32.const -1
    i32.xor
  else
    local.get $ua
    i32.const -2147483648
    i32.or
  end
  local.set $oa
  local.get $ub
  i32.const -2147483648
  i32.and
  if (result i32)
    local.get $ub
    i32.const -1
    i32.xor
  else
    local.get $ub
    i32.const -2147483648
    i32.or
  end
  local.set $ob
  local.get $oa
  local.get $ob
  i32.gt_u
  if (result i32)
    local.get $oa
    local.get $ob
    i32.sub
  else
    local.get $ob
    local.get $oa
    i32.sub
  end
  i32.const 1
  i32.le_u)

(func $jplmm_total_div_i32 (param $a i32) (param $b i32) (result i32)
  (local $is_zero i32)
  (local $safe_b i32)
  local.get $b
  i32.eqz
  local.tee $is_zero
  local.get $b
  i32.or
  local.set $safe_b
  i32.const 0
  local.get $a
  local.get $safe_b
  i32.div_s
  local.get $is_zero
  select)

(func $jplmm_total_mod_i32 (param $a i32) (param $b i32) (result i32)
  (local $is_zero i32)
  (local $safe_b i32)
  local.get $b
  i32.eqz
  local.tee $is_zero
  local.get $b
  i32.or
  local.set $safe_b
  i32.const 0
  local.get $a
  local.get $safe_b
  i32.rem_s
  local.get $is_zero
  select)

(func $jplmm_total_div_f32 (param $a f32) (param $b f32) (result f32)
  local.get $b
  f32.const 0
  f32.eq
  if (result f32)
    f32.const 0
  else
    local.get $a
    local.get $b
    f32.div
    call $jplmm_nan_to_zero_f32
  end)

(func $jplmm_total_mod_f32 (param $a f32) (param $b f32) (result f32)
  local.get $b
  f32.const 0
  f32.eq
  if (result f32)
    f32.const 0
  else
    local.get $a
    local.get $a
    local.get $b
    f32.div
    f32.trunc
    local.get $b
    f32.mul
    f32.sub
    call $jplmm_nan_to_zero_f32
  end)

(func $jplmm_nan_to_zero_f32 (param $x f32) (result f32)
  local.get $x
  f32.const 0
  local.get $x
  local.get $x
  f32.eq
  select)

(func $jplmm_sat_add_i32 (param $a i32) (param $b i32) (result i32)
  local.get $a
  i64.extend_i32_s
  local.get $b
  i64.extend_i32_s
  i64.add
  call $jplmm_clamp_i64_to_i32)

(func $jplmm_sat_sub_i32 (param $a i32) (param $b i32) (result i32)
  local.get $a
  i64.extend_i32_s
  local.get $b
  i64.extend_i32_s
  i64.sub
  call $jplmm_clamp_i64_to_i32)

(func $jplmm_sat_mul_i32 (param $a i32) (param $b i32) (result i32)
  local.get $a
  i64.extend_i32_s
  local.get $b
  i64.extend_i32_s
  i64.mul
  call $jplmm_clamp_i64_to_i32)

(func $jplmm_sat_neg_i32 (param $a i32) (result i32)
  i64.const 0
  local.get $a
  i64.extend_i32_s
  i64.sub
  call $jplmm_clamp_i64_to_i32)

(func $jplmm_clamp_i64_to_i32 (param $x i64) (result i32)
  local.get $x
  i64.const -2147483648
  i64.lt_s
  if (result i32)
    i32.const -2147483648
  else
    local.get $x
    i64.const 2147483647
    i64.gt_s
    if (result i32)
      i32.const 2147483647
    else
      local.get $x
      i32.wrap_i64
    end
  end)

(func $jplmm_abs_i32 (param $x i32) (result i32)
  local.get $x
  i32.const 0
  i32.lt_s
  if (result i32)
    local.get $x
    call $jplmm_sat_neg_i32
  else
    local.get $x
  end)

(func $jplmm_max_i32 (param $a i32) (param $b i32) (result i32)
  local.get $a
  local.get $b
  local.get $a
  local.get $b
  i32.gt_s
  select)

(func $jplmm_min_i32 (param $a i32) (param $b i32) (result i32)
  local.get $a
  local.get $b
  local.get $a
  local.get $b
  i32.lt_s
  select)

(func $jplmm_clamp_i32 (param $x i32) (param $lo i32) (param $hi i32) (result i32)
  local.get $x
  local.get $lo
  call $jplmm_max_i32
  local.get $hi
  call $jplmm_min_i32)

(func $jplmm_max_f32 (param $a f32) (param $b f32) (result f32)
  local.get $a
  local.get $b
  local.get $a
  local.get $b
  f32.gt
  select)

(func $jplmm_min_f32 (param $a f32) (param $b f32) (result f32)
  local.get $a
  local.get $b
  local.get $a
  local.get $b
  f32.lt
  select)

(func $jplmm_clamp_f32 (param $x f32) (param $lo f32) (param $hi f32) (result f32)
  local.get $x
  local.get $lo
  call $jplmm_max_f32
  local.get $hi
  call $jplmm_min_f32)
`.trim();
}

function emitMathImports(): string {
  return `
(import "env" "jplmm_exp_f32" (func $jplmm_exp_f32 (param f32) (result f32)))
(import "env" "jplmm_sin_f32" (func $jplmm_sin_f32 (param f32) (result f32)))
(import "env" "jplmm_cos_f32" (func $jplmm_cos_f32 (param f32) (result f32)))
(import "env" "jplmm_tan_f32" (func $jplmm_tan_f32 (param f32) (result f32)))
(import "env" "jplmm_asin_f32" (func $jplmm_asin_f32 (param f32) (result f32)))
(import "env" "jplmm_acos_f32" (func $jplmm_acos_f32 (param f32) (result f32)))
(import "env" "jplmm_atan_f32" (func $jplmm_atan_f32 (param f32) (result f32)))
(import "env" "jplmm_log_f32" (func $jplmm_log_f32 (param f32) (result f32)))
(import "env" "jplmm_pow_f32" (func $jplmm_pow_f32 (param f32) (param f32) (result f32)))
(import "env" "jplmm_atan2_f32" (func $jplmm_atan2_f32 (param f32) (param f32) (result f32)))
`.trim();
}

function emitHeapHelpers(): string {
  return `
(func $jplmm_alloc_bytes (param $bytes i32) (result i32)
  (local $base i32) (local $aligned i32) (local $needed i32) (local $capacity i32) (local $grow i32)
  global.get $jplmm_heap_top
  local.set $base
  local.get $bytes
  i32.const 7
  i32.add
  i32.const -8
  i32.and
  local.set $aligned
  local.get $base
  local.get $aligned
  i32.add
  local.set $needed
  memory.size
  i32.const 16
  i32.shl
  local.set $capacity
  local.get $needed
  local.get $capacity
  i32.gt_u
  if
    local.get $needed
    local.get $capacity
    i32.sub
    i32.const 65535
    i32.add
    i32.const 16
    i32.shr_u
    local.tee $grow
    memory.grow
    i32.const -1
    i32.eq
    if
      unreachable
    end
  end
  local.get $needed
  global.set $jplmm_heap_top
  local.get $base)

(func $jplmm_alloc_words (param $words i32) (result i32)
  local.get $words
  i32.const 4
  i32.mul
  call $jplmm_alloc_bytes)

(func $jplmm_word_addr (param $handle i32) (param $word i32) (result i32)
  local.get $handle
  local.get $word
  i32.const 4
  i32.mul
  i32.add)

(func $jplmm_word_load_i32 (param $handle i32) (param $word i32) (result i32)
  local.get $handle
  local.get $word
  call $jplmm_word_addr
  i32.load)

(func $jplmm_word_load_f32 (param $handle i32) (param $word i32) (result f32)
  local.get $handle
  local.get $word
  call $jplmm_word_addr
  f32.load)

(func $jplmm_word_store_i32 (param $handle i32) (param $word i32) (param $value i32)
  local.get $handle
  local.get $word
  call $jplmm_word_addr
  local.get $value
  i32.store)

(func $jplmm_word_store_f32 (param $handle i32) (param $word i32) (param $value f32)
  local.get $handle
  local.get $word
  call $jplmm_word_addr
  local.get $value
  f32.store)

(func $jplmm_copy_words (param $dst_handle i32) (param $dst_word i32) (param $src_handle i32) (param $src_word i32) (param $count i32)
  (local $i i32)
  block $exit
    loop $loop
      local.get $i
      local.get $count
      i32.ge_s
      br_if $exit
      local.get $dst_handle
      local.get $dst_word
      local.get $i
      i32.add
      call $jplmm_word_addr
      local.get $src_handle
      local.get $src_word
      local.get $i
      i32.add
      call $jplmm_word_addr
      i32.load
      i32.store
      local.get $i
      i32.const 1
      i32.add
      local.set $i
      br $loop
    end
  end)

(func $jplmm_array_rank (param $handle i32) (result i32)
  local.get $handle
  i32.const 0
  call $jplmm_word_load_i32)

(func $jplmm_array_dim (param $handle i32) (param $index i32) (result i32)
  local.get $handle
  i32.const 1
  local.get $index
  i32.add
  call $jplmm_word_load_i32)

(func $jplmm_array_total_cells (param $handle i32) (result i32)
  (local $i i32) (local $total i32) (local $rank i32)
  i32.const 1
  local.set $total
  local.get $handle
  call $jplmm_array_rank
  local.set $rank
  block $exit
    loop $loop
      local.get $i
      local.get $rank
      i32.ge_s
      br_if $exit
      local.get $total
      local.get $handle
      local.get $i
      call $jplmm_array_dim
      call $jplmm_sat_mul_i32
      local.set $total
      local.get $i
      i32.const 1
      i32.add
      local.set $i
      br $loop
    end
  end
  local.get $total)

(func $jplmm_array_stride (param $handle i32) (param $index i32) (result i32)
  (local $i i32) (local $stride i32) (local $rank i32)
  i32.const 1
  local.set $stride
  local.get $handle
  call $jplmm_array_rank
  local.set $rank
  local.get $index
  i32.const 1
  i32.add
  local.set $i
  block $exit
    loop $loop
      local.get $i
      local.get $rank
      i32.ge_s
      br_if $exit
      local.get $stride
      local.get $handle
      local.get $i
      call $jplmm_array_dim
      call $jplmm_sat_mul_i32
      local.set $stride
      local.get $i
      i32.const 1
      i32.add
      local.set $i
      br $loop
    end
  end
  local.get $stride)

(func $jplmm_array_slice (param $source i32) (param $consumed i32) (param $offset i32) (result i32)
  (local $src_rank i32) (local $dst_rank i32) (local $total i32) (local $handle i32) (local $i i32)
  local.get $source
  call $jplmm_array_rank
  local.set $src_rank
  local.get $consumed
  local.get $src_rank
  i32.gt_s
  if
    unreachable
  end
  local.get $src_rank
  local.get $consumed
  i32.sub
  local.set $dst_rank
  i32.const 1
  local.set $total
  block $calc_exit
    loop $calc_loop
      local.get $i
      local.get $dst_rank
      i32.ge_s
      br_if $calc_exit
      local.get $total
      local.get $source
      local.get $consumed
      local.get $i
      i32.add
      call $jplmm_array_dim
      call $jplmm_sat_mul_i32
      local.set $total
      local.get $i
      i32.const 1
      i32.add
      local.set $i
      br $calc_loop
    end
  end
  i32.const 1
  local.get $dst_rank
  i32.add
  local.get $total
  i32.add
  call $jplmm_alloc_words
  local.set $handle
  local.get $handle
  i32.const 0
  local.get $dst_rank
  call $jplmm_word_store_i32
  i32.const 0
  local.set $i
  block $dim_exit
    loop $dim_loop
      local.get $i
      local.get $dst_rank
      i32.ge_s
      br_if $dim_exit
      local.get $handle
      i32.const 1
      local.get $i
      i32.add
      local.get $source
      local.get $consumed
      local.get $i
      i32.add
      call $jplmm_array_dim
      call $jplmm_word_store_i32
      local.get $i
      i32.const 1
      i32.add
      local.set $i
      br $dim_loop
    end
  end
  local.get $handle
  i32.const 1
  local.get $dst_rank
  i32.add
  local.get $source
  i32.const 1
  local.get $src_rank
  i32.add
  local.get $offset
  i32.add
  local.get $total
  call $jplmm_copy_words
  local.get $handle)
`.trim();
}

function emitWasmArrayAllocHelpers(maxRank: number): string {
  const helpers: string[] = [];
  for (let rank = 1; rank <= maxRank; rank += 1) {
    const params = Array.from({ length: rank }, (_, idx) => `(param $d${idx} i32)`).join(" ");
    const totalLines: string[] = ["i32.const 1", "local.set $total"];
    for (let i = 0; i < rank; i += 1) {
      totalLines.push("local.get $total");
      totalLines.push(`local.get $d${i}`);
      totalLines.push("call $jplmm_sat_mul_i32");
      totalLines.push("local.set $total");
    }
    const storeLines: string[] = [
      "local.get $handle",
      "i32.const 0",
      `i32.const ${rank}`,
      "call $jplmm_word_store_i32",
    ];
    for (let i = 0; i < rank; i += 1) {
      storeLines.push("local.get $handle");
      storeLines.push(`i32.const ${i + 1}`);
      storeLines.push(`local.get $d${i}`);
      storeLines.push("call $jplmm_word_store_i32");
    }
    helpers.push(`(func $jplmm_array_alloc_r${rank} ${params} (result i32)
  (local $total i32) (local $handle i32)
${indent(totalLines.join("\n"), 1)}
  i32.const 1
  i32.const ${rank}
  i32.add
  local.get $total
  i32.add
  call $jplmm_alloc_words
  local.set $handle
${indent(storeLines.join("\n"), 1)}
  local.get $handle
)`);
  }
  return helpers.join("\n\n");
}

function emitTypeEquality(type: Type, leftInstr: string, rightInstr: string): string {
  if (type.tag === "float") {
    return `${leftInstr}
${rightInstr}
call $jplmm_eq_f32_ulp1`;
  }
  if (type.tag === "int" || type.tag === "void") {
    return `${leftInstr}
${rightInstr}
i32.eq`;
  }
  if (type.tag === "named") {
    return `${leftInstr}
${rightInstr}
call $${structEqHelperName(type.name)}`;
  }
  if (type.tag === "array") {
    return `${leftInstr}
${rightInstr}
call $${arrayEqHelperName(type)}`;
  }
  const _never: never = type;
  return `${_never}`;
}

function emitWasmStructEqualityHelper(struct: IRStructDef): string {
  const lines = [`(func $${structEqHelperName(struct.name)} (param $a i32) (param $b i32) (result i32)`];
  lines.push(indent(`local.get $a
local.get $b
i32.eq
if
  i32.const 1
  return
end
local.get $a
i32.eqz
local.get $b
i32.eqz
i32.or
if
  i32.const 0
  return
end`, 1));
  for (let i = 0; i < struct.fields.length; i += 1) {
    lines.push(
      indent(
        `${emitTypeEquality(
          struct.fields[i]!.type,
          emitLoadWord(struct.fields[i]!.type, "local.get $a", `i32.const ${i}`),
          emitLoadWord(struct.fields[i]!.type, "local.get $b", `i32.const ${i}`),
        )}
i32.eqz
if
  i32.const 0
  return
end`,
        1,
      ),
    );
  }
  lines.push(indent("i32.const 1", 1));
  lines.push(")");
  return lines.join("\n");
}

function emitWasmArrayEqualityHelper(type: Type): string {
  const arrayType = expectArrayType(type, "array equality");
  const lines = [`(func $${arrayEqHelperName(arrayType)} (param $a i32) (param $b i32) (result i32)`, "  (local $i i32)", "  (local $total i32)"];
  lines.push(indent(`local.get $a
local.get $b
i32.eq
if
  i32.const 1
  return
end
local.get $a
i32.eqz
local.get $b
i32.eqz
i32.or
if
  i32.const 0
  return
end`, 1));
  lines.push(indent(`local.get $a
call $jplmm_array_rank
i32.const ${arrayType.dims}
i32.ne
if
  i32.const 0
  return
end
local.get $b
call $jplmm_array_rank
i32.const ${arrayType.dims}
i32.ne
if
  i32.const 0
  return
end`, 1));
  for (let i = 0; i < arrayType.dims; i += 1) {
    lines.push(
      indent(
        `local.get $a
i32.const ${i}
call $jplmm_array_dim
local.get $b
i32.const ${i}
call $jplmm_array_dim
i32.ne
if
  i32.const 0
  return
end`,
        1,
      ),
    );
  }
  lines.push(indent(`local.get $a
call $jplmm_array_total_cells
local.set $total
block $exit
  loop $loop
    local.get $i
    local.get $total
    i32.ge_s
    br_if $exit
${indent(
  `${emitTypeEquality(
    arrayType.element,
    emitLoadWord(arrayType.element, "local.get $a", `i32.const ${1 + arrayType.dims}\nlocal.get $i\ni32.add`),
    emitLoadWord(arrayType.element, "local.get $b", `i32.const ${1 + arrayType.dims}\nlocal.get $i\ni32.add`),
  )}
    i32.eqz
    if
      i32.const 0
      return
    end`,
  2,
)}
    local.get $i
    i32.const 1
    i32.add
    local.set $i
    br $loop
  end
end
i32.const 1`, 1));
  lines.push(")");
  return lines.join("\n");
}

export function compileWatToWasm(wat: string, options: CompileWatOptions = {}): Uint8Array {
  const tmpRoot = mkdtempSync(join(tmpdir(), "jplmm-wat-"));
  const watPath = join(tmpRoot, "module.wat");
  const wasmPath = join(tmpRoot, "module.wasm");
  const args = [watPath, "-o", wasmPath];

  if (options.tailCalls) {
    args.unshift("--enable-tail-call");
  }

  writeFileSync(watPath, wat);
  try {
    execFileSync(options.wat2wasmPath ?? "wat2wasm", args, {
      stdio: "pipe",
    });
    return new Uint8Array(readFileSync(wasmPath));
  } finally {
    rmSync(tmpRoot, {
      recursive: true,
      force: true,
    });
  }
}

export async function instantiateWatModule(
  wat: string,
  options: InstantiateWatOptions = {},
): Promise<{ wasm: Uint8Array; module: WebAssembly.Module; instance: WebAssembly.Instance }> {
  const wasm = compileWatToWasm(wat, options);
  const bytes = Uint8Array.from(wasm);
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, mergeDefaultImports(options.imports));
  return { wasm, module, instance };
}

export async function compileProgramToInstance(
  program: IRProgram,
  options: EmitWatOptions & InstantiateWatOptions = {},
): Promise<{ wat: string; wasm: Uint8Array; module: WebAssembly.Module; instance: WebAssembly.Instance }> {
  const wat = emitWatModule(program, {
    ...options,
    exportFunctions: options.exportFunctions ?? true,
  });
  const instantiateOptions: InstantiateWatOptions = {
    ...(options.tailCalls !== undefined ? { tailCalls: options.tailCalls } : {}),
    ...(options.wat2wasmPath !== undefined ? { wat2wasmPath: options.wat2wasmPath } : {}),
    ...(options.imports !== undefined ? { imports: options.imports } : {}),
  };
  const compiled = await instantiateWatModule(wat, instantiateOptions);
  return { wat, ...compiled };
}

function indent(text: string, depth: number): string {
  const prefix = "  ".repeat(depth);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function mergeDefaultImports(imports: WebAssembly.Imports | undefined): WebAssembly.Imports {
  const envDefaults = {
    jplmm_exp_f32: (x: number) => Math.fround(Math.exp(x)),
    jplmm_sin_f32: (x: number) => Math.fround(Math.sin(x)),
    jplmm_cos_f32: (x: number) => Math.fround(Math.cos(x)),
    jplmm_tan_f32: (x: number) => Math.fround(Math.tan(x)),
    jplmm_asin_f32: (x: number) => Math.fround(Math.asin(x)),
    jplmm_acos_f32: (x: number) => Math.fround(Math.acos(x)),
    jplmm_atan_f32: (x: number) => Math.fround(Math.atan(x)),
    jplmm_log_f32: (x: number) => Math.fround(Math.log(x)),
    jplmm_pow_f32: (x: number, y: number) => Math.fround(Math.pow(x, y)),
    jplmm_atan2_f32: (y: number, x: number) => Math.fround(Math.atan2(y, x)),
  };

  const mergedEnv = {
    ...envDefaults,
    ...((imports?.env as Record<string, unknown> | undefined) ?? {}),
  };

  return {
    ...(imports ?? {}),
    env: mergedEnv,
  };
}
