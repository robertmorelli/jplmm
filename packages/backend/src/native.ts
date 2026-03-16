import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { INT32_MAX, INT32_MIN, getArrayExtentNames, getScalarBounds, type Type } from "@jplmm/ast";
import type { IRExpr, IRFunction, IRProgram, IRStructDef } from "@jplmm/ir";
import type {
  AitkenImplementation,
  ClosedFormImplementation,
  LinearSpeculationImplementation,
  LutImplementation,
  OptimizeArtifacts,
} from "@jplmm/optimize";

export type EmitNativeCOptions = {
  artifacts?: OptimizeArtifacts;
};

export type CompileNativeOptions = EmitNativeCOptions & {
  arch?: "arm64";
  clangPath?: string;
  optLevel?: "O0" | "O1" | "O2" | "O3";
};

export type NativeRunner = {
  executablePath: string;
  source: string;
  sourcePath: string;
  workdir: string;
  cleanup: () => void;
};

export type RunNativeOptions = CompileNativeOptions & {
  iterations?: number;
};

type NativeContext = {
  fn: IRFunction;
  cName: string;
  publicName: string;
  aitken: AitkenImplementation | null;
  structs: Map<string, IRStructDef>;
  functionSymbols: Map<string, string>;
};

type NativeFunctionSet = {
  prototypes: string[];
  definitions: string[];
};

type NativeModuleContext = {
  structs: Map<string, IRStructDef>;
  functionSymbols: Map<string, string>;
};

