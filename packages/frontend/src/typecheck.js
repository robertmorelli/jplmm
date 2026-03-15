import { eraseScalarBounds, getArrayExtentNames, isNumericType, renderType, sameTypeShape, } from "@jplmm/ast";
import { error } from "./errors";
const INT_T = { tag: "int" };
const FLOAT_T = { tag: "float" };
const VOID_T = { tag: "void" };
const IMAGE_T = { tag: "array", element: INT_T, dims: 3 };
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
export function typecheckProgram(program) {
    const diagnostics = [];
    const typeMap = new Map();
    const fnSigs = collectFnSigs(program);
    const structDefs = collectStructDefs(program);
    const globalEnv = new Map();
    for (const cmd of program.commands) {
        if (unwrapTimedDefinition(cmd, "struct_def")) {
            continue;
        }
        const fnDef = unwrapTimedDefinition(cmd, "fn_def");
        if (fnDef) {
            const env = new Map();
            for (const p of fnDef.params) {
                env.set(p.name, p.type);
                bindArrayExtentNames(env, p.type);
            }
            const ctx = { sig: fnSigs.get(fnDef.name) };
            for (const stmt of fnDef.body) {
                if (stmt.tag === "let") {
                    const t = inferExpr(stmt.expr, env, fnSigs, structDefs, diagnostics, typeMap, ctx);
                    applyLValueType(stmt.lvalue, t, env, fnSigs, structDefs, diagnostics, typeMap, ctx, "local");
                    continue;
                }
                if (stmt.tag === "ret") {
                    const t = inferExpr(stmt.expr, env, fnSigs, structDefs, diagnostics, typeMap, ctx);
                    if (!sameTypeShape(t, fnDef.retType)) {
                        diagnostics.push(nodeError(stmt, `ret type mismatch: expected ${renderType(fnDef.retType)}, got ${renderType(t)}`, "RET_TYPE"));
                    }
                    continue;
                }
                if (stmt.tag === "rad") {
                    const t = inferExpr(stmt.expr, env, fnSigs, structDefs, diagnostics, typeMap, ctx);
                    if (t.tag !== "int" && t.tag !== "float") {
                        diagnostics.push(nodeError(stmt, "rad expression must be int or float", "RAD_TYPE"));
                    }
                    continue;
                }
                if (stmt.tag === "gas") {
                    if (stmt.limit !== "inf" &&
                        (!Number.isInteger(stmt.limit) || stmt.limit < 0 || stmt.limit > 4294967296)) {
                        diagnostics.push(nodeError(stmt, "gas N requires an integer literal in [0, 2^32]", "GAS_LIT"));
                    }
                }
            }
            continue;
        }
        typecheckTopLevelCmd(cmd, globalEnv, fnSigs, structDefs, diagnostics, typeMap);
    }
    return { program, typeMap, diagnostics };
}
function collectFnSigs(program) {
    const out = new Map();
    for (const cmd of program.commands) {
        const definition = unwrapTimedDefinition(cmd, "fn_def");
        if (!definition) {
            continue;
        }
        if (definition.keyword === "ref" && out.has(definition.name)) {
            continue;
        }
        out.set(definition.name, {
            params: definition.params.map((p) => p.type),
            ret: definition.retType,
        });
    }
    return out;
}
function typecheckTopLevelCmd(cmd, env, fnSigs, structDefs, diagnostics, typeMap) {
    switch (cmd.tag) {
        case "let_cmd": {
            const t = inferExpr(cmd.expr, env, fnSigs, structDefs, diagnostics, typeMap, undefined);
            applyLValueType(cmd.lvalue, t, env, fnSigs, structDefs, diagnostics, typeMap, undefined, "top");
            return;
        }
        case "read_image":
            bindImageArgument(cmd.target, env, diagnostics);
            return;
        case "write_image": {
            const t = inferExpr(cmd.expr, env, fnSigs, structDefs, diagnostics, typeMap, undefined);
            if (!isWritableImageType(t)) {
                diagnostics.push(nodeError(cmd, `write image expects int[][] or int[][][], got ${renderType(t)}`, "IMAGE_TYPE"));
            }
            return;
        }
        case "show":
            inferExpr(cmd.expr, env, fnSigs, structDefs, diagnostics, typeMap, undefined);
            return;
        case "time":
            if (cmd.cmd.tag === "fn_def" || cmd.cmd.tag === "struct_def") {
                return;
            }
            typecheckTopLevelCmd(cmd.cmd, env, fnSigs, structDefs, diagnostics, typeMap);
            return;
        case "print":
            return;
        default: {
            const _never = cmd;
            return _never;
        }
    }
}
function applyLValueType(lvalue, exprType, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx, mode) {
    switch (lvalue.tag) {
        case "var":
            env.set(lvalue.name, exprType);
            return;
        case "field": {
            const baseType = env.get(lvalue.base);
            if (!baseType || baseType.tag !== "named") {
                diagnostics.push(nodeError(lvalue, `Field assignment requires a struct variable, got ${renderType(baseType ?? VOID_T)}`, "FIELD_BASE"));
                return;
            }
            const field = structDefs.get(baseType.name)?.find((candidate) => candidate.name === lvalue.field);
            if (!field) {
                diagnostics.push(nodeError(lvalue, `Struct '${baseType.name}' has no field '${lvalue.field}'`, "FIELD_UNKNOWN"));
                return;
            }
            if (!sameTypeShape(field.type, exprType)) {
                diagnostics.push(nodeError(lvalue, `Field assignment type mismatch: expected ${renderType(field.type)}, got ${renderType(exprType)}`, "FIELD_ASSIGN_TYPE"));
            }
            return;
        }
        case "tuple":
            diagnostics.push(nodeError(lvalue, mode === "top"
                ? "Tuple let bindings are only supported for read image targets"
                : "Tuple let bindings are not supported inside functions", "LHS_TUPLE"));
            return;
        default: {
            const _never = lvalue;
            return _never;
        }
    }
}
function bindImageArgument(argument, env, diagnostics) {
    const leaves = flattenArgument(argument);
    if (leaves.length === 1) {
        env.set(leaves[0], IMAGE_T);
        return;
    }
    if (leaves.length === 3) {
        env.set(leaves[0], INT_T);
        env.set(leaves[1], INT_T);
        env.set(leaves[2], IMAGE_T);
        return;
    }
    diagnostics.push(nodeError(argument, "read image target must bind either image or (width, height, image)", "IMAGE_TARGET"));
}
function flattenArgument(argument) {
    if (argument.tag === "var") {
        return [argument.name];
    }
    return argument.items.flatMap((item) => flattenArgument(item));
}
function collectStructDefs(program) {
    const out = new Map();
    for (const cmd of program.commands) {
        const definition = unwrapTimedDefinition(cmd, "struct_def");
        if (!definition) {
            continue;
        }
        out.set(definition.name, definition.fields);
    }
    return out;
}
function unwrapTimedDefinition(cmd, tag) {
    if (cmd.tag === tag) {
        return cmd;
    }
    if (cmd.tag === "time" && cmd.cmd.tag === tag) {
        return cmd.cmd;
    }
    return null;
}
function inferExpr(expr, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx) {
    let out = VOID_T;
    switch (expr.tag) {
        case "int_lit":
            out = INT_T;
            break;
        case "float_lit":
            out = FLOAT_T;
            break;
        case "void_lit":
            out = VOID_T;
            break;
        case "var":
            out = env.get(expr.name) ?? VOID_T;
            if (!env.has(expr.name)) {
                diagnostics.push(nodeError(expr, `Unbound variable '${expr.name}'`, "UNBOUND_VAR"));
            }
            break;
        case "res":
            out = fnCtx?.sig.ret ?? VOID_T;
            if (!fnCtx) {
                diagnostics.push(nodeError(expr, "res used outside function", "RES_TOP"));
            }
            break;
        case "rec":
            if (!fnCtx) {
                diagnostics.push(nodeError(expr, "rec used outside function", "REC_TOP"));
                out = VOID_T;
            }
            else {
                if (expr.args.length !== fnCtx.sig.params.length) {
                    diagnostics.push(nodeError(expr, `rec argument arity mismatch: expected ${fnCtx.sig.params.length}, got ${expr.args.length}`, "REC_ARITY"));
                }
                for (let i = 0; i < expr.args.length; i += 1) {
                    const actual = inferExpr(expr.args[i], env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
                    const expected = fnCtx.sig.params[i];
                    if (expected && !sameTypeShape(actual, expected)) {
                        diagnostics.push(nodeError(expr.args[i], `rec argument ${i + 1} type mismatch: expected ${renderType(expected)}, got ${renderType(actual)}`, "REC_ARG_TYPE"));
                    }
                }
                out = fnCtx.sig.ret;
            }
            break;
        case "unop": {
            const t = inferExpr(expr.operand, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
            if (!isNumericType(t)) {
                diagnostics.push(nodeError(expr, `Unary '-' requires numeric operand, got ${renderType(t)}`));
            }
            out = eraseScalarBounds(t);
            break;
        }
        case "binop": {
            const a = inferExpr(expr.left, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
            const b = inferExpr(expr.right, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
            if (!sameTypeShape(a, b)) {
                diagnostics.push(nodeError(expr, `Binary '${expr.op}' requires same-type operands, got ${renderType(a)} and ${renderType(b)}`, "BINOP_MISMATCH"));
            }
            else if (!isNumericType(a)) {
                diagnostics.push(nodeError(expr, `Binary '${expr.op}' requires numeric operands, got ${renderType(a)}`, "BINOP_NUM"));
            }
            out = eraseScalarBounds(a);
            break;
        }
        case "call":
            out = inferCall(expr, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
            break;
        case "index": {
            const arrayT = inferExpr(expr.array, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
            for (const idx of expr.indices) {
                const idxT = inferExpr(idx, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
                if (idxT.tag !== "int") {
                    diagnostics.push(nodeError(idx, "Array index must be int", "INDEX_TYPE"));
                }
            }
            if (arrayT.tag !== "array") {
                diagnostics.push(nodeError(expr, `Indexing requires array type, got ${renderType(arrayT)}`, "INDEX_BASE"));
                out = VOID_T;
            }
            else if (expr.indices.length > arrayT.dims) {
                diagnostics.push(nodeError(expr, "Too many indices for array rank", "INDEX_RANK"));
                out = arrayT.element;
            }
            else if (expr.indices.length === arrayT.dims) {
                out = arrayT.element;
            }
            else {
                out = {
                    tag: "array",
                    element: arrayT.element,
                    dims: arrayT.dims - expr.indices.length,
                    ...(sliceArrayExtentNames(arrayT, expr.indices.length) ? { extentNames: sliceArrayExtentNames(arrayT, expr.indices.length) } : {}),
                };
            }
            break;
        }
        case "field": {
            const targetType = inferExpr(expr.target, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
            if (targetType.tag !== "named") {
                diagnostics.push(nodeError(expr, `Field access requires a struct, got ${renderType(targetType)}`, "FIELD_BASE"));
                out = VOID_T;
                break;
            }
            const fields = structDefs.get(targetType.name);
            const field = fields?.find((candidate) => candidate.name === expr.field);
            if (!field) {
                diagnostics.push(nodeError(expr, `Struct '${targetType.name}' has no field '${expr.field}'`, "FIELD_UNKNOWN"));
                out = VOID_T;
                break;
            }
            out = field.type;
            break;
        }
        case "array_cons": {
            if (expr.elements.length === 0) {
                diagnostics.push(nodeError(expr, "Empty array literal is not allowed in v1", "ARRAY_EMPTY"));
                out = { tag: "array", element: VOID_T, dims: 1 };
            }
            else {
                const first = inferExpr(expr.elements[0], env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
                for (let i = 1; i < expr.elements.length; i += 1) {
                    const t = inferExpr(expr.elements[i], env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
                    if (!sameTypeShape(t, first)) {
                        diagnostics.push(nodeError(expr.elements[i], "Array literal elements must share one type", "ARRAY_HOMOGENEOUS"));
                    }
                }
                if (first.tag === "void") {
                    diagnostics.push(nodeError(expr.elements[0], "Array literal elements cannot be void", "ARRAY_ELEM_VOID"));
                }
                out = prependArrayDimension(eraseScalarBounds(first));
            }
            break;
        }
        case "struct_cons": {
            const fields = structDefs.get(expr.name);
            if (!fields) {
                diagnostics.push(nodeError(expr, `Unknown struct '${expr.name}'`, "STRUCT_UNKNOWN"));
                for (const f of expr.fields) {
                    inferExpr(f, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
                }
                out = VOID_T;
                break;
            }
            if (expr.fields.length !== fields.length) {
                diagnostics.push(nodeError(expr, `Struct '${expr.name}' expects ${fields.length} fields, got ${expr.fields.length}`, "STRUCT_ARITY"));
            }
            for (let i = 0; i < expr.fields.length; i += 1) {
                const actual = inferExpr(expr.fields[i], env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
                const expected = fields[i]?.type;
                if (expected && !sameTypeShape(actual, expected)) {
                    diagnostics.push(nodeError(expr.fields[i], `Struct '${expr.name}' field ${i + 1} type mismatch: expected ${renderType(expected)}, got ${renderType(actual)}`, "STRUCT_FIELD_TYPE"));
                }
            }
            out = { tag: "named", name: expr.name };
            break;
        }
        case "array_expr": {
            const bodyType = eraseScalarBounds(inferComprehensionBody(expr.bindings, expr.body, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx));
            if (bodyType.tag === "void") {
                diagnostics.push(nodeError(expr.body, "array body cannot be void", "ARRAY_BODY_VOID"));
            }
            out = addArrayDimensions(bodyType, expr.bindings.length);
            break;
        }
        case "sum_expr": {
            const bodyType = inferComprehensionBody(expr.bindings, expr.body, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
            if (!isNumericType(bodyType)) {
                diagnostics.push(nodeError(expr.body, `sum body must be numeric, got ${renderType(bodyType)}`, "SUM_TYPE"));
            }
            out = eraseScalarBounds(bodyType);
            break;
        }
        default: {
            const _never = expr;
            out = _never;
            break;
        }
    }
    typeMap.set(expr.id, out);
    return out;
}
function inferComprehensionBody(bindings, body, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx) {
    const localEnv = new Map(env);
    for (const binding of bindings) {
        const boundType = inferExpr(binding.expr, localEnv, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
        if (boundType.tag !== "int") {
            diagnostics.push(nodeError(binding.expr, "Comprehension bounds must be int", "BINDING_TYPE"));
        }
        else {
            const constValue = tryEvalConstInt(binding.expr);
            if (constValue !== null && constValue < 1) {
                diagnostics.push(nodeError(binding.expr, "const value clamped to 1", "CONST_BOUND_CLAMP"));
            }
        }
        localEnv.set(binding.name, INT_T);
    }
    return inferExpr(body, localEnv, fnSigs, structDefs, diagnostics, typeMap, fnCtx);
}
function inferCall(expr, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx) {
    const { name, args } = expr;
    const inferArgs = () => args.map((a) => inferExpr(a, env, fnSigs, structDefs, diagnostics, typeMap, fnCtx));
    if (name === "to_float") {
        const [a] = inferArgs();
        if (!a || a.tag !== "int" || args.length !== 1) {
            diagnostics.push(nodeError(expr, "to_float expects exactly one int argument", "BUILTIN_SIG"));
        }
        return FLOAT_T;
    }
    if (name === "to_int") {
        const [a] = inferArgs();
        if (!a || a.tag !== "float" || args.length !== 1) {
            diagnostics.push(nodeError(expr, "to_int expects exactly one float argument", "BUILTIN_SIG"));
        }
        return INT_T;
    }
    if (name === "max" || name === "min") {
        const ts = inferArgs();
        if (ts.length !== 2 || !ts[0] || !ts[1] || !sameTypeShape(ts[0], ts[1]) || !isNumericType(ts[0])) {
            diagnostics.push(nodeError(expr, `${name} expects two numeric arguments of the same type`, "BUILTIN_SIG"));
            return VOID_T;
        }
        return eraseScalarBounds(ts[0]);
    }
    if (name === "abs") {
        const [a] = inferArgs();
        if (!a || !isNumericType(a) || args.length !== 1) {
            diagnostics.push(nodeError(expr, "abs expects exactly one numeric argument", "BUILTIN_SIG"));
            return VOID_T;
        }
        return eraseScalarBounds(a);
    }
    if (name === "clamp") {
        const ts = inferArgs();
        if (ts.length !== 3 ||
            !ts[0] ||
            !ts[1] ||
            !ts[2] ||
            !sameTypeShape(ts[0], ts[1]) ||
            !sameTypeShape(ts[0], ts[2]) ||
            !isNumericType(ts[0])) {
            diagnostics.push(nodeError(expr, "clamp expects three numeric arguments of the same type", "BUILTIN_SIG"));
            return VOID_T;
        }
        return eraseScalarBounds(ts[0]);
    }
    if (name === "sqrt" ||
        name === "exp" ||
        name === "sin" ||
        name === "cos" ||
        name === "tan" ||
        name === "asin" ||
        name === "acos" ||
        name === "atan" ||
        name === "log") {
        const [a] = inferArgs();
        if (!a || a.tag !== "float" || args.length !== 1) {
            diagnostics.push(nodeError(expr, `${name} expects exactly one float argument`, "BUILTIN_SIG"));
        }
        return FLOAT_T;
    }
    if (name === "pow" || name === "atan2") {
        const ts = inferArgs();
        if (ts.length !== 2 || ts.some((t) => t.tag !== "float")) {
            diagnostics.push(nodeError(expr, `${name} expects exactly two float arguments`, "BUILTIN_SIG"));
        }
        return FLOAT_T;
    }
    const sig = fnSigs.get(name);
    const argTypes = inferArgs();
    if (!sig) {
        diagnostics.push(nodeError(expr, `Unknown function '${name}'`, "CALL_UNKNOWN"));
        return VOID_T;
    }
    if (argTypes.length !== sig.params.length) {
        diagnostics.push(nodeError(expr, `Function '${name}' expects ${sig.params.length} args, got ${argTypes.length}`, "CALL_ARITY"));
        return sig.ret;
    }
    for (let i = 0; i < argTypes.length; i += 1) {
        if (!sameTypeShape(argTypes[i], sig.params[i])) {
            diagnostics.push(nodeError(args[i], `Function '${name}' arg ${i + 1} type mismatch: expected ${renderType(sig.params[i])}, got ${renderType(argTypes[i])}`, "CALL_ARG_TYPE"));
        }
    }
    return eraseScalarBounds(sig.ret);
}
function tryEvalConstInt(expr) {
    switch (expr.tag) {
        case "int_lit":
            return saturateInt(expr.value);
        case "unop": {
            if (expr.op !== "-") {
                return null;
            }
            const operand = tryEvalConstInt(expr.operand);
            return operand === null ? null : saturateInt(-operand);
        }
        case "binop": {
            const left = tryEvalConstInt(expr.left);
            const right = tryEvalConstInt(expr.right);
            if (left === null || right === null) {
                return null;
            }
            switch (expr.op) {
                case "+":
                    return saturateInt(left + right);
                case "-":
                    return saturateInt(left - right);
                case "*":
                    return saturateInt(left * right);
                case "/":
                    return right === 0 ? 0 : saturateInt(Math.trunc(left / right));
                case "%":
                    return right === 0 ? 0 : saturateInt(left % right);
                default:
                    return null;
            }
        }
        case "call": {
            const args = expr.args.map((arg) => tryEvalConstInt(arg));
            if (args.some((arg) => arg === null)) {
                return null;
            }
            const values = args;
            if (expr.name === "max" && values.length === 2) {
                return Math.max(values[0], values[1]);
            }
            if (expr.name === "min" && values.length === 2) {
                return Math.min(values[0], values[1]);
            }
            if (expr.name === "abs" && values.length === 1) {
                return saturateInt(Math.abs(values[0]));
            }
            if (expr.name === "clamp" && values.length === 3) {
                return saturateInt(Math.max(values[1], Math.min(values[0], values[2])));
            }
            return null;
        }
        default:
            return null;
    }
}
function saturateInt(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(INT32_MIN, Math.min(INT32_MAX, Math.trunc(value)));
}
function prependArrayDimension(type) {
    if (type.tag === "array") {
        const extentNames = getArrayExtentNames(type);
        return {
            tag: "array",
            element: type.element,
            dims: type.dims + 1,
            ...(extentNames ? { extentNames: [null, ...extentNames] } : {}),
        };
    }
    return { tag: "array", element: type, dims: 1 };
}
function addArrayDimensions(type, dims) {
    if (type.tag === "array") {
        const extentNames = getArrayExtentNames(type);
        return {
            tag: "array",
            element: type.element,
            dims: type.dims + dims,
            ...(extentNames ? { extentNames: [...new Array(dims).fill(null), ...extentNames] } : {}),
        };
    }
    return {
        tag: "array",
        element: type,
        dims,
    };
}
function bindArrayExtentNames(env, type) {
    const extentNames = getArrayExtentNames(type);
    if (!extentNames) {
        return;
    }
    for (const extentName of extentNames) {
        if (extentName !== null) {
            env.set(extentName, INT_T);
        }
    }
}
function sliceArrayExtentNames(type, consumed) {
    const names = getArrayExtentNames(type);
    if (!names) {
        return undefined;
    }
    const sliced = names.slice(consumed);
    return sliced.some((name) => name !== null) ? sliced : undefined;
}
function isWritableImageType(type) {
    if (type.tag !== "array" || type.element.tag !== "int") {
        return false;
    }
    return type.dims === 2 || type.dims === 3;
}
function nodeError(node, message, code) {
    return error(message, node?.start ?? 0, node?.end ?? node?.start ?? 0, code);
}
//# sourceMappingURL=typecheck.js.map