export class FrontendError extends Error {
    diagnostics;
    constructor(diagnostics) {
        super(diagnostics.map((d) => d.message).join("\n"));
        this.name = "FrontendError";
        this.diagnostics = diagnostics;
    }
}
export function error(message, start, end, code) {
    if (code) {
        return { message, start, end, severity: "error", code };
    }
    return { message, start, end, severity: "error" };
}
export function warning(message, start, end, code) {
    if (code) {
        return { message, start, end, severity: "warning", code };
    }
    return { message, start, end, severity: "warning" };
}
export function nodeError(node, message, code) {
    return error(message, node?.start ?? 0, node?.end ?? node?.start ?? 0, code);
}
export function nodeWarning(node, message, code) {
    return warning(message, node?.start ?? 0, node?.end ?? node?.start ?? 0, code);
}
//# sourceMappingURL=errors.js.map