# Claude Evaluation: JPL-- Architecture, Spec, and Optimization Plan

This evaluation covers spec.md, arch.md, opt_guide.md, and opt_arch.md after
the current round of fixes. I was involved in identifying and making several
of those fixes, so I'm writing with full context of what changed and why.

---

## Architecture to Spec Mapping

The mapping is good and getting tighter with each revision. The core pipeline
structure — frontend enforces language rules, verify owns proof obligations,
IR lowers structure, optimize transforms, backend emits — cleanly separates
concerns. Nothing in the architecture fights the spec. A few specifics:

**What maps cleanly:**

The `rad` dead-node lifecycle is the best-designed piece of the architecture.
Treating `rad` as a proof annotation that generates a dead `RadExpr` IR node
solves the tension honestly: `rad` is compile-time only by default, but Aitken
and range analysis can read or clone it when they need it, and WASM emission
just drops dead nodes. This is not a hack — it is the right design.

The sentinel node strategy for Group 1 is similarly clean. `TotalDiv`,
`TotalMod`, and `NanToZero` are first-class IR nodes that carry their
semantics through the algebraic group as opaque wrappers, fold correctly at
compile-time constants, and expand branchlessly in Group 4. The `foldConstant`
method requirement on each sentinel type (rather than pattern-matching through
wrappers) is the right enforcement mechanism.

Single-pass binding enforced entirely in `resolve.ts` is correct and load-
bearing. The call graph being a DAG is not a convenience — it is what makes
compositional termination verification possible, and the arch correctly treats
it that way.

**One remaining doc inconsistency:**

The WASM code block in opt_guide §1.3 is incomplete. The comment says:

    ;; result = (y == 0) ? 0 : raw

but the code only shows the safe-divisor trick (`y | eqz(y)` then `div_s`)
without the subsequent `select`. The prose says "safe-divisor plus `select`"
which is correct, but the code block stops before showing it. The spec and
opt_arch both present the complete expansion correctly (`select(0, raw, is0)`).
The code block in opt_guide §1.3 needs the `select` instructions added.

**`res` / `rec` ordering constraint:**

The spec says `rec` must follow at least one prior `ret`. The rationale is
that `rec` may collapse to `res`, so `res` must be initialized. This is
correct. The one confusing case is the `bad` example:

    fun bad(x : int) : int {
        ret rec(x - 1)   // ERROR: no prior ret
        rad x
    }

The `rec` is inside the first `ret`, not after it. The error message ("res has
no meaningful value") is correct — if `rec` collapsed here, it would return an
uninitialized `res`. But a reader might think "but there IS a ret here." The
arch correctly handles this as a linear scan in `resolve.ts`; the spec's
explanation of the rationale could be clearer about the ordering being
evaluated at expression level, not statement level.

---

## Spec Correctness

**The `gas` multiple-statement edge case is unspecified.**

The spec says `rad` and `gas` are mutually exclusive and a function may contain
multiple `rad` statements. It does not say what happens with multiple `gas`
statements. The execution model says "`gas N` initializes a fuel counter (if
not already active)" — implying the second one is a no-op. But this is not
explicitly stated, and whether multiple `gas` statements are a compile-time
error or silently idempotent should be pinned down somewhere. It's a small
surface but someone will write it.

**The `-0.0` concern is real but narrow.**

The spec treats `-0.0 == +0.0` in the fixed-point collapse check (they are
adjacent in the monotonic bit-order ULP representation). The NanToZero guard
canonicalizes to `+0.0`. For most functions this is fine. But for functions
where sign of zero is semantically significant — `atan2(-0.0, -1.0) = -π`
vs `atan2(+0.0, -1.0) = +π` — the convergence check could fire incorrectly
if one side carries `-0.0` and the other `+0.0`. The practical scope is narrow
(only matters for angular state spaces using sign-sensitive operations), but
the spec should state explicitly that `-0.0` and `+0.0` are considered equal
for convergence purposes and note the implication for angular computations.

**The Collatz example is slightly misleading.**

