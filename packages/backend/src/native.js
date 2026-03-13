import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
export function emitNativeCModule(program, options = {}) {
    const functionSets = program.functions.map((fn) => emitNativeFunctionSet(fn, options));
    const prototypes = functionSets.flatMap((set) => set.prototypes.map((item) => `${item};`)).join("\n");
    const definitions = functionSets.flatMap((set) => set.definitions).join("\n\n");
    return `#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

${emitNativeHelpers()}

${prototypes}

${definitions}
`;
}
export function emitNativeRunnerSource(program, fnName, options = {}) {
    const fn = program.functions.find((item) => item.name === fnName);
    if (!fn) {
        throw new Error(`Unknown IR function '${fnName}'`);
    }
    const callArgs = fn.params.map((param, idx) => parseArg(param.type, idx + 2)).join(", ");
    const resultDecl = `${cType(fn.retType)} result = ${cDefaultValue(fn.retType)};`;
    const printExpr = fn.retType.tag === "float" ? `printf("%.9g\\n", result);` : `printf("%d\\n", result);`;
    return `${emitNativeCModule(program, options)}
int main(int argc, char **argv) {
  long iterations = argc > 1 ? strtol(argv[1], NULL, 10) : 1;
  if (iterations < 1) {
    iterations = 1;
  }
  ${resultDecl}
  for (long i = 0; i < iterations; i += 1) {
    result = ${fnName}(${callArgs});
  }
  ${printExpr}
  return 0;
}
`;
}
export function compileNativeRunner(source, options = {}) {
    const root = mkdtempSync(join(process.cwd(), ".jplmm-native-"));
    const sourcePath = join(root, "runner.c");
    const executablePath = join(root, "runner");
    const args = [
        "-std=gnu11",
        `-${options.optLevel ?? "O3"}`,
        "-arch",
        options.arch ?? "arm64",
        sourcePath,
        "-o",
        executablePath,
        "-lm",
    ];
    writeFileSync(sourcePath, source);
    execFileSync(options.clangPath ?? "clang", args, {
        cwd: root,
        env: {
            ...process.env,
            TMPDIR: root,
            DARWIN_USER_TEMP_DIR: root,
            DARWIN_USER_CACHE_DIR: root,
        },
        stdio: "pipe",
    });
    return {
        executablePath,
        source,
        sourcePath,
        workdir: root,
        cleanup: () => {
            rmSync(root, {
                recursive: true,
                force: true,
            });
        },
    };
}
export function compileProgramToNativeRunner(program, fnName, options = {}) {
    const source = emitNativeRunnerSource(program, fnName, options);
    return compileNativeRunner(source, options);
}
export function runNativeFunction(program, fnName, args, options = {}) {
    const runner = compileProgramToNativeRunner(program, fnName, options);
    try {
        const stdout = execFileSync(runner.executablePath, [String(options.iterations ?? 1), ...args.map((arg) => String(arg))], {
            encoding: "utf8",
            stdio: "pipe",
        }).trim();
        return {
            ...runner,
            stdout,
            value: Number(stdout),
        };
    }
    catch (error) {
        runner.cleanup();
        throw error;
    }
}
function emitNativeFunctionSet(fn, options) {
    const implementation = options.artifacts?.implementations.get(fn.name);
    if (implementation?.tag === "closed_form_linear_countdown") {
        return emitClosedFormFunction(fn, implementation);
    }
    if (implementation?.tag === "lut") {
        return emitLutFunctionSet(fn, implementation, options);
    }
    if (implementation?.tag === "linear_speculation") {
        return emitLinearSpeculationFunctionSet(fn, implementation, options);
    }
    return emitPlainFunctionSet(fn, options, fn.name, implementation?.tag === "aitken_scalar_tail" ? implementation : null);
}
function emitClosedFormFunction(fn, implementation) {
    const param = fn.params[implementation.paramIndex];
    if (!param) {
        throw new Error(`Closed-form lowering failed for '${fn.name}'`);
    }
    const stepsExpr = implementation.decrement === 1
        ? `(${param.name} <= 0 ? 1 : ${param.name} + 1)`
        : `(${param.name} <= 0 ? 1 : ((jplmm_sat_add_i32(${param.name}, ${implementation.decrement - 1}) / ${implementation.decrement}) + 1))`;
    return {
        prototypes: [emitPrototype(fn, fn.name)],
        definitions: [
            `${emitPrototype(fn, fn.name)} {
  int32_t jplmm_steps = ${stepsExpr};
  return jplmm_sat_add_i32(${implementation.baseValue}, jplmm_sat_mul_i32(${implementation.stepValue}, jplmm_steps));
}`,
        ],
    };
}
function emitLutFunctionSet(fn, implementation, options) {
    const genericName = `${fn.name}__generic`;
    const tableName = `${fn.name}__lut`;
    const generic = emitPlainFunctionSet(fn, options, genericName, null);
    const tableType = cType(implementation.resultType);
    const tableValues = implementation.table
        .map((value) => implementation.resultType.tag === "float" ? `${formatFloatLiteral(value)}` : `${value | 0}`)
        .join(", ");
    return {
        prototypes: [...generic.prototypes, emitPrototype(fn, fn.name)],
        definitions: [
            `static const ${tableType} ${tableName}[${implementation.table.length}] = { ${tableValues} };`,
            ...generic.definitions,
            `${emitPrototype(fn, fn.name)} {
${indent(emitLutWrapperBody(fn, implementation, genericName, tableName), 1)}
}`,
        ],
    };
}
function emitLinearSpeculationFunctionSet(fn, implementation, options) {
    const genericName = `${fn.name}__generic`;
    const generic = emitPlainFunctionSet(fn, options, genericName, null);
    const varying = fn.params[implementation.varyingParamIndex];
    if (!varying) {
        throw new Error(`Linear speculation lowering failed for '${fn.name}'`);
    }
    return {
        prototypes: [...generic.prototypes, emitPrototype(fn, fn.name)],
        definitions: [
            ...generic.definitions,
            `${emitPrototype(fn, fn.name)} {
  ${varying.name} = ${implementation.fixedPoint};
  return ${genericName}(${fn.params.map((param) => param.name).join(", ")});
}`,
        ],
    };
}
function emitPlainFunctionSet(fn, options, cName, aitken) {
    const ctx = {
        fn,
        cName,
        publicName: fn.name,
        aitken,
    };
    return {
        prototypes: [emitPrototype(fn, cName)],
        definitions: [emitFunctionBody(ctx, options)],
    };
}
function emitFunctionBody(ctx, options) {
    const fn = ctx.fn;
    const gasLimit = getFiniteGasLimit(fn);
    const localDecls = collectLocalDecls(fn, ctx.aitken);
    const lines = [];
    if (gasLimit !== null) {
        lines.push(`int32_t jplmm_fuel = ${gasLimit};`);
    }
    lines.push(`${cType(fn.retType)} res = ${cDefaultValue(fn.retType)};`);
    if (localDecls.length > 0) {
        lines.push(...localDecls);
    }
    lines.push("for (;;) {");
    if (ctx.aitken) {
        lines.push(indent(emitAitkenPrelude(ctx), 1));
    }
    lines.push(indent(emitStatements(ctx, options), 1));
    lines.push("  return res;");
    lines.push("}");
    return `${emitPrototype(fn, ctx.cName)} {
${indent(lines.join("\n"), 1)}
}`;
}
function emitStatements(ctx, options) {
    const lines = [];
    for (const stmt of ctx.fn.body) {
        if (stmt.tag === "gas" || stmt.tag === "rad") {
            continue;
        }
        if (stmt.tag === "let") {
            lines.push(`${stmt.name} = ${emitExpr(stmt.expr, ctx, options)};`);
            continue;
        }
        if (stmt.tag === "ret" && stmt.expr.tag === "rec" && stmt.expr.tailPosition) {
            lines.push(emitTailRecStmt(stmt.expr, ctx, options));
            continue;
        }
        if (stmt.tag === "ret") {
            lines.push(`res = ${emitExpr(stmt.expr, ctx, options)};`);
        }
    }
    return lines.join("\n");
}
function emitTailRecStmt(expr, ctx, options) {
    const lines = [];
    for (let i = 0; i < expr.args.length; i += 1) {
        lines.push(`${recArgLocal(expr.id, i)} = ${emitExpr(expr.args[i], ctx, options)};`);
    }
    lines.push(`if (${emitRecCollapseCondition(expr, ctx)}) {`);
    lines.push("  return res;");
    lines.push("}");
    if (getFiniteGasLimit(ctx.fn) !== null) {
        lines.push("if (jplmm_fuel == 0) {");
        lines.push("  return res;");
        lines.push("}");
        lines.push("jplmm_fuel -= 1;");
    }
    if (ctx.aitken) {
        lines.push(emitAitkenRewrite(ctx, expr));
    }
    for (let i = 0; i < ctx.fn.params.length; i += 1) {
        lines.push(`${ctx.fn.params[i].name} = ${recArgLocal(expr.id, i)};`);
    }
    lines.push("continue;");
    return lines.join("\n");
}
function emitExpr(expr, ctx, options) {
    switch (expr.tag) {
        case "int_lit":
            return `${expr.value | 0}`;
        case "float_lit":
            return formatFloatLiteral(expr.value);
        case "void_lit":
            return cDefaultValue(expr.resultType);
        case "var":
            return expr.name;
        case "res":
            return "res";
        case "binop":
            return emitBinop(expr.op, emitExpr(expr.left, ctx, options), emitExpr(expr.right, ctx, options), expr.resultType);
        case "unop":
            return expr.resultType.tag === "int"
                ? `jplmm_sat_neg_i32(${emitExpr(expr.operand, ctx, options)})`
                : `jplmm_nan_to_zero_f32(-(${emitExpr(expr.operand, ctx, options)}))`;
        case "call":
            return emitCall(expr.name, expr.args.map((arg) => emitExpr(arg, ctx, options)), expr.resultType);
        case "rec":
            return emitNonTailRecExpr(expr, ctx, options);
        case "total_div":
            return `jplmm_total_div_${expr.resultType.tag === "float" ? "f32" : "i32"}(${emitExpr(expr.left, ctx, options)}, ${emitExpr(expr.right, ctx, options)})`;
        case "total_mod":
            return `jplmm_total_mod_${expr.resultType.tag === "float" ? "f32" : "i32"}(${emitExpr(expr.left, ctx, options)}, ${emitExpr(expr.right, ctx, options)})`;
        case "nan_to_zero":
            return `jplmm_nan_to_zero_f32(${emitExpr(expr.value, ctx, options)})`;
        case "sat_add":
            return `jplmm_sat_add_i32(${emitExpr(expr.left, ctx, options)}, ${emitExpr(expr.right, ctx, options)})`;
        case "sat_sub":
            return `jplmm_sat_sub_i32(${emitExpr(expr.left, ctx, options)}, ${emitExpr(expr.right, ctx, options)})`;
        case "sat_mul":
            return `jplmm_sat_mul_i32(${emitExpr(expr.left, ctx, options)}, ${emitExpr(expr.right, ctx, options)})`;
        case "sat_neg":
            return `jplmm_sat_neg_i32(${emitExpr(expr.operand, ctx, options)})`;
        case "index":
        case "field":
        case "struct_cons":
        case "array_cons":
        case "array_expr":
        case "sum_expr":
            throw new Error(`Native lowering for '${expr.tag}' is not implemented yet`);
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function emitNonTailRecExpr(expr, ctx, options) {
    const tempName = `jplmm_non_tail_${expr.id}`;
    const resultType = cType(expr.resultType);
    const args = expr.args.map((arg) => emitExpr(arg, ctx, options));
    const callArgs = args.join(", ");
    const stores = args.map((arg, idx) => `${cType(expr.args[idx].resultType)} ${recArgLocal(expr.id, idx)} = ${arg};`);
    const collapse = emitRecCollapseCondition(expr, ctx);
    const lines = [
        `({ ${resultType} ${tempName};`,
        ...stores.map((line) => `   ${line}`),
        `   if (${collapse}) {`,
        `     ${tempName} = res;`,
        "   } else {",
    ];
    if (getFiniteGasLimit(ctx.fn) !== null) {
        lines.push("     if (jplmm_fuel == 0) {");
        lines.push(`       ${tempName} = res;`);
        lines.push("     } else {");
        lines.push("       jplmm_fuel -= 1;");
        lines.push(`       ${tempName} = ${ctx.publicName}(${callArgs});`);
        lines.push("     }");
    }
    else {
        lines.push(`     ${tempName} = ${ctx.publicName}(${callArgs});`);
    }
    lines.push("   }");
    lines.push(`   ${tempName}; })`);
    return lines.join("\n");
}
function emitRecCollapseCondition(expr, ctx) {
    if (expr.args.length === 0) {
        return "1";
    }
    return expr.args
        .map((arg, idx) => emitEquality(recArgLocal(expr.id, idx), ctx.fn.params[idx].name, arg.resultType))
        .join(" && ");
}
function emitEquality(left, right, type) {
    if (type.tag === "float") {
        return `jplmm_eq_f32_ulp1(${left}, ${right})`;
    }
    return `${left} == ${right}`;
}
function emitBinop(op, left, right, resultType) {
    if (resultType.tag === "int") {
        if (op === "+") {
            return `jplmm_sat_add_i32(${left}, ${right})`;
        }
        if (op === "-") {
            return `jplmm_sat_sub_i32(${left}, ${right})`;
        }
        if (op === "*") {
            return `jplmm_sat_mul_i32(${left}, ${right})`;
        }
        if (op === "/") {
            return `jplmm_total_div_i32(${left}, ${right})`;
        }
        if (op === "%") {
            return `jplmm_total_mod_i32(${left}, ${right})`;
        }
    }
    if (op === "+") {
        return `jplmm_nan_to_zero_f32((${left}) + (${right}))`;
    }
    if (op === "-") {
        return `jplmm_nan_to_zero_f32((${left}) - (${right}))`;
    }
    if (op === "*") {
        return `jplmm_nan_to_zero_f32((${left}) * (${right}))`;
    }
    if (op === "/") {
        return `jplmm_total_div_f32(${left}, ${right})`;
    }
    if (op === "%") {
        return `jplmm_total_mod_f32(${left}, ${right})`;
    }
    throw new Error(`Unsupported native binop '${op}'`);
}
function emitCall(name, args, resultType) {
    switch (name) {
        case "sqrt":
            return `jplmm_nan_to_zero_f32(sqrtf(${args[0] ?? "0"}))`;
        case "exp":
            return `jplmm_nan_to_zero_f32(expf(${args[0] ?? "0"}))`;
        case "sin":
            return `jplmm_nan_to_zero_f32(sinf(${args[0] ?? "0"}))`;
        case "cos":
            return `jplmm_nan_to_zero_f32(cosf(${args[0] ?? "0"}))`;
        case "tan":
            return `jplmm_nan_to_zero_f32(tanf(${args[0] ?? "0"}))`;
        case "asin":
            return `jplmm_nan_to_zero_f32(asinf(${args[0] ?? "0"}))`;
        case "acos":
            return `jplmm_nan_to_zero_f32(acosf(${args[0] ?? "0"}))`;
        case "atan":
            return `jplmm_nan_to_zero_f32(atanf(${args[0] ?? "0"}))`;
        case "log":
            return `jplmm_nan_to_zero_f32(logf(${args[0] ?? "0"}))`;
        case "pow":
            return `jplmm_nan_to_zero_f32(powf(${args[0] ?? "0"}, ${args[1] ?? "0"}))`;
        case "atan2":
            return `jplmm_nan_to_zero_f32(atan2f(${args[0] ?? "0"}, ${args[1] ?? "0"}))`;
        case "abs":
            return resultType.tag === "float"
                ? `fabsf(${args[0] ?? "0"})`
                : `jplmm_abs_i32(${args[0] ?? "0"})`;
        case "max":
            return `${resultType.tag === "float" ? "jplmm_max_f32" : "jplmm_max_i32"}(${args[0] ?? "0"}, ${args[1] ?? "0"})`;
        case "min":
            return `${resultType.tag === "float" ? "jplmm_min_f32" : "jplmm_min_i32"}(${args[0] ?? "0"}, ${args[1] ?? "0"})`;
        case "clamp":
            return `${resultType.tag === "float" ? "jplmm_clamp_f32" : "jplmm_clamp_i32"}(${args[0] ?? "0"}, ${args[1] ?? "0"}, ${args[2] ?? "0"})`;
        case "to_float":
            return `jplmm_nan_to_zero_f32((float)(${args[0] ?? "0"}))`;
        case "to_int":
            return `jplmm_trunc_sat_f32_to_i32(${args[0] ?? "0"})`;
        default:
            return `${name}(${args.join(", ")})`;
    }
}
function emitLutWrapperBody(fn, implementation, genericName, tableName) {
    const lines = [`int32_t jplmm_lut_index = 0;`];
    const conditions = fn.params
        .map((param, idx) => {
        const range = implementation.parameterRanges[idx];
        if (!range) {
            throw new Error(`LUT arity mismatch for '${fn.name}'`);
        }
        return `(${param.name} >= ${range.lo} && ${param.name} <= ${range.hi})`;
    })
        .join(" && ");
    lines.push(`if (${conditions || "1"}) {`);
    let stride = 1;
    for (let i = fn.params.length - 1; i >= 0; i -= 1) {
        const range = implementation.parameterRanges[i];
        const param = fn.params[i];
        lines.push(`  jplmm_lut_index += (${param.name} - ${range.lo}) * ${stride};`);
        stride *= range.hi - range.lo + 1;
    }
    lines.push(`  return ${tableName}[jplmm_lut_index];`);
    lines.push("}");
    lines.push(`return ${genericName}(${fn.params.map((param) => param.name).join(", ")});`);
    return lines.join("\n");
}
function emitAitkenPrelude(ctx) {
    const state = ctx.fn.params[ctx.aitken.stateParamIndex];
    return `if (jplmm_aitken_count == 0) {
  jplmm_aitken_s0 = ${state.name};
} else if (jplmm_aitken_count == 1) {
  jplmm_aitken_s1 = ${state.name};
} else if (jplmm_aitken_count == 2) {
  jplmm_aitken_s2 = ${state.name};
} else {
  jplmm_aitken_s0 = jplmm_aitken_s1;
  jplmm_aitken_s1 = jplmm_aitken_s2;
  jplmm_aitken_s2 = ${state.name};
}
if (jplmm_aitken_count < 3) {
  jplmm_aitken_count += 1;
}`;
}
function emitAitkenRewrite(ctx, expr) {
    const impl = ctx.aitken;
    const targetGuard = impl.targetParamIndex === null
        ? "1"
        : `fabsf(jplmm_aitken_pred - ${ctx.fn.params[impl.targetParamIndex].name}) <= fabsf(jplmm_aitken_s2 - ${ctx.fn.params[impl.targetParamIndex].name})`;
    return `if (jplmm_aitken_count >= ${impl.afterIterations}) {
  jplmm_aitken_delta0 = jplmm_aitken_s1 - jplmm_aitken_s0;
  jplmm_aitken_delta1 = jplmm_aitken_s2 - jplmm_aitken_s1;
  if (fabsf(jplmm_aitken_delta1) < fabsf(jplmm_aitken_delta0)) {
    jplmm_aitken_den = jplmm_aitken_delta1 - jplmm_aitken_delta0;
    if (jplmm_aitken_den != 0.0f && isfinite(jplmm_aitken_den)) {
      jplmm_aitken_pred = jplmm_nan_to_zero_f32(jplmm_aitken_s2 - ((jplmm_aitken_delta1 * jplmm_aitken_delta1) / jplmm_aitken_den));
      if (isfinite(jplmm_aitken_pred) &&
          fabsf(jplmm_aitken_pred - jplmm_aitken_s2) <= fmaxf(1.0f, fabsf(jplmm_aitken_delta1) * 64.0f) &&
          ${targetGuard}) {
        ${recArgLocal(expr.id, impl.stateParamIndex)} = jplmm_aitken_pred;
      }
    }
  }
}`;
}
function collectLocalDecls(fn, aitken) {
    const locals = new Map();
    for (const stmt of fn.body) {
        if (stmt.tag === "let") {
            locals.set(stmt.name, cType(stmt.expr.resultType));
        }
        if (stmt.tag !== "gas") {
            collectRecTemps(stmt.expr, locals);
        }
    }
    if (aitken) {
        locals.set("jplmm_aitken_count", "int32_t");
        locals.set("jplmm_aitken_s0", "float");
        locals.set("jplmm_aitken_s1", "float");
        locals.set("jplmm_aitken_s2", "float");
        locals.set("jplmm_aitken_delta0", "float");
        locals.set("jplmm_aitken_delta1", "float");
        locals.set("jplmm_aitken_den", "float");
        locals.set("jplmm_aitken_pred", "float");
    }
    return [...locals.entries()].map(([name, type]) => `${type} ${name} = ${cDefaultValueFromCType(type)};`);
}
function collectRecTemps(expr, locals) {
    if (expr.tag === "rec") {
        for (let i = 0; i < expr.args.length; i += 1) {
            locals.set(recArgLocal(expr.id, i), cType(expr.args[i].resultType));
            collectRecTemps(expr.args[i], locals);
        }
        return;
    }
    switch (expr.tag) {
        case "binop":
        case "total_div":
        case "total_mod":
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
            collectRecTemps(expr.left, locals);
            collectRecTemps(expr.right, locals);
            return;
        case "unop":
        case "sat_neg":
            collectRecTemps(expr.operand, locals);
            return;
        case "nan_to_zero":
            collectRecTemps(expr.value, locals);
            return;
        case "call":
            for (const arg of expr.args) {
                collectRecTemps(arg, locals);
            }
            return;
        case "index":
            collectRecTemps(expr.array, locals);
            for (const idx of expr.indices) {
                collectRecTemps(idx, locals);
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
        default:
            return;
    }
}
function emitPrototype(fn, cName) {
    const params = fn.params.map((param) => `${cType(param.type)} ${param.name}`).join(", ") || "void";
    return `static ${cType(fn.retType)} ${cName}(${params})`;
}
function cType(type) {
    if (type.tag === "float") {
        return "float";
    }
    if (type.tag === "int") {
        return "int32_t";
    }
    if (type.tag === "void") {
        return "int32_t";
    }
    throw new Error(`Native lowering for type '${type.tag}' is not implemented yet`);
}
function cDefaultValue(type) {
    return type.tag === "float" ? "0.0f" : "0";
}
function cDefaultValueFromCType(type) {
    return type === "float" ? "0.0f" : "0";
}
function formatFloatLiteral(value) {
    if (!Number.isFinite(value)) {
        return "0.0f";
    }
    const numeric = Number(value);
    return Number.isInteger(numeric) ? `${numeric}.0f` : `${numeric}f`;
}
function recArgLocal(id, index) {
    return `jplmm_rec_${id}_${index}`;
}
function getFiniteGasLimit(fn) {
    const gas = fn.body.find((stmt) => stmt.tag === "gas");
    if (!gas || gas.limit === "inf") {
        return null;
    }
    return gas.limit;
}
function parseArg(type, argvIndex) {
    if (type.tag === "float") {
        return `(argc > ${argvIndex} ? strtof(argv[${argvIndex}], NULL) : 0.0f)`;
    }
    return `(argc > ${argvIndex} ? (int32_t)strtol(argv[${argvIndex}], NULL, 10) : 0)`;
}
function emitNativeHelpers() {
    return `static inline int32_t jplmm_clamp_i64_to_i32(int64_t x) {
  if (x < ${INT32_MIN}LL) return ${INT32_MIN};
  if (x > ${INT32_MAX}LL) return ${INT32_MAX};
  return (int32_t)x;
}

static inline int32_t jplmm_sat_add_i32(int32_t a, int32_t b) {
  return jplmm_clamp_i64_to_i32((int64_t)a + (int64_t)b);
}

static inline int32_t jplmm_sat_sub_i32(int32_t a, int32_t b) {
  return jplmm_clamp_i64_to_i32((int64_t)a - (int64_t)b);
}

static inline int32_t jplmm_sat_mul_i32(int32_t a, int32_t b) {
  return jplmm_clamp_i64_to_i32((int64_t)a * (int64_t)b);
}

static inline int32_t jplmm_sat_neg_i32(int32_t a) {
  return a == ${INT32_MIN} ? ${INT32_MAX} : -a;
}

static inline int32_t jplmm_total_div_i32(int32_t a, int32_t b) {
  if (b == 0) return 0;
  if (a == ${INT32_MIN} && b == -1) return ${INT32_MAX};
  return a / b;
}

static inline int32_t jplmm_total_mod_i32(int32_t a, int32_t b) {
  if (b == 0) return 0;
  if (a == ${INT32_MIN} && b == -1) return 0;
  return a % b;
}

static inline float jplmm_nan_to_zero_f32(float x) {
  return isnan(x) ? 0.0f : x;
}

static inline float jplmm_total_div_f32(float a, float b) {
  return b == 0.0f ? 0.0f : jplmm_nan_to_zero_f32(a / b);
}

static inline float jplmm_total_mod_f32(float a, float b) {
  return b == 0.0f ? 0.0f : jplmm_nan_to_zero_f32(fmodf(a, b));
}

static inline int32_t jplmm_abs_i32(int32_t x) {
  return x < 0 ? jplmm_sat_neg_i32(x) : x;
}

static inline int32_t jplmm_max_i32(int32_t a, int32_t b) { return a > b ? a : b; }
static inline int32_t jplmm_min_i32(int32_t a, int32_t b) { return a < b ? a : b; }
static inline int32_t jplmm_clamp_i32(int32_t x, int32_t lo, int32_t hi) { return jplmm_min_i32(jplmm_max_i32(x, lo), hi); }
static inline float jplmm_max_f32(float a, float b) { return a > b ? a : b; }
static inline float jplmm_min_f32(float a, float b) { return a < b ? a : b; }
static inline float jplmm_clamp_f32(float x, float lo, float hi) { return jplmm_min_f32(jplmm_max_f32(x, lo), hi); }

static inline int32_t jplmm_trunc_sat_f32_to_i32(float x) {
  if (!isfinite(x)) return x < 0 ? ${INT32_MIN} : ${INT32_MAX};
  if (x < (float)${INT32_MIN}) return ${INT32_MIN};
  if (x > (float)${INT32_MAX}) return ${INT32_MAX};
  return (int32_t)x;
}

static inline int jplmm_eq_f32_ulp1(float a, float b) {
  union { float f; uint32_t u; } ua = { a }, ub = { b };
  uint32_t oa = (ua.u & 0x80000000u) ? (~ua.u) : (ua.u | 0x80000000u);
  uint32_t ob = (ub.u & 0x80000000u) ? (~ub.u) : (ub.u | 0x80000000u);
  uint32_t diff = oa > ob ? oa - ob : ob - oa;
  return diff <= 1u;
}`;
}
function indent(text, depth) {
    const prefix = "  ".repeat(depth);
    return text
        .split("\n")
        .map((line) => `${prefix}${line}`)
        .join("\n");
}
//# sourceMappingURL=native.js.map