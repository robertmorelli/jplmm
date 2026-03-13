import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export * from "./native";
const FUEL_NAME = "jplmm_fuel";
export function emitWatModule(program, options = {}) {
    const helperBlock = emitHelpers();
    const lutLayouts = planLutLayouts(options.artifacts);
    const memoryBlock = emitLutMemory(lutLayouts, options.exportMemory === true);
    const functions = program.functions
        .map((fn) => emitFunctionSet(fn, options, lutLayouts))
        .filter(Boolean)
        .join("\n\n");
    return `(module
${indent(helperBlock, 1)}
${memoryBlock ? `\n${indent(memoryBlock, 1)}` : ""}
${functions ? `\n${indent(functions, 1)}` : ""}
)`;
}
export const packageName = "@jplmm/backend";
function emitFunctionSet(fn, options, lutLayouts) {
    const implementation = options.artifacts?.implementations.get(fn.name);
    if (implementation?.tag === "closed_form_linear_countdown") {
        return emitClosedFormFunction(fn, implementation, options);
    }
    if (implementation?.tag === "lut") {
        const layout = lutLayouts.get(fn.name);
        if (layout) {
            return emitLutFunctionSet(fn, layout, options);
        }
    }
    return emitPlainFunctionSet(fn, options, {
        wasmName: fn.name,
        publicName: fn.name,
        exportName: options.exportFunctions === true ? fn.name : undefined,
        allowTailCalls: true,
    });
}
function emitPlainFunctionSet(fn, options, target) {
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
    });
}
function emitClosedFormFunction(fn, implementation, options) {
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
function emitLutFunctionSet(fn, layout, options) {
    const genericName = `${fn.name}__generic`;
    const exportClause = options.exportFunctions === true ? ` (export "${fn.name}")` : "";
    const wrapper = `(func $${fn.name}${exportClause} ${fn.params
        .map((param) => `(param $${param.name} ${wasmType(param.type)})`)
        .join(" ")} (result ${wasmType(fn.retType)})
  (local $jplmm_lut_index i32)
${indent(emitLutWrapperBody(fn, layout), 1)}
)`;
    const fallback = emitPlainFunctionSet(fn, {
        ...options,
        tailCalls: false,
    }, {
        wasmName: genericName,
        publicName: fn.name,
        exportName: undefined,
        allowTailCalls: false,
    });
    return [wrapper, fallback].join("\n\n");
}
function emitGasTailWrapper(fn, wasmName, exportName, helperName, gasLimit) {
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
function emitFunctionBody(ctx) {
    const params = emitParamDecls(ctx);
    const result = ctx.fn.retType.tag === "void" ? "" : ` (result ${wasmType(ctx.fn.retType)})`;
    const localDecls = collectLocalDecls(ctx);
    const exportClause = ctx.exportName ? ` (export "${ctx.exportName}")` : "";
    const lines = [];
    if (ctx.fuel?.kind === "local") {
        lines.push(`i32.const ${ctx.fuel.limit}`);
        lines.push(`local.set $${ctx.fuel.name}`);
    }
    const stmtBody = emitStatements(ctx);
    if (ctx.loopLabel) {
        lines.push(`loop $${ctx.loopLabel}`);
        lines.push(indent(stmtBody, 1));
        lines.push("end");
    }
    else if (stmtBody) {
        lines.push(stmtBody);
    }
    if (ctx.fn.retType.tag !== "void") {
        lines.push("local.get $res");
    }
    return `(func $${ctx.wasmName}${exportClause} ${params}${result}
${localDecls ? `${indent(localDecls, 1)}\n` : ""}${indent(lines.join("\n"), 1)}
)`;
}
function emitStatements(ctx) {
    const chunks = [];
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
function emitTailRecStmt(expr, ctx) {
    const lines = [];
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
        lines.push(`local.set $${ctx.fn.params[i].name}`);
    }
    if (!ctx.loopLabel) {
        throw new Error(`Internal error: explicit loop lowering missing loop label for '${ctx.fn.name}'`);
    }
    lines.push(`br $${ctx.loopLabel}`);
    return lines.join("\n");
}
function emitExpr(expr, ctx) {
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
        case "index":
        case "field":
        case "struct_cons":
        case "array_cons":
        case "array_expr":
        case "sum_expr":
            throw new Error(`WAT emission for '${expr.tag}' is not implemented yet`);
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function emitNonTailRecExpr(expr, ctx) {
    const resultType = wasmType(expr.resultType);
    const callLines = [...emitRecArgLoads(expr), `call $${ctx.publicName}`].join("\n");
    const lines = [];
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
function emitRecArgStores(expr, ctx) {
    return expr.args
        .map((arg, idx) => `${emitExpr(arg, ctx)}\nlocal.set $${recArgLocal(expr.id, idx)}`)
        .join("\n");
}
function emitRecArgLoads(expr) {
    return expr.args.map((_, idx) => `local.get $${recArgLocal(expr.id, idx)}`);
}
function emitRecCollapseCondition(expr, ctx) {
    if (expr.args.length === 0) {
        return "i32.const 1";
    }
    const lines = [];
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
function emitParamEquality(param) {
    if (param.type.tag === "float") {
        return "call $jplmm_eq_f32_ulp1";
    }
    if (param.type.tag === "int" || param.type.tag === "void") {
        return "i32.eq";
    }
    throw new Error(`WAT emission for parameter type '${param.type.tag}' is not implemented yet`);
}
function emitReturnCurrentRes(retType) {
    if (retType.tag === "void") {
        return "return";
    }
    return "local.get $res\nreturn";
}
function emitParamDecls(ctx) {
    const params = ctx.fn.params.map((param) => `(param $${param.name} ${wasmType(param.type)})`);
    if (ctx.fuel?.kind === "param") {
        params.push(`(param $${ctx.fuel.name} i32)`);
    }
    return params.join(" ");
}
function emitLutWrapperBody(fn, layout) {
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
function emitLutRangeCondition(fn, impl) {
    if (fn.params.length === 0) {
        return "i32.const 1";
    }
    const lines = [];
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
function emitLutFastPath(fn, layout) {
    const lines = ["i32.const 0", "local.set $jplmm_lut_index"];
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
function planLutLayouts(artifacts) {
    const layouts = new Map();
    if (!artifacts) {
        return layouts;
    }
    let offset = 0;
    const lutEntries = [...artifacts.implementations.entries()]
        .filter((entry) => entry[1].tag === "lut")
        .sort(([a], [b]) => a.localeCompare(b));
    for (const [fnName, impl] of lutEntries) {
        offset = alignTo(offset, 4);
        layouts.set(fnName, { impl, offset });
        offset += impl.table.length * 4;
    }
    return layouts;
}
function emitLutMemory(layouts, exportMemory) {
    if (layouts.size === 0) {
        return "";
    }
    let totalBytes = 0;
    const dataLines = [];
    const ordered = [...layouts.entries()].sort(([, a], [, b]) => a.offset - b.offset);
    for (const [, layout] of ordered) {
        const bytes = encodeLutBytes(layout.impl);
        totalBytes = Math.max(totalBytes, layout.offset + layout.impl.table.length * 4);
        dataLines.push(`(data (i32.const ${layout.offset}) "${bytes}")`);
    }
    const pages = Math.max(1, Math.ceil(totalBytes / 65536));
    const memoryLines = [`(memory $jplmm_lut_mem ${pages})`];
    if (exportMemory) {
        memoryLines.push(`(export "memory" (memory $jplmm_lut_mem))`);
    }
    return [...memoryLines, ...dataLines].join("\n");
}
function encodeLutBytes(impl) {
    return impl.table.map((value) => encodeScalar4(value, impl.resultType)).join("");
}
function encodeScalar4(value, type) {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    if (type.tag === "float") {
        view.setFloat32(0, value, true);
    }
    else {
        view.setInt32(0, value | 0, true);
    }
    let out = "";
    for (let i = 0; i < 4; i += 1) {
        out += `\\${view.getUint8(i).toString(16).padStart(2, "0")}`;
    }
    return out;
}
function alignTo(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
}
function collectLocalDecls(ctx) {
    const locals = new Map();
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
        }
    }
    return [...locals.entries()]
        .filter(([name]) => !ctx.fn.params.some((param) => param.name === name))
        .map(([name, type]) => `(local $${name} ${type})`)
        .join(" ");
}
function collectRecTemps(expr, locals) {
    if (expr.tag === "rec") {
        for (let i = 0; i < expr.args.length; i += 1) {
            locals.set(recArgLocal(expr.id, i), wasmType(expr.args[i].resultType));
            collectRecTemps(expr.args[i], locals);
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
function findTailRecStmt(stmts) {
    for (const stmt of stmts) {
        if (stmt.tag === "ret" && stmt.expr.tag === "rec" && stmt.expr.tailPosition) {
            return stmt;
        }
    }
    return null;
}
function getFiniteGasLimit(fn) {
    const gas = fn.body.find((stmt) => stmt.tag === "gas");
    if (!gas || gas.limit === "inf") {
        return null;
    }
    return gas.limit;
}
function recArgLocal(id, index) {
    return `jplmm_rec_${id}_${index}`;
}
function emitCall(name, argExprs, resultType) {
    const args = argExprs.join("\n");
    switch (name) {
        case "sqrt":
            return `${args}\nf32.sqrt`;
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
function rawBinop(op, type) {
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
function wasmType(type) {
    if (type.tag === "float") {
        return "f32";
    }
    if (type.tag === "int" || type.tag === "void") {
        return "i32";
    }
    throw new Error(`WAT emission for type '${type.tag}' is not implemented yet`);
}
function emitHelpers() {
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
export function compileWatToWasm(wat, options = {}) {
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
    }
    finally {
        rmSync(tmpRoot, {
            recursive: true,
            force: true,
        });
    }
}
export async function instantiateWatModule(wat, options = {}) {
    const wasm = compileWatToWasm(wat, options);
    const bytes = Uint8Array.from(wasm);
    const module = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(module, options.imports ?? {});
    return { wasm, module, instance };
}
export async function compileProgramToInstance(program, options = {}) {
    const wat = emitWatModule(program, {
        ...options,
        exportFunctions: options.exportFunctions ?? true,
    });
    const instantiateOptions = {
        ...(options.tailCalls !== undefined ? { tailCalls: options.tailCalls } : {}),
        ...(options.wat2wasmPath !== undefined ? { wat2wasmPath: options.wat2wasmPath } : {}),
        ...(options.imports !== undefined ? { imports: options.imports } : {}),
    };
    const compiled = await instantiateWatModule(wat, instantiateOptions);
    return { wat, ...compiled };
}
function indent(text, depth) {
    const prefix = "  ".repeat(depth);
    return text
        .split("\n")
        .map((line) => `${prefix}${line}`)
        .join("\n");
}
//# sourceMappingURL=index.js.map