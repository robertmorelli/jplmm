export type DiagnosticSeverity = "error" | "warning";

export type Diagnostic = {
  message: string;
  start: number;
  end: number;
  severity: DiagnosticSeverity;
  code?: string;
};

export class FrontendError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join("\n"));
    this.name = "FrontendError";
    this.diagnostics = diagnostics;
  }
}

export function error(message: string, start: number, end: number, code?: string): Diagnostic {
  if (code) {
    return { message, start, end, severity: "error", code };
  }
  return { message, start, end, severity: "error" };
}

export function warning(
  message: string,
  start: number,
  end: number,
  code?: string,
): Diagnostic {
  if (code) {
    return { message, start, end, severity: "warning", code };
  }
  return { message, start, end, severity: "warning" };
}
