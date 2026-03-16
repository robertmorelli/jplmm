export const BUILTIN_FUNCTIONS = new Set([
    "sqrt",
    "exp",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "log",
    "pow",
    "atan2",
    "to_float",
    "to_int",
    "max",
    "min",
    "abs",
    "clamp",
]);
export const NAN_GUARDED_BUILTINS = new Set(["sqrt", "log", "pow", "asin", "acos"]);
export function unwrapTimedDefinition(cmd, tag) {
    if (cmd.tag === tag) {
        return cmd;
    }
    if (cmd.tag === "time" && cmd.cmd.tag === tag) {
        return cmd.cmd;
    }
    return null;
}
//# sourceMappingURL=nodes.js.map