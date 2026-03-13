import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { emitWatModule } from "@jplmm/backend";
import { runFrontend } from "@jplmm/frontend";
import { buildIR } from "@jplmm/ir";
import { optimizeProgram } from "@jplmm/optimize";
import { verifyProgram } from "@jplmm/verify";
export function runOnSource(source, mode, options = {}) {
    const frontend = runFrontend(source);
    const diagnostics = frontend.diagnostics.map((d) => `${d.severity.toUpperCase()}: ${d.message}`);
    let proofSummary = [];
    let optimizeSummary = [];
    let implementationSummary = [];
    let wat;
    if (mode === "verify") {
        const verify = verifyProgram(frontend.program);
        diagnostics.push(...verify.diagnostics.map((d) => `${d.severity.toUpperCase()}: ${d.message}`));
        proofSummary = [...verify.proofMap.entries()].map(([fnName, p]) => `${fnName}: ${p.status} (${p.method}) - ${p.details}`);
    }
    const hasErrors = diagnostics.some((d) => d.startsWith("ERROR:"));
    if (!hasErrors && (mode === "optimize" || mode === "wat")) {
        const ir = buildIR(frontend.program, frontend.typeMap);
        const optimizeOptions = options.experimental ? { enableResearchPasses: true } : {};
        const optimized = optimizeProgram(ir, optimizeOptions);
        optimizeSummary = optimized.reports.map((report) => {
            const prefix = report.experimental ? "[experimental] " : "";
            const detail = report.details.length > 0 ? ` ${report.details.join("; ")}` : "";
            return `${prefix}${report.name}:${detail}`;
        });
        implementationSummary = [...optimized.artifacts.implementations.entries()].map(([fnName, impl]) => `${fnName}: ${impl.tag}`);
        if (mode === "wat") {
            wat = emitWatModule(optimized.program, {
                artifacts: optimized.artifacts,
                tailCalls: true,
                exportFunctions: true,
            });
        }
    }
    const ok = diagnostics.every((d) => !d.startsWith("ERROR:"));
    return { mode, diagnostics, proofSummary, optimizeSummary, implementationSummary, wat, ok };
}
export function runOnFile(filepath, mode, options = {}) {
    const source = readFileSync(resolve(filepath), "utf8");
    return runOnSource(source, mode, options);
}
export function main(argv) {
    const args = [...argv];
    const experimental = args.includes("--experimental");
    const filtered = args.filter((arg) => arg !== "--experimental");
    const modeArg = filtered[0];
    const fileArg = filtered[1];
    const mode = modeArg === "-p"
        ? "parse"
        : modeArg === "-t"
            ? "typecheck"
            : modeArg === "-v"
                ? "verify"
                : modeArg === "-i"
                    ? "optimize"
                    : modeArg === "-s"
                        ? "wat"
                        : "verify";
    const file = modeArg?.startsWith("-") ? fileArg : modeArg;
    if (!file) {
        // eslint-disable-next-line no-console
        console.error("Usage: jplmm [-p|-t|-v|-i|-s] [--experimental] <file.jplmm>");
        return 2;
    }
    const report = runOnFile(file, mode, { experimental });
    for (const d of report.diagnostics) {
        // eslint-disable-next-line no-console
        console.log(d);
    }
    for (const p of report.proofSummary) {
        // eslint-disable-next-line no-console
        console.log(p);
    }
    for (const p of report.optimizeSummary) {
        // eslint-disable-next-line no-console
        console.log(p);
    }
    for (const impl of report.implementationSummary) {
        // eslint-disable-next-line no-console
        console.log(impl);
    }
    if (report.wat) {
        // eslint-disable-next-line no-console
        console.log(report.wat);
    }
    return report.ok ? 0 : 1;
}
//# sourceMappingURL=index.js.map