import { checkSatAndGetValues, parseZ3Int, sanitizeSymbol as sanitize, } from "@jplmm/smt";
export function isSupportedIntBuiltin(name, arity) {
    if (name === "max" || name === "min") {
        return arity === 2;
    }
    if (name === "abs") {
        return arity === 1;
    }
    if (name === "clamp") {
        return arity === 3;
    }
    return false;
}
export function substituteIntExpr(expr, substitution) {
    switch (expr.tag) {
        case "int_lit":
            return expr;
        case "var":
            return substitution.get(expr.name) ?? expr;
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            return {
                tag: expr.tag,
                left: substituteIntExpr(expr.left, substitution),
                right: substituteIntExpr(expr.right, substitution),
            };
        case "sat_neg":
            return { tag: "sat_neg", operand: substituteIntExpr(expr.operand, substitution) };
        case "call":
            return {
                tag: "call",
                name: expr.name,
                args: expr.args.map((arg) => substituteIntExpr(arg, substitution)),
                interpreted: expr.interpreted,
            };
    }
}
export function substituteRecursiveExpr(expr, substitution) {
    switch (expr.tag) {
        case "int_lit":
            return expr;
        case "var":
            return substitution.get(expr.name) ?? expr;
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            return {
                tag: expr.tag,
                left: substituteRecursiveExpr(expr.left, substitution),
                right: substituteRecursiveExpr(expr.right, substitution),
            };
        case "sat_neg":
            return { tag: "sat_neg", operand: substituteRecursiveExpr(expr.operand, substitution) };
        case "call":
            return {
                tag: "call",
                name: expr.name,
                args: expr.args.map((arg) => substituteRecursiveExpr(arg, substitution)),
                interpreted: expr.interpreted,
            };
        case "rec":
            return {
                tag: "rec",
                args: expr.args.map((arg) => substituteIntExpr(arg, new Map([...substitution.entries()].map(([name, value]) => [name, asPlainIntExpr(value) ?? { tag: "var", name }])))),
                currentRes: substituteRecursiveExpr(expr.currentRes, substitution),
            };
    }
}
export function asPlainIntExpr(expr) {
    switch (expr.tag) {
        case "int_lit":
        case "var":
            return expr;
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod": {
            const left = asPlainIntExpr(expr.left);
            const right = asPlainIntExpr(expr.right);
            if (!left || !right) {
                return null;
            }
            return { tag: expr.tag, left, right };
        }
        case "sat_neg": {
            const operand = asPlainIntExpr(expr.operand);
            return operand ? { tag: "sat_neg", operand } : null;
        }
        case "call":
            {
                const args = expr.args.map((arg) => asPlainIntExpr(arg));
                if (args.some((arg) => arg === null)) {
                    return null;
                }
                return {
                    tag: "call",
                    name: expr.name,
                    args: args,
                    interpreted: expr.interpreted,
                };
            }
        case "rec":
            return null;
    }
}
export function emitIntExpr(expr) {
    switch (expr.tag) {
        case "int_lit":
            return `${expr.value}`;
        case "var":
            return sanitize(expr.name);
        case "sat_add":
            return `(sat_add_int ${emitIntExpr(expr.left)} ${emitIntExpr(expr.right)})`;
        case "sat_sub":
            return `(sat_sub_int ${emitIntExpr(expr.left)} ${emitIntExpr(expr.right)})`;
        case "sat_mul":
            return `(sat_mul_int ${emitIntExpr(expr.left)} ${emitIntExpr(expr.right)})`;
        case "sat_neg":
            return `(sat_neg_int ${emitIntExpr(expr.operand)})`;
        case "total_div":
            return `(total_div_int ${emitIntExpr(expr.left)} ${emitIntExpr(expr.right)})`;
        case "total_mod":
            return `(total_mod_int ${emitIntExpr(expr.left)} ${emitIntExpr(expr.right)})`;
        case "call": {
            const args = expr.args.map((arg) => emitIntExpr(arg)).join(" ");
            if (!expr.interpreted) {
                return `(${sanitize(expr.name)} ${args})`;
            }
            switch (expr.name) {
                case "max":
                    return `(max_int ${args})`;
                case "min":
                    return `(min_int ${args})`;
                case "abs":
                    return `(abs_int ${args})`;
                case "clamp":
                    return `(clamp_range_int ${args})`;
                default:
                    return `(${sanitize(expr.name)} ${args})`;
            }
        }
    }
}
export function emitCollapseCondition(args, paramNames) {
    if (args.length === 0) {
        return "true";
    }
    if (args.length !== paramNames.length) {
        throw new Error("Recursive proof expected argument arity to match the enclosing function arity");
    }
    return `(and ${args.map((arg, index) => `(= ${emitIntExpr(arg)} ${sanitize(paramNames[index])} )`).join(" ")})`
        .replaceAll(" )", ")");
}
export function renderIntExpr(expr) {
    switch (expr.tag) {
        case "int_lit":
            return `${expr.value}`;
        case "var":
            return expr.name;
        case "sat_add":
            return `(${renderIntExpr(expr.left)} + ${renderIntExpr(expr.right)})`;
        case "sat_sub":
            return `(${renderIntExpr(expr.left)} - ${renderIntExpr(expr.right)})`;
        case "sat_mul":
            return `(${renderIntExpr(expr.left)} * ${renderIntExpr(expr.right)})`;
        case "sat_neg":
            return `(-${renderIntExpr(expr.operand)})`;
        case "total_div":
            return `total_div(${renderIntExpr(expr.left)}, ${renderIntExpr(expr.right)})`;
        case "total_mod":
            return `total_mod(${renderIntExpr(expr.left)}, ${renderIntExpr(expr.right)})`;
        case "call":
            return `${expr.name}(${expr.args.map((arg) => renderIntExpr(arg)).join(", ")})`;
    }
}
export function collectRecursiveSites(expr) {
    const out = [];
    function visit(node) {
        switch (node.tag) {
            case "rec":
                out.push({ args: node.args });
                visit(node.currentRes);
                return;
            case "sat_add":
            case "sat_sub":
            case "sat_mul":
            case "total_div":
            case "total_mod":
                visit(node.left);
                visit(node.right);
                return;
            case "sat_neg":
                visit(node.operand);
                return;
            case "call":
                for (const arg of node.args) {
                    visit(arg);
                }
                return;
            default:
                return;
        }
    }
    visit(expr);
    return out;
}
export function collectRecursiveCallPatterns(expr, patterns) {
    switch (expr.tag) {
        case "rec": {
            const key = serializeRecArgs(expr.args);
            if (!patterns.has(key)) {
                patterns.set(key, expr.args);
            }
            collectRecursiveCallPatterns(expr.currentRes, patterns);
            return;
        }
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            collectRecursiveCallPatterns(expr.left, patterns);
            collectRecursiveCallPatterns(expr.right, patterns);
            return;
        case "sat_neg":
            collectRecursiveCallPatterns(expr.operand, patterns);
            return;
        case "call":
            for (const arg of expr.args) {
                collectRecursiveCallPatterns(arg, patterns);
            }
            return;
        default:
            return;
    }
}
export function collectCallsRecursive(expr, calls) {
    switch (expr.tag) {
        case "call":
            if (!expr.interpreted) {
                calls.set(expr.name, expr.args.length);
            }
            for (const arg of expr.args) {
                collectCallsRecursive(arg, calls);
            }
            return;
        case "rec":
            for (const arg of expr.args) {
                collectCalls(arg, calls);
            }
            collectCallsRecursive(expr.currentRes, calls);
            return;
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            collectCallsRecursive(expr.left, calls);
            collectCallsRecursive(expr.right, calls);
            return;
        case "sat_neg":
            collectCallsRecursive(expr.operand, calls);
            return;
        default:
            return;
    }
}
export function serializeRecArgs(args) {
    return args.map((arg) => emitIntExpr(arg)).join("||");
}
export function uniqueExprs(exprs) {
    const out = [];
    const seen = new Set();
    for (const expr of exprs) {
        const key = emitIntExpr(expr);
        if (!seen.has(key)) {
            seen.add(key);
            out.push(expr);
        }
    }
    return out;
}
export function collectSummaryVars(baselineParamNames, baselineExpr, refinedExpr) {
    const vars = new Set();
    for (const name of baselineParamNames) {
        vars.add(name);
    }
    collectExprVars(baselineExpr, vars);
    collectExprVars(refinedExpr, vars);
    return [...vars];
}
export function collectExprVars(expr, vars) {
    switch (expr.tag) {
        case "var":
            vars.add(expr.name);
            return;
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            collectExprVars(expr.left, vars);
            collectExprVars(expr.right, vars);
            return;
        case "sat_neg":
            collectExprVars(expr.operand, vars);
            return;
        case "call":
            for (const arg of expr.args) {
                collectExprVars(arg, vars);
            }
            return;
        default:
            return;
    }
}
export function collectCalls(expr, calls) {
    switch (expr.tag) {
        case "call":
            if (!expr.interpreted) {
                calls.set(expr.name, expr.args.length);
            }
            for (const arg of expr.args) {
                collectCalls(arg, calls);
            }
            return;
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            collectCalls(expr.left, calls);
            collectCalls(expr.right, calls);
            return;
        case "sat_neg":
            collectCalls(expr.operand, calls);
            return;
        default:
            return;
    }
}
export function queryIntCounterexample(lines, vars) {
    if (vars.length === 0) {
        return null;
    }
    const result = checkSatAndGetValues(lines, vars.map((name) => sanitize(name)));
    if (!result.ok || result.status !== "sat" || !result.values) {
        return null;
    }
    const values = result.values;
    const assignments = vars.map((name) => `${name} = ${values.get(sanitize(name)) ?? "?"}`);
    return assignments.length > 0 ? `counterexample: ${assignments.join(", ")}` : null;
}
export function queryIntValues(lines, vars) {
    const result = checkSatAndGetValues(lines, vars.map((name) => sanitize(name)));
    if (!result.ok || result.status !== "sat" || !result.values) {
        return null;
    }
    const values = result.values;
    const parsed = new Map();
    for (const name of vars) {
        const raw = values.get(sanitize(name));
        const value = raw ? parseZ3Int(raw) : null;
        if (value === null) {
            return null;
        }
        parsed.set(name, value);
    }
    return parsed;
}
export function formatIntAssignments(names, values) {
    const assignments = names.map((name) => `${name} = ${values.get(name) ?? "?"}`);
    return assignments.length > 0 ? assignments.join(", ") : null;
}
//# sourceMappingURL=int.js.map