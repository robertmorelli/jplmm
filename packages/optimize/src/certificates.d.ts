import type { IRProgram } from "@jplmm/ir";
import type { OptimizeResult } from "./types";
export type OptimizeCertificateValidation = {
    ok: boolean;
    detail: string;
};
export type OptimizeCertificateChecks = {
    canonicalize: OptimizeCertificateValidation;
    rangeAnalysis: OptimizeCertificateValidation;
    guardElimination: OptimizeCertificateValidation;
    finalIdentity: OptimizeCertificateValidation;
    closedForm: OptimizeCertificateValidation;
    lut: OptimizeCertificateValidation;
};
export declare function validateOptimizeCertificates(result: OptimizeResult): OptimizeCertificateChecks;
export declare function validateCanonicalizePassCertificate(rawProgram: IRProgram, canonicalProgram: IRProgram, certificate: OptimizeResult["certificates"]["canonicalize"]): OptimizeCertificateValidation;
export declare function validateRangeAnalysisPassCertificate(program: IRProgram, certificate: OptimizeResult["certificates"]["rangeAnalysis"]): OptimizeCertificateValidation;
export declare function validateGuardEliminationPassCertificate(canonicalProgram: IRProgram, guardProgram: IRProgram, certificate: OptimizeResult["certificates"]["guardElimination"]): OptimizeCertificateValidation;
export declare function validateFinalIdentityPassCertificate(certificate: OptimizeResult["certificates"]["finalIdentity"]): OptimizeCertificateValidation;
export declare function validateClosedFormPassCertificate(program: IRProgram, certificate: OptimizeResult["certificates"]["closedForm"]): OptimizeCertificateValidation;
export declare function validateLutPassCertificate(certificate: OptimizeResult["certificates"]["lut"]): OptimizeCertificateValidation;
//# sourceMappingURL=certificates.d.ts.map