import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { BUILTIN_FUNCTIONS, INT32_MAX, INT32_MIN, renderType, unwrapTimedDefinition } from "@jplmm/ast";
import { buildIR } from "@jplmm/ir";
import { executeProgram, optimizeProgram } from "@jplmm/optimize";
const INT_T = { tag: "int" };
const FLOAT_T = { tag: "float" };
const VOID_T = { tag: "void" };
export function executeTopLevelProgram(program, typeMap, cwd) {
    const ir = buildIR(program, typeMap);
    const optimized = optimizeProgram(ir);
    const ctx = {
        program,
        typeMap,
        globals: new Map(),
        cwd,
        irProgram: optimized.program,
        artifacts: optimized.artifacts,
        output: [],
        wroteFiles: [],
    };
    const mainFn = findImplicitMain(program);
    if (mainFn && !hasExplicitTopLevelExecution(program)) {
        const value = executeProgram(ctx.irProgram, mainFn.name, [], { artifacts: ctx.artifacts }).value;
        if (mainFn.retType.tag !== "void") {
            ctx.output.push(formatValue(value));
        }
        return {
            output: ctx.output,
            wroteFiles: ctx.wroteFiles,
        };
    }
    for (const cmd of program.commands) {
        executeCmd(cmd, ctx);
    }
    return {
        output: ctx.output,
        wroteFiles: ctx.wroteFiles,
    };
}
export function traceTopLevelProgram(program, typeMap, cwd) {
    const ir = buildIR(program, typeMap);
    const optimized = optimizeProgram(ir);
    const ctx = {
        program,
        typeMap,
        globals: new Map(),
        cwd,
        irProgram: optimized.program,
        artifacts: optimized.artifacts,
        output: [],
        wroteFiles: [],
    };
    const commands = [];
    const mainFn = findImplicitMain(program);
    if (mainFn && !hasExplicitTopLevelExecution(program)) {
        const value = executeProgram(ctx.irProgram, mainFn.name, [], { artifacts: ctx.artifacts }).value;
        if (mainFn.retType.tag !== "void") {
            ctx.output.push(formatValue(value));
        }
        commands.push({
            id: mainFn.id,
            tag: "implicit_main",
            rendered: `${mainFn.name}()`,
            effect: "executes the implicit zero-argument main entrypoint and emits its return value if non-void",
            outputDelta: [...ctx.output],
            wroteFilesDelta: [],
        });
        return {
            usedImplicitMain: true,
            implicitMainName: mainFn.name,
            commands,
            finalOutput: [...ctx.output],
            wroteFiles: [...ctx.wroteFiles],
        };
    }
    for (const cmd of program.commands) {
        const outputBefore = ctx.output.length;
        const wroteBefore = ctx.wroteFiles.length;
        executeCmd(cmd, ctx);
        commands.push({
            id: cmd.id,
            tag: cmd.tag,
            rendered: renderCmd(cmd),
            effect: describeCmdEffect(cmd),
            outputDelta: ctx.output.slice(outputBefore),
            wroteFilesDelta: ctx.wroteFiles.slice(wroteBefore),
        });
    }
    return {
        usedImplicitMain: false,
        implicitMainName: null,
        commands,
        finalOutput: [...ctx.output],
        wroteFiles: [...ctx.wroteFiles],
    };
}
function findImplicitMain(program) {
    for (const cmd of program.commands) {
        const fn = unwrapTimedDefinition(cmd, "fn_def");
        if (fn && fn.name === "main" && fn.params.length === 0) {
            return fn;
        }
    }
    return null;
}
function hasExplicitTopLevelExecution(program) {
    return program.commands.some((cmd) => {
        if (cmd.tag === "fn_def" || cmd.tag === "struct_def") {
            return false;
        }
        if (cmd.tag === "time" && (cmd.cmd.tag === "fn_def" || cmd.cmd.tag === "struct_def")) {
            return false;
        }
        return true;
    });
}
function renderCmd(cmd) {
    switch (cmd.tag) {
        case "fn_def":
            return `${cmd.keyword} ${cmd.name}(${cmd.params.map((param) => `${param.name}:${renderType(param.type)}`).join(", ")}): ${renderType(cmd.retType)}`;
        case "let_cmd":
            return `let ${renderLValue(cmd.lvalue)} = ${renderExpr(cmd.expr)}`;
        case "struct_def":
            return `struct ${cmd.name}`;
        case "read_image":
            return `read image "${cmd.filename}" as ${renderArgument(cmd.target)}`;
        case "write_image":
            return `write image ${renderExpr(cmd.expr)} -> "${cmd.filename}"`;
        case "print":
            return `print "${cmd.message}"`;
        case "show":
            return `show ${renderExpr(cmd.expr)}`;
        case "time":
            return `time ${renderCmd(cmd.cmd)}`;
        default: {
            const _never = cmd;
            return `${_never}`;
        }
    }
}
function describeCmdEffect(cmd) {
    switch (cmd.tag) {
        case "fn_def":
            return "declares a callable function for later execution";
        case "struct_def":
            return "declares a struct shape for later construction and field projection";
        case "let_cmd":
            return "evaluates the expression once and binds the resulting runtime value at top level";
        case "read_image":
            return "loads an image file and binds the resulting dimensions and/or array value";
        case "write_image":
            return "evaluates the expression and writes an image file";
        case "print":
            return "emits the literal message to top-level output";
        case "show":
            return "evaluates the expression and emits its formatted runtime value";
        case "time":
            return "executes the nested command and appends an elapsed-time line";
        default: {
            const _never = cmd;
            return `${_never}`;
        }
    }
}
function renderLValue(lvalue) {
    switch (lvalue.tag) {
        case "var":
            return lvalue.name;
        case "field":
            return `${lvalue.base}.${lvalue.field}`;
        case "tuple":
            return `(${lvalue.items.map((item) => renderLValue(item)).join(", ")})`;
        default: {
            const _never = lvalue;
            return `${_never}`;
        }
    }
}
function renderArgument(argument) {
    switch (argument.tag) {
        case "var":
            return argument.name;
        case "tuple":
            return `(${argument.items.map((item) => renderArgument(item)).join(", ")})`;
        default: {
            const _never = argument;
            return `${_never}`;
        }
    }
}
function renderExpr(expr) {
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
            return `${expr.value}`;
        case "void_lit":
            return "void";
        case "var":
            return expr.name;
        case "binop":
            return `${renderExpr(expr.left)} ${expr.op} ${renderExpr(expr.right)}`;
        case "unop":
            return `${expr.op}${renderExpr(expr.operand)}`;
        case "call":
            return `${expr.name}(${expr.args.map((arg) => renderExpr(arg)).join(", ")})`;
        case "index":
            return `${renderExpr(expr.array)}[${expr.indices.map((idx) => renderExpr(idx)).join(", ")}]`;
        case "field":
            return `${renderExpr(expr.target)}.${expr.field}`;
        case "struct_cons":
            return `${expr.name}(${expr.fields.map((field) => renderExpr(field)).join(", ")})`;
        case "array_cons":
            return `[${expr.elements.map((element) => renderExpr(element)).join(", ")}]`;
        case "array_expr":
            return `array[${expr.bindings.map((binding) => `${binding.name}:${renderExpr(binding.expr)}`).join(", ")}] ${renderExpr(expr.body)}`;
        case "sum_expr":
            return `sum[${expr.bindings.map((binding) => `${binding.name}:${renderExpr(binding.expr)}`).join(", ")}] ${renderExpr(expr.body)}`;
        case "res":
            return "res";
        case "rec":
            return `rec(${expr.args.map((arg) => renderExpr(arg)).join(", ")})`;
        default: {
            const _never = expr;
            return `${_never}`;
        }
    }
}
function executeCmd(cmd, ctx) {
    switch (cmd.tag) {
        case "fn_def":
        case "struct_def":
            return;
        case "let_cmd": {
            const value = evalExpr(cmd.expr, ctx, new Map());
            assignLValue(cmd.lvalue, value, ctx, new Map());
            return;
        }
        case "print":
            ctx.output.push(cmd.message);
            return;
        case "show":
            ctx.output.push(formatValue(evalExpr(cmd.expr, ctx, new Map())));
            return;
        case "time": {
            const start = performance.now();
            executeCmd(cmd.cmd, ctx);
            const elapsedMs = performance.now() - start;
            ctx.output.push(`time: ${elapsedMs.toFixed(3)} ms`);
            return;
        }
        case "read_image": {
            const image = readImageFile(resolvePath(ctx.cwd, cmd.filename));
            assignArgument(cmd.target, image.meta, image.value, ctx);
            return;
        }
        case "write_image": {
            const value = evalExpr(cmd.expr, ctx, new Map());
            const filename = resolvePath(ctx.cwd, cmd.filename);
            writeImageFile(filename, value);
            ctx.wroteFiles.push(filename);
            return;
        }
        default: {
            const _never = cmd;
            return _never;
        }
    }
}
function assignArgument(argument, meta, image, ctx) {
    const leaves = flattenArgument(argument);
    if (leaves.length === 1) {
        ctx.globals.set(leaves[0], image);
        return;
    }
    if (leaves.length === 3) {
        ctx.globals.set(leaves[0], saturateInt(meta.width));
        ctx.globals.set(leaves[1], saturateInt(meta.height));
        ctx.globals.set(leaves[2], image);
        return;
    }
    throw new Error("read image target must bind image or (width, height, image)");
}
function flattenArgument(argument) {
    if (argument.tag === "var") {
        return [argument.name];
    }
    return argument.items.flatMap((item) => flattenArgument(item));
}
function assignLValue(lvalue, value, ctx, locals) {
    switch (lvalue.tag) {
        case "var":
            if (locals.has(lvalue.name)) {
                locals.set(lvalue.name, value);
            }
            else {
                ctx.globals.set(lvalue.name, value);
            }
            return;
        case "field": {
            const base = loadValue(lvalue.base, ctx, locals);
            if (!isStructValue(base)) {
                throw new Error(`Cannot assign field on non-struct value '${lvalue.base}'`);
            }
            const fieldType = inferFieldType(base, lvalue.field, ctx.program);
            const nextFields = base.fields.slice();
            const fieldIndex = fieldType.index;
            nextFields[fieldIndex] = normalizeByType(value, fieldType.type);
            storeValue(lvalue.base, { ...base, fields: nextFields }, ctx, locals);
            return;
        }
        case "tuple":
            throw new Error("Tuple let bindings are only supported for read image targets");
        default: {
            const _never = lvalue;
            return _never;
        }
    }
}
function storeValue(name, value, ctx, locals) {
    if (locals.has(name)) {
        locals.set(name, value);
        return;
    }
    ctx.globals.set(name, value);
}
function loadValue(name, ctx, locals) {
    const local = locals.get(name);
    if (local !== undefined) {
        return local;
    }
    const global = ctx.globals.get(name);
    if (global !== undefined) {
        return global;
    }
    throw new Error(`Unbound variable '${name}' during execution`);
}
function evalExpr(expr, ctx, locals) {
    const type = ctx.typeMap.get(expr.id) ?? fallbackType(expr, ctx, locals);
    switch (expr.tag) {
        case "int_lit":
            return saturateInt(expr.value);
        case "float_lit":
            return nanToZero(f32(expr.value));
        case "void_lit":
            return 0;
        case "var":
            return loadValue(expr.name, ctx, locals);
        case "res":
        case "rec":
            throw new Error(`'${expr.tag}' is not valid in top-level execution`);
        case "unop": {
            const operand = evalExpr(expr.operand, ctx, locals);
            return evalUnary(expr.op, operand, type);
        }
        case "binop": {
            const left = evalExpr(expr.left, ctx, locals);
            const right = evalExpr(expr.right, ctx, locals);
            return evalBinary(expr.op, left, right, type);
        }
        case "call": {
            const args = expr.args.map((arg) => evalExpr(arg, ctx, locals));
            if (isBuiltin(expr.name)) {
                return evalBuiltin(expr.name, args, type);
            }
            return executeProgram(ctx.irProgram, expr.name, args, { artifacts: ctx.artifacts }).value;
        }
        case "field": {
            const target = evalExpr(expr.target, ctx, locals);
            if (!isStructValue(target)) {
                throw new Error("Field access requires a struct value");
            }
            const info = inferFieldType(target, expr.field, ctx.program);
            return target.fields[info.index];
        }
        case "index": {
            const arrayValue = evalExpr(expr.array, ctx, locals);
            if (!isArrayValue(arrayValue)) {
                throw new Error("Indexing requires an array value");
            }
            const indices = expr.indices.map((idx) => assertInt(evalExpr(idx, ctx, locals), "index"));
            return arrayGet(arrayValue, indices);
        }
        case "struct_cons": {
            const fields = expr.fields.map((field) => evalExpr(field, ctx, locals));
            return { kind: "struct", typeName: expr.name, fields };
        }
        case "array_cons": {
            const elements = expr.elements.map((element) => evalExpr(element, ctx, locals));
            return makeArrayLiteral(elements, type);
        }
        case "array_expr":
            return evalArrayComprehension(expr.bindings, expr.body, ctx, locals, type);
        case "sum_expr":
            return evalSumComprehension(expr.bindings, expr.body, ctx, locals, type);
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function evalArrayComprehension(bindings, body, ctx, locals, type) {
    const values = [];
    const dims = [];
    iterateBindings(bindings, ctx, locals, (scope, indices, extents) => {
        if (dims.length === 0) {
            dims.push(...extents);
        }
        values.push(evalExpr(body, ctx, scope));
        void indices;
    });
    const elementType = type.tag === "array" ? type.element : VOID_T;
    return { kind: "array", elementType, dims, values: values.map((value) => normalizeByType(value, elementType)) };
}
function evalSumComprehension(bindings, body, ctx, locals, type) {
    let acc = type.tag === "float" ? 0 : 0;
    iterateBindings(bindings, ctx, locals, (scope) => {
        const value = evalExpr(body, ctx, scope);
        acc = evalBinary("+", acc, value, type);
    });
    return acc;
}
function iterateBindings(bindings, ctx, locals, onPoint) {
    const extents = bindings.map((binding) => Math.max(1, assertInt(evalExpr(binding.expr, ctx, locals), "binding extent")));
    const scope = new Map(locals);
    const indices = [];
    const visit = (depth) => {
        if (depth === bindings.length) {
            onPoint(scope, indices, extents);
            return;
        }
        const binding = bindings[depth];
        for (let i = 0; i < extents[depth]; i += 1) {
            scope.set(binding.name, saturateInt(i));
            indices[depth] = i;
            visit(depth + 1);
        }
    };
    visit(0);
}
function makeArrayLiteral(elements, type) {
    if (type.tag !== "array") {
        return { kind: "array", elementType: VOID_T, dims: [elements.length], values: elements };
    }
    if (elements.length === 0) {
        return { kind: "array", elementType: type.element, dims: [0], values: [] };
    }
    const first = elements[0];
    if (isArrayValue(first)) {
        const child = first;
        const dims = [elements.length, ...child.dims];
        const values = [];
        for (const element of elements) {
            if (!isArrayValue(element)) {
                throw new Error("Nested array literal mixed array and scalar elements");
            }
            values.push(...element.values);
        }
        return { kind: "array", elementType: child.elementType, dims, values };
    }
    return {
        kind: "array",
        elementType: type.element,
        dims: [elements.length],
        values: elements.map((element) => normalizeByType(element, type.element)),
    };
}
function arrayGet(array, indices) {
    if (indices.length > array.dims.length) {
        throw new Error("Too many indices for array access");
    }
    const clampedIndices = indices.map((index, idx) => clampIndex(index, array.dims[idx] ?? 1));
    const offset = linearOffset(array.dims, clampedIndices);
    if (indices.length === array.dims.length) {
        return array.values[offset] ?? defaultValueForType(array.elementType);
    }
    const sliceDims = array.dims.slice(clampedIndices.length);
    const sliceSize = product(sliceDims);
    const start = offset;
    const end = start + sliceSize;
    return {
        kind: "array",
        elementType: array.elementType,
        dims: sliceDims,
        values: array.values.slice(start, end),
    };
}
function linearOffset(dims, indices) {
    let stride = 1;
    let offset = 0;
    for (let i = dims.length - 1; i >= 0; i -= 1) {
        const index = indices[i] ?? 0;
        offset += index * stride;
        stride *= dims[i];
    }
    return offset;
}
function clampIndex(index, dim) {
    if (dim <= 1) {
        return 0;
    }
    if (index < 0) {
        return 0;
    }
    if (index >= dim) {
        return dim - 1;
    }
    return index;
}
function evalUnary(op, operand, type) {
    const number = assertNumber(operand, `unary ${op}`);
    if (type.tag === "int") {
        return saturateInt(-number);
    }
    return nanToZero(f32(-number));
}
function evalBinary(op, left, right, type) {
    const a = assertNumber(left, `binary ${op}`);
    const b = assertNumber(right, `binary ${op}`);
    if (type.tag === "int") {
        if (op === "+")
            return saturateInt(a + b);
        if (op === "-")
            return saturateInt(a - b);
        if (op === "*")
            return saturateInt(a * b);
        if (op === "/")
            return totalDivInt(a, b);
        if (op === "%")
            return totalModInt(a, b);
    }
    else {
        if (op === "+")
            return nanToZero(f32(a + b));
        if (op === "-")
            return nanToZero(f32(a - b));
        if (op === "*")
            return nanToZero(f32(a * b));
        if (op === "/")
            return totalDivFloat(a, b);
        if (op === "%")
            return totalModFloat(a, b);
    }
    throw new Error(`Unsupported binary operator '${op}'`);
}
function evalBuiltin(name, args, resultType) {
    const asNumberArgs = args.map((arg) => assertNumber(arg, name));
    switch (name) {
        case "sqrt":
            return nanToZero(f32(Math.sqrt(asNumberArgs[0] ?? 0)));
        case "exp":
            return nanToZero(f32(Math.exp(asNumberArgs[0] ?? 0)));
        case "sin":
            return nanToZero(f32(Math.sin(asNumberArgs[0] ?? 0)));
        case "cos":
            return nanToZero(f32(Math.cos(asNumberArgs[0] ?? 0)));
        case "tan":
            return nanToZero(f32(Math.tan(asNumberArgs[0] ?? 0)));
        case "asin":
            return nanToZero(f32(Math.asin(asNumberArgs[0] ?? 0)));
        case "acos":
            return nanToZero(f32(Math.acos(asNumberArgs[0] ?? 0)));
        case "atan":
            return nanToZero(f32(Math.atan(asNumberArgs[0] ?? 0)));
        case "log":
            return nanToZero(f32(Math.log(asNumberArgs[0] ?? 0)));
        case "pow":
            return nanToZero(f32(Math.pow(asNumberArgs[0] ?? 0, asNumberArgs[1] ?? 0)));
        case "atan2":
            return nanToZero(f32(Math.atan2(asNumberArgs[0] ?? 0, asNumberArgs[1] ?? 0)));
        case "to_float":
            return nanToZero(f32(asNumberArgs[0] ?? 0));
        case "to_int":
            return toInt(asNumberArgs[0] ?? 0);
        case "max":
            return normalizeByType(Math.max(asNumberArgs[0] ?? 0, asNumberArgs[1] ?? 0), resultType);
        case "min":
            return normalizeByType(Math.min(asNumberArgs[0] ?? 0, asNumberArgs[1] ?? 0), resultType);
        case "abs":
            return normalizeByType(Math.abs(asNumberArgs[0] ?? 0), resultType);
        case "clamp":
            return normalizeByType(Math.min(Math.max(asNumberArgs[0] ?? 0, asNumberArgs[1] ?? 0), asNumberArgs[2] ?? 0), resultType);
        default:
            throw new Error(`Unknown builtin '${name}'`);
    }
}
function isBuiltin(name) {
    return BUILTIN_FUNCTIONS.has(name);
}
function normalizeByType(value, type) {
    if (type.tag === "int") {
        return saturateInt(assertNumber(value, "int"));
    }
    if (type.tag === "float") {
        return nanToZero(f32(assertNumber(value, "float")));
    }
    if (type.tag === "named") {
        if (!isStructValue(value)) {
            throw new Error(`Expected struct value for type '${type.name}'`);
        }
        return value;
    }
    if (type.tag === "array") {
        if (!isArrayValue(value)) {
            throw new Error("Expected array value");
        }
        return value;
    }
    return 0;
}
function defaultValueForType(type) {
    if (type.tag === "int" || type.tag === "float" || type.tag === "void") {
        return 0;
    }
    if (type.tag === "named") {
        return { kind: "struct", typeName: type.name, fields: [] };
    }
    return {
        kind: "array",
        elementType: type.element,
        dims: new Array(type.dims).fill(0),
        values: [],
    };
}
function inferFieldType(value, fieldName, program) {
    const structDef = findStructDef(program, value.typeName);
    if (!structDef) {
        throw new Error(`Unknown struct '${value.typeName}'`);
    }
    const index = structDef.fields.findIndex((field) => field.name === fieldName);
    if (index < 0) {
        throw new Error(`Unknown field '${fieldName}' on struct '${value.typeName}'`);
    }
    return { index, type: structDef.fields[index].type };
}
function fallbackType(expr, ctx, locals) {
    if (expr.tag === "var") {
        const value = locals.get(expr.name) ?? ctx.globals.get(expr.name);
        if (value === undefined) {
            return VOID_T;
        }
        if (typeof value === "number") {
            return Number.isInteger(value) ? INT_T : FLOAT_T;
        }
        if (isStructValue(value)) {
            return { tag: "named", name: value.typeName };
        }
        if (isArrayValue(value)) {
            return { tag: "array", element: value.elementType, dims: value.dims.length };
        }
    }
    return VOID_T;
}
function formatValue(value) {
    if (typeof value === "number") {
        return Number.isInteger(value) ? `${value}` : `${Number(value.toFixed(6))}`;
    }
    if (isStructValue(value)) {
        return `${value.typeName} { ${value.fields.map((field) => formatValue(field)).join(", ")} }`;
    }
    const rows = rehydrateArray(value);
    return JSON.stringify(rows);
}
function rehydrateArray(array) {
    const [dim, ...rest] = array.dims;
    if (dim === undefined) {
        return [];
    }
    if (rest.length === 0) {
        return array.values.map((value) => formatLeaf(value));
    }
    const chunk = product(rest);
    const rows = [];
    for (let i = 0; i < dim; i += 1) {
        rows.push(rehydrateArray({
            kind: "array",
            elementType: array.elementType,
            dims: rest,
            values: array.values.slice(i * chunk, (i + 1) * chunk),
        }));
    }
    return rows;
}
function formatLeaf(value) {
    if (typeof value === "number") {
        return value;
    }
    if (isStructValue(value)) {
        return {
            kind: value.typeName,
            fields: value.fields.map((field) => formatLeaf(field)),
        };
    }
    return rehydrateArray(value);
}
function readImageFile(filename) {
    const bytes = readFileSync(filename);
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
        return readBmpFile(filename, bytes);
    }
    const text = bytes.toString("utf8");
    const tokens = text
        .replace(/#[^\n]*/g, "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    const magic = tokens.shift();
    if (magic !== "P2" && magic !== "P3") {
        throw new Error(`Unsupported image format '${magic ?? ""}'. Use BMP or ASCII P2/P3 PPM/PGM.`);
    }
    const width = Number(tokens.shift() ?? "0");
    const height = Number(tokens.shift() ?? "0");
    const maxValue = Number(tokens.shift() ?? "255");
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0 || maxValue <= 0) {
        throw new Error(`Invalid image header in '${filename}'`);
    }
    const channels = magic === "P3" ? 3 : 1;
    const expected = width * height * channels;
    if (tokens.length < expected) {
        throw new Error(`Image '${filename}' is truncated`);
    }
    const values = tokens.slice(0, expected).map((token) => {
        const raw = Number(token);
        const scaled = Math.round((raw / maxValue) * 255);
        return saturateByte(scaled);
    });
    return {
        meta: { width, height },
        value: {
            kind: "array",
            elementType: INT_T,
            dims: [height, width, channels],
            values,
        },
    };
}
function writeImageFile(filename, value) {
    if (filename.toLowerCase().endsWith(".bmp")) {
        writeBmpFile(filename, value);
        return;
    }
    if (!isArrayValue(value)) {
        throw new Error("write image expects an array value");
    }
    if (value.dims.length !== 2 && value.dims.length !== 3) {
        throw new Error("write image expects int[][] or int[][][]");
    }
    const height = value.dims[0] ?? 0;
    const width = value.dims[1] ?? 0;
    const channels = value.dims[2] ?? 1;
    if (channels !== 1 && channels !== 3) {
        throw new Error("write image expects grayscale or RGB image data");
    }
    const numbers = value.values.map((entry) => saturateByte(assertInt(entry, "image pixel")));
    const header = `${channels === 1 ? "P2" : "P3"}\n${width} ${height}\n255\n`;
    writeFileSync(filename, `${header}${numbers.join(" ")}\n`);
}
function readBmpFile(filename, bytes) {
    if (bytes.length < 54) {
        throw new Error(`BMP '${filename}' is truncated`);
    }
    const pixelOffset = bytes.readUInt32LE(10);
    const dibSize = bytes.readUInt32LE(14);
    const width = bytes.readInt32LE(18);
    const signedHeight = bytes.readInt32LE(22);
    const planes = bytes.readUInt16LE(26);
    const bitsPerPixel = bytes.readUInt16LE(28);
    const compression = bytes.readUInt32LE(30);
    if (dibSize < 40 || planes !== 1 || compression !== 0) {
        throw new Error(`Unsupported BMP '${filename}': only uncompressed BITMAPINFOHEADER images are supported`);
    }
    if (width <= 0 || signedHeight === 0) {
        throw new Error(`Invalid BMP dimensions in '${filename}'`);
    }
    if (bitsPerPixel !== 24 && bitsPerPixel !== 32) {
        throw new Error(`Unsupported BMP '${filename}': only 24-bit and 32-bit images are supported`);
    }
    const height = Math.abs(signedHeight);
    const topDown = signedHeight < 0;
    const rowStride = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
    const channelStride = bitsPerPixel / 8;
    const values = [];
    for (let y = 0; y < height; y += 1) {
        const srcY = topDown ? y : height - 1 - y;
        const rowStart = pixelOffset + srcY * rowStride;
        if (rowStart + rowStride > bytes.length) {
            throw new Error(`BMP '${filename}' is truncated`);
        }
        for (let x = 0; x < width; x += 1) {
            const pixel = rowStart + x * channelStride;
            values.push(bytes[pixel + 2] ?? 0, bytes[pixel + 1] ?? 0, bytes[pixel] ?? 0);
        }
    }
    return {
        meta: { width, height },
        value: {
            kind: "array",
            elementType: INT_T,
            dims: [height, width, 3],
            values,
        },
    };
}
function writeBmpFile(filename, value) {
    if (!isArrayValue(value)) {
        throw new Error("write image expects an array value");
    }
    if (value.dims.length !== 2 && value.dims.length !== 3) {
        throw new Error("write image expects int[][] or int[][][]");
    }
    const height = value.dims[0] ?? 0;
    const width = value.dims[1] ?? 0;
    const channels = value.dims[2] ?? 1;
    if (channels !== 1 && channels !== 3) {
        throw new Error("write image expects grayscale or RGB image data");
    }
    const rowStride = Math.floor((24 * width + 31) / 32) * 4;
    const pixelBytes = rowStride * height;
    const offset = 54;
    const buffer = Buffer.alloc(offset + pixelBytes);
    buffer.write("BM", 0, "ascii");
    buffer.writeUInt32LE(offset + pixelBytes, 2);
    buffer.writeUInt32LE(offset, 10);
    buffer.writeUInt32LE(40, 14);
    buffer.writeInt32LE(width, 18);
    buffer.writeInt32LE(height, 22);
    buffer.writeUInt16LE(1, 26);
    buffer.writeUInt16LE(24, 28);
    buffer.writeUInt32LE(0, 30);
    buffer.writeUInt32LE(pixelBytes, 34);
    buffer.writeInt32LE(2835, 38);
    buffer.writeInt32LE(2835, 42);
    for (let y = 0; y < height; y += 1) {
        const dstRow = offset + (height - 1 - y) * rowStride;
        for (let x = 0; x < width; x += 1) {
            const src = (y * width + x) * channels;
            const base = dstRow + x * 3;
            const r = saturateByte(assertInt(value.values[src] ?? 0, "image pixel"));
            const g = saturateByte(assertInt(value.values[src + (channels === 1 ? 0 : 1)] ?? r, "image pixel"));
            const b = saturateByte(assertInt(value.values[src + (channels === 1 ? 0 : 2)] ?? r, "image pixel"));
            buffer[base] = b;
            buffer[base + 1] = g;
            buffer[base + 2] = r;
        }
    }
    writeFileSync(filename, buffer);
}
function resolvePath(cwd, filename) {
    return resolve(cwd, filename);
}
function totalDivInt(a, b) {
    if (b === 0)
        return 0;
    return saturateInt(Math.trunc(a / b));
}
function totalModInt(a, b) {
    if (b === 0)
        return 0;
    return saturateInt(a % b);
}
function totalDivFloat(a, b) {
    if (b === 0)
        return 0;
    return nanToZero(f32(a / b));
}
function totalModFloat(a, b) {
    if (b === 0)
        return 0;
    return nanToZero(f32(a % b));
}
function toInt(value) {
    if (Number.isNaN(value))
        return 0;
    if (value === Infinity)
        return INT32_MAX;
    if (value === -Infinity)
        return INT32_MIN;
    return saturateInt(Math.trunc(value));
}
function saturateInt(value) {
    if (!Number.isFinite(value)) {
        return value < 0 ? INT32_MIN : INT32_MAX;
    }
    if (value < INT32_MIN)
        return INT32_MIN;
    if (value > INT32_MAX)
        return INT32_MAX;
    return value | 0;
}
function saturateByte(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.max(0, Math.min(255, Math.round(value)));
}
function nanToZero(value) {
    return Number.isNaN(value) ? 0 : value;
}
function f32(value) {
    return Math.fround(value);
}
function assertNumber(value, context) {
    if (typeof value !== "number") {
        throw new Error(`${context} expected scalar value`);
    }
    return value;
}
function assertInt(value, context) {
    return saturateInt(assertNumber(value, context));
}
function isStructValue(value) {
    return typeof value === "object" && value !== null && "kind" in value && value.kind === "struct";
}
function isArrayValue(value) {
    return typeof value === "object" && value !== null && "kind" in value && value.kind === "array";
}
function _sameDims(left, right) {
    return left.length === right.length && left.every((dim, idx) => dim === right[idx]);
}
function product(values) {
    return values.reduce((acc, value) => acc * value, 1);
}
function findStructDef(program, name) {
    for (const cmd of program.commands) {
        if (cmd.tag === "struct_def" && cmd.name === name) {
            return cmd;
        }
        if (cmd.tag === "time" && cmd.cmd.tag === "struct_def" && cmd.cmd.name === name) {
            return cmd.cmd;
        }
    }
    return undefined;
}
//# sourceMappingURL=run.js.map