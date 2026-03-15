import { type Param, type Type } from "@jplmm/ast";
import { type Z3RunOptions } from "@jplmm/smt";
export type ScalarTag = "int" | "float";
export type ScalarExpr = {
    tag: "int_lit";
    value: number;
} | {
    tag: "float_lit";
    value: number;
} | {
    tag: "var";
    name: string;
    valueType: ScalarTag;
} | {
    tag: "unop";
    op: "-";
    operand: ScalarExpr;
    valueType: ScalarTag;
} | {
    tag: "binop";
    op: "+" | "-" | "*" | "/" | "%";
    left: ScalarExpr;
    right: ScalarExpr;
    valueType: ScalarTag;
} | {
    tag: "select";
    index: ScalarExpr;
    cases: ScalarExpr[];
    valueType: ScalarTag;
} | {
    tag: "sum";
    bindings: ArrayBinding[];
    body: ScalarExpr;
    valueType: ScalarTag;
} | {
    tag: "sat_add";
    left: ScalarExpr;
    right: ScalarExpr;
} | {
    tag: "sat_sub";
    left: ScalarExpr;
    right: ScalarExpr;
} | {
    tag: "sat_mul";
    left: ScalarExpr;
    right: ScalarExpr;
} | {
    tag: "sat_neg";
    operand: ScalarExpr;
} | {
    tag: "total_div";
    left: ScalarExpr;
    right: ScalarExpr;
    valueType: ScalarTag;
} | {
    tag: "total_mod";
    left: ScalarExpr;
    right: ScalarExpr;
    valueType: ScalarTag;
} | {
    tag: "nan_to_zero";
    value: ScalarExpr;
} | {
    tag: "positive_extent";
    value: ScalarExpr;
} | {
    tag: "clamp_index";
    index: ScalarExpr;
    dim: ScalarExpr;
} | {
    tag: "read";
    array: SymArray;
    indices: ScalarExpr[];
    valueType: ScalarTag;
} | {
    tag: "call";
    name: string;
    args: ScalarExpr[];
    valueType: ScalarTag;
    interpreted: boolean;
};
export type ArrayBinding = {
    name: string;
    extent: ScalarExpr;
};
export type SymStructField = {
    name: string;
    type: Type;
    value: SymValue;
};
export type SymLeafModel = {
    kind: "scalar";
    type: Type;
    readName: string;
} | {
    kind: "struct";
    typeName: string;
    fields: SymLeafField[];
} | {
    kind: "opaque";
    type: Type;
    label: string;
};
export type SymLeafField = {
    name: string;
    type: Type;
    model: SymLeafModel;
};
export type SymArray = {
    tag: "param";
    name: string;
    arrayType: Type;
    dims: ScalarExpr[];
    leafType: Type;
    leafModel: SymLeafModel;
} | {
    tag: "abstract";
    name: string;
    args: ScalarExpr[];
    arrayType: Type;
    dims: ScalarExpr[];
    leafType: Type;
    leafModel: SymLeafModel;
} | {
    tag: "comprehension";
    arrayType: Type;
    bindings: ArrayBinding[];
    body: SymValue;
} | {
    tag: "literal";
    arrayType: Type;
    elements: SymValue[];
} | {
    tag: "choice";
    selector: ScalarExpr;
    options: SymArray[];
    arrayType: Type;
} | {
    tag: "slice";
    base: SymArray;
    fixedIndices: ScalarExpr[];
    arrayType: Type;
};
export type SymValue = {
    kind: "scalar";
    expr: ScalarExpr;
} | {
    kind: "array";
    array: SymArray;
} | {
    kind: "struct";
    typeName: string;
    fields: SymStructField[];
} | {
    kind: "void";
    type: Type;
} | {
    kind: "opaque";
    type: Type;
    label: string;
};
export type CounterexampleQuery = {
    baseLines: string[];
    querySymbols: Array<{
        symbol: string;
        label: string;
    }>;
};
export type CounterexampleQueryResult = {
    ok: true;
    query: CounterexampleQuery;
} | {
    ok: false;
    reason: string;
};
export type SmtEncodingState = {
    sumDefinitions: string[];
    sumHelpers: Map<string, string>;
    nextSumId: number;
};
export type EmitOverrides = {
    onVar?: (expr: Extract<ScalarExpr, {
        tag: "var";
    }>) => string | null;
    onCall?: (expr: Extract<ScalarExpr, {
        tag: "call";
    }>) => string | null;
    smt?: SmtEncodingState;
};
export type ComparisonInterval = {
    lo: number;
    hi: number;
    exact: boolean;
    boundBy?: ScalarExpr;
};
export declare function makeOpaque(type: Type, label: string, site: string): SymValue;
export declare function createSmtEncodingState(): SmtEncodingState;
export declare function appendSmtEncodingState(lines: string[], state: SmtEncodingState | undefined): void;
export declare function scalarTag(type: Type | undefined): ScalarTag | null;
export declare function sameType(left: Type, right: Type): boolean;
export declare function normalizeScalarExprForType(expr: ScalarExpr, type: Type): ScalarExpr;
export declare function normalizeValueForType(value: SymValue, type: Type): SymValue;
export declare function buildComparisonEnvFromParams(params: ReadonlyArray<Param>): Map<string, ComparisonInterval>;
export declare function normalizeValueForComparison(value: SymValue, env?: Map<string, ComparisonInterval>): SymValue;
export declare function normalizeScalarForComparison(expr: ScalarExpr, env?: Map<string, ComparisonInterval>): ScalarExpr;
export declare function appendScalarTypeConstraints(lines: string[], symbol: string, type: Type | undefined): void;
export declare function arrayLeafType(type: Type): Type;
export declare function scalarExprType(expr: ScalarExpr): ScalarTag;
export declare function isInterpretedCall(name: string, arity: number): boolean;
export declare function canEncodeScalarExprWithSmt(expr: ScalarExpr): boolean;
export declare function canEncodeValueWithSmt(value: SymValue): boolean;
export declare function canEncodeArrayWithSmt(array: SymArray): boolean;
export declare function symbolizeArrayParam(param: Param, callSigs: Map<string, {
    args: ScalarTag[];
    ret: ScalarTag;
}>, structDefs?: Map<string, Array<{
    name: string;
    type: Type;
}>>): SymArray;
export declare function symbolizeParamValue(param: Param, callSigs: Map<string, {
    args: ScalarTag[];
    ret: ScalarTag;
}>, structDefs?: Map<string, Array<{
    name: string;
    type: Type;
}>>): SymValue;
export declare function symbolizeAbstractValue(type: Type, baseName: string, args: ScalarExpr[], callSigs: Map<string, {
    args: ScalarTag[];
    ret: ScalarTag;
}>, structDefs?: Map<string, Array<{
    name: string;
    type: Type;
}>>): SymValue;
export declare function isSupportedRecArgValue(type: Type, value: SymValue, current: SymValue | undefined): boolean;
export declare function readSymbolicArray(array: SymArray, indices: ScalarExpr[], resultType: Type, stmtIndex: number, nodeId: number): SymValue;
export declare function selectValue(selector: ScalarExpr, cases: SymValue[], resultType: Type, stmtIndex: number, nodeId: number): SymValue;
export declare function sameKindForType(value: SymValue, type: Type): boolean;
export declare function substituteValue(expr: SymValue, substitution: Map<string, SymValue>): SymValue;
export declare function substituteArray(array: SymArray, substitution: Map<string, SymValue>): SymArray;
export declare function substituteScalar(expr: ScalarExpr, substitution: Map<string, SymValue>): ScalarExpr;
export declare function buildMeasureCounterexampleQuery(params: Param[], currentMeasure: ScalarExpr, nextMeasure: ScalarExpr, substitution: Map<string, SymValue>, callSigs: Map<string, {
    args: ScalarTag[];
    ret: ScalarTag;
}>, currentValues: Map<string, SymValue>, collapseCondition?: string | null): CounterexampleQueryResult;
export declare function symbolizeCurrentParamValue(param: Param): SymValue;
export declare function emitValueChange(current: SymValue, next: SymValue, type: Type, overrides?: EmitOverrides): string | null;
export declare function emitValueEquality(current: SymValue, next: SymValue, type: Type, overrides?: EmitOverrides): string | null;
export declare function emitArrayEquality(left: SymArray, right: SymArray, overrides?: EmitOverrides): string | null;
export declare function emitLeafArrayRead(array: SymArray, indices: ScalarExpr[], resultType: Type): string | null;
export declare function arrayDims(array: SymArray): ScalarExpr[] | null;
export declare function resolveArrayType(array: SymArray): Type;
export declare function strictDecrease(currentMeasure: ScalarExpr, nextMeasure: ScalarExpr, overrides?: EmitOverrides): string;
export declare function emitAbsoluteMeasure(expr: ScalarExpr, overrides?: EmitOverrides): string;
export declare function emitScalar(expr: ScalarExpr): string;
export declare function emitScalarWithOverrides(expr: ScalarExpr, overrides?: EmitOverrides): string;
export declare function emitArrayRead(array: SymArray, indices: ScalarExpr[], valueType: ScalarTag): string;
export declare function emitArrayReadWithOverrides(array: SymArray, indices: ScalarExpr[], valueType: ScalarTag, overrides?: EmitOverrides): string;
export declare function renderScalarExpr(expr: ScalarExpr): string;
export declare function renderArrayExpr(array: SymArray): string;
export declare function collectVars(expr: ScalarExpr, out: Map<string, ScalarTag>, shadowed?: Set<string>): void;
export declare function collectValueVars(value: SymValue, out: Map<string, ScalarTag>, shadowed?: Set<string>): void;
export declare function collectArrayVars(array: SymArray, out: Map<string, ScalarTag>, shadowed?: Set<string>): void;
export declare function queryCounterexample(query: CounterexampleQuery, solverOptions?: Z3RunOptions): string | null;
export declare function queryIntModelValues(lines: string[], vars: string[], solverOptions?: Z3RunOptions): Map<string, number> | null;
export declare function formatModelAssignments(names: string[], values: Map<string, number>): string | null;
export declare function renderValueExpr(value: SymValue): string;
export declare function emitValueSexpr(value: SymValue): string;
export declare function extendSymbolicSubstitution(current: SymValue, next: SymValue, substitution: Map<string, SymValue>): void;
//# sourceMappingURL=scalar.d.ts.map