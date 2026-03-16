import type { IRProgram } from "@jplmm/ir";
import type { ExprProvenance, ProvenanceStage, SerializedExprProvenance } from "./types";
export declare function buildExprProvenance(input: IRProgram, output: IRProgram, stage?: ProvenanceStage): ExprProvenance;
export declare function serializeExprProvenance(provenance: ExprProvenance): SerializedExprProvenance;
//# sourceMappingURL=provenance.d.ts.map