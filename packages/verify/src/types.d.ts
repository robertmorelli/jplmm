export type ProofStatus = "verified" | "bounded" | "unverified" | "rejected";
export type ProofMethod = "structural" | "gas" | "gas_inf" | "none";
export type ProofResult = {
    status: ProofStatus;
    method: ProofMethod;
    details: string;
};
export type VerificationDiagnostic = {
    fnName: string;
    message: string;
    code: "VERIFY_NO_PROOF" | "VERIFY_STRUCTURAL_UNSUPPORTED" | "VERIFY_STRUCTURAL_FAIL" | "VERIFY_GAS_INF";
    severity: "error" | "warning";
};
export type VerificationOutput = {
    proofMap: Map<string, ProofResult>;
    diagnostics: VerificationDiagnostic[];
};
//# sourceMappingURL=types.d.ts.map