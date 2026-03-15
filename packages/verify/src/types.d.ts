import type { IRFunction, IRProgram } from "@jplmm/ir";
import type { IrProofSiteTrace, IrRadWitness, IrStmtSemantics, ScalarTag, SymValue } from "@jplmm/proof";
export type ProofStatus = "verified" | "bounded" | "unverified" | "rejected";
export type ProofMethod = "structural" | "smt" | "gas" | "gas_inf" | "none";
export type ProofResult = {
    status: ProofStatus;
    method: ProofMethod;
    details: string;
};
export type VerificationDiagnostic = {
    fnName: string;
    message: string;
    code: "VERIFY_NO_PROOF" | "VERIFY_PROOF_FAIL" | "VERIFY_GAS_INF";
    severity: "error" | "warning";
};
export type VerificationOutput = {
    proofMap: Map<string, ProofResult>;
    diagnostics: VerificationDiagnostic[];
    canonicalProgram: IRProgram;
    traceMap: Map<string, VerificationFunctionTrace>;
};
export type VerificationOptions = {
    proofTimeoutMs?: number;
};
export type VerificationFunctionTrace = {
    fnName: string;
    canonical: IRFunction;
    hasRec: boolean;
    paramValues: Map<string, SymValue>;
    exprSemantics: Map<number, SymValue>;
    result: SymValue | null;
    stmtSemantics: IrStmtSemantics[];
    radSites: IrRadWitness[];
    proofSites: IrProofSiteTrace[];
    callSigs: Map<string, {
        args: ScalarTag[];
        ret: ScalarTag;
    }>;
};
//# sourceMappingURL=types.d.ts.map