import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildWatSemantics, emitNativeCModule, emitWatModule } from "@jplmm/backend";
import { runFrontend } from "@jplmm/frontend";
import { buildIR } from "@jplmm/ir";
import { optimizeProgram } from "@jplmm/optimize";
import { analyzeProgramMetrics, verifyProgram } from "@jplmm/verify";
import { executeTopLevelProgram } from "./run";
import { buildSemanticsDebugData, renderSemanticsDebugData } from "./semantics";
export function runOnSource(source, mode, options = {}) {
    const frontend = runFrontend(source);
    const diagnostics = frontend.diagnostics.map((d) => `${d.severity.toUpperCase()}: ${d.message}`);
    const shouldVerify = mode === "verify" || (mode === "run" && options.verifyBeforeRun === true);
    const shouldAnalyzeProofs = shouldVerify || mode === "semantics";
    const shouldShowRefinements = mode !== "parse" && mode !== "typecheck";
    let proofSummary = shouldShowRefinements
        ? frontend.refinements.map((refinement) => renderRefinementSummary(refinement))
        : [];
    let analysisSummary = [];
    let optimizeSummary = [];
    let implementationSummary = [];
    let semantics;
    let wat;
    let nativeC;
    let output = [];
    let wroteFiles = [];
    let verification = null;
    let semanticsBackend = null;
    if (shouldAnalyzeProofs) {
        verification = verifyProgram(frontend.program, frontend.typeMap);
        const metrics = analyzeProgramMetrics(frontend.program);
        diagnostics.push(...verification.diagnostics.map((d) => `${d.severity.toUpperCase()}: ${d.message}`));
        proofSummary.push(...[...verification.proofMap.entries()].map(([fnName, p]) => `${fnName}: ${p.status} (${p.method}) - ${p.details}`));
        analysisSummary = [...metrics.entries()].map(([fnName, metric]) => `${fnName}: source complexity ${metric.sourceComplexity} (base 1 + ${metric.recSites} rec site${metric.recSites === 1 ? "" : "s"}); canonical line-coverage witness ${metric.canonicalWitness}; coarse total call bound ${metric.coarseTotalCallBound}`);
    }
    const hasErrors = diagnostics.some((d) => d.startsWith("ERROR:"));
    if (!hasErrors && (mode === "optimize" || mode === "wat" || mode === "native" || mode === "semantics")) {
        const ir = buildIR(frontend.program, frontend.typeMap);
        const optimizeOptions = buildOptimizeOptions(options);
        const optimized = optimizeProgram(ir, optimizeOptions);
        optimizeSummary = optimized.reports.map((report) => {
            const prefix = report.experimental ? "[experimental] " : "";
            const detail = report.details.length > 0 ? ` ${report.details.join("; ")}` : "";
            return `${prefix}${report.name}:${detail}`;
        });
        implementationSummary = [...optimized.artifacts.implementations.entries()].map(([fnName, impl]) => `${fnName}: ${impl.tag}`);
        if (mode === "semantics") {
            semanticsBackend = {
                optimizeSummary: [...optimizeSummary],
                implementationSummary: [...implementationSummary],
                optimizedProgram: optimized.program,
                wasm: buildWatSemantics(optimized.program, {
                    artifacts: optimized.artifacts,
                    tailCalls: true,
                    exportFunctions: true,
                }),
            };
        }
        if (mode === "wat") {
            wat = emitWatModule(optimized.program, {
                artifacts: optimized.artifacts,
                tailCalls: true,
                exportFunctions: true,
                moduleComments: buildWatDebugComments(optimizeSummary, implementationSummary, optimized.artifacts.implementations, optimizeOptions.enableResearchPasses === true, optimizeOptions.disabledPasses ?? []),
            });
        }
        if (mode === "native") {
            nativeC = emitNativeCModule(optimized.program, {
                artifacts: optimized.artifacts,
            });
        }
    }
    if (mode === "semantics") {
        semantics = renderSemanticsDebugData(buildSemanticsDebugData(frontend, verification ?? verifyProgram(frontend.program, frontend.typeMap), semanticsBackend));
    }
    if (!hasErrors && mode === "run") {
        const execution = executeTopLevelProgram(frontend.program, frontend.typeMap, options.cwd ?? process.cwd());
        output = execution.output;
        wroteFiles = execution.wroteFiles;
    }
    const ok = diagnostics.every((d) => !d.startsWith("ERROR:"));
    return {
        mode,
        diagnostics,
        proofSummary,
        analysisSummary,
        optimizeSummary,
        implementationSummary,
        semantics,
        wat,
        nativeC,
        output,
        wroteFiles,
        ok,
    };
}
function buildWatDebugComments(optimizeSummary, implementationSummary, implementations, researchEnabled, disabledPasses) {
    const comments = ["JPLMM debug WAT"];
    if (optimizeSummary.length > 0) {
        comments.push("optimization passes:");
        comments.push(...optimizeSummary.map((line) => `  ${line}`));
    }
    if (implementationSummary.length > 0) {
        comments.push("selected implementations:");
        comments.push(...implementationSummary.map((line) => `  ${line}`));
    }
    if (!researchEnabled) {
        comments.push("safe mode active: all optional optimizer passes are disabled");
    }
    if (disabledPasses.length > 0) {
        comments.push(`disabled passes: ${disabledPasses.join(", ")}`);
    }
    const watFallbacks = [...implementations.entries()]
        .flatMap(([fnName, implementation]) => describeWatFallback(fnName, implementation));
    if (watFallbacks.length > 0) {
        comments.push("wat backend fallbacks:");
        comments.push(...watFallbacks.map((line) => `  ${line}`));
    }
    return comments;
}
function describeWatFallback(fnName, implementation) {
    switch (implementation.tag) {
        case "closed_form_linear_countdown":
        case "lut":
        case "aitken_scalar_tail":
            return [];
        case "linear_speculation":
            return [`${fnName}: linear_speculation recognized but WAT lowering is not implemented yet; emitting generic recursion`];
        default: {
            const _never = implementation;
            return _never;
        }
    }
}
export function runOnFile(filepath, mode, options = {}) {
    const source = readFileSync(resolve(filepath), "utf8");
    return runOnSource(source, mode, {
        ...options,
        cwd: options.cwd ?? dirname(resolve(filepath)),
    });
}
export function main(argv) {
    const args = [...argv];
    let experimental = true;
    let safe = false;
    const disablePasses = [];
    const filtered = [];
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--experimental") {
            experimental = true;
            continue;
        }
        if (arg === "--safe") {
            safe = true;
            continue;
        }
        if (arg === "--disable-pass") {
            const pass = args[i + 1];
            if (!pass || !isDisableablePassName(pass)) {
                // eslint-disable-next-line no-console
                console.error(`Unknown or missing pass after --disable-pass. Expected one of: ${DISABLEABLE_PASSES.join(", ")}`);
                return 2;
            }
            disablePasses.push(pass);
            i += 1;
            continue;
        }
        if (arg.startsWith("--disable-pass=")) {
            const pass = arg.slice("--disable-pass=".length);
            if (!isDisableablePassName(pass)) {
                // eslint-disable-next-line no-console
                console.error(`Unknown pass '${pass}'. Expected one of: ${DISABLEABLE_PASSES.join(", ")}`);
                return 2;
            }
            disablePasses.push(pass);
            continue;
        }
        filtered.push(arg);
    }
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
                        : modeArg === "-a"
                            ? "native"
                            : modeArg === "-r"
                                ? "run"
                                : modeArg === "-m"
                                    ? "semantics"
                                    : "verify";
    const file = modeArg?.startsWith("-") ? fileArg : modeArg;
    if (!file) {
        // eslint-disable-next-line no-console
        console.error("Usage: jplmm [-p|-t|-v|-i|-s|-a|-r|-m] [--safe] [--disable-pass <name>] <file.jplmm>");
        return 2;
    }
    const report = runOnFile(file, mode, { experimental, safe, disablePasses });
    for (const d of report.diagnostics) {
        // eslint-disable-next-line no-console
        console.log(d);
    }
    for (const p of report.proofSummary) {
        // eslint-disable-next-line no-console
        console.log(p);
    }
    for (const line of report.analysisSummary) {
        // eslint-disable-next-line no-console
        console.log(line);
    }
    for (const p of report.optimizeSummary) {
        // eslint-disable-next-line no-console
        console.log(p);
    }
    for (const impl of report.implementationSummary) {
        // eslint-disable-next-line no-console
        console.log(impl);
    }
    if (report.semantics) {
        // eslint-disable-next-line no-console
        console.log(report.semantics);
    }
    if (report.wat) {
        // eslint-disable-next-line no-console
        console.log(report.wat);
    }
    if (report.nativeC) {
        // eslint-disable-next-line no-console
        console.log(report.nativeC);
    }
    for (const line of report.output) {
        // eslint-disable-next-line no-console
        console.log(line);
    }
    return report.ok ? 0 : 1;
}
function renderRefinementSummary(refinement) {
    const prefix = `${refinement.fnName}: ref ${refinement.status}`;
    if (refinement.status === "equivalent") {
        const method = refinement.method ? ` (${refinement.method})` : "";
        const explanation = refinement.equivalence ?? refinement.detail;
        return `${prefix}${method} - ${explanation}`;
    }
    return `${prefix} - ${refinement.detail}`;
}
const DISABLEABLE_PASSES = [
    "guard_elimination",
    "closed_form",
    "lut_tabulation",
    "aitken",
    "linear_speculation",
];
function isDisableablePassName(value) {
    return DISABLEABLE_PASSES.includes(value);
}
function buildOptimizeOptions(options) {
    const disabledPasses = new Set(options.disablePasses ?? []);
    const safe = options.safe === true || options.experimental === false;
    if (safe) {
        for (const pass of DISABLEABLE_PASSES) {
            disabledPasses.add(pass);
        }
    }
    return {
        enableResearchPasses: !safe,
        disabledPasses: [...disabledPasses],
    };
}
//# sourceMappingURL=index.js.map