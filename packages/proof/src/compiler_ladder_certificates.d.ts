import type { IRProgram } from "@jplmm/ir";
import { type OptimizeResult } from "@jplmm/optimize";
import type { SemanticsCertificateRecord, SemanticsEdgeRecord, SerializedRangeAnalysis } from "./compiler_ladder";
export declare function validateCanonicalizeCertificate(rawProgram: IRProgram, canonicalProgram: IRProgram, certificate: OptimizeResult["certificates"]["canonicalize"]): SemanticsCertificateRecord;
export declare function validateRangeAnalysisCertificate(program: IRProgram, certificate: OptimizeResult["certificates"]["rangeAnalysis"]): SemanticsCertificateRecord;
export declare function validateGuardEliminationCertificate(canonicalProgram: IRProgram, guardProgram: IRProgram, certificate: OptimizeResult["certificates"]["guardElimination"]): SemanticsCertificateRecord;
export declare function validateIdentityCertificate(certificate: OptimizeResult["certificates"]["finalIdentity"]): SemanticsCertificateRecord;
export declare function validateClosedFormCertificate(program: IRProgram, certificate: OptimizeResult["certificates"]["closedForm"]): SemanticsCertificateRecord;
export declare function validateLutCertificate(certificate: OptimizeResult["certificates"]["lut"]): SemanticsCertificateRecord;
export declare function revalidateCertificate(edges: SemanticsEdgeRecord[], from: SemanticsEdgeRecord["from"], to: SemanticsEdgeRecord["to"], baselineProgram: IRProgram, refinedProgram: IRProgram | null, rangeAnalysis?: SerializedRangeAnalysis | null): SemanticsCertificateRecord | null;
//# sourceMappingURL=compiler_ladder_certificates.d.ts.map