function createNativeModuleContext(program: IRProgram): NativeModuleContext {
  const structs = new Map(program.structs.map((struct) => [struct.name, struct] as const));
  const functionSymbols = new Map<string, string>();
  const used = new Set<string>(["main"]);

  for (const fn of program.functions) {
    const base = `jplmm_fn_${sanitizeCIdentifier(fn.name)}`;
    let symbol = base;
    let suffix = 2;
    while (used.has(symbol)) {
      symbol = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(symbol);
    functionSymbols.set(fn.name, symbol);
  }

  return {
    structs,
    functionSymbols,
  };
}

function getFunctionSymbol(functionSymbols: Map<string, string>, name: string): string {
  return functionSymbols.get(name) ?? name;
}

function sanitizeCIdentifier(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

export function emitNativeCModule(program: IRProgram, options: EmitNativeCOptions = {}): string {
  const module = createNativeModuleContext(program);
  const functionSets = program.functions.map((fn) => emitNativeFunctionSet(fn, options, module));
  const prototypes = functionSets.flatMap((set) => set.prototypes.map((item) => `${item};`)).join("\n");
  const definitions = functionSets.flatMap((set) => set.definitions).join("\n\n");

  return `#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

${emitNativeHelpers()}

${emitNativeTypeHelpers(program, module.structs)}

${prototypes}

${definitions}
`;
}

export function emitNativeRunnerSource(
  program: IRProgram,
  fnName: string,
  options: EmitNativeCOptions = {},
): string {
  const module = createNativeModuleContext(program);
  const fn = program.functions.find((item) => item.name === fnName);
  if (!fn) {
    throw new Error(`Unknown IR function '${fnName}'`);
  }
  const symbolName = getFunctionSymbol(module.functionSymbols, fnName);

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
    jplmm_reset_heap();
    result = ${symbolName}(${callArgs});
  }
  ${printExpr}
  return 0;
}
`;
}

export function compileNativeRunner(source: string, options: CompileNativeOptions = {}): NativeRunner {
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

export function compileProgramToNativeRunner(
  program: IRProgram,
  fnName: string,
  options: CompileNativeOptions = {},
): NativeRunner {
  const source = emitNativeRunnerSource(program, fnName, options);
  return compileNativeRunner(source, options);
}

export function runNativeFunction(
  program: IRProgram,
  fnName: string,
  args: number[],
  options: RunNativeOptions = {},
): NativeRunner & { stdout: string; value: number } {
  const runner = compileProgramToNativeRunner(program, fnName, options);
  try {
    const stdout = execFileSync(
      runner.executablePath,
      [String(options.iterations ?? 1), ...args.map((arg) => String(arg))],
      {
        encoding: "utf8",
        stdio: "pipe",
      },
    ).trim();
    return {
      ...runner,
      stdout,
      value: Number(stdout),
    };
  } catch (error) {
    runner.cleanup();
    throw error;
  }
}

function emitNativeFunctionSet(
  fn: IRFunction,
  options: EmitNativeCOptions,
  module: NativeModuleContext,
): NativeFunctionSet {
  const publicName = getFunctionSymbol(module.functionSymbols, fn.name);
  const implementation = options.artifacts?.implementations.get(fn.name);
  if (implementation?.tag === "closed_form_linear_countdown") {
    return emitClosedFormFunction(fn, implementation, publicName);
  }
  if (implementation?.tag === "lut") {
    return emitLutFunctionSet(fn, implementation, options, module, publicName);
  }
  if (implementation?.tag === "linear_speculation") {
    return emitLinearSpeculationFunctionSet(fn, implementation, options, module, publicName);
  }
  return emitPlainFunctionSet(
    fn,
    options,
    publicName,
    publicName,
    implementation?.tag === "aitken_scalar_tail" ? implementation : null,
    module,
  );
}

function emitClosedFormFunction(
  fn: IRFunction,
  implementation: ClosedFormImplementation,
  cName: string,
): NativeFunctionSet {
  const param = fn.params[implementation.paramIndex];
  if (!param) {
    throw new Error(`Closed-form lowering failed for '${fn.name}'`);
  }
  const stepsExpr =
    implementation.decrement === 1
      ? `(${param.name} <= 0 ? 1 : ${param.name} + 1)`
      : `(${param.name} <= 0 ? 1 : ((jplmm_sat_add_i32(${param.name}, ${implementation.decrement - 1}) / ${implementation.decrement}) + 1))`;

  return {
    prototypes: [emitPrototype(fn, cName)],
    definitions: [
      `${emitPrototype(fn, cName)} {
  ${emitParamNormalizationLines(fn.params).join("\n  ")}
  int32_t jplmm_steps = ${stepsExpr};
  return jplmm_sat_add_i32(${implementation.baseValue}, jplmm_sat_mul_i32(${implementation.stepValue}, jplmm_steps));
}`,
    ],
  };
}

function emitLutFunctionSet(
  fn: IRFunction,
  implementation: LutImplementation,
  options: EmitNativeCOptions,
  module: NativeModuleContext,
  publicName: string,
): NativeFunctionSet {
  const genericName = `${publicName}__generic`;
  const tableName = `${publicName}__lut`;
  const generic = emitPlainFunctionSet(fn, options, genericName, publicName, null, module);
  const tableType = cType(implementation.resultType);
  const tableValues = implementation.table
    .map((value) =>
      implementation.resultType.tag === "float" ? `${formatFloatLiteral(value)}` : `${value | 0}`,
    )
    .join(", ");

  return {
    prototypes: [...generic.prototypes, emitPrototype(fn, publicName)],
    definitions: [
      `static const ${tableType} ${tableName}[${implementation.table.length}] = { ${tableValues} };`,
      ...generic.definitions,
      `${emitPrototype(fn, publicName)} {
${indent(emitLutWrapperBody(fn, implementation, genericName, tableName), 1)}
}`,
    ],
  };
}

function emitLinearSpeculationFunctionSet(
  fn: IRFunction,
  implementation: LinearSpeculationImplementation,
  options: EmitNativeCOptions,
  module: NativeModuleContext,
  publicName: string,
): NativeFunctionSet {
  const genericName = `${publicName}__generic`;
  const generic = emitPlainFunctionSet(fn, options, genericName, publicName, null, module);
  const varying = fn.params[implementation.varyingParamIndex];
  if (!varying) {
    throw new Error(`Linear speculation lowering failed for '${fn.name}'`);
  }

  return {
    prototypes: [...generic.prototypes, emitPrototype(fn, publicName)],
    definitions: [
      ...generic.definitions,
      `${emitPrototype(fn, publicName)} {
  ${varying.name} = ${implementation.fixedPoint};
  return ${genericName}(${fn.params.map((param) => param.name).join(", ")});
}`,
    ],
  };
}

function emitPlainFunctionSet(
  fn: IRFunction,
  options: EmitNativeCOptions,
  cName: string,
  publicName: string,
  aitken: AitkenImplementation | null,
  module: NativeModuleContext,
): NativeFunctionSet {
  const ctx: NativeContext = {
    fn,
    cName,
    publicName,
    aitken,
    structs: module.structs,
    functionSymbols: module.functionSymbols,
  };
  return {
    prototypes: [emitPrototype(fn, cName)],
    definitions: [emitFunctionBody(ctx, options)],
  };
}

function emitFunctionBody(ctx: NativeContext, options: EmitNativeCOptions): string {
  const fn = ctx.fn;
  const gasLimit = getFiniteGasLimit(fn);
  const localDecls = collectLocalDecls(fn, ctx.aitken);
  const lines: string[] = [];

  if (gasLimit !== null) {
    lines.push(`int32_t jplmm_fuel = ${gasLimit};`);
  }
  lines.push(`${cType(fn.retType)} res = ${cDefaultValue(fn.retType)};`);
  if (localDecls.length > 0) {
    lines.push(...localDecls);
  }
  lines.push("for (;;) {");
  const normalization = emitParamNormalizationLines(fn.params);
  if (normalization.length > 0) {
    lines.push(indent(normalization.join("\n"), 1));
  }
  const extentLines = emitParamExtentLines(fn.params);
  if (extentLines.length > 0) {
    lines.push(indent(extentLines.join("\n"), 1));
  }
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

function emitStatements(ctx: NativeContext, options: EmitNativeCOptions): string {
  const lines: string[] = [];
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

function emitTailRecStmt(
  expr: Extract<IRExpr, { tag: "rec" }>,
  ctx: NativeContext,
  options: EmitNativeCOptions,
): string {
  const lines: string[] = [];
  for (let i = 0; i < expr.args.length; i += 1) {
    lines.push(
      `${recArgLocal(expr.id, i)} = ${normalizeScalarExprForType(emitExpr(expr.args[i]!, ctx, options), ctx.fn.params[i]?.type)};`,
    );
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
    lines.push(`${ctx.fn.params[i]!.name} = ${recArgLocal(expr.id, i)};`);
  }
  lines.push("continue;");
  return lines.join("\n");
}

function emitExpr(expr: IRExpr, ctx: NativeContext, options: EmitNativeCOptions): string {
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
      return emitCall(expr.name, expr.args.map((arg) => emitExpr(arg, ctx, options)), expr.resultType, ctx.functionSymbols);
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
    case "field":
      return emitFieldExpr(expr, ctx, options);
    case "struct_cons":
      return emitStructConsExpr(expr, ctx, options);
    case "array_cons":
      return emitArrayConsExpr(expr, ctx, options);
    case "array_expr":
      return emitArrayComprehensionExpr(expr, ctx, options);
    case "sum_expr":
      return emitSumComprehensionExpr(expr, ctx, options);
    case "index":
      return emitIndexExpr(expr, ctx, options);
    default: {
      const _never: never = expr;
      return _never;
    }
  }
}

function emitNonTailRecExpr(
  expr: Extract<IRExpr, { tag: "rec" }>,
  ctx: NativeContext,
  options: EmitNativeCOptions,
): string {
  const tempName = `jplmm_non_tail_${expr.id}`;
  const resultType = cType(expr.resultType);
  const args = expr.args.map((arg) => emitExpr(arg, ctx, options));
  const stores = args.map((arg, idx) => `${cType(expr.args[idx]!.resultType)} ${recArgLocal(expr.id, idx)} = ${normalizeScalarExprForType(arg, ctx.fn.params[idx]?.type)};`);
  const callArgs = expr.args.map((_, idx) => recArgLocal(expr.id, idx)).join(", ");
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
  } else {
    lines.push(`     ${tempName} = ${ctx.publicName}(${callArgs});`);
  }
  lines.push("   }");
  lines.push(`   ${tempName}; })`);
  return lines.join("\n");
}

function emitRecCollapseCondition(expr: Extract<IRExpr, { tag: "rec" }>, ctx: NativeContext): string {
  if (expr.args.length === 0) {
    return "1";
  }
  return expr.args
    .map((arg, idx) => emitEquality(recArgLocal(expr.id, idx), ctx.fn.params[idx]!.name, arg.resultType))
    .join(" && ");
}

function emitEquality(left: string, right: string, type: Type): string {
  if (type.tag === "float") {
    return `jplmm_eq_f32_ulp1(${left}, ${right})`;
  }
  if (type.tag === "named") {
    return `${structEqHelperName(type.name)}(${left}, ${right})`;
  }
  if (type.tag === "array") {
    return `${arrayEqHelperName(type)}(${left}, ${right})`;
  }
  return `${left} == ${right}`;
}

function emitBinop(op: string, left: string, right: string, resultType: Type): string {
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

function emitCall(name: string, args: string[], resultType: Type, functionSymbols: Map<string, string>): string {
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
      return `${getFunctionSymbol(functionSymbols, name)}(${args.join(", ")})`;
  }
}

function emitLutWrapperBody(
  fn: IRFunction,
  implementation: LutImplementation,
  genericName: string,
  tableName: string,
): string {
  const lines = [...emitParamNormalizationLines(fn.params), `int32_t jplmm_lut_index = 0;`];

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
    const range = implementation.parameterRanges[i]!;
    const param = fn.params[i]!;
    lines.push(
      `  jplmm_lut_index += (${param.name} - ${range.lo}) * ${stride};`,
    );
    stride *= range.hi - range.lo + 1;
  }
  lines.push(`  return ${tableName}[jplmm_lut_index];`);
  lines.push("}");
  lines.push(`return ${genericName}(${fn.params.map((param) => param.name).join(", ")});`);
  return lines.join("\n");
}

function emitAitkenPrelude(ctx: NativeContext): string {
  const state = ctx.fn.params[ctx.aitken!.stateParamIndex]!;
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

function emitAitkenRewrite(ctx: NativeContext, expr: Extract<IRExpr, { tag: "rec" }>): string {
  const impl = ctx.aitken!;
  const targetGuard =
    impl.targetParamIndex === null
      ? "1"
      : `fabsf(jplmm_aitken_pred - ${ctx.fn.params[impl.targetParamIndex]!.name}) <= fabsf(jplmm_aitken_s2 - ${ctx.fn.params[impl.targetParamIndex]!.name})`;

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

function collectLocalDecls(fn: IRFunction, aitken: AitkenImplementation | null): string[] {
  const locals = new Map<string, string>();
  for (const param of fn.params) {
    for (const extentName of getArrayExtentNames(param.type) ?? []) {
      if (extentName !== null) {
        locals.set(extentName, "int32_t");
      }
    }
  }
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

function emitParamExtentLines(params: { name: string; type: Type }[]): string[] {
  const lines: string[] = [];
  for (const param of params) {
    const extentNames = getArrayExtentNames(param.type);
    if (!extentNames) {
      continue;
    }
    for (let i = 0; i < extentNames.length; i += 1) {
      const extentName = extentNames[i];
      if (extentName !== null) {
        lines.push(`${extentName} = jplmm_array_dim(${param.name}, ${i});`);
      }
    }
  }
  return lines;
}

function collectRecTemps(expr: IRExpr, locals: Map<string, string>): void {
  if (expr.tag === "rec") {
    for (let i = 0; i < expr.args.length; i += 1) {
      locals.set(recArgLocal(expr.id, i), cType(expr.args[i]!.resultType));
      collectRecTemps(expr.args[i]!, locals);
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

function emitPrototype(fn: IRFunction, cName: string): string {
  const params = fn.params.map((param) => `${cType(param.type)} ${param.name}`).join(", ") || "void";
  return `static ${cType(fn.retType)} ${cName}(${params})`;
}

function emitParamNormalizationLines(params: { name: string; type: Type }[]): string[] {
  return params
    .map((param) => {
      const normalized = normalizeScalarExprForType(param.name, param.type);
      return normalized === param.name ? null : `${param.name} = ${normalized};`;
    })
    .filter((line): line is string => line !== null);
}

function normalizeScalarExprForType(expr: string, type: Type | undefined): string {
  if (!type) {
    return expr;
  }
  if (type.tag === "int") {
    const bounds = getScalarBounds(type);
    if (!bounds) {
      return expr;
    }
    if (bounds.lo !== null && bounds.hi !== null) {
      return `jplmm_clamp_i32(${expr}, ${Math.trunc(bounds.lo)}, ${Math.trunc(bounds.hi)})`;
    }
    if (bounds.lo !== null) {
      return `jplmm_max_i32(${expr}, ${Math.trunc(bounds.lo)})`;
    }
    if (bounds.hi !== null) {
      return `jplmm_min_i32(${expr}, ${Math.trunc(bounds.hi)})`;
    }
    return expr;
  }
  if (type.tag === "float") {
    const out = `jplmm_nan_to_zero_f32(${expr})`;
    const bounds = getScalarBounds(type);
    if (!bounds) {
      return out;
    }
    if (bounds.lo !== null && bounds.hi !== null) {
      return `jplmm_clamp_f32(${out}, ${formatFloatLiteral(bounds.lo)}, ${formatFloatLiteral(bounds.hi)})`;
    }
    if (bounds.lo !== null) {
      return `jplmm_max_f32(${out}, ${formatFloatLiteral(bounds.lo)})`;
    }
    if (bounds.hi !== null) {
      return `jplmm_min_f32(${out}, ${formatFloatLiteral(bounds.hi)})`;
    }
    return out;
  }
  return expr;
}

function cType(type: Type): string {
  if (type.tag === "float") {
    return "float";
  }
  if (type.tag === "int" || type.tag === "void" || type.tag === "array" || type.tag === "named") {
    return "int32_t";
  }
  const _never: never = type;
  throw new Error(`Native lowering for an unexpected type is not implemented: ${_never}`);
}

function cDefaultValue(type: Type): string {
  return type.tag === "float" ? "0.0f" : "0";
}

function cDefaultValueFromCType(type: string): string {
  return type === "float" ? "0.0f" : "0";
}

function formatFloatLiteral(value: number): string {
  if (!Number.isFinite(value)) {
    return "0.0f";
  }
  const numeric = Number(value);
  return Number.isInteger(numeric) ? `${numeric}.0f` : `${numeric}f`;
}

function recArgLocal(id: number, index: number): string {
  return `jplmm_rec_${id}_${index}`;
}

function getFiniteGasLimit(fn: IRFunction): number | null {
  const gas = fn.body.find((stmt) => stmt.tag === "gas");
  if (!gas || gas.limit === "inf") {
    return null;
  }
  return gas.limit;
}

function parseArg(type: Type, argvIndex: number): string {
  if (type.tag === "float") {
    return `(argc > ${argvIndex} ? strtof(argv[${argvIndex}], NULL) : 0.0f)`;
  }
  return `(argc > ${argvIndex} ? (int32_t)strtol(argv[${argvIndex}], NULL, 10) : 0)`;
}

function emitFieldExpr(expr: Extract<IRExpr, { tag: "field" }>, ctx: NativeContext, options: EmitNativeCOptions): string {
  const targetType = expr.target.resultType;
  if (targetType.tag !== "named") {
    throw new Error(`Field access requires a struct target in '${ctx.fn.name}'`);
  }
  const structDef = ctx.structs.get(targetType.name);
  if (!structDef) {
    throw new Error(`Unknown struct '${targetType.name}' in native lowering`);
  }
  const fieldIndex = structDef.fields.findIndex((field) => field.name === expr.field);
  if (fieldIndex < 0) {
    throw new Error(`Unknown field '${expr.field}' on struct '${targetType.name}'`);
  }
  const baseLocal = `jplmm_field_base_${expr.id}`;
  return `({ int32_t ${baseLocal} = ${emitExpr(expr.target, ctx, options)};
   if (${baseLocal} == 0) {
     jplmm_panic("field access on null struct");
   }
   ${loadWordExpr(expr.resultType, baseLocal, `${fieldIndex}`)}; })`;
}

function emitStructConsExpr(
  expr: Extract<IRExpr, { tag: "struct_cons" }>,
  ctx: NativeContext,
  options: EmitNativeCOptions,
): string {
  const structDef = ctx.structs.get(expr.name);
  if (!structDef) {
    throw new Error(`Unknown struct '${expr.name}' in native lowering`);
  }
  const handleLocal = `jplmm_struct_${expr.id}`;
  const lines = [`({ int32_t ${handleLocal} = jplmm_alloc_words(${structDef.fields.length});`];
  for (let i = 0; i < structDef.fields.length; i += 1) {
    const fieldType = structDef.fields[i]!.type;
    const valueExpr = emitExpr(expr.fields[i]!, ctx, options);
    lines.push(`   ${storeWordStmt(fieldType, handleLocal, `${i}`, valueExpr)}`);
  }
  lines.push(`   ${handleLocal}; })`);
  return lines.join("\n");
}

function emitArrayConsExpr(
  expr: Extract<IRExpr, { tag: "array_cons" }>,
  ctx: NativeContext,
  options: EmitNativeCOptions,
): string {
  const arrayType = expectArrayType(expr.resultType, "array literal");
  const rank = arrayType.dims;
  const handleLocal = `jplmm_array_${expr.id}`;
  const headerWords = 1 + rank;

  if (expr.elements.length === 0) {
    return `jplmm_array_alloc_r1(0)`;
  }

  if (expr.elements[0]!.resultType.tag === "array") {
    const childType = expectArrayType(expr.elements[0]!.resultType, "nested array literal");
    const childRank = childType.dims;
    const childLocals = expr.elements.map((_, idx) => `jplmm_child_${expr.id}_${idx}`);
    const childCells = `jplmm_child_cells_${expr.id}`;
    const dimLocals = Array.from({ length: childRank }, (_, idx) => `jplmm_dim_${expr.id}_${idx + 1}`);
    const allocArgs = [String(expr.elements.length), ...dimLocals].join(", ");
    const lines = [`({ int32_t ${handleLocal};`];
    for (let i = 0; i < expr.elements.length; i += 1) {
      lines.push(`   int32_t ${childLocals[i]} = ${emitExpr(expr.elements[i]!, ctx, options)};`);
      lines.push(`   if (${childLocals[i]} == 0) {`);
      lines.push(`     jplmm_panic("nested array literal produced null child");`);
      lines.push("   }");
      lines.push(`   if (jplmm_array_rank(${childLocals[i]}) != ${childRank}) {`);
      lines.push(`     jplmm_panic("nested array literal rank mismatch");`);
      lines.push("   }");
    }
    for (let i = 0; i < childRank; i += 1) {
      lines.push(`   int32_t ${dimLocals[i]} = jplmm_array_dim(${childLocals[0]}, ${i});`);
    }
    for (let i = 1; i < expr.elements.length; i += 1) {
      for (let j = 0; j < childRank; j += 1) {
        lines.push(`   if (jplmm_array_dim(${childLocals[i]}, ${j}) != ${dimLocals[j]}) {`);
        lines.push(`     jplmm_panic("array literal requires nested arrays with matching dimensions");`);
        lines.push("   }");
      }
    }
    lines.push(`   int32_t ${childCells} = jplmm_array_total_cells(${childLocals[0]});`);
    lines.push(`   ${handleLocal} = jplmm_array_alloc_r${rank}(${allocArgs});`);
    lines.push(`   int32_t jplmm_dst_${expr.id} = 0;`);
    for (let i = 0; i < expr.elements.length; i += 1) {
      lines.push(
        `   jplmm_copy_words(${handleLocal}, ${headerWords} + jplmm_dst_${expr.id}, ${childLocals[i]}, ${1 + childRank}, ${childCells});`,
      );
      lines.push(`   jplmm_dst_${expr.id} += ${childCells};`);
    }
    lines.push(`   ${handleLocal}; })`);
    return lines.join("\n");
  }

  const allocArgs = expr.elements.length === 0 ? "0" : `${expr.elements.length}`;
  const lines = [`({ int32_t ${handleLocal} = jplmm_array_alloc_r1(${allocArgs});`];
  for (let i = 0; i < expr.elements.length; i += 1) {
    lines.push(
      `   ${storeWordStmt(arrayType.element, handleLocal, `${headerWords + i}`, emitExpr(expr.elements[i]!, ctx, options))}`,
    );
  }
  lines.push(`   ${handleLocal}; })`);
  return lines.join("\n");
}

function emitArrayComprehensionExpr(
  expr: Extract<IRExpr, { tag: "array_expr" }>,
  ctx: NativeContext,
  options: EmitNativeCOptions,
): string {
  const resultType = expectArrayType(expr.resultType, "array comprehension");
  const prefixRank = expr.bindings.length;
  const suffixRank = resultType.dims - prefixRank;
  const handleLocal = `jplmm_array_${expr.id}`;
  const totalLocal = `jplmm_total_${expr.id}`;
  const cursorLocal = `jplmm_cursor_${expr.id}`;
  const bodyCellsLocal = `jplmm_body_cells_${expr.id}`;
  const dimLocals = Array.from({ length: resultType.dims }, (_, idx) => `jplmm_dim_${expr.id}_${idx}`);
  const headerWords = 1 + resultType.dims;
  const prepassBody = emitArrayComprehensionLeaf(expr, ctx, options, {
    suffixRank,
    dimLocals,
    totalLocal,
    bodyCellsLocal,
    mode: "prepass",
    handleLocal,
    cursorLocal,
    headerWords,
  });
  const fillBody = emitArrayComprehensionLeaf(expr, ctx, options, {
    suffixRank,
    dimLocals,
    totalLocal,
    bodyCellsLocal,
    mode: "fill",
    handleLocal,
    cursorLocal,
    headerWords,
  });
  const allocArgs = dimLocals.slice(0, resultType.dims).join(", ");
  const lines = [`({ int32_t ${handleLocal};`];
  lines.push(`   int32_t ${totalLocal} = 0;`);
  lines.push(`   int32_t ${bodyCellsLocal} = 0;`);
  for (const dimLocal of dimLocals) {
    lines.push(`   int32_t ${dimLocal} = 0;`);
  }
  lines.push(indent(emitBindingLoopTree(expr.bindings, ctx, options, expr.id, dimLocals, 0, prepassBody), 1));
  lines.push(`   ${handleLocal} = jplmm_array_alloc_r${resultType.dims}(${allocArgs});`);
  lines.push(`   int32_t ${cursorLocal} = 0;`);
  lines.push(indent(emitBindingLoopTree(expr.bindings, ctx, options, expr.id, dimLocals, 0, fillBody), 1));
  lines.push(`   ${handleLocal}; })`);
  return lines.join("\n");
}

function emitSumComprehensionExpr(
  expr: Extract<IRExpr, { tag: "sum_expr" }>,
  ctx: NativeContext,
  options: EmitNativeCOptions,
): string {
  const sumLocal = `jplmm_sum_${expr.id}`;
  const lines = [`({ ${cType(expr.resultType)} ${sumLocal} = ${cDefaultValue(expr.resultType)};`];
  const body = `${sumLocal} = ${emitBinop("+", sumLocal, emitExpr(expr.body, ctx, options), expr.resultType)};`;
  lines.push(indent(emitBindingLoopTree(expr.bindings, ctx, options, expr.id, [], 0, body), 1));
  lines.push(`   ${sumLocal}; })`);
  return lines.join("\n");
}

function emitIndexExpr(expr: Extract<IRExpr, { tag: "index" }>, ctx: NativeContext, options: EmitNativeCOptions): string {
  const baseLocal = `jplmm_index_base_${expr.id}`;
  const offsetLocal = `jplmm_offset_${expr.id}`;
  const arrayType = expectArrayType(expr.array.resultType, "array indexing");
  const lines = [`({ int32_t ${baseLocal} = ${emitExpr(expr.array, ctx, options)};`];
  lines.push(`   if (${baseLocal} == 0) {`);
  lines.push(`     jplmm_panic("indexing null array");`);
  lines.push("   }");
  lines.push(`   if (jplmm_array_rank(${baseLocal}) < ${expr.indices.length}) {`);
  lines.push(`     jplmm_panic("array index rank mismatch");`);
  lines.push("   }");
  lines.push(`   int32_t ${offsetLocal} = 0;`);
  for (let i = 0; i < expr.indices.length; i += 1) {
    const indexLocal = `jplmm_idx_${expr.id}_${i}`;
    lines.push(
      `   int32_t ${indexLocal} = jplmm_clamp_i32(${emitExpr(expr.indices[i]!, ctx, options)}, 0, jplmm_max_i32(0, jplmm_array_dim(${baseLocal}, ${i}) - 1));`,
    );
    lines.push(`   ${offsetLocal} += ${indexLocal} * jplmm_array_stride(${baseLocal}, ${i});`);
  }
  if (expr.indices.length === arrayType.dims) {
    lines.push(`   ${loadWordExpr(expr.resultType, baseLocal, `${1 + arrayType.dims} + ${offsetLocal}`)}; })`);
  } else {
    lines.push(`   jplmm_array_slice(${baseLocal}, ${expr.indices.length}, ${offsetLocal}); })`);
  }
  return lines.join("\n");
}

function emitArrayComprehensionLeaf(
  expr: Extract<IRExpr, { tag: "array_expr" }>,
  ctx: NativeContext,
  options: EmitNativeCOptions,
  state: {
    suffixRank: number;
    dimLocals: string[];
    totalLocal: string;
    bodyCellsLocal: string;
    mode: "prepass" | "fill";
    handleLocal: string;
    cursorLocal: string;
    headerWords: number;
  },
): string {
  if (expr.body.resultType.tag === "array") {
    const bodyLocal = `jplmm_body_${expr.id}_${state.mode}`;
    const lines = [`int32_t ${bodyLocal} = ${emitExpr(expr.body, ctx, options)};`];
    lines.push(`if (${bodyLocal} == 0) {`);
    lines.push(`  jplmm_panic("array comprehension produced null nested array");`);
    lines.push("}");
    lines.push(`if (jplmm_array_rank(${bodyLocal}) != ${state.suffixRank}) {`);
    lines.push(`  jplmm_panic("array comprehension nested rank mismatch");`);
    lines.push("}");
    for (let i = 0; i < state.suffixRank; i += 1) {
      const dimLocal = state.dimLocals[expr.bindings.length + i]!;
      lines.push(`if (${dimLocal} == 0) {`);
      lines.push(`  ${dimLocal} = jplmm_array_dim(${bodyLocal}, ${i});`);
      lines.push(`} else if (${dimLocal} != jplmm_array_dim(${bodyLocal}, ${i})) {`);
      lines.push(`  jplmm_panic("array body produced ragged nested arrays");`);
      lines.push("}");
    }
    lines.push(`if (${state.bodyCellsLocal} == 0) {`);
    lines.push(`  ${state.bodyCellsLocal} = jplmm_array_total_cells(${bodyLocal});`);
    lines.push(`} else if (${state.bodyCellsLocal} != jplmm_array_total_cells(${bodyLocal})) {`);
    lines.push(`  jplmm_panic("array body produced ragged nested arrays");`);
    lines.push("}");
    if (state.mode === "prepass") {
      lines.push(`${state.totalLocal} += ${state.bodyCellsLocal};`);
    } else {
      lines.push(
        `jplmm_copy_words(${state.handleLocal}, ${state.headerWords} + ${state.cursorLocal}, ${bodyLocal}, ${1 + state.suffixRank}, ${state.bodyCellsLocal});`,
      );
      lines.push(`${state.cursorLocal} += ${state.bodyCellsLocal};`);
    }
    return lines.join("\n");
  }

  if (state.mode === "prepass") {
    return `${state.totalLocal} += 1;`;
  }

  return `${storeWordStmt(
    arrayLeafType(expr.resultType),
    state.handleLocal,
    `${state.headerWords} + ${state.cursorLocal}`,
    emitExpr(expr.body, ctx, options),
  )}
${state.cursorLocal} += 1;`;
}

function emitBindingLoopTree(
  bindings: Array<{ name: string; expr: IRExpr }>,
  ctx: NativeContext,
  options: EmitNativeCOptions,
  exprId: number,
  dimLocals: string[],
  index: number,
  leafBody: string,
): string {
  if (index === bindings.length) {
    return leafBody;
  }
  const binding = bindings[index]!;
  const extentLocal = `jplmm_extent_${exprId}_${index}`;
  const lines = [`{`];
  lines.push(`  int32_t ${extentLocal} = jplmm_max_i32(1, ${emitExpr(binding.expr, ctx, options)});`);
  if (dimLocals[index]) {
    lines.push(`  if (${dimLocals[index]} == 0) {`);
      lines.push(`    ${dimLocals[index]} = ${extentLocal};`);
    lines.push(`  } else if (${dimLocals[index]} != ${extentLocal}) {`);
    lines.push(`    jplmm_panic("array body produced ragged dimensions");`);
    lines.push("  }");
  }
  lines.push(`  for (int32_t ${binding.name} = 0; ${binding.name} < ${extentLocal}; ${binding.name} += 1) {`);
  lines.push(indent(emitBindingLoopTree(bindings, ctx, options, exprId, dimLocals, index + 1, leafBody), 2));
  lines.push("  }");
  lines.push("}");
  return lines.join("\n");
}

function emitNativeTypeHelpers(program: IRProgram, structs: Map<string, IRStructDef>): string {
  const arrayTypes = collectArrayTypes(program);
  const maxRank = arrayTypes.reduce((acc, type) => Math.max(acc, type.dims), 0);
  const structHelpers = [...structs.values()].map((struct) => emitNativeStructEqualityHelper(struct)).join("\n\n");
  const arrayHelpers = dedupeTypes(arrayTypes)
    .map((type) => emitNativeArrayEqualityHelper(type))
    .join("\n\n");

  return [emitNativeHeapHelpers(), emitNativeArrayAllocHelpers(maxRank), structHelpers, arrayHelpers]
    .filter(Boolean)
    .join("\n\n");
}

function emitNativeHeapHelpers(): string {
  return `static uint8_t *jplmm_heap = NULL;
static int32_t jplmm_heap_size = 8;
static int32_t jplmm_heap_capacity = 0;

static void jplmm_panic(const char *message) {
  fprintf(stderr, "%s\\n", message);
  abort();
}

static void jplmm_ensure_heap_capacity(int32_t needed) {
  if (jplmm_heap_capacity == 0) {
    jplmm_heap_capacity = 1 << 20;
    while (jplmm_heap_capacity < needed) {
      jplmm_heap_capacity <<= 1;
    }
    jplmm_heap = (uint8_t *)calloc((size_t)jplmm_heap_capacity, 1u);
    if (!jplmm_heap) {
      jplmm_panic("failed to allocate JPL heap");
    }
    return;
  }
  if (needed <= jplmm_heap_capacity) {
    return;
  }
  int32_t nextCapacity = jplmm_heap_capacity;
  while (nextCapacity < needed) {
    nextCapacity <<= 1;
  }
  uint8_t *next = (uint8_t *)realloc(jplmm_heap, (size_t)nextCapacity);
  if (!next) {
    jplmm_panic("failed to grow JPL heap");
  }
  memset(next + jplmm_heap_capacity, 0, (size_t)(nextCapacity - jplmm_heap_capacity));
  jplmm_heap = next;
  jplmm_heap_capacity = nextCapacity;
}

static void jplmm_reset_heap(void) {
  jplmm_ensure_heap_capacity(8);
  jplmm_heap_size = 8;
}

static int32_t jplmm_alloc_bytes(int32_t bytes) {
  if (bytes < 0) {
    jplmm_panic("negative allocation request");
  }
  int32_t aligned = (bytes + 7) & ~7;
  int32_t base = jplmm_heap_size;
  jplmm_ensure_heap_capacity(base + aligned);
  memset(jplmm_heap + base, 0, (size_t)aligned);
  jplmm_heap_size += aligned;
  return base;
}

static int32_t jplmm_alloc_words(int32_t words) {
  return jplmm_alloc_bytes(words * 4);
}

static inline int32_t jplmm_word_load_i32(int32_t handle, int32_t word) {
  int32_t value = 0;
  memcpy(&value, jplmm_heap + handle + (word * 4), sizeof(value));
  return value;
}

static inline float jplmm_word_load_f32(int32_t handle, int32_t word) {
  float value = 0.0f;
  memcpy(&value, jplmm_heap + handle + (word * 4), sizeof(value));
  return value;
}

static inline void jplmm_word_store_i32(int32_t handle, int32_t word, int32_t value) {
  memcpy(jplmm_heap + handle + (word * 4), &value, sizeof(value));
}

static inline void jplmm_word_store_f32(int32_t handle, int32_t word, float value) {
  memcpy(jplmm_heap + handle + (word * 4), &value, sizeof(value));
}

static inline void jplmm_copy_words(int32_t dstHandle, int32_t dstWord, int32_t srcHandle, int32_t srcWord, int32_t count) {
  memcpy(jplmm_heap + dstHandle + (dstWord * 4), jplmm_heap + srcHandle + (srcWord * 4), (size_t)count * 4u);
}

static inline int32_t jplmm_array_rank(int32_t handle) {
  return jplmm_word_load_i32(handle, 0);
}

static inline int32_t jplmm_array_dim(int32_t handle, int32_t index) {
  return jplmm_word_load_i32(handle, 1 + index);
}

static int32_t jplmm_array_total_cells(int32_t handle) {
  int32_t total = 1;
  int32_t rank = jplmm_array_rank(handle);
  for (int32_t i = 0; i < rank; i += 1) {
    total = jplmm_sat_mul_i32(total, jplmm_array_dim(handle, i));
  }
  return total;
}

static int32_t jplmm_array_stride(int32_t handle, int32_t index) {
  int32_t stride = 1;
  int32_t rank = jplmm_array_rank(handle);
  for (int32_t i = index + 1; i < rank; i += 1) {
    stride = jplmm_sat_mul_i32(stride, jplmm_array_dim(handle, i));
  }
  return stride;
}

static int32_t jplmm_array_slice(int32_t source, int32_t consumedRank, int32_t offsetCells) {
  int32_t srcRank = jplmm_array_rank(source);
  if (consumedRank > srcRank) {
    jplmm_panic("array index rank mismatch");
  }
  int32_t dstRank = srcRank - consumedRank;
  int32_t totalCells = 1;
  int32_t handle = 0;
  for (int32_t i = 0; i < dstRank; i += 1) {
    int32_t dim = jplmm_array_dim(source, consumedRank + i);
    totalCells = jplmm_sat_mul_i32(totalCells, dim);
  }
  handle = jplmm_alloc_words(1 + dstRank + totalCells);
  jplmm_word_store_i32(handle, 0, dstRank);
  for (int32_t i = 0; i < dstRank; i += 1) {
    jplmm_word_store_i32(handle, 1 + i, jplmm_array_dim(source, consumedRank + i));
  }
  jplmm_copy_words(handle, 1 + dstRank, source, 1 + srcRank + offsetCells, totalCells);
  return handle;
}`;
}

function emitNativeArrayAllocHelpers(maxRank: number): string {
  const helpers: string[] = [];
  for (let rank = 1; rank <= maxRank; rank += 1) {
    const params = Array.from({ length: rank }, (_, idx) => `int32_t d${idx}`).join(", ");
    const dims = Array.from({ length: rank }, (_, idx) => `  jplmm_word_store_i32(handle, ${idx + 1}, d${idx});`).join("\n");
    const total = Array.from({ length: rank }, (_, idx) => `  total = jplmm_sat_mul_i32(total, d${idx});`).join("\n");
    helpers.push(`static int32_t jplmm_array_alloc_r${rank}(${params}) {
  int32_t total = 1;
${total}
  int32_t handle = jplmm_alloc_words(1 + ${rank} + total);
  jplmm_word_store_i32(handle, 0, ${rank});
${dims}
  return handle;
}`);
  }
  return helpers.join("\n\n");
}

function emitNativeStructEqualityHelper(struct: IRStructDef): string {
  const lines = [`static int ${structEqHelperName(struct.name)}(int32_t a, int32_t b) {`];
  lines.push("  if (a == b) return 1;");
  lines.push("  if (a == 0 || b == 0) return 0;");
  for (let i = 0; i < struct.fields.length; i += 1) {
    lines.push(
      `  if (!(${emitEquality(loadWordExpr(struct.fields[i]!.type, "a", `${i}`), loadWordExpr(struct.fields[i]!.type, "b", `${i}`), struct.fields[i]!.type)})) return 0;`,
    );
  }
  lines.push("  return 1;");
  lines.push("}");
  return lines.join("\n");
}

function emitNativeArrayEqualityHelper(type: Type): string {
  const arrayType = expectArrayType(type, "array equality");
  const lines = [`static int ${arrayEqHelperName(arrayType)}(int32_t a, int32_t b) {`];
  lines.push("  if (a == b) return 1;");
  lines.push("  if (a == 0 || b == 0) return 0;");
  lines.push(`  if (jplmm_array_rank(a) != ${arrayType.dims} || jplmm_array_rank(b) != ${arrayType.dims}) return 0;`);
  for (let i = 0; i < arrayType.dims; i += 1) {
    lines.push(`  if (jplmm_array_dim(a, ${i}) != jplmm_array_dim(b, ${i})) return 0;`);
  }
  lines.push("  int32_t total = jplmm_array_total_cells(a);");
  lines.push("  for (int32_t i = 0; i < total; i += 1) {");
  lines.push(
    `    if (!(${emitEquality(
      loadWordExpr(arrayType.element, "a", `${1 + arrayType.dims} + i`),
      loadWordExpr(arrayType.element, "b", `${1 + arrayType.dims} + i`),
      arrayType.element,
    )})) return 0;`,
  );
  lines.push("  }");
  lines.push("  return 1;");
  lines.push("}");
  return lines.join("\n");
}

function loadWordExpr(type: Type, handleExpr: string, wordExpr: string): string {
  return type.tag === "float"
    ? `jplmm_word_load_f32(${handleExpr}, ${wordExpr})`
    : `jplmm_word_load_i32(${handleExpr}, ${wordExpr})`;
}

function storeWordStmt(type: Type, handleExpr: string, wordExpr: string, valueExpr: string): string {
  return type.tag === "float"
    ? `jplmm_word_store_f32(${handleExpr}, ${wordExpr}, ${valueExpr});`
    : `jplmm_word_store_i32(${handleExpr}, ${wordExpr}, ${valueExpr});`;
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

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
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
      for (const arg of expr.args) {
        collectArrayTypesFromExpr(arg, out);
      }
      return;
    case "rec":
      for (const arg of expr.args) {
        collectArrayTypesFromExpr(arg, out);
      }
      return;
    case "struct_cons":
      for (const arg of expr.fields) {
        collectArrayTypesFromExpr(arg, out);
      }
      return;
    case "field":
      collectArrayTypesFromExpr(expr.target, out);
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

function emitNativeHelpers(): string {
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

function indent(text: string, depth: number): string {
  const prefix = "  ".repeat(depth);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
