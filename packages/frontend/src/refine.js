import { renderType, sameType } from "@jplmm/ast";
import { buildCanonicalProgram, checkFunctionRefinement, renderIrFunction, } from "@jplmm/proof";
import { error } from "./errors";
export function refineProgram(program, typeMap, options = {}) {
    const diagnostics = [];
    const refinements = [];
    const output = [];
    const effective = new Map();
    for (const cmd of program.commands) {
        const fn = unwrapTimedFnDef(cmd);
        if (!fn) {
            output.push(cmd);
            continue;
        }
        if (fn.keyword !== "ref") {
            output.push(cmd);
            effective.set(fn.name, {
                cmd,
                fn,
                outputIndex: output.length - 1,
                policyKeyword: fn.keyword,
            });
            continue;
        }
        const current = effective.get(fn.name);
        if (!current) {
            const message = `ref '${fn.name}' requires an earlier fun/def/fn definition`;
            diagnostics.push(diagnosticForFn(fn, message, "REF_NO_BASE"));
            refinements.push({
                fnName: fn.name,
                baselineKeyword: null,
                status: "invalid",
                detail: message,
                ...captureRenderedAndStructuredSemantics(fn.name, [], [...materializeCommands(output), cmd], typeMap),
                ...optionalSpan("ref", fn.start, fn.end),
            });
            continue;
        }
        const baselineCommands = materializeCommands(output);
        const refinedCmd = rewriteFunctionKeyword(cmd, current.policyKeyword);
        const refinedCommands = materializeCommands(output, new Map([[current.outputIndex, refinedCmd]]));
        const semantics = captureRefinementSemantics(fn.name, baselineCommands, refinedCommands, typeMap);
        const signatureProblem = compareRefinementSignature(current.fn, fn);
        if (signatureProblem) {
            diagnostics.push(diagnosticForFn(fn, signatureProblem, "REF_SIGNATURE"));
            refinements.push({
                fnName: fn.name,
                baselineKeyword: current.policyKeyword,
                status: "invalid",
                detail: signatureProblem,
                ...semantics,
                ...optionalSpan("baseline", current.fn.start, current.fn.end),
                ...optionalSpan("ref", fn.start, fn.end),
            });
            continue;
        }
        const check = checkFunctionRefinement(fn.name, baselineCommands, refinedCommands, typeMap, options.proofTimeoutMs === undefined ? {} : { timeoutMs: options.proofTimeoutMs });
        if (!check.ok) {
            diagnostics.push(diagnosticForFn(fn, check.message, check.code));
            refinements.push(reportFailedRefinement(current, fn, check, semantics));
            continue;
        }
        output[current.outputIndex] = null;
        output.push(refinedCmd);
        const rewrittenFn = unwrapTimedFnDef(refinedCmd);
        if (!rewrittenFn) {
            continue;
        }
        effective.set(fn.name, {
            cmd: refinedCmd,
            fn: rewrittenFn,
            outputIndex: output.length - 1,
            policyKeyword: current.policyKeyword,
        });
        refinements.push({
            fnName: fn.name,
            baselineKeyword: current.policyKeyword,
            status: "equivalent",
            method: check.method,
            detail: check.detail,
            ...(check.equivalence ? { equivalence: check.equivalence } : {}),
            ...semantics,
            ...optionalSpan("baseline", current.fn.start, current.fn.end),
            ...optionalSpan("ref", fn.start, fn.end),
        });
    }
    return {
        program: { commands: materializeCommands(output) },
        diagnostics,
        refinements,
    };
}
function reportFailedRefinement(current, fn, check, semantics) {
    return {
        fnName: fn.name,
        baselineKeyword: current.policyKeyword,
        status: check.code === "REF_MISMATCH" ? "mismatch" : "unproven",
        detail: check.message,
        ...semantics,
        ...optionalSpan("baseline", current.fn.start, current.fn.end),
        ...optionalSpan("ref", fn.start, fn.end),
    };
}
function captureRefinementSemantics(fnName, baselineCommands, refinedCommands, typeMap) {
    return captureRenderedAndStructuredSemantics(fnName, baselineCommands, refinedCommands, typeMap);
}
function captureRenderedAndStructuredSemantics(fnName, baselineCommands, refinedCommands, typeMap) {
    const baseline = captureCanonicalFunctionSemantics(fnName, baselineCommands, typeMap);
    const refined = captureCanonicalFunctionSemantics(fnName, refinedCommands, typeMap);
    return {
        baselineSemantics: baseline ? renderIrFunction(baseline) : [],
        refSemantics: refined ? renderIrFunction(refined) : [],
        ...(baseline ? { baselineSemanticsData: baseline } : {}),
        ...(refined ? { refSemanticsData: refined } : {}),
    };
}
function captureCanonicalFunctionSemantics(fnName, commands, typeMap) {
    try {
        const canonical = buildCanonicalProgram({ commands }, typeMap);
        return canonical.functions.find((candidate) => candidate.name === fnName) ?? null;
    }
    catch {
        return null;
    }
}
function optionalSpan(prefix, start, end) {
    return {
        ...(start !== undefined ? { [`${prefix}Start`]: start } : {}),
        ...(end !== undefined ? { [`${prefix}End`]: end } : {}),
    };
}
function compareRefinementSignature(baseline, candidate) {
    if (baseline.params.length !== candidate.params.length) {
        return `ref '${candidate.name}' must keep the same arity as '${baseline.name}'`;
    }
    for (let i = 0; i < baseline.params.length; i += 1) {
        if (!sameType(baseline.params[i].type, candidate.params[i].type)) {
            return `ref '${candidate.name}' parameter ${i + 1} must keep type ${renderType(baseline.params[i].type)}`;
        }
    }
    if (!sameType(baseline.retType, candidate.retType)) {
        return `ref '${candidate.name}' must keep return type ${renderType(baseline.retType)}`;
    }
    return null;
}
function unwrapTimedFnDef(cmd) {
    if (cmd.tag === "fn_def") {
        return cmd;
    }
    if (cmd.tag === "time" && cmd.cmd.tag === "fn_def") {
        return cmd.cmd;
    }
    return null;
}
function rewriteFunctionKeyword(cmd, keyword) {
    if (cmd.tag === "fn_def") {
        return { ...cmd, keyword };
    }
    if (cmd.tag === "time" && cmd.cmd.tag === "fn_def") {
        return { ...cmd, cmd: { ...cmd.cmd, keyword } };
    }
    return cmd;
}
function materializeCommands(output, replacements = new Map()) {
    const commands = [];
    for (let i = 0; i < output.length; i += 1) {
        const next = replacements.has(i) ? replacements.get(i) : output[i];
        if (next) {
            commands.push(next);
        }
    }
    return commands;
}
function diagnosticForFn(fn, message, code) {
    return error(message, fn.start ?? 0, fn.end ?? fn.start ?? 0, code);
}
//# sourceMappingURL=refine.js.map