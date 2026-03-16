import { unwrapTimedDefinition } from "@jplmm/ast";
export function analyzeProgramMetrics(program) {
    const metrics = new Map();
    const structDefs = collectStructDefs(program);
    for (const cmd of program.commands) {
        const fn = unwrapTimedDefinition(cmd, "fn_def");
        if (!fn) {
            continue;
        }
        const recSites = countRecSitesInFunction(fn.body);
        metrics.set(fn.name, {
            sourceComplexity: 1 + recSites,
            recSites,
            canonicalWitness: `${fn.name}(${fn.params.map((param) => renderCanonicalValue(param.type, structDefs)).join(", ")})`,
            coarseTotalCallBound: renderCoarseTotalCallBound(fn.body, recSites),
        });
    }
    return metrics;
}
function countRecSitesInFunction(body) {
    let total = 0;
    for (const stmt of body) {
        switch (stmt.tag) {
            case "let":
            case "ret":
            case "rad":
                total += countRecSitesInExpr(stmt.expr);
                break;
            case "gas":
                break;
            default: {
                const _never = stmt;
                void _never;
            }
        }
    }
    return total;
}
function countRecSitesInExpr(expr) {
    switch (expr.tag) {
        case "rec":
            return 1 + expr.args.reduce((sum, arg) => sum + countRecSitesInExpr(arg), 0);
        case "binop":
            return countRecSitesInExpr(expr.left) + countRecSitesInExpr(expr.right);
        case "unop":
            return countRecSitesInExpr(expr.operand);
        case "call":
            return expr.args.reduce((sum, arg) => sum + countRecSitesInExpr(arg), 0);
        case "index":
            return countRecSitesInExpr(expr.array) + expr.indices.reduce((sum, arg) => sum + countRecSitesInExpr(arg), 0);
        case "field":
            return countRecSitesInExpr(expr.target);
        case "struct_cons":
            return expr.fields.reduce((sum, arg) => sum + countRecSitesInExpr(arg), 0);
        case "array_cons":
            return expr.elements.reduce((sum, arg) => sum + countRecSitesInExpr(arg), 0);
        case "array_expr":
        case "sum_expr":
            return expr.bindings.reduce((sum, binding) => sum + countRecSitesInExpr(binding.expr), 0) + countRecSitesInExpr(expr.body);
        case "int_lit":
        case "float_lit":
        case "void_lit":
        case "var":
        case "res":
            return 0;
        default: {
            const _never = expr;
            return _never;
        }
    }
}
function renderCanonicalValue(type, structDefs) {
    switch (type.tag) {
        case "int":
            return "0";
        case "float":
            return "0.0";
        case "void":
            return "void";
        case "array":
            return renderMinimalArray(type.element, type.dims, structDefs);
        case "named": {
            const fields = structDefs.get(type.name) ?? [];
            return `${type.name} { ${fields.map((field) => renderCanonicalValue(field.type, structDefs)).join(", ")} }`;
        }
        default: {
            const _never = type;
            return _never;
        }
    }
}
function renderMinimalArray(element, dims, structDefs) {
    const inner = dims === 1
        ? renderCanonicalValue(element, structDefs)
        : renderMinimalArray(element, dims - 1, structDefs);
    return `[${inner}]`;
}
function collectStructDefs(program) {
    const structs = new Map();
    for (const cmd of program.commands) {
        const struct = unwrapTimedDefinition(cmd, "struct_def");
        if (struct) {
            structs.set(struct.name, struct.fields);
        }
    }
    return structs;
}
function renderCoarseTotalCallBound(body, recSites) {
    if (recSites === 0) {
        return "1";
    }
    const gasStmt = body.find((stmt) => stmt.tag === "gas");
    if (gasStmt) {
        if (gasStmt.limit === "inf") {
            return "unbounded (gas inf)";
        }
        return renderBranchingSeries(recSites, String(gasStmt.limit));
    }
    const hasRad = body.some((stmt) => stmt.tag === "rad");
    if (hasRad) {
        return renderBranchingSeries(recSites, "2^32");
    }
    return "unknown (no rad/gas)";
}
function renderBranchingSeries(recSites, depth) {
    if (recSites <= 1) {
        return `${depth} + 1`;
    }
    return `sum_{i=0..${depth}} ${recSites}^i`;
}
//# sourceMappingURL=metrics.js.map