The spec uses Collatz as the `gas` example. The function as written does not
compute the standard Collatz sequence — it applies one Collatz step per
iteration but the fixed-point collapse condition (`res == x`) fires when the
step result equals the input, which in practice doesn't happen cleanly. The
`gas 1000` exhausts and returns whatever `res` was at that point. This is
a fine example of `gas` preventing divergence, but the framing ("no
conditionals, so we use a trick") implies the function produces a meaningful
result, which it doesn't. Worth either replacing with a cleaner example or
being explicit that gas-exhaustion behavior is the point.

---

## Feasibility by Phase

**Phase 1 (MVC):** Solid. tree-sitter for a ~30-production grammar, TypeScript
AST with discriminated unions, structural verification only, naive loop-based
WASM — this is a well-understood compiler pipeline applied to a small language.
The main gotcha is the float ULP comparison in the fixed-point check: the
monotonic bit-order formula (`ord(u) = sign ? ~u : (u | 0x80000000)`) is easy
to get subtly wrong at the boundary cases (`+0/-0`, infinities, denormals).
Write focused tests before shipping Phase 1.

**Phase 2 (Core optimizations):** Doable with real effort, no research
unknowns. Range analysis, sentinel folding, LUT tabulation, Lyapunov unrolling,
and SIMD vectorization are all well-understood techniques. The marquee demo
(sqrt pattern-matched to `sqrtf`, Newton's method fully unrolled to a
straight-line block) is achievable and will demonstrate the thesis clearly.

The `multi-rec` expression case needs explicit IR invariants before Phase 2.
The Fibonacci example has two `rec` calls in one expression:

    ret max(res, rec(max(0, x - 1)) + rec(max(0, x - 2)))

The loop-based IR lowering handles this correctly (both recs are evaluated
independently), but the IR needs to specify evaluation order and what happens
when one collapses and the other doesn't. Currently neither the arch nor the
IR doc makes this explicit. It will come up during implementation.

**Phase 3 (Symbolic + SMT verification):** Doable. Z3-wasm via `z3-solver` npm
is used in production tools (Boogie, some VS Code extensions). The symbolic
factorization for the Babylonian contraction ratio is the hardest part of the
non-Z3 path; if that works, most real programs will never reach Z3. The async
handling in the LSP (three-state proof status, cancellation on edit) is
well-designed.

**Phase 4 (LSP):** Very doable. tree-sitter incremental parsing is mature. The
async Z3 boundary is the only unusual piece and the design for it (pending
state, non-blocking diagnostics, cancel-on-edit) is correct.

**Phase 5 (Research):** Mixed. See below.

---

## Research Pass Assessment

**Aitken Extrapolation (Pass 2.4):** Sound and likely high ROI for slowly-
converging functions. The `rad`-based validation of the extrapolated value is
the right soundness check — if the extrapolation is bad, the fallback always
terminates. One underspecification: the validation condition is
`rad(S_∞) < rad(S₂)` AND `rad(S_∞) < ULP`. "ULP" of what? The spec defines
ULP in the context of comparing parameter values. Here it presumably means
`ULP(S_∞)` for float or `1` for int. This needs to be pinned down in opt_guide
before implementing.

**Convergence Wavefront Scheduling (Pass 3.3):** Well-specified and doable.
Stream compaction with `i8x16.swizzle` and bitmasks is standard GPU/SIMD
compute applied to WASM. The active mask and compact/retire IR nodes are
clearly defined. This is mostly engineering.

**Separability Analysis (Pass 3.2):** Feasible for the constrained cases
described (multiplicative or additive i-only/j-only factoring). Not a general
algebraic separability solver — and it doesn't need to be. Detecting
`body = I_only * J_only` by partitioning sub-expression variable dependencies
is a tractable analysis. The validation step (proving commutativity of the
combining operation) is the hard part and may need to be pattern-restricted
rather than proven generally.

**Linear Speculation (Pass 3.4):** The design is intellectually coherent — the
absence of branching makes the speculation linear rather than a tree, which is
the key insight. The Total Arithmetic prerequisite is correctly identified as
load-bearing. But: the docs explicitly acknowledge that on the primary target
(WASM in browser), the two-thread model is "not directly viable due to
SharedArrayBuffer overhead." The single-thread benefit ("separating compute and
check basic blocks helps the WASM engine's OOO scheduler") is speculative and
uncheckable without profiling. This pass is primarily a contribution for arm64
native lowering. That's fine — label it that way clearly. As written, it reads
as more WASM-relevant than it is.

**CAS Fixed-Point Resolution (Pass 2.2):** The Pyodide/SymPy dependency is
still in opt_arch. This is the biggest unresolved concrete dependency in the
entire research tier. SymPy via Pyodide is a ~50MB Python runtime with
non-deterministic memory behavior and a 500ms timeout that in practice often
means "CAS loaded but didn't finish." The pattern matcher (Pass 2.1) will
catch 95%+ of real-world cases. I would recommend either: (a) committing to
a specific lightweight JS CAS (nerdamer, algebrite) and listing it as a real
dependency, or (b) moving CAS to a reach goal and not listing it as an
implementable pass. "SymPy via Pyodide, or a lightweight JS CAS" is not an
implementation plan.

**V-Cycle (Pass 3.5):** Now correctly specified with bounded-stencil detection,
depth-1 only, and whitelist-based soundness. The placeholder status in opt_arch
is the right call. The prerequisite list (3.2 stable, stencil-detection
sub-analysis, extended pattern registry) is concrete and correct. Putting it
dead last in implementation order is right.

---

## What I Think

The core thesis is honest and holds up: language restrictions that would
normally reduce expressiveness (no branches, finite state space, required
termination proofs) are directly responsible for optimizations that would be
unsound or unimplementable in general-purpose languages. LUT tabulation is the
clearest example — it works because `rad` guarantees you can evaluate every
input at compile time, which you can never do in a Turing-complete language.
The argument is not hand-waving; it is correct.

The implementation plan is realistic. Phases 1-4 produce useful, demonstrable
intermediate results at each step. You don't need the research passes to have a
working, interesting compiler. That's the right shape for a research project —
you have a floor that works and a ceiling that's ambitious.

The remaining rough edges are mostly in the research tier documentation rather
than in the architecture itself. The core pipeline (frontend, verify, IR,
Group 1-4) is well-specified and buildable. The float ULP comparison, multi-rec
expression lowering, and sentinel folding semantics all need focused tests
before you'll trust them.

The one architectural question I'd push on: the implementation order puts
symbolic verification (Phase 3) after core optimizations (Phase 2). That means
during Phase 2, only structural verification is available. Several of the Phase
2 demo programs — Babylonian sqrt with `rad g - res`, integer sqrt with the
same — require symbolic verification to compile with `rad`. If you can only
verify structural decrease in Phase 2, your Phase 2 demos are limited to
programs with `rad x` (simple structural cases). Either verify/symbolic.ts
should move into Phase 2 (before or alongside the optimizer), or the Phase 2
result description should be honest that the Babylonian demo requires Phase 3.

---

## Open Issues (Summary)

| Issue | Severity | Location |
|-------|----------|----------|
| WASM code block in opt_guide §1.3 missing `select` instructions | Minor | opt_guide.md §1.3 |
| Multiple `gas` statements in one function: error or no-op? | Minor | spec.md |
| `-0.0` / `+0.0` equality in convergence check: note implications for angular computations | Minor | spec.md |
| Collatz example: clarify that gas-exhaustion behavior (not correctness) is the point | Minor | spec.md |
| Aitken validation ULP: specify "ULP of what" | Minor | opt_guide.md §3.1 |
| Multi-`rec` expression IR evaluation order: needs explicit invariant | Moderate | ir/arch.md |
| CAS dependency (Pyodide): commit to a concrete choice or move to reach goal | Moderate | opt_arch.md §2.2 |
| Phase ordering: symbolic verification needed for Phase 2 demos | Moderate | arch.md implementation order |
| Tier 2.4 (opt_guide) vs Pass 2.4 (opt_arch) name collision | Minor | both |
