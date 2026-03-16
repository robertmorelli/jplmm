# Kernel IR Pipeline Implementation Spec

## `packages/kernel-ir/package.json`
- Functions: none.
- Add:
  - New workspace package `@jplmm/kernel-ir`.
  - Dependencies on `@jplmm/ast` and `@jplmm/ir`.
  - Same `build`, `typecheck`, `test`, `lint`, and `test:coverage` scripts used by the other TS workspace packages.
- Modify: nothing.
- Remove: nothing.
- Why:
  - `kernel_ir` needs its own shared types and helpers so optimize and proof both import the same node definitions instead of each package inventing its own copy.

## `packages/kernel-ir/tsconfig.json`
- Functions: none.
- Add:
  - New package-local TS config copied from the existing package pattern.
  - Include `src` and `test`.
- Modify: nothing.
- Remove: nothing.
- Why:
  - The new package has to build and typecheck independently inside the workspace.

## `packages/kernel-ir/vitest.config.ts`
- Functions: none.
- Add:
  - New package-local Vitest config copied from the existing package pattern.
- Modify: nothing.
- Remove: nothing.
- Why:
  - The package needs its own unit test entrypoint.

## `packages/kernel-ir/src/nodes.ts`
- Functions: none.
- Add:
  - `type KernelBinding = { name: string; expr: KernelExpr }`.
  - `type KernelExpr` with all current IR leaf/scalar/struct/call/index/rec variants, but replacing:
    - `array_expr` with `parallel_array`.
    - `sum_expr` with `linear_sum`.
  - On `parallel_array` and `linear_sum`, add `captures: string[]`.
  - `type KernelStmt` mirroring `IRStmt`, but `expr` is `KernelExpr`.
  - `type KernelGlobalLet` mirroring `IRGlobalLet`, but `expr` is `KernelExpr`.
  - `type KernelFunction`.
  - `type KernelProgram = { structs: IRStructDef[]; functions: KernelFunction[]; globals: KernelGlobalLet[] }`.
- Modify: nothing.
- Remove:
  - Do not carry `array_expr` or `sum_expr` into kernel nodes.
- Why:
  - The floor needs explicit node tags for pointwise parallel array construction and linear folds, and it needs capture lists on each kernel site.

## `packages/kernel-ir/src/render.ts`
- Functions to add:
  - `renderKernelExpr(expr: KernelExpr): string`
  - `renderKernelStmt(stmt: KernelStmt): string`
  - `renderKernelFunction(fn: KernelFunction): string[]`
- Add:
  - Custom printing for:
    - `parallel_array` as `parallel_array[captures=...] [bindings] body`
    - `linear_sum` as `linear_sum[captures=...] [bindings] body`
  - Reuse the same textual formatting as IR for every unchanged tag.
- Modify: nothing.
- Remove: nothing.
- Why:
  - The semantics dump must show the kernel floor with kernel-specific tags instead of printing the reified IR form.

## `packages/kernel-ir/src/reify.ts`
- Functions to add:
  - `reifyKernelExpr(expr: KernelExpr): IRExpr`
  - `reifyKernelStmt(stmt: KernelStmt): IRStmt`
  - `reifyKernelFunction(fn: KernelFunction): IRFunction`
  - `reifyKernelProgram(program: KernelProgram): IRProgram`
- Add:
  - Exact lossless reification:
    - `parallel_array -> array_expr`
    - `linear_sum -> sum_expr`
    - drop `captures`
    - preserve original `id`, `resultType`, function names, statement ids, and binding order
  - Recursive mapping for every unchanged tag.
- Modify: nothing.
- Remove: nothing.
- Why:
  - The validator and proof ladder need a mechanical inverse that turns kernel IR back into ordinary IR so the existing symbolic equivalence checker can be reused.

## `packages/kernel-ir/src/traverse.ts`
- Functions to add:
  - `kernelExprChildren(expr: KernelExpr): KernelExpr[]`
  - `collectKernelExprNodes(expr: KernelExpr, out: Map<number, KernelExpr>): void`
  - `collectKernelSites(program: KernelProgram): KernelSite[]`
