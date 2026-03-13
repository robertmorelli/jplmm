import { INT32_MAX, INT32_MIN, buildJplScalarPrelude, checkSatAndGetValues, sanitizeSymbol as sanitize, } from "@jplmm/smt";
let arrayEqCounter = 0;
export function scalarTag(type) {
    if (!type) {
        return null;
    }
    if (type.tag === "int" || type.tag === "float") {
        return type.tag;
    }
    return null;
}
export function sameType(left, right) {
    if (left.tag !== right.tag) {
        return false;
    }
    if (left.tag === "array" && right.tag === "array") {
        return left.dims === right.dims && sameType(left.element, right.element);
    }
    if (left.tag === "named" && right.tag === "named") {
        return left.name === right.name;
    }
    return true;
}
export function arrayLeafType(type) {
    return type.tag === "array" ? type.element : type;
}
export function scalarExprType(expr) {
    switch (expr.tag) {
        case "int_lit":
            return "int";
        case "float_lit":
            return "float";
        case "sum":
        case "select":
            return expr.valueType;
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "sat_neg":
            return "int";
        case "nan_to_zero":
            return scalarExprType(expr.value);
        case "positive_extent":
        case "clamp_index":
            return "int";
        default:
            return expr.valueType;
    }
}
export function isInterpretedCall(name, arity) {
    if (name === "max" || name === "min") {
        return arity === 2;
    }
    if (name === "abs" || name === "to_float" || name === "to_int") {
        return arity === 1;
    }
    if (name === "clamp") {
        return arity === 3;
    }
    return false;
}
export function canEncodeScalarExprWithSmt(expr) {
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
        case "var":
            return true;
        case "unop":
            return canEncodeScalarExprWithSmt(expr.operand);
        case "binop":
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            return canEncodeScalarExprWithSmt(expr.left) && canEncodeScalarExprWithSmt(expr.right);
        case "sat_neg":
            return canEncodeScalarExprWithSmt(expr.operand);
        case "nan_to_zero":
            return canEncodeScalarExprWithSmt(expr.value);
        case "positive_extent":
            return canEncodeScalarExprWithSmt(expr.value);
        case "clamp_index":
            return canEncodeScalarExprWithSmt(expr.index) && canEncodeScalarExprWithSmt(expr.dim);
        case "read":
            return expr.indices.every(canEncodeScalarExprWithSmt) && canEncodeArrayWithSmt(expr.array);
        case "call":
            return expr.args.every(canEncodeScalarExprWithSmt);
        case "select":
            return canEncodeScalarExprWithSmt(expr.index) && expr.cases.every(canEncodeScalarExprWithSmt);
        case "sum":
            return false;
    }
}
export function canEncodeValueWithSmt(value) {
    switch (value.kind) {
        case "scalar":
            return canEncodeScalarExprWithSmt(value.expr);
        case "array":
            return canEncodeArrayWithSmt(value.array);
        case "struct":
            return value.fields.every((field) => canEncodeValueWithSmt(field.value));
        case "void":
            return true;
        case "opaque":
            return false;
    }
}
export function canEncodeArrayWithSmt(array) {
    switch (array.tag) {
        case "param":
            return array.dims.every(canEncodeScalarExprWithSmt) && canEncodeLeafModelWithSmt(array.leafModel);
        case "comprehension":
            return array.bindings.every((binding) => canEncodeScalarExprWithSmt(binding.extent))
                && canEncodeValueWithSmt(array.body);
        case "literal":
            return array.elements.every(canEncodeValueWithSmt);
        case "choice":
            return canEncodeScalarExprWithSmt(array.selector) && array.options.every(canEncodeArrayWithSmt);
        case "slice":
            return canEncodeArrayWithSmt(array.base) && array.fixedIndices.every(canEncodeScalarExprWithSmt);
    }
}
function canEncodeLeafModelWithSmt(model) {
    switch (model.kind) {
        case "scalar":
            return true;
        case "struct":
            return model.fields.every((field) => canEncodeLeafModelWithSmt(field.model));
        case "opaque":
            return false;
    }
}
export function symbolizeArrayParam(param, callSigs, structDefs = new Map()) {
    return buildParamArrayValue(param.name, param.type, callSigs, structDefs);
}
function buildParamArrayValue(name, type, callSigs, structDefs) {
    if (type.tag !== "array") {
        throw new Error(`Expected array param, got ${type.tag}`);
    }
    const dims = new Array(type.dims).fill(null).map((_, index) => ({
        tag: "var",
        name: `jplmm_dim_${name}_${index}`,
        valueType: "int",
    }));
    const leaf = arrayLeafType(type);
    return {
        tag: "param",
        name,
        arrayType: type,
        dims,
        leafType: leaf,
        leafModel: buildLeafModel(leaf, `jplmm_${name}`, type.dims, callSigs, structDefs),
    };
}
export function symbolizeParamValue(param, callSigs, structDefs = new Map()) {
    return buildParamValue(param.type, param.name, callSigs, structDefs);
}
function buildParamValue(type, baseName, callSigs, structDefs) {
    const scalar = scalarTag(type);
    if (scalar) {
        return {
            kind: "scalar",
            expr: {
                tag: "var",
                name: baseName,
                valueType: scalar,
            },
        };
    }
    if (type.tag === "array") {
        return {
            kind: "array",
            array: buildParamArrayValue(baseName, type, callSigs, structDefs),
        };
    }
    if (type.tag === "named") {
        return symbolizeStructParam(type, baseName, callSigs, structDefs);
    }
    if (type.tag === "void") {
        return { kind: "void", type };
    }
    return { kind: "opaque", type, label: baseName };
}
function symbolizeStructParam(type, baseName, callSigs, structDefs) {
    const fields = lookupStructFields(type.name, structDefs);
    if (!fields) {
        return { kind: "opaque", type, label: baseName };
    }
    return {
        kind: "struct",
        typeName: type.name,
        fields: fields.map((field) => ({
            name: field.name,
            type: field.type,
            value: buildParamValue(field.type, `${baseName}.${field.name}`, callSigs, structDefs),
        })),
    };
}
function buildLeafModel(type, baseName, readArity, callSigs, structDefs) {
    const scalar = scalarTag(type);
    if (scalar) {
        const readName = `jplmm_read_${baseName}`;
        callSigs.set(readName, { args: new Array(readArity).fill("int"), ret: scalar });
        return {
            kind: "scalar",
            type,
            readName,
        };
    }
    if (type.tag === "named") {
        const fields = lookupStructFields(type.name, structDefs);
        if (!fields) {
            return { kind: "opaque", type, label: baseName };
        }
        return {
            kind: "struct",
            typeName: type.name,
            fields: fields.map((field) => ({
                name: field.name,
                type: field.type,
                model: buildLeafModel(field.type, `${baseName}.${field.name}`, readArity, callSigs, structDefs),
            })),
        };
    }
    return { kind: "opaque", type, label: baseName };
}
export function isSupportedRecArgValue(type, value, current) {
    if (scalarTag(type)) {
        return value.kind === "scalar";
    }
    if (type.tag === "array") {
        return value.kind === "array";
    }
    if (type.tag === "named") {
        return value.kind === "struct" && current?.kind === "struct" && value.typeName === current.typeName;
    }
    if (type.tag === "void") {
        return value.kind === "void";
    }
    return value.kind === "opaque" && current?.kind === "opaque" && current.label === value.label;
}
export function readSymbolicArray(array, indices, resultType, stmtIndex, nodeId) {
    switch (array.tag) {
        case "slice":
            return readSymbolicArray(array.base, [...array.fixedIndices, ...indices], resultType, stmtIndex, nodeId);
        case "param":
            if (resultType.tag === "array") {
                return {
                    kind: "array",
                    array: {
                        tag: "slice",
                        base: array,
                        fixedIndices: indices,
                        arrayType: resultType,
                    },
                };
            }
            return instantiateLeafRead(array.leafModel, indices, array.dims, resultType, stmtIndex, nodeId);
        case "comprehension": {
            if (resultType.tag === "array") {
                return {
                    kind: "array",
                    array: {
                        tag: "slice",
                        base: array,
                        fixedIndices: indices,
                        arrayType: resultType,
                    },
                };
            }
            const consumed = array.bindings.length;
            const bindings = array.bindings.slice(0, consumed);
            const substitution = new Map();
            for (let i = 0; i < bindings.length; i += 1) {
                const binding = bindings[i];
                const index = indices[i];
                if (!index) {
                    return { kind: "opaque", type: resultType, label: `read_${stmtIndex}_${nodeId}` };
                }
                substitution.set(binding.name, {
                    kind: "scalar",
                    expr: {
                        tag: "clamp_index",
                        index,
                        dim: { tag: "positive_extent", value: binding.extent },
                    },
                });
            }
            const reduced = substituteValue(array.body, substitution);
            const remaining = indices.slice(consumed);
            if (remaining.length === 0) {
                return reduced.kind === "opaque" || sameKindForType(reduced, resultType)
                    ? reduced
                    : { kind: "opaque", type: resultType, label: `read_${stmtIndex}_${nodeId}` };
            }
            if (reduced.kind === "array") {
                return readSymbolicArray(reduced.array, remaining, resultType, stmtIndex, nodeId);
            }
            return { kind: "opaque", type: resultType, label: `read_${stmtIndex}_${nodeId}` };
        }
        case "literal":
            return readLiteralArray(array, indices, resultType, stmtIndex, nodeId);
        case "choice": {
            const values = array.options.map((option) => readSymbolicArray(option, indices, resultType, stmtIndex, nodeId));
            return selectValue(array.selector, values, resultType, stmtIndex, nodeId);
        }
    }
}
function instantiateLeafRead(model, indices, dims, resultType, stmtIndex, nodeId) {
    switch (model.kind) {
        case "scalar":
            if (scalarTag(resultType) !== scalarTag(model.type)) {
                return { kind: "opaque", type: resultType, label: `read_${stmtIndex}_${nodeId}` };
            }
            return {
                kind: "scalar",
                expr: {
                    tag: "call",
                    name: model.readName,
                    args: indices.map((index, dim) => ({
                        tag: "clamp_index",
                        index,
                        dim: dims[dim] ?? { tag: "int_lit", value: 1 },
                    })),
                    valueType: scalarTag(model.type),
                    interpreted: false,
                },
            };
        case "struct":
            if (resultType.tag !== "named" || resultType.name !== model.typeName) {
                return { kind: "opaque", type: resultType, label: `read_${stmtIndex}_${nodeId}` };
            }
            return {
                kind: "struct",
                typeName: model.typeName,
                fields: model.fields.map((field) => ({
                    name: field.name,
                    type: field.type,
                    value: instantiateLeafRead(field.model, indices, dims, field.type, stmtIndex, nodeId),
                })),
            };
        case "opaque":
            return { kind: "opaque", type: resultType, label: model.label };
    }
}
function readLiteralArray(array, indices, resultType, stmtIndex, nodeId) {
    if (indices.length === 0) {
        return { kind: "array", array };
    }
    const selector = clampLiteralIndex(indices[0], array.elements.length);
    const remaining = indices.slice(1);
    if (remaining.length === 0) {
        return selectValue(selector, array.elements, resultType, stmtIndex, nodeId);
    }
    const reads = array.elements.map((element) => {
        if (element.kind !== "array") {
            return { kind: "opaque", type: resultType, label: `literal_read_${stmtIndex}_${nodeId}` };
        }
        return readSymbolicArray(element.array, remaining, resultType, stmtIndex, nodeId);
    });
    return selectValue(selector, reads, resultType, stmtIndex, nodeId);
}
function selectValue(selector, cases, resultType, stmtIndex, nodeId) {
    if (cases.length === 0) {
        return { kind: "opaque", type: resultType, label: `select_${stmtIndex}_${nodeId}` };
    }
    const constantIndex = constantClampedIndex(selector, cases.length);
    if (constantIndex !== null) {
        return cases[constantIndex] ?? { kind: "opaque", type: resultType, label: `select_${stmtIndex}_${nodeId}` };
    }
    if (scalarTag(resultType)) {
        if (cases.every((value) => value.kind === "scalar")) {
            return {
                kind: "scalar",
                expr: {
                    tag: "select",
                    index: selector,
                    cases: cases.map((value) => value.expr),
                    valueType: scalarTag(resultType),
                },
            };
        }
        return { kind: "opaque", type: resultType, label: `select_${stmtIndex}_${nodeId}` };
    }
    if (resultType.tag === "array") {
        if (cases.every((value) => value.kind === "array")) {
            return {
                kind: "array",
                array: {
                    tag: "choice",
                    selector,
                    options: cases.map((value) => value.array),
                    arrayType: resultType,
                },
            };
        }
        return { kind: "opaque", type: resultType, label: `select_${stmtIndex}_${nodeId}` };
    }
    if (resultType.tag === "named") {
        if (!cases.every((value) => value.kind === "struct" && value.typeName === resultType.name)) {
            return { kind: "opaque", type: resultType, label: `select_${stmtIndex}_${nodeId}` };
        }
        const fields = cases[0].fields;
        return {
            kind: "struct",
            typeName: resultType.name,
            fields: fields.map((field, fieldIndex) => ({
                name: field.name,
                type: field.type,
                value: selectValue(selector, cases.map((value) => value.fields[fieldIndex].value), field.type, stmtIndex, nodeId),
            })),
        };
    }
    if (resultType.tag === "void") {
        return { kind: "void", type: resultType };
    }
    return { kind: "opaque", type: resultType, label: `select_${stmtIndex}_${nodeId}` };
}
function clampLiteralIndex(index, length) {
    return {
        tag: "clamp_index",
        index,
        dim: { tag: "int_lit", value: Math.max(1, length) },
    };
}
function constantClampedIndex(index, length) {
    if (index.tag === "int_lit") {
        if (length <= 1) {
            return 0;
        }
        if (index.value < 0) {
            return 0;
        }
        if (index.value >= length) {
            return length - 1;
        }
        return index.value;
    }
    if (index.tag === "clamp_index") {
        return constantClampedIndex(index.index, length);
    }
    return null;
}
export function sameKindForType(value, type) {
    if (value.kind === "scalar") {
        return scalarTag(type) === scalarExprType(value.expr);
    }
    if (value.kind === "array") {
        return type.tag === "array";
    }
    if (value.kind === "struct") {
        return type.tag === "named" && value.typeName === type.name;
    }
    if (value.kind === "void") {
        return type.tag === "void";
    }
    return true;
}
export function substituteValue(expr, substitution) {
    switch (expr.kind) {
        case "scalar":
            return { kind: "scalar", expr: substituteScalar(expr.expr, substitution) };
        case "array":
            return { kind: "array", array: substituteArray(expr.array, substitution) };
        case "struct":
            return {
                kind: "struct",
                typeName: expr.typeName,
                fields: expr.fields.map((field) => ({
                    ...field,
                    value: substituteValue(field.value, substitution),
                })),
            };
        case "void":
            return expr;
        case "opaque":
            return expr;
    }
}
export function substituteArray(array, substitution) {
    switch (array.tag) {
        case "param": {
            const replacement = substitution.get(array.name);
            if (replacement?.kind === "array") {
                return replacement.array;
            }
            return {
                ...array,
                dims: array.dims.map((dim) => substituteScalar(dim, substitution)),
            };
        }
        case "slice":
            return {
                ...array,
                base: substituteArray(array.base, substitution),
                fixedIndices: array.fixedIndices.map((index) => substituteScalar(index, substitution)),
            };
        case "literal":
            return {
                ...array,
                elements: array.elements.map((element) => substituteValue(element, substitution)),
            };
        case "choice":
            return {
                ...array,
                selector: substituteScalar(array.selector, substitution),
                options: array.options.map((option) => substituteArray(option, substitution)),
            };
        case "comprehension": {
            const shadowed = new Map(substitution);
            for (const binding of array.bindings) {
                shadowed.delete(binding.name);
            }
            return {
                ...array,
                bindings: array.bindings.map((binding) => ({
                    name: binding.name,
                    extent: substituteScalar(binding.extent, substitution),
                })),
                body: substituteValue(array.body, shadowed),
            };
        }
    }
}
export function substituteScalar(expr, substitution) {
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
            return expr;
        case "var": {
            const replacement = substitution.get(expr.name);
            return replacement?.kind === "scalar" ? replacement.expr : expr;
        }
        case "unop":
            return {
                tag: "unop",
                op: expr.op,
                operand: substituteScalar(expr.operand, substitution),
                valueType: expr.valueType,
            };
        case "select":
            return {
                tag: "select",
                index: substituteScalar(expr.index, substitution),
                cases: expr.cases.map((value) => substituteScalar(value, substitution)),
                valueType: expr.valueType,
            };
        case "sum": {
            const shadowed = new Map(substitution);
            for (const binding of expr.bindings) {
                shadowed.delete(binding.name);
            }
            return {
                tag: "sum",
                bindings: expr.bindings.map((binding) => ({
                    name: binding.name,
                    extent: substituteScalar(binding.extent, substitution),
                })),
                body: substituteScalar(expr.body, shadowed),
                valueType: expr.valueType,
            };
        }
        case "binop":
            return {
                tag: "binop",
                op: expr.op,
                left: substituteScalar(expr.left, substitution),
                right: substituteScalar(expr.right, substitution),
                valueType: expr.valueType,
            };
        case "total_div":
        case "total_mod":
            return {
                tag: expr.tag,
                left: substituteScalar(expr.left, substitution),
                right: substituteScalar(expr.right, substitution),
                valueType: expr.valueType,
            };
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
            return {
                tag: expr.tag,
                left: substituteScalar(expr.left, substitution),
                right: substituteScalar(expr.right, substitution),
            };
        case "sat_neg":
            return {
                tag: "sat_neg",
                operand: substituteScalar(expr.operand, substitution),
            };
        case "nan_to_zero":
            return {
                tag: "nan_to_zero",
                value: substituteScalar(expr.value, substitution),
            };
        case "positive_extent":
            return { tag: "positive_extent", value: substituteScalar(expr.value, substitution) };
        case "clamp_index":
            return {
                tag: "clamp_index",
                index: substituteScalar(expr.index, substitution),
                dim: substituteScalar(expr.dim, substitution),
            };
        case "read":
            return {
                tag: "read",
                array: substituteArray(expr.array, substitution),
                indices: expr.indices.map((index) => substituteScalar(index, substitution)),
                valueType: expr.valueType,
            };
        case "call":
            return {
                tag: "call",
                name: expr.name,
                args: expr.args.map((arg) => substituteScalar(arg, substitution)),
                valueType: expr.valueType,
                interpreted: expr.interpreted,
            };
    }
}
export function buildMeasureCounterexampleQuery(params, currentMeasure, nextMeasure, substitution, callSigs, currentValues) {
    if (!canEncodeScalarExprWithSmt(currentMeasure) || !canEncodeScalarExprWithSmt(nextMeasure)) {
        return {
            ok: false,
            reason: "current refinement proof backend cannot encode this rad expression in SMT yet",
        };
    }
    const vars = new Map();
    collectVars(currentMeasure, vars);
    collectVars(nextMeasure, vars);
    for (const value of substitution.values()) {
        collectValueVars(value, vars);
    }
    const preconditions = [];
    const preconditionFailures = [];
    for (let i = 0; i < params.length; i += 1) {
        const param = params[i];
        const next = substitution.get(param.name);
        if (!next) {
            continue;
        }
        const current = currentValues.get(param.name) ?? symbolizeCurrentParamValue(param);
        collectValueVars(current, vars);
        const change = emitValueChange(current, next, param.type);
        if (change) {
            preconditions.push(change);
            continue;
        }
        preconditionFailures.push(`could not encode non-collapse guard for '${param.name}'`);
    }
    if (preconditions.length === 0) {
        return {
            ok: false,
            reason: preconditionFailures[0]
                ?? "no symbolizable recursive argument change was available for the SMT rad proof",
        };
    }
    const lines = buildJplScalarPrelude();
    for (const [name, sig] of callSigs) {
        const domain = sig.args.map((arg) => (arg === "int" ? "Int" : "Real")).join(" ");
        const sort = sig.ret === "int" ? "Int" : "Real";
        lines.push(`(declare-fun ${sanitize(name)} (${domain}) ${sort})`);
    }
    for (const [name, tag] of vars) {
        lines.push(`(declare-const ${sanitize(name)} ${tag === "int" ? "Int" : "Real"})`);
        if (tag === "int") {
            lines.push(`(assert (<= ${INT32_MIN} ${sanitize(name)}))`);
            lines.push(`(assert (<= ${sanitize(name)} ${INT32_MAX}))`);
        }
    }
    const decrease = strictDecrease(currentMeasure, nextMeasure);
    lines.push(`(assert (or ${preconditions.join(" ")}))`);
    lines.push(`(assert (not ${decrease}))`);
    const querySymbols = [];
    for (const param of params) {
        const tag = scalarTag(param.type);
        if (!tag) {
            continue;
        }
        querySymbols.push({
            symbol: sanitize(param.name),
            label: param.name,
        });
    }
    for (const param of params) {
        const tag = scalarTag(param.type);
        const next = substitution.get(param.name);
        if (!tag || !next || next.kind !== "scalar") {
            continue;
        }
        const nextSymbol = `jplmm_next_${sanitize(param.name)}`;
        lines.push(`(define-fun ${nextSymbol} () ${tag === "int" ? "Int" : "Real"} ${emitScalar(next.expr)})`);
        querySymbols.push({
            symbol: nextSymbol,
            label: `next ${param.name}`,
        });
    }
    const measureSort = scalarExprType(currentMeasure) === "int" ? "Int" : "Real";
    lines.push(`(define-fun jplmm_abs_current_measure () ${measureSort} ${emitAbsoluteMeasure(currentMeasure)})`);
    lines.push(`(define-fun jplmm_abs_next_measure () ${measureSort} ${emitAbsoluteMeasure(nextMeasure)})`);
    querySymbols.push({ symbol: "jplmm_abs_current_measure", label: "|rad| current" }, { symbol: "jplmm_abs_next_measure", label: "|rad| next" });
    return {
        ok: true,
        query: {
            baseLines: lines,
            querySymbols,
        },
    };
}
export function symbolizeCurrentParamValue(param) {
    return symbolizeParamValue(param, new Map(), new Map());
}
export function emitValueChange(current, next, type) {
    const equality = emitValueEquality(current, next, type);
    return equality ? `(not ${equality})` : null;
}
export function emitValueEquality(current, next, type) {
    if (scalarTag(type)) {
        if (current.kind !== "scalar" || next.kind !== "scalar") {
            return null;
        }
        if (!canEncodeScalarExprWithSmt(current.expr) || !canEncodeScalarExprWithSmt(next.expr)) {
            return null;
        }
        return `(= ${emitScalar(current.expr)} ${emitScalar(next.expr)})`;
    }
    if (type.tag === "array") {
        if (current.kind !== "array" || next.kind !== "array") {
            return null;
        }
        return emitArrayEquality(current.array, next.array);
    }
    if (type.tag === "named") {
        if (current.kind !== "struct" || next.kind !== "struct" || current.typeName !== type.name || next.typeName !== type.name) {
            return null;
        }
        if (current.fields.length !== next.fields.length) {
            return null;
        }
        const clauses = current.fields.map((field, index) => {
            const right = next.fields[index];
            if (!right || right.name !== field.name) {
                return null;
            }
            return emitValueEquality(field.value, right.value, field.type);
        });
        if (clauses.some((clause) => clause === null)) {
            return null;
        }
        if (clauses.length === 0) {
            return "true";
        }
        return clauses.length === 1 ? clauses[0] : `(and ${clauses.join(" ")})`;
    }
    if (type.tag === "void") {
        return current.kind === "void" && next.kind === "void" ? "true" : null;
    }
    if (current.kind === "opaque" && next.kind === "opaque" && current.label === next.label) {
        return "true";
    }
    return null;
}
export function emitArrayEquality(left, right) {
    const leftDims = arrayDims(left);
    const rightDims = arrayDims(right);
    if (!leftDims || !rightDims || leftDims.length !== rightDims.length) {
        return null;
    }
    const leftType = resolveArrayType(left);
    const rightType = resolveArrayType(right);
    if (leftType.tag !== "array" || rightType.tag !== "array" || !sameType(leftType.element, rightType.element)) {
        return null;
    }
    const dimEqualities = leftDims.map((dim, index) => `(= ${emitScalar(dim)} ${emitScalar(rightDims[index])})`);
    const prefix = dimEqualities.length === 0 ? "true" : dimEqualities.length === 1 ? dimEqualities[0] : `(and ${dimEqualities.join(" ")})`;
    const counter = arrayEqCounter;
    arrayEqCounter += 1;
    const binders = leftDims.map((_, index) => `(${`jplmm_idx_${counter}_${index}`} Int)`);
    const idxExprs = leftDims.map((_, index) => ({
        tag: "var",
        name: `jplmm_idx_${counter}_${index}`,
        valueType: "int",
    }));
    const ranges = leftDims.map((dim, index) => {
        const name = sanitize(`jplmm_idx_${counter}_${index}`);
        return `(and (<= 0 ${name}) (< ${name} ${emitScalar(dim)}))`;
    });
    const rangeGuard = ranges.length === 0 ? "true" : ranges.length === 1 ? ranges[0] : `(and ${ranges.join(" ")})`;
    const leftRead = readSymbolicArray(left, idxExprs, leftType.element, -1, -1);
    const rightRead = readSymbolicArray(right, idxExprs, rightType.element, -1, -1);
    const readEquality = emitValueEquality(leftRead, rightRead, leftType.element);
    if (!readEquality) {
        return null;
    }
    const quantified = `(forall (${binders.join(" ")}) (=> ${rangeGuard} ${readEquality}))`;
    return prefix === "true" ? quantified : `(and ${prefix} ${quantified})`;
}
export function emitLeafArrayRead(array, indices, resultType) {
    const value = readSymbolicArray(array, indices, resultType, -1, -1);
    return value.kind === "scalar" && canEncodeScalarExprWithSmt(value.expr) ? emitScalar(value.expr) : null;
}
export function arrayDims(array) {
    switch (array.tag) {
        case "param":
            return array.dims;
        case "slice": {
            const dims = arrayDims(array.base);
            return dims ? dims.slice(array.fixedIndices.length) : null;
        }
        case "comprehension":
            return arrayDimsWithPrefix(array.bindings.map((binding) => ({ tag: "positive_extent", value: binding.extent })), array.body.kind === "array" ? array.body.array : null);
        case "literal":
            return arrayDimsWithPrefix([{ tag: "int_lit", value: Math.max(1, array.elements.length) }], array.elements[0]?.kind === "array" ? array.elements[0].array : null);
        case "choice":
            return array.options[0] ? arrayDims(array.options[0]) : null;
    }
}
export function resolveArrayType(array) {
    switch (array.tag) {
        case "param":
        case "comprehension":
        case "literal":
        case "choice":
        case "slice":
            return array.arrayType;
    }
}
export function strictDecrease(currentMeasure, nextMeasure) {
    if (scalarExprType(currentMeasure) === "int") {
        return `(< (abs_int ${emitScalar(nextMeasure)}) (abs_int ${emitScalar(currentMeasure)}))`;
    }
    return `(< (abs_real ${emitScalar(nextMeasure)}) (abs_real ${emitScalar(currentMeasure)}))`;
}
export function emitAbsoluteMeasure(expr) {
    return `(${scalarExprType(expr) === "int" ? "abs_int" : "abs_real"} ${emitScalar(expr)})`;
}
export function emitScalar(expr) {
    return emitScalarWithOverrides(expr);
}
export function emitScalarWithOverrides(expr, overrides = {}) {
    switch (expr.tag) {
        case "int_lit":
            return `${expr.value}`;
        case "float_lit":
            return realLiteral(expr.value);
        case "var":
            return overrides.onVar?.(expr) ?? sanitize(expr.name);
        case "unop":
            return `(- ${emitScalarWithOverrides(expr.operand, overrides)})`;
        case "select":
            return emitSelect(expr.index, expr.cases, overrides);
        case "positive_extent":
            return `(positive_extent_int ${emitScalarWithOverrides(expr.value, overrides)})`;
        case "clamp_index":
            return `(clamp_index_int ${emitScalarWithOverrides(expr.index, overrides)} ${emitScalarWithOverrides(expr.dim, overrides)})`;
        case "read":
            return emitArrayReadWithOverrides(expr.array, expr.indices, expr.valueType, overrides);
        case "binop":
            if (expr.valueType === "int") {
                if (expr.op === "+")
                    return `(+ ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
                if (expr.op === "-")
                    return `(- ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
                if (expr.op === "*")
                    return `(* ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
                if (expr.op === "/")
                    return `(total_div_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
                return `(total_mod_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
            }
            if (expr.op === "+")
                return `(+ ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
            if (expr.op === "-")
                return `(- ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
            if (expr.op === "*")
                return `(* ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
            if (expr.op === "/")
                return `(total_div_real ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
            return `(- ${emitScalarWithOverrides(expr.left, overrides)} (* ${emitScalarWithOverrides(expr.right, overrides)} (to_real (trunc_real (/ ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})))))`;
        case "sat_add":
            return `(sat_add_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
        case "sat_sub":
            return `(sat_sub_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
        case "sat_mul":
            return `(sat_mul_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
        case "sat_neg":
            return `(sat_neg_int ${emitScalarWithOverrides(expr.operand, overrides)})`;
        case "total_div":
            return expr.valueType === "int"
                ? `(total_div_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`
                : `(total_div_real ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`;
        case "total_mod":
            return expr.valueType === "int"
                ? `(total_mod_int ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})`
                : `(- ${emitScalarWithOverrides(expr.left, overrides)} (* ${emitScalarWithOverrides(expr.right, overrides)} (to_real (trunc_real (/ ${emitScalarWithOverrides(expr.left, overrides)} ${emitScalarWithOverrides(expr.right, overrides)})))))`;
        case "nan_to_zero":
            return emitScalarWithOverrides(expr.value, overrides);
        case "call": {
            const args = expr.args.map((arg) => emitScalarWithOverrides(arg, overrides)).join(" ");
            if (!expr.interpreted) {
                return `(${sanitize(expr.name)} ${args})`;
            }
            switch (expr.name) {
                case "max":
                    return `(${expr.valueType === "int" ? "max_int" : "max_real"} ${args})`;
                case "min":
                    return `(${expr.valueType === "int" ? "min_int" : "min_real"} ${args})`;
                case "abs":
                    return `(${expr.valueType === "int" ? "abs_int" : "abs_real"} ${args})`;
                case "clamp":
                    return `(${expr.valueType === "int" ? "clamp_int" : "clamp_real"} ${args})`;
                case "to_float":
                    return `(to_real ${emitScalarWithOverrides(expr.args[0], overrides)})`;
                case "to_int":
                    return `(to_int_real ${emitScalarWithOverrides(expr.args[0], overrides)})`;
                default:
                    return `(${sanitize(expr.name)} ${args})`;
            }
        }
        case "sum":
            throw new Error("sum expressions do not have SMT lowering yet");
    }
}
export function emitArrayRead(array, indices, valueType) {
    return emitArrayReadWithOverrides(array, indices, valueType);
}
export function emitArrayReadWithOverrides(array, indices, valueType, overrides = {}) {
    switch (array.tag) {
        case "slice":
            return emitArrayReadWithOverrides(array.base, [...array.fixedIndices, ...indices], valueType, overrides);
        case "param":
            if (array.leafModel.kind !== "scalar") {
                throw new Error("Expected scalar leaf when emitting symbolic array read");
            }
            return `(${sanitize(array.leafModel.readName)} ${indices.map((index, dim) => emitScalarWithOverrides({
                tag: "clamp_index",
                index,
                dim: array.dims[dim] ?? { tag: "int_lit", value: 1 },
            }, overrides)).join(" ")})`;
        case "comprehension":
        case "literal":
        case "choice":
            return emitDerivedArrayReadWithOverrides(array, indices, valueType, overrides);
    }
}
export function renderScalarExpr(expr) {
    switch (expr.tag) {
        case "int_lit":
        case "float_lit":
            return `${expr.value}`;
        case "var":
            return expr.name;
        case "unop":
            return `(-${renderScalarExpr(expr.operand)})`;
        case "select":
            return `select(${renderScalarExpr(expr.index)}; ${expr.cases.map((value) => renderScalarExpr(value)).join(", ")})`;
        case "sum":
            return `sum[${expr.bindings.map((binding) => `${binding.name}:${renderScalarExpr(binding.extent)}`).join(", ")}] ${renderScalarExpr(expr.body)}`;
        case "sat_add":
            return `sat_add(${renderScalarExpr(expr.left)}, ${renderScalarExpr(expr.right)})`;
        case "sat_sub":
            return `sat_sub(${renderScalarExpr(expr.left)}, ${renderScalarExpr(expr.right)})`;
        case "sat_mul":
            return `sat_mul(${renderScalarExpr(expr.left)}, ${renderScalarExpr(expr.right)})`;
        case "sat_neg":
            return `sat_neg(${renderScalarExpr(expr.operand)})`;
        case "total_div":
            return `total_div(${renderScalarExpr(expr.left)}, ${renderScalarExpr(expr.right)})`;
        case "total_mod":
            return `total_mod(${renderScalarExpr(expr.left)}, ${renderScalarExpr(expr.right)})`;
        case "nan_to_zero":
            return `nan_to_zero(${renderScalarExpr(expr.value)})`;
        case "positive_extent":
            return `extent(${renderScalarExpr(expr.value)})`;
        case "clamp_index":
            return `clamp_index(${renderScalarExpr(expr.index)}, ${renderScalarExpr(expr.dim)})`;
        case "read":
            return `${renderArrayExpr(expr.array)}[${expr.indices.map((index) => renderScalarExpr(index)).join(", ")}]`;
        case "binop":
            return `(${renderScalarExpr(expr.left)} ${expr.op} ${renderScalarExpr(expr.right)})`;
        case "call":
            return `${expr.name}(${expr.args.map((arg) => renderScalarExpr(arg)).join(", ")})`;
    }
}
export function renderArrayExpr(array) {
    switch (array.tag) {
        case "param":
            return array.name;
        case "slice":
            return `${renderArrayExpr(array.base)}[${array.fixedIndices.map((index) => renderScalarExpr(index)).join(", ")}]`;
        case "comprehension":
            return `array[${array.bindings.map((binding) => `${binding.name}:${renderScalarExpr(binding.extent)}`).join(", ")}]`;
        case "literal":
            return `[${array.elements.map((element) => renderValueExpr(element)).join(", ")}]`;
        case "choice":
            return `select_array(${renderScalarExpr(array.selector)}; ${array.options.map((option) => renderArrayExpr(option)).join(", ")})`;
    }
}
export function collectVars(expr, out, shadowed = new Set()) {
    switch (expr.tag) {
        case "var":
            if (!shadowed.has(expr.name)) {
                out.set(expr.name, expr.valueType);
            }
            return;
        case "unop":
            collectVars(expr.operand, out, shadowed);
            return;
        case "select":
            collectVars(expr.index, out, shadowed);
            for (const value of expr.cases) {
                collectVars(value, out, shadowed);
            }
            return;
        case "sum": {
            const innerShadowed = new Set(shadowed);
            for (const binding of expr.bindings) {
                collectVars(binding.extent, out, innerShadowed);
                innerShadowed.add(binding.name);
            }
            collectVars(expr.body, out, innerShadowed);
            return;
        }
        case "sat_add":
        case "sat_sub":
        case "sat_mul":
        case "total_div":
        case "total_mod":
            collectVars(expr.left, out, shadowed);
            collectVars(expr.right, out, shadowed);
            return;
        case "sat_neg":
            collectVars(expr.operand, out, shadowed);
            return;
        case "nan_to_zero":
            collectVars(expr.value, out, shadowed);
            return;
        case "positive_extent":
            collectVars(expr.value, out, shadowed);
            return;
        case "clamp_index":
            collectVars(expr.index, out, shadowed);
            collectVars(expr.dim, out, shadowed);
            return;
        case "read":
            for (const index of expr.indices) {
                collectVars(index, out, shadowed);
            }
            collectArrayVars(expr.array, out, shadowed);
            return;
        case "binop":
            collectVars(expr.left, out, shadowed);
            collectVars(expr.right, out, shadowed);
            return;
        case "call":
            for (const arg of expr.args) {
                collectVars(arg, out, shadowed);
            }
            return;
        default:
            return;
    }
}
export function collectValueVars(value, out, shadowed = new Set()) {
    switch (value.kind) {
        case "scalar":
            collectVars(value.expr, out, shadowed);
            return;
        case "array":
            collectArrayVars(value.array, out, shadowed);
            return;
        case "struct":
            for (const field of value.fields) {
                collectValueVars(field.value, out, shadowed);
            }
            return;
        case "void":
            return;
        case "opaque":
            return;
    }
}
export function collectArrayVars(array, out, shadowed = new Set()) {
    switch (array.tag) {
        case "param":
            for (const dim of array.dims) {
                collectVars(dim, out, shadowed);
            }
            return;
        case "slice":
            collectArrayVars(array.base, out, shadowed);
            for (const index of array.fixedIndices) {
                collectVars(index, out, shadowed);
            }
            return;
        case "literal":
            for (const element of array.elements) {
                collectValueVars(element, out, shadowed);
            }
            return;
        case "choice":
            collectVars(array.selector, out, shadowed);
            for (const option of array.options) {
                collectArrayVars(option, out, shadowed);
            }
            return;
        case "comprehension": {
            const innerShadowed = new Set(shadowed);
            for (const binding of array.bindings) {
                collectVars(binding.extent, out, innerShadowed);
                innerShadowed.add(binding.name);
            }
            collectValueVars(array.body, out, innerShadowed);
            return;
        }
    }
}
export function queryCounterexample(query) {
    const result = checkSatAndGetValues(query.baseLines, query.querySymbols.map((entry) => entry.symbol));
    if (!result.ok) {
        return null;
    }
    if (result.status !== "sat" || !result.values) {
        return null;
    }
    const values = result.values;
    const currentAssignments = query.querySymbols
        .filter((entry) => !entry.label.startsWith("next ") && !entry.label.startsWith("|rad|"))
        .map((entry) => `${entry.label} = ${values.get(entry.symbol) ?? "?"}`);
    const nextAssignments = query.querySymbols
        .filter((entry) => entry.label.startsWith("next "))
        .map((entry) => `${entry.label} = ${values.get(entry.symbol) ?? "?"}`);
    const currentMeasure = values.get("jplmm_abs_current_measure");
    const nextMeasure = values.get("jplmm_abs_next_measure");
    const parts = [];
    if (currentAssignments.length > 0) {
        parts.push(currentAssignments.join(", "));
    }
    if (nextAssignments.length > 0) {
        parts.push(nextAssignments.join(", "));
    }
    if (currentMeasure && nextMeasure) {
        parts.push(`|rad| ${currentMeasure} -> ${nextMeasure}`);
    }
    return parts.length > 0 ? `counterexample: ${parts.join("; ")}` : null;
}
function realLiteral(value) {
    const negative = value < 0;
    const fixed = Math.abs(value).toFixed(20).replace(/\.?0+$/, "");
    const literal = fixed.includes(".") ? fixed : `${fixed}.0`;
    return negative ? `(- ${literal})` : literal;
}
function emitSelect(index, cases, overrides = {}) {
    if (cases.length === 0) {
        throw new Error("Cannot emit empty select expression");
    }
    let acc = emitScalarWithOverrides(cases[cases.length - 1], overrides);
    for (let i = cases.length - 2; i >= 0; i -= 1) {
        acc = `(ite (= ${emitScalarWithOverrides(index, overrides)} ${i}) ${emitScalarWithOverrides(cases[i], overrides)} ${acc})`;
    }
    return acc;
}
export function renderValueExpr(value) {
    switch (value.kind) {
        case "scalar":
            return renderScalarExpr(value.expr);
        case "array":
            return renderArrayExpr(value.array);
        case "struct":
            return `${value.typeName} { ${value.fields.map((field) => renderValueExpr(field.value)).join(", ")} }`;
        case "void":
            return "void";
        case "opaque":
            return value.label;
    }
}
export function extendSymbolicSubstitution(current, next, substitution) {
    if (current.kind === "scalar" && current.expr.tag === "var") {
        substitution.set(current.expr.name, next);
        return;
    }
    if (current.kind === "array" && current.array.tag === "param") {
        substitution.set(current.array.name, next);
        return;
    }
    if (current.kind === "struct" && next.kind === "struct" && current.typeName === next.typeName) {
        for (let i = 0; i < current.fields.length; i += 1) {
            const left = current.fields[i];
            const right = next.fields[i];
            if (!left || !right || left.name !== right.name) {
                continue;
            }
            extendSymbolicSubstitution(left.value, right.value, substitution);
        }
    }
}
function emitDerivedArrayReadWithOverrides(array, indices, valueType, overrides = {}) {
    const value = readSymbolicArray(array, indices, valueType === "int" ? { tag: "int" } : { tag: "float" }, -1, -1);
    if (value.kind !== "scalar" || !canEncodeScalarExprWithSmt(value.expr)) {
        throw new Error("Expected encodable scalar value when emitting symbolic array read");
    }
    return emitScalarWithOverrides(value.expr, overrides);
}
function arrayDimsWithPrefix(prefix, nested) {
    if (!nested) {
        return prefix;
    }
    const suffix = arrayDims(nested);
    return suffix ? [...prefix, ...suffix] : null;
}
function lookupStructFields(typeName, structDefs) {
    return structDefs.get(typeName) ?? null;
}
//# sourceMappingURL=scalar.js.map