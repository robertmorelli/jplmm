import { error } from "./errors";
const INT_T = { tag: "int" };
const FLOAT_T = { tag: "float" };
const VOID_T = { tag: "void" };
export function typecheckProgram(program) {
    const diagnostics = [];
    const typeMap = new Map();
    const fnSigs = collectFnSigs(program);
    const globalEnv = new Map();
    for (const cmd of program.commands) {
        if (cmd.tag === "fn_def") {
            const env = new Map();
            for (const p of cmd.params) {
                env.set(p.name, p.type);
            }
            const ctx = { sig: fnSigs.get(cmd.name) };
            for (const stmt of cmd.body) {
                if (stmt.tag === "let") {
                    const t = inferExpr(stmt.expr, env, fnSigs, diagnostics, typeMap, ctx);
                    if (stmt.lvalue.tag === "var") {
                        env.set(stmt.lvalue.name, t);
                    }
                    else {
                        diagnostics.push(error("Only simple variable lvalues are supported in v1", 0, 0, "LHS_V1"));
                    }
                    continue;
                }
                if (stmt.tag === "ret") {
                    const t = inferExpr(stmt.expr, env, fnSigs, diagnostics, typeMap, ctx);
                    if (!sameType(t, cmd.retType)) {
                        diagnostics.push(error(`ret type mismatch: expected ${typeToString(cmd.retType)}, got ${typeToString(t)}`, 0, 0, "RET_TYPE"));
                    }
                    continue;
                }
                if (stmt.tag === "rad") {
                    const t = inferExpr(stmt.expr, env, fnSigs, diagnostics, typeMap, ctx);
                    if (t.tag !== "int" && t.tag !== "float") {
                        diagnostics.push(error("rad expression must be int or float", 0, 0, "RAD_TYPE"));
                    }
                    continue;
                }
                if (stmt.tag === "gas") {
                    if (stmt.limit !== "inf" && (!Number.isInteger(stmt.limit) || stmt.limit < 0)) {
                        diagnostics.push(error("gas N requires a non-negative integer literal", 0, 0, "GAS_LIT"));
                    }
                }
            }
            continue;
        }
        if (cmd.tag === "let_cmd") {
            const t = inferExpr(cmd.expr, globalEnv, fnSigs, diagnostics, typeMap, undefined);
            if (cmd.lvalue.tag === "var") {
                globalEnv.set(cmd.lvalue.name, t);
            }
            else {
                diagnostics.push(error("Only simple variable lvalues are supported in v1", 0, 0, "LHS_V1"));
            }
            continue;
        }
    }
    return { program, typeMap, diagnostics };
}
function collectFnSigs(program) {
    const out = new Map();
    for (const cmd of program.commands) {
        if (cmd.tag === "fn_def") {
            out.set(cmd.name, {
                params: cmd.params.map((p) => p.type),
                ret: cmd.retType,
            });
        }
    }
    return out;
}
function inferExpr(expr, env, fnSigs, diagnostics, typeMap, fnCtx) {
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
                diagnostics.push(error(`Unbound variable '${expr.name}'`, 0, 0, "UNBOUND_VAR"));
            }
            break;
        case "res":
            out = fnCtx?.sig.ret ?? VOID_T;
            if (!fnCtx) {
                diagnostics.push(error("res used outside function", 0, 0, "RES_TOP"));
            }
            break;
        case "rec":
            if (!fnCtx) {
                diagnostics.push(error("rec used outside function", 0, 0, "REC_TOP"));
                out = VOID_T;
            }
            else {
                if (expr.args.length !== fnCtx.sig.params.length) {
                    diagnostics.push(error(`rec argument arity mismatch: expected ${fnCtx.sig.params.length}, got ${expr.args.length}`, 0, 0, "REC_ARITY"));
                }
                for (let i = 0; i < expr.args.length; i += 1) {
                    const actual = inferExpr(expr.args[i], env, fnSigs, diagnostics, typeMap, fnCtx);
                    const expected = fnCtx.sig.params[i];
                    if (expected && !sameType(actual, expected)) {
                        diagnostics.push(error(`rec argument ${i + 1} type mismatch: expected ${typeToString(expected)}, got ${typeToString(actual)}`, 0, 0, "REC_ARG_TYPE"));
                    }
                }
                out = fnCtx.sig.ret;
            }
            break;
        case "unop": {
            const t = inferExpr(expr.operand, env, fnSigs, diagnostics, typeMap, fnCtx);
            if (!isNumeric(t)) {
                diagnostics.push(error(`Unary '-' requires numeric operand, got ${typeToString(t)}`, 0, 0));
            }
            out = t;
            break;
        }
        case "binop": {
            const a = inferExpr(expr.left, env, fnSigs, diagnostics, typeMap, fnCtx);
            const b = inferExpr(expr.right, env, fnSigs, diagnostics, typeMap, fnCtx);
            if (!sameType(a, b)) {
                diagnostics.push(error(`Binary '${expr.op}' requires same-type operands, got ${typeToString(a)} and ${typeToString(b)}`, 0, 0, "BINOP_MISMATCH"));
            }
            else if (!isNumeric(a)) {
                diagnostics.push(error(`Binary '${expr.op}' requires numeric operands, got ${typeToString(a)}`, 0, 0, "BINOP_NUM"));
            }
            out = a;
            break;
        }
        case "call":
            out = inferCall(expr.name, expr.args, env, fnSigs, diagnostics, typeMap, fnCtx);
            break;
        case "index": {
            const arrayT = inferExpr(expr.array, env, fnSigs, diagnostics, typeMap, fnCtx);
            for (const idx of expr.indices) {
                const idxT = inferExpr(idx, env, fnSigs, diagnostics, typeMap, fnCtx);
                if (idxT.tag !== "int") {
                    diagnostics.push(error("Array index must be int", 0, 0, "INDEX_TYPE"));
                }
            }
            if (arrayT.tag !== "array") {
                diagnostics.push(error(`Indexing requires array type, got ${typeToString(arrayT)}`, 0, 0, "INDEX_BASE"));
                out = VOID_T;
            }
            else if (expr.indices.length > arrayT.dims) {
                diagnostics.push(error("Too many indices for array rank", 0, 0, "INDEX_RANK"));
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
                };
            }
            break;
        }
        case "field":
            diagnostics.push(error("Struct field typing is not implemented in v1", 0, 0, "FIELD_NYI"));
            inferExpr(expr.target, env, fnSigs, diagnostics, typeMap, fnCtx);
            out = VOID_T;
            break;
        case "array_cons": {
            if (expr.elements.length === 0) {
                diagnostics.push(error("Empty array literal is not allowed in v1", 0, 0, "ARRAY_EMPTY"));
                out = { tag: "array", element: VOID_T, dims: 1 };
            }
            else {
                const first = inferExpr(expr.elements[0], env, fnSigs, diagnostics, typeMap, fnCtx);
                for (let i = 1; i < expr.elements.length; i += 1) {
                    const t = inferExpr(expr.elements[i], env, fnSigs, diagnostics, typeMap, fnCtx);
                    if (!sameType(t, first)) {
                        diagnostics.push(error("Array literal elements must share one type", 0, 0, "ARRAY_HOMOGENEOUS"));
                    }
                }
                out = { tag: "array", element: first, dims: 1 };
            }
            break;
        }
        case "struct_cons":
            diagnostics.push(error("Struct constructor typing is not implemented in v1", 0, 0, "STRUCT_NYI"));
            for (const f of expr.fields) {
                inferExpr(f, env, fnSigs, diagnostics, typeMap, fnCtx);
            }
            out = VOID_T;
            break;
        case "array_expr":
        case "sum_expr":
            diagnostics.push(error(`${expr.tag} typing is not implemented in v1`, 0, 0, "NYI_V1"));
            out = VOID_T;
            break;
        default: {
            const _never = expr;
            out = _never;
            break;
        }
    }
    typeMap.set(expr.id, out);
    return out;
}
function inferCall(name, args, env, fnSigs, diagnostics, typeMap, fnCtx) {
    const inferArgs = () => args.map((a) => inferExpr(a, env, fnSigs, diagnostics, typeMap, fnCtx));
    if (name === "to_float") {
        const [a] = inferArgs();
        if (!a || a.tag !== "int" || args.length !== 1) {
            diagnostics.push(error("to_float expects exactly one int argument", 0, 0, "BUILTIN_SIG"));
        }
        return FLOAT_T;
    }
    if (name === "to_int") {
        const [a] = inferArgs();
        if (!a || a.tag !== "float" || args.length !== 1) {
            diagnostics.push(error("to_int expects exactly one float argument", 0, 0, "BUILTIN_SIG"));
        }
        return INT_T;
    }
    if (name === "max" || name === "min") {
        const ts = inferArgs();
        if (ts.length !== 2 || !ts[0] || !ts[1] || !sameType(ts[0], ts[1]) || !isNumeric(ts[0])) {
            diagnostics.push(error(`${name} expects two numeric arguments of the same type`, 0, 0, "BUILTIN_SIG"));
            return VOID_T;
        }
        return ts[0];
    }
    if (name === "abs") {
        const [a] = inferArgs();
        if (!a || !isNumeric(a) || args.length !== 1) {
            diagnostics.push(error("abs expects exactly one numeric argument", 0, 0, "BUILTIN_SIG"));
            return VOID_T;
        }
        return a;
    }
    if (name === "clamp") {
        const ts = inferArgs();
        if (ts.length !== 3 ||
            !ts[0] ||
            !ts[1] ||
            !ts[2] ||
            !sameType(ts[0], ts[1]) ||
            !sameType(ts[0], ts[2]) ||
            !isNumeric(ts[0])) {
            diagnostics.push(error("clamp expects three numeric arguments of the same type", 0, 0, "BUILTIN_SIG"));
            return VOID_T;
        }
        return ts[0];
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
            diagnostics.push(error(`${name} expects exactly one float argument`, 0, 0, "BUILTIN_SIG"));
        }
        return FLOAT_T;
    }
    if (name === "pow" || name === "atan2") {
        const ts = inferArgs();
        if (ts.length !== 2 || ts.some((t) => t.tag !== "float")) {
            diagnostics.push(error(`${name} expects exactly two float arguments`, 0, 0, "BUILTIN_SIG"));
        }
        return FLOAT_T;
    }
    const sig = fnSigs.get(name);
    const argTypes = inferArgs();
    if (!sig) {
        diagnostics.push(error(`Unknown function '${name}'`, 0, 0, "CALL_UNKNOWN"));
        return VOID_T;
    }
    if (argTypes.length !== sig.params.length) {
        diagnostics.push(error(`Function '${name}' expects ${sig.params.length} args, got ${argTypes.length}`, 0, 0, "CALL_ARITY"));
        return sig.ret;
    }
    for (let i = 0; i < argTypes.length; i += 1) {
        if (!sameType(argTypes[i], sig.params[i])) {
            diagnostics.push(error(`Function '${name}' arg ${i + 1} type mismatch: expected ${typeToString(sig.params[i])}, got ${typeToString(argTypes[i])}`, 0, 0, "CALL_ARG_TYPE"));
        }
    }
    return sig.ret;
}
function isNumeric(t) {
    return t.tag === "int" || t.tag === "float";
}
function sameType(a, b) {
    if (a.tag !== b.tag) {
        return false;
    }
    if (a.tag === "array" && b.tag === "array") {
        return a.dims === b.dims && sameType(a.element, b.element);
    }
    if (a.tag === "named" && b.tag === "named") {
        return a.name === b.name;
    }
    return true;
}
function typeToString(t) {
    switch (t.tag) {
        case "int":
        case "float":
        case "void":
            return t.tag;
        case "named":
            return t.name;
        case "array":
            return `${typeToString(t.element)}${"[]".repeat(t.dims)}`;
        default: {
            const _never = t;
            return `${_never}`;
        }
    }
}
//# sourceMappingURL=typecheck.js.map