- Add:
  - `type KernelSite = { fnName: string; exprId: number; tag: "parallel_array" | "linear_sum"; bindingCount: number; captureNames: string[] }`
  - Deterministic site ordering: sort by `fnName`, then `exprId`.
  - Deterministic capture ordering: sorted unique `captureNames`.
- Modify: nothing.
- Remove: nothing.
- Why:
  - Optimize certificates, provenance, and tests all need one shared traversal over kernel nodes.

## `packages/kernel-ir/src/index.ts`
- Functions: none.
- Add:
  - Re-export `nodes`, `render`, `reify`, and `traverse`.
  - `export const packageName = "@jplmm/kernel-ir";`
- Modify: nothing.
- Remove: nothing.
- Why:
  - Other packages should import kernel types and helpers from one stable surface.

## `packages/kernel-ir/test/kernel_ir.test.ts`
- Functions: test-only.
- Add:
  - Test that `reifyKernelProgram` maps `parallel_array` back to `array_expr` and `linear_sum` back to `sum_expr` without changing ids.
  - Test that `collectKernelSites` returns the expected `exprId`, `tag`, `bindingCount`, and sorted captures.
  - Test that a top-level `parallel_array` built from a function with named extents does not list those extent names as captures.
  - Test that an inner `parallel_array` or `linear_sum` nested inside another comprehension body does list referenced function-level extent names as captures.
  - Test that `renderKernelFunction` prints `parallel_array` and `linear_sum` instead of IR tags.
- Modify: nothing.
- Remove: nothing.
- Why:
  - The new package needs direct unit coverage before optimize/proof start depending on it.

## `packages/optimize/package.json`
- Functions: none.
- Add:
  - Dependency on `@jplmm/kernel-ir`.
- Modify: nothing.
- Remove: nothing.
- Why:
  - The optimize pass now emits `KernelProgram` and uses shared kernel traversal helpers.

## `packages/optimize/src/types.ts`
- Functions: none.
- Add:
  - Import `type KernelProgram` and `type KernelSite` from `@jplmm/kernel-ir`.
  - `type KernelizeResult = { program: KernelProgram; changed: boolean; sites: KernelSite[] }`
  - `OptimizePassName` member `"kernelize"`.
  - `OptimizeStages["kernel"]`.
  - `OptimizeCertificates["kernelize"] = { sites: KernelSite[] }`.
  - `ProvenanceStage` member `"kernelize"`.
  - `OptimizeProvenance["finalOptimizedToKernel"]`.
- Modify:
  - Extend `OptimizeResult`, `OptimizeCertificates`, `OptimizeStages`, and `OptimizeProvenance` to carry the kernel floor data.
- Remove: nothing.
- Why:
  - The optimize result is the source of truth consumed by the semantics ladder and by `validateOptimizeCertificates`.

## `packages/optimize/src/index.ts`
- Functions: none.
- Add:
  - `export * from "./kernelize";`
- Modify: nothing.
- Remove: nothing.
- Why:
  - Tests and proof code need access to the new pass and its helper types.

## `packages/optimize/src/kernelize.ts`
- Functions to add:
  - `kernelizeProgram(program: IRProgram): KernelizeResult`
  - `kernelizeGlobal(global: IRGlobalLet, boundGlobals: Set<string>): KernelGlobalLet`
  - `kernelizeFunction(fn: IRFunction): KernelFunction`
  - `kernelizeStmt(stmt: IRStmt, functionScope: Set<string>, lexicalScope: Set<string>): KernelStmt`
  - `kernelizeExpr(expr: IRExpr, functionScope: Set<string>, lexicalScope: Set<string>): KernelExpr`
  - `kernelizeParallelArray(expr: Extract<IRExpr, { tag: "array_expr" }>, functionScope: Set<string>, lexicalScope: Set<string>): KernelExpr`
  - `kernelizeLinearSum(expr: Extract<IRExpr, { tag: "sum_expr" }>, functionScope: Set<string>, lexicalScope: Set<string>): KernelExpr`
  - `collectFunctionScope(fn: IRFunction): Set<string>`
  - `collectCaptureNames(expr: IRExpr, functionScope: Set<string>, lexicalScope: Set<string>, locallyBound: Set<string>): string[]`
  - `collectKernelSiteMetadataFromIr(program: IRProgram): KernelSite[]`
