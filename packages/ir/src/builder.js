import { FLOAT_T, INT_T, VOID_T } from "./types";
export function buildIR(program, typeMap) {
    const fnSigs = collectFnSigs(program);
    const functions = [];
    const globals = [];
    const globalEnv = new Map();
    for (const cmd of program.commands) {
        if (cmd.tag === "fn_def") {
            functions.push(lowerFunction(cmd, fnSigs, typeMap));
            continue;
        }
        if (cmd.tag === "let_cmd") {
            if (cmd.lvalue.tag !== "var") {
                continue;
            }
            const lowered = lowerExpr(cmd.expr, {
                env: globalEnv,
                fnRetType: VOID_T,
                fnSigs,
                typeMap,
            }, false);
            globalEnv.set(cmd.lvalue.name, lowered.resultType);
            globals.push({
                tag: "let_cmd",
                name: cmd.lvalue.name,
                expr: lowered,
                id: cmd.id,
            });
        }
    }
    return { functions, globals };
}
function collectFnSigs(program) {
    const out = new Map();
    for (const cmd of program.commands) {
        if (cmd.tag !== "fn_def") {
            continue;
        }
        out.set(cmd.name, {
            params: cmd.params.map((p) => p.type),
            ret: cmd.retType,
        });
    }
    return out;
}
function lowerFunction(cmd, fnSigs, typeMap) {
    const env = new Map();
    for (const p of cmd.params) {
        env.set(p.name, p.type);
    }
    const ctx = {
        env,
        fnRetType: cmd.retType,
        fnSigs,
        typeMap,
    };
    const body = cmd.body
        .map((stmt) => lowerStmt(stmt, ctx))
        .filter((s) => s !== null);
    return {
        name: cmd.name,
        params: cmd.params,
        retType: cmd.retType,
        body,
        id: cmd.id,
    };
}
function lowerStmt(stmt, ctx) {
    if (stmt.tag === "let") {
        if (stmt.lvalue.tag !== "var") {
            return null;
        }
        const expr = lowerExpr(stmt.expr, ctx, false);
        ctx.env.set(stmt.lvalue.name, expr.resultType);
        return { tag: "let", name: stmt.lvalue.name, expr, id: stmt.id };
    }
    if (stmt.tag === "ret") {
        return { tag: "ret", expr: lowerExpr(stmt.expr, ctx, true), id: stmt.id };
    }
    if (stmt.tag === "rad") {
        return { tag: "rad", expr: lowerExpr(stmt.expr, ctx, false), id: stmt.id };
    }
    if (stmt.tag === "gas") {
        return { tag: "gas", limit: stmt.limit, id: stmt.id };
    }
    return null;
}
function lowerExpr(expr, ctx, isTailPosition) {
    switch (expr.tag) {
        case "int_lit":
            return {
                tag: "int_lit",
                value: expr.value,
                id: expr.id,
                resultType: getType(expr.id, ctx, INT_T),
            };
        case "float_lit":
            return {
                tag: "float_lit",
                value: expr.value,
                id: expr.id,
                resultType: getType(expr.id, ctx, FLOAT_T),
            };
        case "void_lit":
            return {
                tag: "void_lit",
                id: expr.id,
                resultType: getType(expr.id, ctx, VOID_T),
            };
        case "var":
            return {
                tag: "var",
                name: expr.name,
                id: expr.id,
                resultType: getType(expr.id, ctx, ctx.env.get(expr.name) ?? VOID_T),
            };
        case "res":
            return {
                tag: "res",
                id: expr.id,
                resultType: getType(expr.id, ctx, ctx.fnRetType),
            };
        case "rec":
            return {
                tag: "rec",
                args: expr.args.map((a) => lowerExpr(a, ctx, false)),
                id: expr.id,
                resultType: getType(expr.id, ctx, ctx.fnRetType),
                tailPosition: isTailPosition,
            };
        case "binop": {
            const left = lowerExpr(expr.left, ctx, false);
            const right = lowerExpr(expr.right, ctx, false);
            const fallback = inferBinopType(expr.op, left.resultType, right.resultType);
            return {
                tag: "binop",
                op: expr.op,
                left,
                right,
                id: expr.id,
                resultType: getType(expr.id, ctx, fallback),
            };
        }
        case "unop": {
            const operand = lowerExpr(expr.operand, ctx, false);
            return {
                tag: "unop",
                op: expr.op,
                operand,
                id: expr.id,
                resultType: getType(expr.id, ctx, operand.resultType),
            };
        }
        case "call": {
            const args = expr.args.map((a) => lowerExpr(a, ctx, false));
            const fallback = inferCallType(expr.name, args.map((a) => a.resultType), ctx);
            return {
                tag: "call",
                name: expr.name,
                args,
                id: expr.id,
                resultType: getType(expr.id, ctx, fallback),
            };
        }
        case "index": {
            const array = lowerExpr(expr.array, ctx, false);
            const indices = expr.indices.map((i) => lowerExpr(i, ctx, false));
            const fallback = array.resultType.tag === "array"
                ? indices.length >= array.resultType.dims
                    ? array.resultType.element
                    : {
                        tag: "array",
                        element: array.resultType.element,
                        dims: array.resultType.dims - indices.length,
                    }
                : VOID_T;
            return {
                tag: "index",
                array,
                indices,
                id: expr.id,
                resultType: getType(expr.id, ctx, fallback),
            };
        }
        case "field":
            return {
                tag: "field",
                target: lowerExpr(expr.target, ctx, false),
                field: expr.field,
                id: expr.id,
                resultType: getType(expr.id, ctx, VOID_T),
            };
        case "struct_cons":
            return {
                tag: "struct_cons",
                name: expr.name,
                fields: expr.fields.map((f) => lowerExpr(f, ctx, false)),
                id: expr.id,
                resultType: getType(expr.id, ctx, { tag: "named", name: expr.name }),
            };
        case "array_cons": {
            const elements = expr.elements.map((e) => lowerExpr(e, ctx, false));
            const elemType = elements[0]?.resultType ?? VOID_T;
            return {
                tag: "array_cons",
                elements,
                id: expr.id,
                resultType: getType(expr.id, ctx, { tag: "array", element: elemType, dims: 1 }),
            };
        }
        case "array_expr":
        case "sum_expr": {
            const bindings = expr.bindings.map((b) => ({
                name: b.name,
                expr: lowerExpr(b.expr, ctx, false),
            }));
            const body = lowerExpr(expr.body, ctx, false);
            return {
                tag: expr.tag,
                bindings,
                body,
                id: expr.id,
                resultType: getType(expr.id, ctx, body.resultType),
            };
        }
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function getType(id, ctx, fallback) {
    return ctx.typeMap?.get(id) ?? fallback;
}
function inferBinopType(op, left, right) {
    if (op === "%" || op === "/" || op === "+" || op === "-" || op === "*") {
        if (left.tag === "float" || right.tag === "float") {
            return FLOAT_T;
        }
        if (left.tag === "int" && right.tag === "int") {
            return INT_T;
        }
    }
    return left.tag === "void" ? right : left;
}
function inferCallType(name, argTypes, ctx) {
    if (name === "sqrt" ||
        name === "exp" ||
        name === "sin" ||
        name === "cos" ||
        name === "tan" ||
        name === "asin" ||
        name === "acos" ||
        name === "atan" ||
        name === "log" ||
        name === "pow" ||
        name === "atan2" ||
        name === "to_float") {
        return FLOAT_T;
    }
    if (name === "to_int") {
        return INT_T;
    }
    if (name === "max" || name === "min" || name === "abs" || name === "clamp") {
        return argTypes[0] ?? VOID_T;
    }
    return ctx.fnSigs.get(name)?.ret ?? VOID_T;
}
//# sourceMappingURL=builder.js.map