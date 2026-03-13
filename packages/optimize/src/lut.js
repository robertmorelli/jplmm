import { executeProgram } from "./runtime";
export function tabulateLuts(program, artifacts, threshold) {
    const out = [];
    for (const fn of program.functions) {
        if (artifacts.implementations.has(fn.name)) {
            continue;
        }
        const cardinality = artifacts.cardinalityMap.get(fn.name);
        if (!cardinality || cardinality.cardinality === "inf" || cardinality.cardinality <= 0) {
            continue;
        }
        if (cardinality.cardinality > threshold) {
            continue;
        }
        if (fn.params.some((param) => param.type.tag !== "int") || (fn.retType.tag !== "int" && fn.retType.tag !== "float")) {
            continue;
        }
        const table = enumerateArgs(cardinality, (args) => {
            const value = executeProgram(program, fn.name, args, { artifacts }).value;
            if (typeof value !== "number") {
                throw new Error(`LUT tabulation requires scalar results for '${fn.name}'`);
            }
            return value;
        });
        out.push({
            fnName: fn.name,
            implementation: {
                tag: "lut",
                parameterRanges: cardinality.parameterRanges,
                table,
                resultType: fn.retType,
            },
        });
    }
    return out;
}
function enumerateArgs(cardinality, evaluate) {
    const table = [];
    const current = new Array(cardinality.parameterRanges.length);
    const loop = (idx) => {
        if (idx === cardinality.parameterRanges.length) {
            table.push(evaluate([...current]));
            return;
        }
        const range = cardinality.parameterRanges[idx];
        for (let value = range.lo; value <= range.hi; value += 1) {
            current[idx] = value;
            loop(idx + 1);
        }
    };
    loop(0);
    return table;
}
//# sourceMappingURL=lut.js.map