- Add:
  - Deterministic syntax-directed lowering from final optimized IR into kernel IR.
  - Preserve every original `id`, `resultType`, binding order, statement order, function order, and struct definition.
  - For every `array_expr`, emit `parallel_array` and compute `captures`.
  - For every `sum_expr`, emit `linear_sum` and compute `captures`.
  - Build `functionScope` from:
    - function parameter names
    - every named array extent introduced by the function parameter types
  - Build `lexicalScope` from the names currently bound at the current lowering point.
  - Capture rule for a kernel site:
    - names in `lexicalScope` are not captures for that kernel
    - names from `functionScope` that are not in `lexicalScope` are captures for that kernel
    - binder names introduced by the kernel itself are never captures for that kernel
  - Top-level kernel rule:
    - the first kernel directly in the function body starts with `lexicalScope === functionScope`
    - function parameters and named extents are therefore not captures for that top-level kernel
  - Nested kernel rule:
    - when lowering the body of a `parallel_array` or `linear_sum`, recurse with `lexicalScope` extended only by that kernel's binders
    - function-level extent names are therefore captures for any nested kernel that references them, unless that same name was rebound inside the outer kernel body
  - Thread lexical scope through `let` statements and through array/sum binders so nested kernels get correct capture lists.
  - Return `sites: collectKernelSites(kernelProgram)`.
- Modify: nothing.
- Remove: nothing.
- Why:
  - This is the actual floor-construction pass. It is the only place that should decide which IR nodes become kernel nodes and what each kernel captures.

## `packages/optimize/src/provenance.ts`
- Functions to add:
  - `buildKernelExprProvenance(input: IRProgram, output: KernelProgram): ExprProvenance`
  - `assignKernelExprProvenance(...)`
  - `collectKernelExprIds(...)`
- Modify:
  - Extend `inferProvenanceRule` to handle `stage === "kernelize"`.
  - Extend `mapExprTagToRule` so:
    - `parallel_array -> kernelize_parallel_array`
    - `linear_sum -> kernelize_linear_sum`
  - Reuse the same `status` rules:
    - same `id` and same tag => `preserved`
    - same `id` with renamed tag => `rewritten`
    - new `id` => `generated`
- Remove: nothing.
- Why:
  - The semantics dump already records floor-to-floor provenance; the kernel floor needs the same treatment.

## `packages/optimize/src/certificates.ts`
- Functions to add:
  - `validateKernelizePassCertificate(finalProgram: IRProgram, kernelProgram: KernelProgram, certificate: OptimizeResult["certificates"]["kernelize"]): OptimizeCertificateValidation`
- Modify:
  - Add `kernelize` to `OptimizeCertificateChecks`.
  - Add `kernelize` to `validateOptimizeCertificates`.
  - In `validateKernelizePassCertificate`:
    - reify `kernelProgram` with `reifyKernelProgram`
    - compute expected sites with `collectKernelSiteMetadataFromIr(finalProgram)`
    - compute actual sites with `collectKernelSites(kernelProgram)`
    - fail if the reified IR differs from `finalProgram`
    - fail if any site is missing, extra, or has the wrong capture set
- Remove: nothing.
- Why:
  - Kernelization needs a local checker that is independent of the pass output structure and proves the new floor is a pure relabeling plus capture annotation.

## `packages/optimize/src/pipeline.ts`
- Functions to modify:
  - `optimizeProgram`
- Add:
  - Import `kernelizeProgram`, `validateKernelizePassCertificate`, and `buildKernelExprProvenance`.
  - Run `kernelizeProgram(current)` after `guard_elimination` and before implementation artifacts.
  - Build a `kernelize` report entry with:
    - `parallel_sites=<count>`
    - `linear_sites=<count>`
    - certificate/proof-gate detail
  - Populate:
    - `stages.kernel`
    - `certificates.kernelize`
    - `provenance.finalOptimizedToKernel`
