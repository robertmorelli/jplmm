# Codex Answers

Answers to questions in `gemini_questions.md` and `claude_questions.md`.
These are implementation decisions/recommendations intended to unblock build-out.

## Answers to Gemini Questions

### G1. LUT memory management
Use a global LUT budget plus per-function profitability. Keep current per-function thresholds, but also cap total LUT bytes per module and evict low-value candidates first (cold callsites, poor speedup estimate).

### G2. Cascading range resolution
Default to one monomorphic function body with interval transfer summaries. Do not clone specialized versions in v1. If added later, specialization must be capped by a hard variant limit per function.

### G3. Absorption brittleness
Absorption analysis is an optimization only. Misses should leave semantically correct code and only cost performance. Track misses with pass stats so regressions are visible.

### G4. Cost of broad NaN guards
Yes, broad guards add measurable overhead if guard-elim is weak. That is acceptable for semantic simplicity in canonical IR; performance recovery is delegated to Guard Elimination and later lowering. Keep this gated by benchmarks.

### G5. Signed zero semantics
`NanToZero` should preserve non-NaN payloads (including `-0.0`). Total zero-divisor canonicalization may produce `+0.0`. Document that signed-zero-sensitive functions (`atan2`) may differ from strict IEEE edge behavior in zero-divisor paths.

### G6. `rec` argument saturation
Yes. Fixed-point checks operate on language-level values after saturating semantics are applied. Equality sees saturated values, not pre-saturation intermediates.

### G7. Multi-`rec` heterogeneous convergence
Semantics are strict left-to-right expression evaluation with independent `rec` evaluations. If `rec(x)` converges quickly, it does not keep re-running while `rec(y)` continues.

### G8. Register/stack pressure with multi-`rec`
Lower to ANF/three-address IR with explicit temporaries, then schedule into wasm locals. Split large expressions early to avoid pressure spikes; treat this as an IR normalization invariant.

### G9. SMT timeout determinism
Use solver resource limits (`rlimit`) and fixed solver seed, not only wall-clock timeout. `unknown/timeout` should deterministically fail verification in CLI with a clear diagnostic.

### G10. ULP distance at infinities
Special-case infinities: collapse only if both are same-sign infinity. Do not use finite ULP tolerance across finite↔infinity boundary.

### G11. WASM atomics overhead in Strategy B
Correct risk. Keep true multi-thread speculation off by default on wasm; treat as native-target optimization first. On wasm, use single-thread structural decoupling only.

### G12. Aitken + speculation rollback
Thread/worker doing checks owns Aitken validation. If validation passes, set atomic halt+result. If it fails, no rollback signal is needed; compute thread continues normally.

### G13. WasmGC pressure in `rec` loops
Do not rely on per-iteration GC allocation. Require scalar replacement/escape analysis for hot loops, or keep heap-heavy recurrences out of aggressive optimization paths.

### G14. `ref.eq` false negatives
Correctness is preserved by fallback structural comparison. Improve hit-rate via structural sharing and CSE/hash-consing where cheap, but treat as an optimization, not a requirement.

### G15. CAS dependency choice
Do not depend on Pyodide in core compiler. Keep CAS resolution experimental and optional. Pattern matching is the practical default algebraic path.

### G16. Symbolic verification phase ordering
Split symbolic verification into tiers: minimal symbolic support needed by core demos should move earlier (with structural), while advanced factorization remains later.

## Answers to Claude Questions

### C1. Which `res` does `rad` see?
`rad` resolves `res` to the symbolic value defined by the nearest preceding `ret` in straight-line statement order at that program point. If none exists, it is a compile-time error.

### C2. Multiple `gas` statements
Make this a compile-time error: at most one `gas` statement per function.

### C3. Shadowing in `array`/`sum` variables
Keep "no shadowing" uniform, including loop bindings. Nested loops must use distinct binder names in v1.

### C4. `res` type vs `rad` scalar requirement
`rad` expressions must be scalar numeric (`int`/`float`). Composite-return functions can still use `rad`, but via scalar measures over parameters/derived scalars (not raw composite `res`).

### C5. `-0.0` and angular convergence
Acknowledge explicitly in spec: collapse treats `+0.0` and `-0.0` equal; signed-zero-sensitive angular behavior may differ in edge cases.

### C6. Collapse with infinities
Define explicitly: `+inf == +inf` and `-inf == -inf` collapse; opposite-sign infinities do not.

### C7. Multiple `rec` call proof/eval order
Proof obligations are per call site and independent. Runtime evaluation is strict left-to-right; one call’s collapse does not mutate caller context for sibling calls.

### C8. Array-parameter proof precondition
For arrays, "differ" means dimension mismatch or at least one element mismatch under element rules. In v1, reject hard array-valued `rad` obligations unless they fit restricted analyzable forms.

### C9. Aitken `ULP` criterion
Use state-space criterion, not radius-space: accept extrapolation only if it decreases `rad` and satisfies fixed-point proximity under normal collapse tolerance (componentwise ULP rule).

### C10. Concrete IR loop form for `rec`
Use explicit loop header with phi-like param/res/fuel state variables, body block, and backedge updates. Non-tail `rec` lowers to value-producing subgraphs that re-enter loop machinery as needed.

### C11. `gas` fuel parameter ABI
Use wrapper strategy: public function keeps original ABI; internal lowered worker carries fuel state.

### C12. Range analysis on `rec`
Use iterative dataflow to fixed point with widening/narrowing guards. Single-pass is too weak for recursive quality.

### C13. LUT tabulation with `let` and calls
Tabulation uses a compile-time evaluator for the lowered IR subset. Candidate functions must have evaluable callees and no runtime-only effects.

### C14. Symbolic verification vs Phase 2 demos
Yes, mismatch exists unless addressed. Resolution: move a minimal symbolic verifier earlier (or classify those demos as Phase 3). Prefer moving minimal symbolic earlier.

### C15. Concrete CAS plan
Treat CAS as optional plugin-based experimental path. No Pyodide dependency in default toolchain. Pattern matcher remains primary.

### C16. Tier numbering collision
Agreed. Normalize numbering so optimization names are unique across docs; keep `opt_arch.md` pass IDs canonical.

### C17. Missing `select` in code block
Agreed. Code examples should include the full safe-divisor + `select` sequence to match semantics.

### C18. Source file extension
Use `.jplmm` as the canonical source extension for JPL-- tooling (CLI, LSP, tree-sitter associations).
