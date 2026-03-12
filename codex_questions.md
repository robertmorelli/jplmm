# Codex Implementation Questions

These are implementation questions to resolve before or during build-out.

## 1. Language Frontend (Parse/Resolve/Typecheck)

1. How will `NodeId` assignment be made stable across incremental edits for LSP features?
2. Do we want deterministic `NodeId` ordering across machines/runs, or only per compilation unit?
3. What exact diagnostic should fire when `res` is used before first `ret` in nested expressions?
4. What exact diagnostic should fire when `rec` appears before first `ret`?
5. Should the parser reject all legacy JPL keywords at lex time, parse time, or resolve time?
6. How do we represent source spans for synthetic nodes introduced during lowering?
7. How strict should float literal parsing be for out-of-range or subnormal edge cases?
8. Are negative array dimensions rejected in typecheck or deferred to runtime checks?
9. How do we enforce "no shadowing" in pattern-like lvalues and nested scopes?
10. What is the exact rule for function forward references across files/modules (if multi-file is added later)?

## 2. Core Semantics and Execution Model

1. What is the canonical interpreter-level model for `rec` in non-tail expression positions?
2. How will stack-neutral loop lowering encode intermediate values for multiple `rec` calls in one expression?
3. Do we evaluate `rec` arguments left-to-right with strict sequencing, and is this observable anywhere?
4. What is the precise runtime behavior for `gas N` when multiple `rec` evaluations occur per iteration?
5. Is `gas` decremented per loop iteration, per `rec` encounter, or per non-collapsed `rec` transition?
6. What is the exact collapse rule for structs/arrays containing mixed int/float fields?
7. Should `void` be legal in any `rec` argument path, and if so, how is equality defined?
8. Are there any cases where `res` can be read after failed `ret` typing, or does typecheck halt hard?

## 3. Numeric Semantics (Total Arithmetic, Saturation, NaNless Floats)

1. Where is `TotalDiv`/`TotalMod` introduced: IR builder or Pass 1.1 only?
2. For integer `TotalDiv`/`TotalMod`, what exact branchless lowering template is canonical in backend codegen?
3. How will we guarantee the `select(0, raw, is0)` polarity is never accidentally inverted?
4. Should NaN-to-zero canonicalization be inserted for every float op in canonical IR, then eliminated?
5. Which float ops are excluded from canonical NaN guards (if any), and why?
6. Do we preserve `-0.0` where IEEE behavior matters (e.g., `atan2`) or normalize to `+0.0`?
7. How do we test and validate saturating behavior for `SatNeg(INT32_MIN)` across targets?
8. For `to_int(float)`, what are exact conversions for `+inf`, `-inf`, and signed zeros?
9. Which numeric edge cases become compile-time folds versus runtime lowered sequences?
10. Do we need a dedicated conformance test corpus for arithmetic identities and corner cases?

## 4. Fixed-Point Equality and ULP Distance

1. What exact utility function computes `ULPDistance(a, b)` using monotonic bit ordering?
2. How will we unit test adjacency behavior around `+0.0` and `-0.0`?
3. How do we handle infinities in ULP distance comparisons without overflow in integer math?
4. Is ULP tolerance configurable for experimentation, or hard-coded to 1 in all modes?
5. Will verifier assumptions and runtime collapse checks share the same implementation to avoid drift?

## 5. Verification (`rad`, structural/symbolic/SMT)

1. What subset of symbolic algebra is in-scope for v1 before SMT fallback?
2. How do we encode the `exists i` ULP-difference precondition in a practical SMT query?
3. What timeout budget is acceptable for SMT in CLI mode?
4. What is the cancellation model for in-flight SMT checks in LSP?
5. How do we ensure verifier soundness if optimization later rewrites recurrence structure?
6. What minimum proof trace should `-v` output for failed obligations?
7. Which verifier regression suite should be mandatory in CI before optimizer changes merge?

## 6. IR Design and Pass Contracts

1. What invariants are mandatory after IR builder (before Pass 1.1)?
2. Which passes are allowed to introduce new control-flow nodes versus expression-only rewrites?
3. How do we enforce "sentinel semantics are opaque" in constant folding APIs?
4. Should pass metadata be immutable persistent structures or mutable maps with snapshots?
5. What validator runs between passes to catch broken invariants early?
6. How do we track provenance when a pass clones `RadExpr` into live runtime nodes?

## 7. Optimizer Pipeline and Pass Ordering

1. Is Total Arithmetic always first, or can experimental pipelines reorder it?
2. What hard dependencies should be machine-checked versus only documented?
3. How do `--enable-pass` and `--disable-pass` avoid illegal dependency combinations?
4. Should each pass declare `requires`/`provides` metadata for automatic validation?
5. What output parity tests compare `--no-optimize` and optimized pipelines for semantic equivalence?

## 8. Backend (WASM 3.0 + Optional Targets)

1. What feature-detection path selects loop backedge lowering versus `return_call` lowering?
2. What is the fallback behavior when target engine lacks full tail-call support?
3. How are `TotalDiv` and `TotalMod` lowered in SIMD contexts?
4. How are WasmGC structures mapped when host runtime has partial GC feature support?
5. What guarantees do we need for shared-memory atomic ordering in speculation passes?
6. Which wasm engines are in the official compatibility matrix?

## 9. LSP and Developer Experience

1. Which phases run on each keystroke versus debounced/background tasks?
2. What is the maximum acceptable latency budget for diagnostics and hover updates?
3. How are stale proof results invalidated when only dependent ranges change?
4. What minimal hover info is required for `rad`/`rec` to be useful without noise?
5. How do we surface "experimental pass changed behavior/perf" insights in tooling?

## 10. Testing, Benchmarking, and Release Gates

1. What are the non-negotiable golden tests for language semantics?
2. Which benchmarks represent real target workloads for this project?
3. What performance regressions trigger a block in CI?
4. Do we need differential testing against an interpreter for every optimizer pass?
5. What is the policy for promoting an experimental pass to default?
6. What criteria define "Phase complete" for each roadmap phase?

## 11. Research Pass Gating

1. What objective metrics justify keeping Aitken enabled for a function family?
2. What safety checks are mandatory before enabling linear speculation on a target?
3. Which separability patterns are explicitly supported versus out of scope?
4. Should V-cycle remain "OPEN" until equivalence validation strategy is formalized?
5. What are the rollback criteria if a research pass hurts predictability or debuggability?