- Modify:
  - Extend the returned `reports`, `stages`, `certificates`, and `provenance`.
  - Update `finalIdentity.reason` to say that `kernel_ir` and implementation artifacts are emitted after the final optimized IR floor.
  - When `proofGateCertificates === true`, reject invalid kernelization by throwing an error instead of silently dropping the floor.
- Remove: nothing.
- Why:
  - The optimize pipeline is where the kernel floor becomes a first-class output rather than an ad hoc side computation.

## `packages/optimize/test/optimize.test.ts`
- Functions: test-only.
- Add:
  - Test that `optimizeProgram(...).stages.kernel.program` contains `parallel_array` and `linear_sum` for a matmul-like example.
  - Test that `result.certificates.kernelize.sites` matches the expected `exprId` and capture names.
  - Test that a top-level `parallel_array` in `matmul(A:int[rows][d1], B:int[d2][cols])` does not capture `rows`, `d1`, `d2`, or `cols` when referenced directly in that outer kernel.
  - Test that a nested `parallel_array` or `linear_sum` inside a comprehension body does capture referenced function-level extent names such as `rows` and `cols`.
  - Test that `validateOptimizeCertificates(result).kernelize.ok === true`.
  - Test that `result.provenance.finalOptimizedToKernel` includes `kernelize_parallel_array` and `kernelize_linear_sum`.
- Modify:
  - Extend the existing certificate test to assert `checks.kernelize.ok`.
- Remove: nothing.
- Why:
  - The optimize package needs direct coverage for the new pass, certificate, and provenance outputs.

## `packages/proof/package.json`
- Functions: none.
- Add:
  - Dependency on `@jplmm/kernel-ir`.
- Modify: nothing.
- Remove: nothing.
- Why:
  - The ladder builder and certificate revalidator now import kernel floor types and helpers.

## `packages/proof/src/compiler_ladder.ts`
- Functions/types to add:
  - `type SemanticsKernelFloorRecord`
  - `buildKernelFloorRecord(program: KernelProgram, symbolPrefix: string): SemanticsKernelFloorRecord`
  - `serializeKernelExprSemantics(...)`
  - `collectKernelExprNodes(...)`
- Functions/types to modify:
  - `SemanticsCompilerRecord`
  - `SemanticsEdgeRecord`
  - `SemanticsCertificateRecord`
  - `buildCompilerSemantics`
  - `checkCompilerSemanticsRecord`
  - `buildIrEdgeRecord`
- Add:
  - Import `type KernelProgram`, `type KernelExpr`, `renderKernelExpr`, `renderKernelFunction`, `reifyKernelProgram`, and `kernelExprChildren`.
  - Add `floors.kernel`.
  - Add `analyses.provenance.finalOptimizedToKernel`.
  - Add certificate kind `"kernelize"`.
  - Add edge `final_optimized_ir -> kernel_ir`.
  - In `buildKernelFloorRecord`, analyze the reified IR program, but render expressions/functions with the kernel renderer.
- Modify:
  - Bump `schemaVersion` from `1` to `2`.
  - Widen `buildIrEdgeRecord` so it can be used for `final_optimized_ir -> kernel_ir` by comparing `finalOptimized.program` to `reifyKernelProgram(kernel.program)`.
  - In `buildCompilerSemantics`, build `kernelCertificate` with `validateKernelizeCertificate(...)`, build the kernel floor, and insert the kernel edge before `closed_form_impl_ir`.
  - In `checkCompilerSemanticsRecord`, rebuild and revalidate the kernel edge.
- Remove: nothing.
- Why:
  - The proof bundle has to serialize, recheck, and display the new floor exactly the same way it already handles the IR floors.

## `packages/proof/src/compiler_ladder_certificates.ts`
- Functions to add:
  - `validateKernelizeCertificate(finalProgram: IRProgram, kernelProgram: KernelProgram, certificate: OptimizeResult["certificates"]["kernelize"]): SemanticsCertificateRecord`
  - `revalidateKernelizeCertificate(edges: SemanticsEdgeRecord[], finalProgram: IRProgram, kernelProgram: KernelProgram): SemanticsCertificateRecord | null`
