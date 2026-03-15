import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getArrayExtentNames, getScalarBounds } from "@jplmm/ast";
export * from "./native";
const FUEL_NAME = "jplmm_fuel";
export function emitWatModule(program, options = {}) {
    const module = createWatModuleContext(program, options);
    const importBlock = emitMathImports();
    const helperBlock = emitHelpers(program, module.memoryPlan.heapBase, options.exportFunctions === true);
    const memoryBlock = emitMemoryBlock(module.memoryPlan, options.exportMemory === true);
    const commentBlock = emitModuleComments(options.moduleComments);
    const functions = program.functions
        .map((fn) => emitFunctionSet(fn, options, module))
        .filter(Boolean)
        .join("\n\n");
    return `(module
${commentBlock ? `${indent(commentBlock, 1)}\n` : ""}\
${importBlock ? `${indent(importBlock, 1)}\n` : ""}\
${indent(helperBlock, 1)}
${memoryBlock ? `\n${indent(memoryBlock, 1)}` : ""}
${functions ? `\n${indent(functions, 1)}` : ""}
)`;
}
export const packageName = "@jplmm/backend";
export function buildWatSemantics(program, options = {}) {
    const module = createWatModuleContext(program, options);
    const functions = program.functions.map((fn) => describeWatFunctionSemantics(planWatFunctionLowering(fn, options, module.memoryPlan.lutLayouts, module.structs)));
    const helperNames = new Set();
    for (const fn of functions) {
        for (const helper of fn.helpers) {
            helperNames.add(helper.name);
        }
        for (const helper of fn.fallback?.helpers ?? []) {
            helperNames.add(helper.name);
        }
    }
    return {
        kind: "jplmm_wasm_semantics",
        options: {
            tailCalls: options.tailCalls !== false,
            exportFunctions: options.exportFunctions === true,
            exportMemory: options.exportMemory === true,
        },
        memory: {
            heapBase: module.memoryPlan.heapBase,
            initialPages: module.memoryPlan.initialPages,
            luts: [...module.memoryPlan.lutLayouts.entries()]
                .sort(([, a], [, b]) => a.offset - b.offset)
                .map(([fnName, layout]) => ({
                fnName,
                offset: layout.offset,
                cells: layout.impl.table.length,
                resultType: layout.impl.resultType,
                parameterRanges: layout.impl.parameterRanges,
            })),
        },
        helperSemantics: Object.fromEntries([...helperNames]
            .sort((a, b) => a.localeCompare(b))
            .map((name) => [name, describeHelperSemantic(name)])),
        functions,
    };
}
function createWatModuleContext(program, options) {
    return {
        structs: new Map(program.structs.map((struct) => [struct.name, struct])),
        memoryPlan: planMemory(options.artifacts),
    };
}
function emitFunctionSet(fn, options, module) {
    return emitFunctionSetFromPlan(planWatFunctionLowering(fn, options, module.memoryPlan.lutLayouts, module.structs), options);
}
function planWatFunctionLowering(fn, options, lutLayouts, structs) {
    const implementation = options.artifacts?.implementations.get(fn.name);
    const implementationTag = implementationTagForLowering(implementation?.tag);
    const aitken = implementation?.tag === "aitken_scalar_tail" ? implementation : null;
    if (implementation?.tag === "closed_form_linear_countdown") {
        return {
            kind: "closed_form",
            implementationTag: "closed_form_linear_countdown",
            fn,
            entryWasmName: fn.name,
            bodyWasmName: fn.name,
            exportName: options.exportFunctions === true ? fn.name : undefined,
            implementation,
        };
    }
    if (implementation?.tag === "lut") {
        const layout = lutLayouts.get(fn.name);
        if (layout) {
            return {
                kind: "lut",
                implementationTag: "lut",
                fn,
                entryWasmName: fn.name,
                bodyWasmName: fn.name,
                exportName: options.exportFunctions === true ? fn.name : undefined,
                layout,
                fallback: planPlainFunctionLowering(fn, {
                    ...options,
                    tailCalls: false,
                }, {
                    wasmName: `${fn.name}__generic`,
                    publicName: fn.name,
                    exportName: undefined,
                    allowTailCalls: false,
                    aitken: null,
                    structs,
                }, implementationTag),
            };
        }
    }
    return planPlainFunctionLowering(fn, options, {
        wasmName: fn.name,
        publicName: fn.name,
        exportName: options.exportFunctions === true ? fn.name : undefined,
        allowTailCalls: aitken === null,
        aitken,
        structs,
    }, implementationTag);
}
function planPlainFunctionLowering(fn, options, target, implementationTag) {
    const gasLimit = getFiniteGasLimit(fn);
    const hasTailRec = findTailRecStmt(fn.body) !== null;
    const wantTailCalls = target.allowTailCalls && hasTailRec && options.tailCalls !== false && target.aitken === null;
    if (wantTailCalls && gasLimit !== null) {
        const helperName = `${target.wasmName}__tail`;
        return {
            kind: "plain",
            implementationTag,
            entryWasmName: target.wasmName,
            bodyWasmName: helperName,
            entryExportName: target.exportName,
            gasLimit,
            hasTailRec,
            ctx: {
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
                aitken: target.aitken,
                structs: target.structs,
            },
        };
    }
    return {
        kind: "plain",
        implementationTag,
        entryWasmName: target.wasmName,
        bodyWasmName: target.wasmName,
        entryExportName: target.exportName,
        gasLimit,
        hasTailRec,
        ctx: {
            fn,
            wasmName: target.wasmName,
            publicName: target.publicName,
            tailTargetName: target.wasmName,
            exportName: target.exportName,
            useTailCalls: wantTailCalls,
            loopLabel: wantTailCalls ? null : hasTailRec ? `${target.wasmName}__loop` : null,
            fuel: gasLimit === null ? null : { kind: "local", name: FUEL_NAME, limit: gasLimit },
            aitken: target.aitken,
            structs: target.structs,
        },
    };
}
function emitFunctionSetFromPlan(plan, options) {
    switch (plan.kind) {
        case "closed_form":
            return emitClosedFormFunction(plan.fn, plan.implementation, {
                ...options,
                exportFunctions: plan.exportName !== undefined,
            });
        case "lut":
            return emitLutFunctionSetFromPlan(plan);
        case "plain":
            return emitPlainFunctionSet(plan);
        default: {
            const _never = plan;
            return _never;
        }
    }
}
function emitPlainFunctionSet(plan) {
    if (plan.entryWasmName !== plan.bodyWasmName && plan.gasLimit !== null) {
        return [
            emitGasTailWrapper(plan.ctx.fn, plan.entryWasmName, plan.entryExportName, plan.bodyWasmName, plan.gasLimit),
            emitFunctionBody(plan.ctx),
        ].join("\n\n");
    }
    return emitFunctionBody(plan.ctx);
}
function implementationTagForLowering(tag) {
    switch (tag) {
        case "closed_form_linear_countdown":
        case "lut":
        case "aitken_scalar_tail":
        case "linear_speculation":
            return tag;
        default:
            return "plain";
    }
}
function emitClosedFormFunction(fn, implementation, options) {
    const param = fn.params[implementation.paramIndex];
    if (!param) {
        throw new Error(`Closed-form lowering failed for '${fn.name}'`);
    }
    const exportClause = options.exportFunctions === true ? ` (export "${fn.name}")` : "";
    const normalization = emitParamNormalizationPrelude(fn.params);
    const body = `
${normalization ? `${normalization}\n` : ""}
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
function emitLutFunctionSetFromPlan(plan) {
    const exportClause = plan.exportName ? ` (export "${plan.exportName}")` : "";
    const wrapper = `(func $${plan.entryWasmName}${exportClause} ${plan.fn.params
        .map((param) => `(param $${param.name} ${wasmType(param.type)})`)
        .join(" ")} (result ${wasmType(plan.fn.retType)})
  (local $jplmm_lut_index i32)
${indent(emitLutWrapperBody(plan.fn, plan.layout), 1)}
)`;
    const fallback = emitPlainFunctionSet(plan.fallback);
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
    const normalization = emitParamNormalizationPrelude(ctx.fn.params);
    if (normalization) {
        chunks.push(normalization);
    }
    const extents = emitParamExtentPrelude(ctx.fn.params);
    if (extents) {
        chunks.push(extents);
    }
    if (ctx.aitken) {
        chunks.push(emitAitkenPrelude(ctx));
    }
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
    if (ctx.aitken) {
        lines.push(emitAitkenRewrite(ctx, expr));
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
function describeWatFunctionSemantics(plan) {
    switch (plan.kind) {
        case "plain": {
            const statements = describePlainStatements(plan.ctx);
            const recursion = describePlainRecursionSemantics(plan);
            return {
                name: plan.ctx.fn.name,
                entryWasmName: plan.entryWasmName,
                bodyWasmName: plan.bodyWasmName,
                exportName: plan.entryExportName ?? null,
                implementation: {
                    tag: plan.implementationTag,
                    loweredAs: plan.entryWasmName === plan.bodyWasmName ? "plain" : "gas_tail_wrapper",
                    fallbackWasmName: null,
                    notes: describePlainImplementationNotes(plan),
                },
                helpers: buildHelperSemantics(collectHelperNamesFromStatements(statements, recursion)),
                recursion,
                statements,
                fallback: null,
            };
        }
        case "closed_form": {
            const helpers = buildHelperSemantics([
                "jplmm_sat_add_i32",
                "jplmm_total_div_i32",
                "jplmm_sat_mul_i32",
            ]);
            return {
                name: plan.fn.name,
                entryWasmName: plan.entryWasmName,
                bodyWasmName: plan.bodyWasmName,
                exportName: plan.exportName ?? null,
                implementation: {
                    tag: plan.implementationTag,
                    loweredAs: "closed_form",
                    fallbackWasmName: null,
                    notes: [
                        "recognized as a linear countdown closed form",
                        "lowered to saturating integer arithmetic plus total division",
                    ],
                },
                helpers,
                recursion: {
                    hasTailRec: false,
                    hasNonTailRec: false,
                    tailStrategy: "none",
                    fuel: { kind: "none", limit: null },
                    collapse: [],
                    aitken: false,
                },
                statements: [{
                        stmtIndex: -1,
                        tag: "ret",
                        lowering: "closed-form specialization computes the countdown result directly with total and saturating arithmetic helpers",
                        target: "res",
                        expr: null,
                    }],
                fallback: null,
            };
        }
        case "lut": {
            const fallbackStatements = describePlainStatements(plan.fallback.ctx);
            const fallbackRecursion = describePlainRecursionSemantics(plan.fallback);
            return {
                name: plan.fn.name,
                entryWasmName: plan.entryWasmName,
                bodyWasmName: plan.bodyWasmName,
                exportName: plan.exportName ?? null,
                implementation: {
                    tag: plan.implementationTag,
                    loweredAs: "lut_wrapper",
                    fallbackWasmName: plan.fallback.entryWasmName,
                    notes: [
                        "entrypoint checks whether inputs fall inside the tabulated parameter ranges",
                        "in-range calls load directly from Wasm linear memory; out-of-range calls fall back to the generic function body",
                    ],
                },
                helpers: [],
                recursion: {
                    hasTailRec: false,
                    hasNonTailRec: false,
                    tailStrategy: "none",
                    fuel: { kind: "none", limit: null },
                    collapse: [],
                    aitken: false,
                },
                statements: [{
                        stmtIndex: -1,
                        tag: "ret",
                        lowering: "LUT wrapper checks parameter ranges, loads from linear memory on hits, and otherwise calls the generic fallback",
                        target: "res",
                        expr: null,
                    }],
                fallback: {
                    wasmName: plan.fallback.entryWasmName,
                    helpers: buildHelperSemantics(collectHelperNamesFromStatements(fallbackStatements, fallbackRecursion)),
                    recursion: fallbackRecursion,
                    statements: fallbackStatements,
                },
            };
        }
        default: {
            const _never = plan;
            return _never;
        }
    }
}
function describePlainStatements(ctx) {
    return ctx.fn.body.map((stmt, stmtIndex) => {
        if (stmt.tag === "gas") {
            return {
                stmtIndex,
                tag: stmt.tag,
                lowering: stmt.limit === "inf"
                    ? "gas inf is not lowered to a finite Wasm fuel guard"
                    : `finite gas ${stmt.limit} becomes an explicit recursion fuel guard in Wasm`,
                target: null,
                expr: null,
            };
        }
        if (stmt.tag === "rad") {
            return {
                stmtIndex,
                tag: stmt.tag,
                lowering: "rad is a proof/termination annotation and does not emit Wasm instructions",
                target: null,
                expr: describeExprSemantics(stmt.expr, ctx),
            };
        }
        if (stmt.tag === "let") {
            return {
                stmtIndex,
                tag: stmt.tag,
                lowering: "evaluates the expression and stores the lowered value in a Wasm local",
                target: stmt.name,
                expr: describeExprSemantics(stmt.expr, ctx),
            };
        }
        if (stmt.expr.tag === "rec" && stmt.expr.tailPosition) {
            return {
                stmtIndex,
                tag: stmt.tag,
                lowering: ctx.useTailCalls
                    ? "tail recursion becomes a collapse check, optional fuel decrement, and return_call to the helper body"
                    : "tail recursion becomes a collapse check, optional fuel decrement, local parameter rewrite, and loop branch",
                target: ctx.useTailCalls ? null : "params",
                expr: describeExprSemantics(stmt.expr, ctx),
            };
        }
        return {
            stmtIndex,
            tag: stmt.tag,
            lowering: "evaluates the expression and stores the lowered value in the result local",
            target: "res",
            expr: describeExprSemantics(stmt.expr, ctx),
        };
    });
}
function describePlainRecursionSemantics(plan) {
    const hasNonTailRec = plan.ctx.fn.body.some((stmt) => stmt.tag !== "gas" && exprHasNonTailRec(stmt.expr));
    const hasAnyRec = plan.hasTailRec || hasNonTailRec;
    return {
        hasTailRec: plan.hasTailRec,
        hasNonTailRec,
        tailStrategy: plan.ctx.useTailCalls ? "return_call" : plan.hasTailRec ? "loop_branch" : "none",
        fuel: plan.ctx.fuel
            ? {
                kind: plan.ctx.fuel.kind,
                limit: plan.ctx.fuel.limit,
            }
            : {
                kind: "none",
                limit: null,
            },
        collapse: hasAnyRec
            ? plan.ctx.fn.params.map((param) => {
                const equality = describeParamEqualityLowering(param);
                return {
                    param: param.name,
                    type: param.type,
                    equality: equality.semantics,
                    helper: equality.helper,
                };
            })
            : [],
        aitken: plan.ctx.aitken !== null,
    };
}
function describePlainImplementationNotes(plan) {
    const notes = [];
    if (plan.entryWasmName !== plan.bodyWasmName && plan.gasLimit !== null) {
        notes.push(`exported entry ${plan.entryWasmName} forwards an explicit finite fuel counter to helper ${plan.bodyWasmName}`);
    }
    if (plan.implementationTag === "linear_speculation") {
        notes.push("linear speculation was recognized upstream, but the Wasm backend currently lowers the generic recursive body");
    }
    if (plan.ctx.aitken) {
        notes.push("Aitken acceleration is applied in the tail-recursive state-update path before the next recursive step");
    }
    return notes;
}
function describeExprSemantics(expr, ctx) {
    switch (expr.tag) {
        case "int_lit":
            return leafExprSemantics(expr, "const", "materializes a 32-bit integer constant", [], ["i32.const"]);
        case "float_lit":
            return leafExprSemantics(expr, "const", "materializes a 32-bit float constant", [], ["f32.const"]);
        case "void_lit":
            return leafExprSemantics(expr, "default_void", "void is represented with a zero default in the Wasm ABI slot", [], [expr.resultType.tag === "float" ? "f32.const 0" : "i32.const 0"]);
        case "var":
            return leafExprSemantics(expr, "local_get", `reads Wasm local '${expr.name}'`, [], ["local.get"]);
        case "res":
            return leafExprSemantics(expr, "local_get", "reads the current result local", [], ["local.get"]);
        case "binop":
            return {
                tag: expr.tag,
                resultType: expr.resultType,
                lowering: {
                    kind: "raw_binop",
                    semantics: `applies raw Wasm ${expr.resultType.tag} ${expr.op} arithmetic`,
                    helper: null,
                    helpers: [],
                    rawOps: [rawBinop(expr.op, expr.resultType)],
                    notes: [],
                },
                children: [describeExprSemantics(expr.left, ctx), describeExprSemantics(expr.right, ctx)],
            };
        case "unop":
            return {
                tag: expr.tag,
                resultType: expr.resultType,
                lowering: {
                    kind: "raw_unop",
                    semantics: expr.resultType.tag === "int"
                        ? "integer negation is lowered as multiply by -1"
                        : "float negation is lowered as f32.neg",
                    helper: null,
                    helpers: [],
                    rawOps: expr.resultType.tag === "int" ? ["i32.const -1", "i32.mul"] : ["f32.neg"],
                    notes: [],
                },
                children: [describeExprSemantics(expr.operand, ctx)],
            };
        case "call": {
            const lowering = describeCallLowering(expr.name, expr.resultType);
            return {
                tag: expr.tag,
                resultType: expr.resultType,
                lowering: {
                    kind: lowering.kind,
                    semantics: lowering.semantics,
                    helper: lowering.helper,
                    helpers: lowering.helpers,
                    rawOps: lowering.rawOps,
                    notes: lowering.notes,
                },
                children: expr.args.map((arg) => describeExprSemantics(arg, ctx)),
            };
        }
        case "rec":
            return {
                tag: expr.tag,
                resultType: expr.resultType,
                lowering: {
                    kind: expr.tailPosition ? "tail_recursion" : "recursive_call",
                    semantics: describeRecSemantics(expr, ctx),
                    helper: null,
                    helpers: recursionHelperNames(ctx.fn.params),
                    rawOps: [],
                    notes: describeRecNotes(expr, ctx),
                },
                children: expr.args.map((arg) => describeExprSemantics(arg, ctx)),
            };
        case "total_div":
            return helperExprSemantics(expr, expr.resultType.tag === "float" ? "jplmm_total_div_f32" : "jplmm_total_div_i32", "totalized division defers to a backend helper that returns zero on division by zero", [describeExprSemantics(expr.left, ctx), describeExprSemantics(expr.right, ctx)]);
        case "total_mod":
            return helperExprSemantics(expr, expr.resultType.tag === "float" ? "jplmm_total_mod_f32" : "jplmm_total_mod_i32", "totalized modulus defers to a backend helper that returns zero on division by zero", [describeExprSemantics(expr.left, ctx), describeExprSemantics(expr.right, ctx)]);
        case "nan_to_zero":
            return helperExprSemantics(expr, "jplmm_nan_to_zero_f32", "normalizes NaN float results to zero", [describeExprSemantics(expr.value, ctx)]);
        case "sat_add":
            return helperExprSemantics(expr, "jplmm_sat_add_i32", "saturating integer addition is delegated to a helper", [describeExprSemantics(expr.left, ctx), describeExprSemantics(expr.right, ctx)]);
        case "sat_sub":
            return helperExprSemantics(expr, "jplmm_sat_sub_i32", "saturating integer subtraction is delegated to a helper", [describeExprSemantics(expr.left, ctx), describeExprSemantics(expr.right, ctx)]);
        case "sat_mul":
            return helperExprSemantics(expr, "jplmm_sat_mul_i32", "saturating integer multiplication is delegated to a helper", [describeExprSemantics(expr.left, ctx), describeExprSemantics(expr.right, ctx)]);
        case "sat_neg":
            return helperExprSemantics(expr, "jplmm_sat_neg_i32", "saturating integer negation is delegated to a helper", [describeExprSemantics(expr.operand, ctx)]);
        case "field": {
            const targetType = expr.target.resultType.tag === "named" ? expr.target.resultType.name : "unknown";
            return {
                tag: expr.tag,
                resultType: expr.resultType,
                lowering: {
                    kind: "struct_field",
                    semantics: `checks for a non-null ${targetType} handle and then loads field '${expr.field}' from linear memory`,
                    helper: expr.resultType.tag === "float" ? "jplmm_word_load_f32" : "jplmm_word_load_i32",
                    helpers: [expr.resultType.tag === "float" ? "jplmm_word_load_f32" : "jplmm_word_load_i32"],
                    rawOps: [],
                    notes: [],
                },
                children: [describeExprSemantics(expr.target, ctx)],
            };
        }
        case "struct_cons":
            return {
                tag: expr.tag,
                resultType: expr.resultType,
                lowering: {
                    kind: "struct_alloc",
                    semantics: `allocates a heap-backed struct '${expr.name}' and stores each lowered field into linear memory`,
                    helper: "jplmm_alloc_words",
                    helpers: ["jplmm_alloc_words", ...collectStoreHelpers(expr.fields)],
                    rawOps: [],
                    notes: [],
                },
                children: expr.fields.map((field) => describeExprSemantics(field, ctx)),
            };
        case "array_cons":
            return {
                tag: expr.tag,
                resultType: expr.resultType,
                lowering: {
                    kind: "array_literal",
                    semantics: expr.elements[0]?.resultType.tag === "array"
                        ? "allocates an array, checks nested ranks and dimensions for agreement, and copies child payloads into linear memory"
                        : "allocates a rank-1 array and stores each element into linear memory",
                    helper: arrayAllocHelperName(expectArrayType(expr.resultType, "array literal").dims),
                    helpers: arrayConsHelpers(expr),
                    rawOps: [],
                    notes: [],
                },
                children: expr.elements.map((element) => describeExprSemantics(element, ctx)),
            };
        case "array_expr":
            return {
                tag: expr.tag,
                resultType: expr.resultType,
                lowering: {
                    kind: "array_comprehension",
                    semantics: "iterates the bindings with positive extents, infers or checks array dimensions, allocates one destination array, then fills it in row-major order",
                    helper: arrayAllocHelperName(expectArrayType(expr.resultType, "array comprehension").dims),
                    helpers: arrayExprHelpers(expr),
                    rawOps: [],
                    notes: bindingLoopNotes(expr),
                },
                children: [
                    ...expr.bindings.map((binding) => describeExprSemantics(binding.expr, ctx)),
                    describeExprSemantics(expr.body, ctx),
                ],
            };
        case "sum_expr":
            return {
                tag: expr.tag,
                resultType: expr.resultType,
                lowering: {
                    kind: "sum_comprehension",
                    semantics: "iterates the bindings with positive extents and accumulates the body with totalized sum semantics",
                    helper: expr.resultType.tag === "float" ? "jplmm_nan_to_zero_f32" : "jplmm_sat_add_i32",
                    helpers: expr.resultType.tag === "float" ? ["jplmm_nan_to_zero_f32"] : ["jplmm_sat_add_i32"],
                    rawOps: expr.resultType.tag === "float" ? ["f32.add"] : [],
                    notes: bindingLoopNotes(expr),
                },
                children: [
                    ...expr.bindings.map((binding) => describeExprSemantics(binding.expr, ctx)),
                    describeExprSemantics(expr.body, ctx),
                ],
            };
        case "index":
            return {
                tag: expr.tag,
                resultType: expr.resultType,
                lowering: {
                    kind: "array_index",
                    semantics: expr.indices.length === expectArrayType(expr.array.resultType, "array indexing").dims
                        ? "computes row-major offsets with clamped indices and loads one element from linear memory"
                        : "computes row-major offsets with clamped indices and slices the remaining suffix array",
                    helper: expr.indices.length === expectArrayType(expr.array.resultType, "array indexing").dims
                        ? (expr.resultType.tag === "float" ? "jplmm_word_load_f32" : "jplmm_word_load_i32")
                        : "jplmm_array_slice",
                    helpers: indexHelpers(expr),
                    rawOps: [],
                    notes: ["each index is clamped into the inclusive range [0, dim - 1] before offset calculation"],
                },
                children: [describeExprSemantics(expr.array, ctx), ...expr.indices.map((index) => describeExprSemantics(index, ctx))],
            };
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function leafExprSemantics(expr, kind, semantics, helpers, rawOps) {
    return {
        tag: expr.tag,
        resultType: expr.resultType,
        lowering: {
            kind,
            semantics,
            helper: helpers[0] ?? null,
            helpers,
            rawOps,
            notes: [],
        },
        children: [],
    };
}
function helperExprSemantics(expr, helper, semantics, children) {
    return {
        tag: expr.tag,
        resultType: expr.resultType,
        lowering: {
            kind: "helper_call",
            semantics,
            helper,
            helpers: [helper],
            rawOps: [],
            notes: [],
        },
        children,
    };
}
function collectHelperNamesFromStatements(statements, recursion) {
    const names = new Set();
    for (const stmt of statements) {
        if (stmt.expr) {
            for (const name of collectHelperNamesFromExpr(stmt.expr)) {
                names.add(name);
            }
        }
    }
    for (const collapse of recursion.collapse) {
        if (collapse.helper) {
            names.add(collapse.helper);
        }
    }
    return [...names];
}
function collectHelperNamesFromExpr(expr) {
    const names = new Set(expr.lowering.helpers);
    if (expr.lowering.helper) {
        names.add(expr.lowering.helper);
    }
    for (const child of expr.children) {
        for (const name of collectHelperNamesFromExpr(child)) {
            names.add(name);
        }
    }
    return [...names];
}
function buildHelperSemantics(names) {
    return [...new Set(names)]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({
        name,
        semantics: describeHelperSemantic(name),
    }));
}
function bindingLoopNotes(expr) {
    return [
        "binding extents are forced to be at least 1 via max(extent, 1)",
        "bindings are iterated in lexicographic order with nested Wasm loops",
        expr.bindings.length === 0 ? "the body runs exactly once" : `the body runs once per point in the ${expr.bindings.length}-level iteration space`,
    ];
}
function arrayConsHelpers(expr) {
    const arrayType = expectArrayType(expr.resultType, "array literal");
    const helpers = [arrayAllocHelperName(arrayType.dims)];
    if (expr.elements[0]?.resultType.tag === "array") {
        helpers.push("jplmm_array_rank", "jplmm_array_dim", "jplmm_array_total_cells", "jplmm_copy_words");
    }
    else {
        helpers.push(...collectStoreHelpers(expr.elements));
    }
    return [...new Set(helpers)];
}
function arrayExprHelpers(expr) {
    const helpers = [
        arrayAllocHelperName(expectArrayType(expr.resultType, "array comprehension").dims),
        "jplmm_max_i32",
    ];
    if (expr.body.resultType.tag === "array") {
        helpers.push("jplmm_array_rank", "jplmm_array_dim", "jplmm_array_total_cells", "jplmm_copy_words");
    }
    else {
        helpers.push(...collectStoreHelpers([expr.body]));
    }
    return [...new Set(helpers)];
}
function indexHelpers(expr) {
    const arrayType = expectArrayType(expr.array.resultType, "array indexing");
    const helpers = [
        "jplmm_array_rank",
        "jplmm_array_dim",
        "jplmm_array_stride",
        "jplmm_max_i32",
        "jplmm_clamp_i32",
    ];
    if (expr.indices.length === arrayType.dims) {
        helpers.push(expr.resultType.tag === "float" ? "jplmm_word_load_f32" : "jplmm_word_load_i32");
    }
    else {
        helpers.push("jplmm_array_slice");
    }
    return helpers;
}
function collectStoreHelpers(values) {
    return [...new Set(values.map((value) => value.resultType.tag === "float" ? "jplmm_word_store_f32" : "jplmm_word_store_i32"))];
}
function arrayAllocHelperName(rank) {
    return `jplmm_array_alloc_r${rank}`;
}
function exprHasNonTailRec(expr) {
    if (expr.tag === "rec") {
        if (!expr.tailPosition) {
            return true;
        }
        return expr.args.some((arg) => exprHasNonTailRec(arg));
    }
    switch (expr.tag) {
        case "binop":
        case "total_div":
        case "total_mod":
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
            return exprHasNonTailRec(expr.left) || exprHasNonTailRec(expr.right);
        case "unop":
        case "sat_neg":
            return exprHasNonTailRec(expr.operand);
        case "call":
            return expr.args.some((arg) => exprHasNonTailRec(arg));
        case "field":
            return exprHasNonTailRec(expr.target);
        case "struct_cons":
            return expr.fields.some((field) => exprHasNonTailRec(field));
        case "array_cons":
            return expr.elements.some((element) => exprHasNonTailRec(element));
        case "array_expr":
        case "sum_expr":
            return expr.bindings.some((binding) => exprHasNonTailRec(binding.expr)) || exprHasNonTailRec(expr.body);
        case "index":
            return exprHasNonTailRec(expr.array) || expr.indices.some((index) => exprHasNonTailRec(index));
        case "nan_to_zero":
            return exprHasNonTailRec(expr.value);
        default:
            return false;
    }
}
function describeRecSemantics(expr, ctx) {
    const collapse = "first checks whether the recursive arguments equal the current parameters and collapses to the current result when they do";
    const fuel = ctx.fuel ? " then checks and decrements explicit recursion fuel" : "";
    if (expr.tailPosition) {
        return `${collapse}${fuel} and finally ${ctx.useTailCalls ? "performs a return_call to the tail helper" : "rewrites parameters and branches back to the loop header"}`;
    }
    return `${collapse}${fuel} and otherwise calls the public function normally`;
}
function describeRecNotes(expr, ctx) {
    const notes = [
        "collapse uses per-parameter equality with int/void equality, ULP-1 float equality, or generated aggregate equality helpers",
    ];
    if (ctx.fuel) {
        notes.push(`finite gas is stored as ${ctx.fuel.kind === "param" ? "an extra helper parameter" : "a mutable Wasm local"}`);
    }
    if (ctx.aitken && expr.tailPosition) {
        notes.push("Aitken prediction may rewrite one recursive state argument before the next step");
    }
    return notes;
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
            const _never = expr;
            return _never;
        }
    }
}
function emitFieldExpr(expr, ctx) {
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
function emitStructConsExpr(expr, ctx) {
    const structDef = ctx.structs.get(expr.name);
    if (!structDef) {
        throw new Error(`Unknown struct '${expr.name}' in WAT lowering`);
    }
    const handleLocal = tempLocal(expr.id, "struct");
    const lines = [`i32.const ${structDef.fields.length}`, "call $jplmm_alloc_words", `local.set $${handleLocal}`];
    for (let i = 0; i < structDef.fields.length; i += 1) {
        lines.push(emitStoreWord(structDef.fields[i].type, `local.get $${handleLocal}`, `i32.const ${i}`, emitExpr(expr.fields[i], ctx)));
    }
    lines.push(`local.get $${handleLocal}`);
    return lines.join("\n");
}
function emitArrayConsExpr(expr, ctx) {
    const arrayType = expectArrayType(expr.resultType, "array literal");
    const rank = arrayType.dims;
    const handleLocal = tempLocal(expr.id, "array");
    const lines = [];
    if (expr.elements.length === 0) {
        return "i32.const 0\ncall $jplmm_array_alloc_r1";
    }
    if (expr.elements[0].resultType.tag === "array") {
        const childType = expectArrayType(expr.elements[0].resultType, "nested array literal");
        const childRank = childType.dims;
        for (let i = 0; i < expr.elements.length; i += 1) {
            lines.push(emitExpr(expr.elements[i], ctx));
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
        lines.push(emitStoreWord(arrayType.element, `local.get $${handleLocal}`, `i32.const ${1 + rank + i}`, emitExpr(expr.elements[i], ctx)));
    }
    lines.push(`local.get $${handleLocal}`);
    return lines.join("\n");
}
function emitArrayExpr(expr, ctx) {
    const resultType = expectArrayType(expr.resultType, "array comprehension");
    const dimLocals = Array.from({ length: resultType.dims }, (_, idx) => tempIndexedLocal(expr.id, "dim", idx));
    const lines = [];
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
function emitSumExpr(expr, ctx) {
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
function emitIndexExpr(expr, ctx) {
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
        lines.push(emitExpr(expr.indices[i], ctx));
        lines.push("i32.const 0");
        lines.push(`local.get $${baseLocal}`);
        lines.push(`i32.const ${i}`);
        lines.push("call $jplmm_array_dim");
        lines.push("i32.const 1");
        lines.push("i32.sub");
        lines.push("i32.const 0");
        lines.push("call $jplmm_max_i32");
        lines.push("call $jplmm_clamp_i32");
        lines.push(`local.set $${idxLocal}`);
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
        lines.push(emitLoadWord(expr.resultType, `local.get $${baseLocal}`, `i32.const ${1 + arrayType.dims}\nlocal.get $${offsetLocal}\ni32.add`));
    }
    else {
        lines.push(`local.get $${baseLocal}`);
        lines.push(`i32.const ${expr.indices.length}`);
        lines.push(`local.get $${offsetLocal}`);
        lines.push("call $jplmm_array_slice");
    }
    return lines.join("\n");
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
        .map((arg, idx) => `${emitExpr(arg, ctx)}${emitScalarNormalizationOps(ctx.fn.params[idx]?.type).length > 0 ? `\n${emitScalarNormalizationOps(ctx.fn.params[idx]?.type).join("\n")}` : ""}\nlocal.set $${recArgLocal(expr.id, idx)}`)
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
    const lowering = describeParamEqualityLowering(param);
    return lowering.helper ? `call $${lowering.helper}` : lowering.rawOp;
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
function emitParamNormalizationPrelude(params) {
    return params
        .flatMap((param) => {
        const ops = emitScalarNormalizationOps(param.type);
        if (ops.length === 0) {
            return [];
        }
        return [`local.get $${param.name}`, ...ops, `local.set $${param.name}`];
    })
        .join("\n");
}
function emitScalarNormalizationOps(type) {
    if (!type) {
        return [];
    }
    if (type.tag === "int") {
        const bounds = getScalarBounds(type);
        if (!bounds) {
            return [];
        }
        if (bounds.lo !== null && bounds.hi !== null) {
            return [`i32.const ${Math.trunc(bounds.lo)}`, `i32.const ${Math.trunc(bounds.hi)}`, "call $jplmm_clamp_i32"];
        }
        if (bounds.lo !== null) {
            return [`i32.const ${Math.trunc(bounds.lo)}`, "call $jplmm_max_i32"];
        }
        if (bounds.hi !== null) {
            return [`i32.const ${Math.trunc(bounds.hi)}`, "call $jplmm_min_i32"];
        }
        return [];
    }
    if (type.tag === "float") {
        const ops = ["call $jplmm_nan_to_zero_f32"];
        const bounds = getScalarBounds(type);
        if (!bounds) {
            return ops;
        }
        if (bounds.lo !== null && bounds.hi !== null) {
            ops.push(`f32.const ${Number.isFinite(bounds.lo) ? bounds.lo : 0}`);
            ops.push(`f32.const ${Number.isFinite(bounds.hi) ? bounds.hi : 0}`);
            ops.push("call $jplmm_clamp_f32");
            return ops;
        }
        if (bounds.lo !== null) {
            ops.push(`f32.const ${Number.isFinite(bounds.lo) ? bounds.lo : 0}`);
            ops.push("call $jplmm_max_f32");
            return ops;
        }
        if (bounds.hi !== null) {
            ops.push(`f32.const ${Number.isFinite(bounds.hi) ? bounds.hi : 0}`);
            ops.push("call $jplmm_min_f32");
            return ops;
        }
        return ops;
    }
    return [];
}
function emitLutWrapperBody(fn, layout) {
    const resultType = wasmType(fn.retType);
    const fallbackCall = `${fn.params.map((param) => `local.get $${param.name}`).join("\n")}
call $${fn.name}__generic`;
    return `${emitParamNormalizationPrelude(fn.params)}
${emitLutRangeCondition(fn, layout.impl)}
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
function emitAitkenPrelude(ctx) {
    const impl = ctx.aitken;
    if (!impl) {
        return "";
    }
    const state = ctx.fn.params[impl.stateParamIndex];
    if (!state) {
        throw new Error(`Aitken lowering state parameter mismatch for '${ctx.fn.name}'`);
    }
    return [
        "local.get $jplmm_aitken_count",
        "i32.eqz",
        "if",
        indent(`local.get $${state.name}\nlocal.set $jplmm_aitken_s0`, 1),
        "else",
        indent(`local.get $jplmm_aitken_count
i32.const 1
i32.eq
if
  local.get $${state.name}
  local.set $jplmm_aitken_s1
else
  local.get $jplmm_aitken_count
  i32.const 2
  i32.eq
  if
    local.get $${state.name}
    local.set $jplmm_aitken_s2
  else
    local.get $jplmm_aitken_s1
    local.set $jplmm_aitken_s0
    local.get $jplmm_aitken_s2
    local.set $jplmm_aitken_s1
    local.get $${state.name}
    local.set $jplmm_aitken_s2
  end
end`, 1),
        "end",
        "local.get $jplmm_aitken_count",
        "i32.const 3",
        "i32.lt_s",
        "if",
        indent(`local.get $jplmm_aitken_count
i32.const 1
i32.add
local.set $jplmm_aitken_count`, 1),
        "end",
    ].join("\n");
}
function emitAitkenRewrite(ctx, expr) {
    const impl = ctx.aitken;
    if (!impl) {
        return "";
    }
    return [
        "local.get $jplmm_aitken_count",
        `i32.const ${impl.afterIterations}`,
        "i32.ge_s",
        "if",
        indent(`local.get $jplmm_aitken_s1
local.get $jplmm_aitken_s0
f32.sub
local.set $jplmm_aitken_delta0
local.get $jplmm_aitken_s2
local.get $jplmm_aitken_s1
f32.sub
local.set $jplmm_aitken_delta1
local.get $jplmm_aitken_delta1
f32.abs
local.get $jplmm_aitken_delta0
f32.abs
f32.lt
if
  local.get $jplmm_aitken_delta1
  local.get $jplmm_aitken_delta0
  f32.sub
  local.set $jplmm_aitken_den
  local.get $jplmm_aitken_den
  f32.const 0
  f32.ne
  local.get $jplmm_aitken_den
  call $jplmm_isfinite_f32
  i32.and
  if
    local.get $jplmm_aitken_s2
    local.get $jplmm_aitken_delta1
    local.get $jplmm_aitken_delta1
    f32.mul
    local.get $jplmm_aitken_den
    f32.div
    f32.sub
    call $jplmm_nan_to_zero_f32
    local.set $jplmm_aitken_pred
${indent(emitAitkenPredictionGuard(ctx), 2)}
    if
      local.get $jplmm_aitken_pred
      local.set $${recArgLocal(expr.id, impl.stateParamIndex)}
    end
  end
end`, 1),
        "end",
    ].join("\n");
}
function emitAitkenPredictionGuard(ctx) {
    const impl = ctx.aitken;
    if (!impl) {
        return "i32.const 0";
    }
    const lines = [
        "local.get $jplmm_aitken_pred",
        "call $jplmm_isfinite_f32",
        "local.get $jplmm_aitken_pred",
        "local.get $jplmm_aitken_s2",
        "f32.sub",
        "f32.abs",
        "f32.const 1",
        "local.get $jplmm_aitken_delta1",
        "f32.abs",
        "f32.const 64",
        "f32.mul",
        "call $jplmm_max_f32",
        "f32.le",
        "i32.and",
    ];
    if (impl.targetParamIndex !== null) {
        const target = ctx.fn.params[impl.targetParamIndex];
        if (!target) {
            throw new Error(`Aitken lowering target parameter mismatch for '${ctx.fn.name}'`);
        }
        lines.push("local.get $jplmm_aitken_pred", `local.get $${target.name}`, "f32.sub", "f32.abs", "local.get $jplmm_aitken_s2", `local.get $${target.name}`, "f32.sub", "f32.abs", "f32.le", "i32.and");
    }
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
function planMemory(artifacts) {
    const lutLayouts = planLutLayouts(artifacts);
    let totalBytes = 0;
    const dataLines = [];
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
function emitMemoryBlock(plan, exportMemory) {
    const memoryLines = [`(memory $jplmm_mem ${plan.initialPages})`, `(global $jplmm_heap_top (mut i32) (i32.const ${plan.heapBase}))`];
    if (exportMemory) {
        memoryLines.push(`(export "memory" (memory $jplmm_mem))`);
    }
    return [...memoryLines, ...plan.dataLines].join("\n");
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
    if (ctx.aitken) {
        locals.set("jplmm_aitken_count", "i32");
        locals.set("jplmm_aitken_s0", "f32");
        locals.set("jplmm_aitken_s1", "f32");
        locals.set("jplmm_aitken_s2", "f32");
        locals.set("jplmm_aitken_delta0", "f32");
        locals.set("jplmm_aitken_delta1", "f32");
        locals.set("jplmm_aitken_den", "f32");
        locals.set("jplmm_aitken_pred", "f32");
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
    for (const param of ctx.fn.params) {
        for (const extentName of getArrayExtentNames(param.type) ?? []) {
            if (extentName !== null) {
                locals.set(extentName, "i32");
            }
        }
    }
    return [...locals.entries()]
        .filter(([name]) => !ctx.fn.params.some((param) => param.name === name))
        .map(([name, type]) => `(local $${name} ${type})`)
        .join(" ");
}
function emitParamExtentPrelude(params) {
    const lines = [];
    for (const param of params) {
        const extentNames = getArrayExtentNames(param.type);
        if (!extentNames) {
            continue;
        }
        for (let i = 0; i < extentNames.length; i += 1) {
            const extentName = extentNames[i];
            if (extentName === null) {
                continue;
            }
            lines.push(`local.get $${param.name}`);
            lines.push(`i32.const ${i}`);
            lines.push("call $jplmm_array_dim");
            lines.push(`local.set $${extentName}`);
        }
    }
    return lines.join("\n");
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
function collectExprTemps(expr, locals) {
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
                locals.set(expr.bindings[i].name, "i32");
                locals.set(tempIndexedLocal(expr.id, "extent", i), "i32");
                collectExprTemps(expr.bindings[i].expr, locals);
            }
            collectExprTemps(expr.body, locals);
            return;
        }
        case "sum_expr":
            locals.set(tempLocal(expr.id, "sum"), wasmType(expr.resultType));
            for (let i = 0; i < expr.bindings.length; i += 1) {
                locals.set(expr.bindings[i].name, "i32");
                locals.set(tempIndexedLocal(expr.id, "extent", i), "i32");
                collectExprTemps(expr.bindings[i].expr, locals);
            }
            collectExprTemps(expr.body, locals);
            return;
        case "index":
            locals.set(tempLocal(expr.id, "index_base"), "i32");
            locals.set(tempLocal(expr.id, "offset"), "i32");
            for (let i = 0; i < expr.indices.length; i += 1) {
                locals.set(tempIndexedLocal(expr.id, "idx", i), "i32");
                collectExprTemps(expr.indices[i], locals);
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
    const lowering = describeCallLowering(name, resultType);
    const args = argExprs.join("\n");
    return [args, ...lowering.instructions].filter(Boolean).join("\n");
}
function describeParamEqualityLowering(param) {
    if (param.type.tag === "float") {
        return {
            semantics: "uses ULP-1 float equality",
            helper: "jplmm_eq_f32_ulp1",
            rawOp: "",
        };
    }
    if (param.type.tag === "int" || param.type.tag === "void") {
        return {
            semantics: "uses exact i32 equality",
            helper: null,
            rawOp: "i32.eq",
        };
    }
    if (param.type.tag === "named") {
        return {
            semantics: `uses generated extensional equality for struct '${param.type.name}'`,
            helper: structEqHelperName(param.type.name),
            rawOp: "",
        };
    }
    if (param.type.tag === "array") {
        return {
            semantics: "uses generated extensional equality for arrays",
            helper: arrayEqHelperName(param.type),
            rawOp: "",
        };
    }
    const _never = param.type;
    throw new Error(`WAT emission for an unexpected parameter type is not implemented: ${_never}`);
}
function describeCallLowering(name, resultType) {
    switch (name) {
        case "sqrt":
            return {
                kind: "builtin_call",
                semantics: "computes square root directly with Wasm floating-point arithmetic",
                helper: null,
                helpers: [],
                rawOps: ["f32.sqrt"],
                notes: [],
                instructions: ["f32.sqrt"],
            };
        case "exp":
        case "sin":
        case "cos":
        case "tan":
        case "asin":
        case "acos":
        case "atan":
        case "log":
        case "pow":
        case "atan2": {
            const helper = `jplmm_${name}_f32`;
            return {
                kind: "builtin_call",
                semantics: `delegates to imported math helper '${helper}' and then normalizes NaN to zero`,
                helper,
                helpers: [helper, "jplmm_nan_to_zero_f32"],
                rawOps: [],
                notes: [],
                instructions: [`call $${helper}`, "call $jplmm_nan_to_zero_f32"],
            };
        }
        case "abs":
            return resultType.tag === "float"
                ? {
                    kind: "builtin_call",
                    semantics: "computes floating-point absolute value directly with Wasm",
                    helper: null,
                    helpers: [],
                    rawOps: ["f32.abs"],
                    notes: [],
                    instructions: ["f32.abs"],
                }
                : {
                    kind: "builtin_call",
                    semantics: "delegates integer absolute value to the saturating integer helper",
                    helper: "jplmm_abs_i32",
                    helpers: ["jplmm_abs_i32"],
                    rawOps: [],
                    notes: [],
                    instructions: ["call $jplmm_abs_i32"],
                };
        case "max":
            return scalarHelperCall(resultType.tag === "float" ? "jplmm_max_f32" : "jplmm_max_i32", "clamps to the larger operand");
        case "min":
            return scalarHelperCall(resultType.tag === "float" ? "jplmm_min_f32" : "jplmm_min_i32", "clamps to the smaller operand");
        case "clamp":
            return scalarHelperCall(resultType.tag === "float" ? "jplmm_clamp_f32" : "jplmm_clamp_i32", "clamps the first operand into the inclusive [lo, hi] interval");
        case "to_float":
            return {
                kind: "builtin_call",
                semantics: "converts a signed i32 to f32",
                helper: null,
                helpers: [],
                rawOps: ["f32.convert_i32_s"],
                notes: [],
                instructions: ["f32.convert_i32_s"],
            };
        case "to_int":
            return {
                kind: "builtin_call",
                semantics: "converts f32 to i32 with Wasm saturating truncation",
                helper: null,
                helpers: [],
                rawOps: ["i32.trunc_sat_f32_s"],
                notes: [],
                instructions: ["i32.trunc_sat_f32_s"],
            };
        default:
            return {
                kind: "direct_call",
                semantics: `calls lowered function '${name}' directly`,
                helper: null,
                helpers: [],
                rawOps: [],
                notes: [],
                instructions: [`call $${name}`],
            };
    }
}
function scalarHelperCall(helper, semantics) {
    return {
        kind: "builtin_call",
        semantics,
        helper,
        helpers: [helper],
        rawOps: [],
        notes: [],
        instructions: [`call $${helper}`],
    };
}
function recursionHelperNames(params) {
    const names = new Set();
    for (const param of params) {
        const equality = describeParamEqualityLowering(param);
        if (equality.helper) {
            names.add(equality.helper);
        }
    }
    return [...names];
}
function describeHelperSemantic(name) {
    switch (name) {
        case "jplmm_eq_f32_ulp1":
            return "1-ULP float equality used for recursive collapse and aggregate equality";
        case "jplmm_total_div_i32":
            return "totalized signed i32 division that returns 0 when the divisor is 0";
        case "jplmm_total_mod_i32":
            return "totalized signed i32 modulus that returns 0 when the divisor is 0";
        case "jplmm_total_div_f32":
            return "totalized f32 division that returns 0 when the divisor is 0 and normalizes NaN to 0";
        case "jplmm_total_mod_f32":
            return "totalized f32 modulus that returns 0 when the divisor is 0 and normalizes NaN to 0";
        case "jplmm_nan_to_zero_f32":
            return "normalizes NaN float values to 0";
        case "jplmm_sat_add_i32":
            return "saturating i32 addition";
        case "jplmm_sat_sub_i32":
            return "saturating i32 subtraction";
        case "jplmm_sat_mul_i32":
            return "saturating i32 multiplication";
        case "jplmm_sat_neg_i32":
            return "saturating i32 negation";
        case "jplmm_abs_i32":
            return "saturating i32 absolute value";
        case "jplmm_max_i32":
            return "signed i32 maximum";
        case "jplmm_min_i32":
            return "signed i32 minimum";
        case "jplmm_clamp_i32":
            return "signed i32 clamp";
        case "jplmm_max_f32":
            return "f32 maximum";
        case "jplmm_min_f32":
            return "f32 minimum";
        case "jplmm_clamp_f32":
            return "f32 clamp";
        case "jplmm_alloc_words":
            return "heap allocation in 32-bit words";
        case "jplmm_word_load_i32":
            return "loads an i32 payload word from linear memory";
        case "jplmm_word_load_f32":
            return "loads an f32 payload word from linear memory";
        case "jplmm_word_store_i32":
            return "stores an i32 payload word into linear memory";
        case "jplmm_word_store_f32":
            return "stores an f32 payload word into linear memory";
        case "jplmm_copy_words":
            return "copies a contiguous range of payload words in linear memory";
        case "jplmm_array_rank":
            return "reads the rank word from an array header";
        case "jplmm_array_dim":
            return "reads one dimension from an array header";
        case "jplmm_array_total_cells":
            return "computes the total number of array payload cells with saturating multiplication";
        case "jplmm_array_stride":
            return "computes the row-major stride for one array dimension";
        case "jplmm_array_slice":
            return "materializes a suffix array slice after partial indexing";
        default:
            if (/^jplmm_array_alloc_r\d+$/.test(name)) {
                return "generated array-allocation helper for a fixed rank";
            }
            if (name.startsWith("jplmm_eq_struct_")) {
                return "generated extensional equality helper for a struct";
            }
            if (name.startsWith("jplmm_eq_array_")) {
                return "generated extensional equality helper for an array";
            }
            if (/^jplmm_(exp|sin|cos|tan|asin|acos|atan|log|pow|atan2)_f32$/.test(name)) {
                return "imported math helper returning an f32";
            }
            return "backend runtime/helper function";
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
    if (type.tag === "int" || type.tag === "void" || type.tag === "array" || type.tag === "named") {
        return "i32";
    }
    const _never = type;
    throw new Error(`WAT emission for an unexpected type is not implemented: ${_never}`);
}
function tempLocal(id, label) {
    return `jplmm_${label}_${id}`;
}
function tempIndexedLocal(id, label, index) {
    return `jplmm_${label}_${id}_${index}`;
}
function emitZero(type) {
    return type.tag === "float" ? "f32.const 0" : "i32.const 0";
}
function emitLoadLocal(name, type) {
    return type.tag === "float" ? `local.get $${name}` : `local.get $${name}`;
}
function rawSumOp(type) {
    return type.tag === "float" ? "f32.add\ncall $jplmm_nan_to_zero_f32" : "call $jplmm_sat_add_i32";
}
function emitLoadWord(type, handleInstr, wordInstr) {
    return `${handleInstr}
${wordInstr}
call $${type.tag === "float" ? "jplmm_word_load_f32" : "jplmm_word_load_i32"}`;
}
function emitStoreWord(type, handleInstr, wordInstr, valueInstr) {
    return `${handleInstr}
${wordInstr}
${valueInstr}
call $${type.tag === "float" ? "jplmm_word_store_f32" : "jplmm_word_store_i32"}`;
}
function emitBindingLoopTree(bindings, ctx, exprId, dimLocals, index, leafBody) {
    if (index === bindings.length) {
        return leafBody;
    }
    const binding = bindings[index];
    const extentLocal = tempIndexedLocal(exprId, "extent", index);
    const exitLabel = `${extentLocal}_exit`;
    const loopLabel = `${extentLocal}_loop`;
    const lines = [
        emitExpr(binding.expr, ctx),
        "i32.const 1",
        "call $jplmm_max_i32",
        `local.set $${extentLocal}`,
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
function emitArrayLeaf(expr, ctx, dimLocals, mode) {
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
            const dimLocal = dimLocals[expr.bindings.length + i];
            lines.push(`local.get $${dimLocal}`);
            lines.push("i32.eqz");
            lines.push("if");
            lines.push(indent(`local.get $${bodyLocal}\ni32.const ${i}\ncall $jplmm_array_dim\nlocal.set $${dimLocal}`, 1));
            lines.push("else");
            lines.push(indent(`local.get $${dimLocal}
local.get $${bodyLocal}
i32.const ${i}
call $jplmm_array_dim
i32.ne
if
  unreachable
end`, 1));
            lines.push("end");
        }
        lines.push(`local.get $${tempLocal(expr.id, "body_cells")}`);
        lines.push("i32.eqz");
        lines.push("if");
        lines.push(indent(`local.get $${bodyLocal}\ncall $jplmm_array_total_cells\nlocal.set $${tempLocal(expr.id, "body_cells")}`, 1));
        lines.push("else");
        lines.push(indent(`local.get $${tempLocal(expr.id, "body_cells")}
local.get $${bodyLocal}
call $jplmm_array_total_cells
i32.ne
if
  unreachable
end`, 1));
        lines.push("end");
        if (mode === "prepass") {
            lines.push(`local.get $${tempLocal(expr.id, "total")}`);
            lines.push(`local.get $${tempLocal(expr.id, "body_cells")}`);
            lines.push("i32.add");
            lines.push(`local.set $${tempLocal(expr.id, "total")}`);
        }
        else {
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
    return `${emitStoreWord(arrayLeafType(expr.resultType), `local.get $${tempLocal(expr.id, "array")}`, `i32.const ${headerWords}
local.get $${tempLocal(expr.id, "cursor")}
i32.add`, emitExpr(expr.body, ctx))}
local.get $${tempLocal(expr.id, "cursor")}
i32.const 1
i32.add
local.set $${tempLocal(expr.id, "cursor")}`;
}
function expectArrayType(type, context) {
    if (type.tag !== "array") {
        throw new Error(`${context} requires an array type`);
    }
    return type;
}
function arrayLeafType(type) {
    return type.tag === "array" ? arrayLeafType(type.element) : type;
}
function sanitizeName(name) {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}
function structEqHelperName(name) {
    return `jplmm_eq_struct_${sanitizeName(name)}`;
}
function arrayEqHelperName(type) {
    return `jplmm_eq_array_${typeKey(type)}`;
}
function typeKey(type) {
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
            const _never = type;
            return `${_never}`;
        }
    }
}
function collectArrayTypes(program) {
    const types = [];
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
function collectArrayTypesFromExpr(expr, out) {
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
function collectArrayTypesFromType(type, out) {
    if (type.tag === "array") {
        out.push(type);
        collectArrayTypesFromType(type.element, out);
    }
}
function dedupeTypes(types) {
    const seen = new Set();
    const out = [];
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
function emitHelpers(program, heapBase, exportRuntimeHelpers) {
    const arrayTypes = dedupeTypes(collectArrayTypes(program));
    const maxRank = arrayTypes.reduce((acc, type) => Math.max(acc, type.dims), 0);
    const structHelpers = program.structs.map((struct) => emitWasmStructEqualityHelper(struct)).join("\n\n");
    const arrayHelpers = arrayTypes.map((type) => emitWasmArrayEqualityHelper(type)).join("\n\n");
    return [emitCoreHelpers(), emitHeapHelpers(heapBase, exportRuntimeHelpers), emitWasmArrayAllocHelpers(maxRank), structHelpers, arrayHelpers]
        .filter(Boolean)
        .join("\n\n");
}
function emitCoreHelpers() {
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

(func $jplmm_isfinite_f32 (param $x f32) (result i32)
  local.get $x
  local.get $x
  f32.eq
  local.get $x
  f32.abs
  f32.const inf
  f32.lt
  i32.and)

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
function emitMathImports() {
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
function emitHeapHelpers(heapBase, exportRuntimeHelpers) {
    const resetExport = exportRuntimeHelpers ? ` (export "__jplmm_reset_heap")` : "";
    return `
(func $jplmm_reset_heap${resetExport}
  i32.const ${heapBase}
  global.set $jplmm_heap_top)

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
function emitWasmArrayAllocHelpers(maxRank) {
    const helpers = [];
    for (let rank = 1; rank <= maxRank; rank += 1) {
        const params = Array.from({ length: rank }, (_, idx) => `(param $d${idx} i32)`).join(" ");
        const totalLines = ["i32.const 1", "local.set $total"];
        for (let i = 0; i < rank; i += 1) {
            totalLines.push("local.get $total");
            totalLines.push(`local.get $d${i}`);
            totalLines.push("call $jplmm_sat_mul_i32");
            totalLines.push("local.set $total");
        }
        const storeLines = [
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
function emitTypeEquality(type, leftInstr, rightInstr) {
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
    const _never = type;
    return `${_never}`;
}
function emitWasmStructEqualityHelper(struct) {
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
        lines.push(indent(`${emitTypeEquality(struct.fields[i].type, emitLoadWord(struct.fields[i].type, "local.get $a", `i32.const ${i}`), emitLoadWord(struct.fields[i].type, "local.get $b", `i32.const ${i}`))}
i32.eqz
if
  i32.const 0
  return
end`, 1));
    }
    lines.push(indent("i32.const 1", 1));
    lines.push(")");
    return lines.join("\n");
}
function emitWasmArrayEqualityHelper(type) {
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
        lines.push(indent(`local.get $a
i32.const ${i}
call $jplmm_array_dim
local.get $b
i32.const ${i}
call $jplmm_array_dim
i32.ne
if
  i32.const 0
  return
end`, 1));
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
${indent(`${emitTypeEquality(arrayType.element, emitLoadWord(arrayType.element, "local.get $a", `i32.const ${1 + arrayType.dims}\nlocal.get $i\ni32.add`), emitLoadWord(arrayType.element, "local.get $b", `i32.const ${1 + arrayType.dims}\nlocal.get $i\ni32.add`))}
    i32.eqz
    if
      i32.const 0
      return
    end`, 2)}
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
    const instance = await WebAssembly.instantiate(module, mergeDefaultImports(options.imports));
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
function emitModuleComments(comments) {
    if (!comments || comments.length === 0) {
        return "";
    }
    return comments
        .flatMap((comment) => comment.split("\n"))
        .map((line) => `;; ${line}`)
        .join("\n");
}
function mergeDefaultImports(imports) {
    const envDefaults = {
        jplmm_exp_f32: (x) => Math.fround(Math.exp(x)),
        jplmm_sin_f32: (x) => Math.fround(Math.sin(x)),
        jplmm_cos_f32: (x) => Math.fround(Math.cos(x)),
        jplmm_tan_f32: (x) => Math.fround(Math.tan(x)),
        jplmm_asin_f32: (x) => Math.fround(Math.asin(x)),
        jplmm_acos_f32: (x) => Math.fround(Math.acos(x)),
        jplmm_atan_f32: (x) => Math.fround(Math.atan(x)),
        jplmm_log_f32: (x) => Math.fround(Math.log(x)),
        jplmm_pow_f32: (x, y) => Math.fround(Math.pow(x, y)),
        jplmm_atan2_f32: (y, x) => Math.fround(Math.atan2(y, x)),
    };
    const mergedEnv = {
        ...envDefaults,
        ...(imports?.env ?? {}),
    };
    return {
        ...(imports ?? {}),
        env: mergedEnv,
    };
}
//# sourceMappingURL=index.js.map