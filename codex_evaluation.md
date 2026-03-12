# Codex Evaluation: Architecture, Spec, and Optimization Plan

Prompt addressed:
"tell me if the architecture and plan are actually mapping correctly onto the spec and optimization goals. tell me if everything including the research passes is doable and well laid out. tell me what you think"

## Executive Verdict

The architecture maps to the spec well, and the implementation plan is credible.
After the recent semantic fixes (zero-divisor canonicalization to zero, stack-neutral `rec` lowering with optional tail-call fast paths, NaNless float domain), the docs are substantially more internally consistent.

This is not "automatic success," but it is a strong and executable research compiler plan.

## What Is Mapping Correctly

1. Language semantics to IR staging is coherent.
`verify` owns proof obligations, `ir` owns execution shape, `optimize` owns transformations, `backend` owns lowering.

2. `rad` lifecycle is thoughtfully designed.
`rad` remains compile-time for correctness while still being available as optimization metadata (`RadExpr` dead node + selective cloning).

3. `rec` model is now robust.
Spec requires stack-neutral iteration semantics, while backend opportunistically uses `return_call` only where legal.

4. Total arithmetic strategy is now aligned with your goals.
Integer and float zero-divisor behavior are explicit and branchless-lowerable; NaN elimination is represented as canonicalization with optimization cleanup.

5. Optimization group boundaries are appropriate.
Group 1 builds semantic invariants and metadata; Groups 2-3 consume those invariants; Group 4 lowers mechanically.

## Remaining Friction Points (Fixable)

1. Numbering/ordering language is still a little confusing in places.
The optimization summary now correctly runs Total Arithmetic before Range Narrowing, but tier labels (`1.3` then `1.1`) can mislead readers. This is editorial, not architectural.

2. NaNless policy needs disciplined implementation tests.
The docs now intentionally favor broad NaN canonicalization for optimizer simplicity, but this adds performance pressure on guard elimination quality.

3. Float convergence equality is easy to get subtly wrong in implementation.
The monotonic-bit-order ULP rule is good, but it should be backed by focused tests (`+0/-0`, infinities, adjacent representables, denormals).

4. Multi-`rec` expression lowering complexity remains nontrivial.
Your semantics allow `rec` in general expressions, not just tail position. The loop-based lowering handles this, but it needs clear IR invariants and tests.

## Doability by Phase

1. Phase 1 (MVP compiler): highly doable.
2. Phase 2 (core optimizations): doable with moderate engineering effort.
3. Phase 3 (symbolic + SMT): doable, but solver/runtime constraints need careful budgeting.
4. Phase 4 (LSP + DX): very doable.
5. Phase 5 (research passes): mixed, with clear separation between practical and speculative passes.

## Research Pass Assessment

1. Aitken extrapolation: doable and likely high ROI if validation/fallback logic is strict.
2. Wavefront scheduling: doable; mostly engineering.
3. Linear speculation: research-feasible, but hardware/runtime-dependent; likely strongest outside browser-WASM constraints.
4. CAS fixed-point resolution: feasible as opportunistic/timeout-limited; do not make it a critical path.
5. Separability rewrite: feasible for constrained pattern classes; general separability remains hard.
6. V-cycle multiresolution: most speculative; should remain explicitly "open/experimental."

## What I Think

This is a serious architecture, not hand-wavy design fiction.
The key reason it works is that the language restrictions are not fighting the optimizer; they are intentionally creating optimizer-friendly invariants.

If you keep the scope discipline you already have (default pipeline practical, research passes opt-in), this is both doable and publishable as a research compiler trajectory.