- Modify:
  - Extend `revalidateCertificate`'s switch with the new `kernelize` kind only if that helper is reused elsewhere; otherwise leave it alone and call `revalidateKernelizeCertificate` directly from `compiler_ladder.ts`.
  - Add the `"kernelize"` branch to the `SemanticsCertificateRecord` switch exhaustiveness.
  - Kernelize validation payload must include:
    - `reifiedMatchesFinal`
    - `missingSites`
    - `extraSites`
    - `captureMismatches`
- Remove: nothing.
- Why:
  - The compiler ladder needs a serialized certificate for the kernel edge, not just the optimize package's internal validator result.

## `packages/proof/test/kernel_ladder.test.ts`
- Functions: test-only.
- Add:
  - Build a real program with nested `array_expr` and `sum_expr`, run `optimizeProgram`, then `buildCompilerSemantics`.
  - Assert:
    - `compiler.floors.kernel.label === "kernel_ir"`
    - `compiler.edges` contains `final_optimized_ir -> kernel_ir`
    - the kernel edge marks the target function `equivalent`
    - `checkCompilerSemanticsRecord` revalidates the dumped record successfully
  - Use the transpose-view matmul program from the frontend tests as the fixture.
- Modify: nothing.
- Remove: nothing.
- Why:
  - This is the direct proof-package regression for the new floor and its rechecker.

## `packages/cli/src/semantics.ts`
- Functions/types to modify:
  - `SEMANTICS_DEBUG_SCHEMA_VERSION`
  - `buildSemanticsDebugData`
  - `checkSemanticsDebugDataBundle`
- Add: nothing.
- Modify:
  - Bump `SEMANTICS_DEBUG_SCHEMA_VERSION` from `1` to `2`.
  - Keep the rest of the serialization path the same; it should accept the updated `SemanticsCompilerRecord` shape with `kernel_ir`.
- Remove: nothing.
- Why:
  - The outer semantics document changed shape because the embedded compiler ladder changed shape.

## `packages/cli/test/cli.test.ts`
- Functions: test-only.
- Add:
  - New semantics-mode test for the transpose-view matmul source asserting:
    - `compiler.floors.kernel.label === "kernel_ir"`
    - `compiler.floors.kernel.functions[...]` render `parallel_array` and `linear_sum`
    - the `final_optimized_ir -> kernel_ir` edge marks `matmul` as `equivalent`
    - `compiler.analyses.provenance.finalOptimizedToKernel.byOutputExprId` is populated
- Modify:
  - Update the existing semantics bundle test to:
    - expect `schemaVersion === 2`
    - expect `compiler.schemaVersion === 2`
    - assert the new `kernel` floor exists
    - stop indexing edges by fixed array offsets after `canonical_range_facts`; use `.find()` by `from`/`to` because inserting the kernel edge changes the order
    - assert the new `kernelize` certificate exists and validates
- Remove: nothing.
- Why:
  - CLI semantics mode is the public path that exposes the ladder; the test must pin the new floor and the new edge.

## `packages/cli/test/examples-ladder.test.ts`
- Functions: test-only.
- Add:
  - A second pass over `grid_relax` examples checking the `final_optimized_ir -> kernel_ir` edge and requiring `relax` to be `equivalent`.
  - A second pass over `tracker_settle` examples checking the `final_optimized_ir -> kernel_ir` edge and requiring `score` to be `equivalent`.
- Modify: nothing.
- Remove: nothing.
- Why:
  - The example corpus already exercises recursive array-heavy functions; the kernel floor has to stay equivalent on that corpus.

## Files that should not change for this step
- `packages/frontend/src/refine.ts`
- `packages/proof/src/refinement.ts`
- `packages/proof/src/ir.ts`
- `packages/proof/src/scalar.ts`
- `packages/cli/src/index.ts`
- `packages/backend/*`
- Why:
  - The kernel IR pipeline step is only:
    - final optimized IR -> kernel IR lowering
    - certificate/provenance plumbing
    - ladder serialization/revalidation
  - No source refinement logic, backend emission, or scalar symbolic semantics changes are required to land this floor.
