JPL-- Optimization Goals
========================

This document describes optimization techniques that exploit the unique
invariants of JPL--: proven termination via `rad`, fixed-point convergence via
`rec`, saturating arithmetic, no conditional branching, single-pass definition
order, and 32-bit scalar types. The target backend is WASM 3.0 (GC, typed
references, tail calls, relaxed SIMD) with optional lowering to arm64 via
existing WASM engines.

The optimizations are organized into tiers by implementation difficulty and
research maturity. Tier 1 optimizations should be implemented first. Tier 2
optimizations are doable with moderate effort. Tier 3 optimizations are
research-grade — they belong in the paper and may eventually land in the
compiler. The Reach Goals section describes the long-term vision.


Tier 1: Core Optimizations
---------------------------

### 1.1 Range-Narrowing and LUT Tabulation

**The marquee optimization.** This is unique to JPL-- and not sound in
Turing-complete languages.

JPL-- heavily relies on `max`, `min`, `clamp`, and `abs` as substitutes for
conditional branching. Each of these narrows the range of a value:

- `clamp(x, 0, 255)` → `x ∈ [0, 255]`
- `max(0, x)` → `x ∈ [0, INT32_MAX]`
- `x % 10` → `x ∈ [-9, 9]` (or `[0, 9]` if `x ≥ 0` is known)
- `abs(x)` → `x ∈ [0, INT32_MAX]`

The compiler propagates these intervals forward through abstract interpretation.
At each function boundary, the product of all parameter ranges gives the total
state-space cardinality:

    cardinality = Π range_size(param_i) for all i

If the cardinality is below a threshold, the function is a candidate for
compile-time tabulation:

- **≤ 256 states:** Always tabulate. Single-byte LUT. A unary `f(x)` where
  `x ∈ [0, 255]` becomes a 256-byte table and a single indexed load.
- **≤ 65,536 states:** Tabulate if the function is called in a hot loop (e.g.,
  inside an `array` or `sum` expression). 64 KB LUT.
- **≤ 2^24 states:** Tabulate only for inner kernels over images or arrays
  where the LUT fits in L2 cache.

**Why this is sound in JPL-- and unsound elsewhere:** Tabulation requires
evaluating the function for *every* input at compile time. In a Turing-complete
language, you can't do this — the function might not halt for some inputs. In
JPL--, every `rad`-verified function is provably total. The compiler can safely
evaluate it at compile time for any input. This is the fundamental payoff of the
termination guarantee.

**Cascading narrowing through the call DAG:** Because definition order is
single-pass, the compiler resolves range information bottom-up. If `inner(y)`
is tabulated and its output range is `[0, 9]`, that information propagates to
every caller. Callers' state spaces shrink, potentially enabling *their*
tabulation. This cascading effect compounds through the call graph.

**No `u8` type needed.** The range-narrowing pass subsumes a dedicated `u8`
type. The compiler infers the effective domain from `clamp`/`max`/`min` usage.
Adding `u8` to the type system would create casting rules, interaction with
`i32`, and new saturating semantics — all unnecessary if the compiler can infer
the domain automatically.


### 1.2 `rec` Lowering with Tail-Call Fast Path

`rec` lowering is stack-neutral by construction. The baseline lowering is an
explicit loop/backedge. When a `rec` site is in tail position and the target
supports tail calls, the compiler emits WASM `return_call` as a fast path.

```
;; JPL--
fn f(x : int) : int {
    ret x * x
    ret rec(res - 1)
    rad res
}

;; WASM 3.0 pseudocode
(func $f (param $x i32) (result i32)
    (local $res i32)
    ;; ret x * x
    (local.set $res (i32.mul (local.get $x) (local.get $x)))
    ;; rec(res - 1): fixed-point check
    (local.set $next (i32.sub (local.get $res) (i32.const 1)))
    (if (i32.eq (local.get $next) (local.get $x))
        (then (return (local.get $res)))
    )
    ;; tail-position fast path
    (return_call $f (local.get $next))
)
```

For `gas N` functions, the fuel counter is an additional `i32` parameter
decremented on each iteration (or on each `return_call` when tail-lowered).


### 1.3 Total Arithmetic (Branchless Trap Elimination)

JPL-- defines canonical results for all mathematically undefined operations.
No operation can trap, fault, or produce a hardware exception. This is not
merely a language design choice — it is a mandatory optimization enabler.

**Why Total Arithmetic is required for speculation:** The linear speculative
execution model (§3.6) has Thread A computing past the actual fixed point into
garbage states. In a normal language, a garbage state might hit `x / 0`,
triggering a `SIGFPE` hardware trap and crashing the program. Total Arithmetic
ensures Thread A computes canonical garbage and keeps burning ALU cycles. Thread
B finds the valid fixed point and silently discards the garbage. Complex
control-flow rollbacks are replaced with simple memory truncation.

**The branchless total division/mod trick (WASM 3.0):**

WASM strictly traps on integer division by zero. To prevent this without
introducing a branch (which would destroy the superscalar pipeline), the
compiler emits a safe-divisor guard plus a branchless select:

```wasm
;; x / y where y might be 0, with JPL-- rule x/0 = 0
;; y_safe = y | (y == 0)    — nonzero divisor, avoids trap
;; raw = x / y_safe
;; result = (y == 0) ? 0 : raw  — mask out the garbage quotient
local.get $y
i32.eqz
local.tee $is_zero       ;; save is_zero; stack: [is_zero]
local.get $y
i32.or
local.set $y_safe        ;; y_safe = y | is_zero
i32.const 0              ;; stack: [0]  ← value returned when y==0
local.get $x
local.get $y_safe
i32.div_s                ;; stack: [0, raw]
local.get $is_zero
select                   ;; select(0, raw, is_zero): if is_zero→0, else→raw
```

`select` is a single-cycle conditional move. The entire sequence is branchless
and trap-free. The same pattern applies to `i32.rem_s` for `x % y`.


**The "Compute Garbage" principle:** Thread A doesn't care about correctness —
it only cares about throughput. Every operation it executes is valid under Total
Arithmetic, even in garbage states. The entire arithmetic surface is a
continuous, total function from `i32 × i32 → i32`. There are no discontinuities,
no exceptional edges, no trap doors. Thread A is a pure feed-forward pipeline
that cannot stop.

**Full Total Arithmetic ruleset:**

| Operation | Undefined Input | Canonical Result | Implementation |
|-----------|----------------|------------------|----------------|
| `x / 0`  | Zero divisor   | `0`              | safe-divisor + `select(0, raw, y==0)` |
| `x % 0`  | Zero divisor   | `0`              | safe-divisor + `select(0, raw, y==0)` |
| `0.0/0.0`| Indeterminate  | `0.0`            | NaN→0 select    |
| `inf-inf`| Indeterminate  | `0.0`            | NaN→0 select    |
| `0.0*inf`| Indeterminate  | `0.0`            | NaN→0 select    |
| `sqrt(x<0)`| Negative     | `0.0`            | NaN→0 select    |
| `log(x≤0)`| Non-positive  | `0.0`            | NaN→0 select    |
| `x/0.0`  | Zero divisor   | `0.0`            | zero-divisor select + NaN→0 |
| `x%0.0`  | Zero divisor   | `0.0`            | zero-divisor select + NaN→0 |

**NaN does not exist in JPL--.** Every IEEE 754 operation that would produce
`NaN` instead produces `0.0` via a branchless two-instruction canonicalization:

```wasm
;; After any op that could produce NaN:
local.tee $temp
local.get $temp
f32.eq          ;; NaN != NaN → false; anything else → true
f32.const 0.0
select          ;; single-cycle conditional move, zero branches
```

This eliminates `NaN` as a poison value that infects downstream computation,
prevents fixed-point collapse (`NaN != NaN`), and breaks SMT/SymPy proofs.
`±inf` is retained as the float analogue of integer saturation — it is
well-behaved under comparison and does not propagate toxically.

In canonical IR, the compiler may apply NaN→0 guards broadly on float ops for a
uniform NaNless domain, then remove redundant guards with range analysis.


### 1.4 Saturating Absorption Elimination

Saturating arithmetic creates absorbing states: once a value reaches
`INT32_MAX`, adding to it is a no-op. The compiler detects these via abstract
interpretation over the saturating lattice.

When a variable's range narrows to a single point `[K, K]`, it is constant.
All downstream operations dependent on that variable are aggressively
constant-folded, pruning the active compute graph.

Example:
```
fn f(x : int) : int {
    let y = x + 2000000000
    let z = y + 2000000000    // y is in [INT32_MIN+2B, INT32_MAX]
                               // z saturates to INT32_MAX for y > 147483647
    ret z + 1                  // if z = INT32_MAX, this is INT32_MAX (absorbed)
    ...
}
```

The compiler can split the domain into regions where `z` is absorbed (constant)
vs. active, and emit specialized code for each.


### 1.5 Reference Equality for Convergence Checks

WASM 3.0 GC provides `ref.eq` for comparing GC'd references in O(1). Since
JPL-- arrays and structs are immutable, structural sharing is guaranteed. The
fixed-point collapse check for arrays becomes:

1. **Pointer compare via `ref.eq`:** O(1). If pointers match, values are
   identical. Collapse.
2. **Fall back to element-wise ULP/integer comparison:** O(n). Only if pointers
   differ.

For functions where the array parameter doesn't change across `rec` calls
(common in image kernels where only scalar parameters converge), the pointer
check eliminates the entire array comparison on every iteration.


### 1.6 Unconditional SIMD (Zero-Divergence Vectorization)

Traditional auto-vectorization fails when `if/else` paths diverge across SIMD
lanes. In JPL--, every execution path evaluates the same structural equations.
There are no branches to diverge.

The compiler packs multiple independent invocations of a function into a single
WASM SIMD register (128-bit, 4x `f32` or 4x `i32`). All lanes execute
identical instructions until each independently hits its fixed-point collapse.

When one lane converges, it masks out (its value is frozen) while others
continue. Because there's no `else` branch, the masked lane simply computes
redundant values that are discarded — no correctness issue, just wasted work on
converged lanes. For fast-converging functions (e.g., Newton's method where all
lanes converge within 1-2 iterations of each other), this waste is negligible.

WASM 3.0 relaxed SIMD provides the instruction set. For image processing, this
means 4 pixels per SIMD register, each running an independent convergent kernel.


Tier 2: Intermediate Optimizations
------------------------------------

### 2.1 Closed-Form Pattern Matching

Rather than embedding a full CAS, the compiler pattern-matches specific `rec` +
`ret` structures and replaces them with known closed forms:

| Pattern | Detection | Replacement |
|---------|-----------|-------------|
| Babylonian method | `ret (g + x/g) / 2`, `rec(x, res)` | `sqrtf(x)` |
| Linear convergence | `ret x + c`, `rec(res)`, `rad x - target` | Direct computation |
| Averaging filter | `ret (a + b) / 2`, `rec` on neighbors | Arithmetic mean |
| GCD | `ret a`, `rec(min,max%min)` | Binary GCD or HW `gcd` |

This is a peephole pass on the IR. Each pattern is a template match on the AST.
The set of recognized patterns grows over time. 5-10 patterns cover the common
cases.

**Compositional detection:** Because the call DAG is single-pass, the compiler
can detect that a function *calls* a Babylonian method and inline the closed
form. If `my_sqrt` is detected as Babylonian and `my_distance` calls `my_sqrt`,
the compiler inlines `sqrtf` into `my_distance`.


### 2.2 Lyapunov-Derived Unroll Bounds

The `rad` expression mathematically bounds the iteration count. For simple
cases, the compiler computes an exact or tight upper bound and unrolls:

**Structural recursion:** `rad x` where `x ∈ [0, N]` → at most `N` iterations.
If `N` is small (say ≤ 16), fully unroll. Zero runtime loop overhead.

**Quadratic convergence (Newton's method):** For `rad g - res` on `f32`, the
contraction ratio is `(g² - x)² / (4(g² + x)²)` which means the error gets
squared each step. Starting from the worst case `f32` range, convergence takes
at most ~6 iterations. Unroll all 6. The entire Newton's method becomes a
straight-line block of multiply-adds with no loop, no branch, no `rec` overhead.

**General strategy:** Compute `ceil(log(initial_rad / epsilon) / log(1/contraction_ratio))`.
If this is ≤ 32, unroll completely.


### 2.3 Vectorized LUT via SIMD Shuffle

When a tabulated function (from §1.1) is called inside an `array` or `sum`
expression over a SIMD-width batch, the compiler maps the LUT lookup to SIMD
byte-shuffle instructions.

WASM SIMD provides `i8x16.swizzle` — a 16-way parallel byte permutation.
Instead of 16 scalar table lookups, one `swizzle` instruction evaluates 16
inputs simultaneously.

For a function `f(x)` where `x ∈ [0, 15]`, this is a single instruction. For
`x ∈ [0, 255]`, it's a cascade of 16 swizzles with a high-nibble select. This
is the standard `pshufb` LUT decomposition used in cryptography and codec
implementations, applied automatically by the compiler.


### 2.4 Speculative Fixed-Point Convergence

The fixed-point check (`args == params?`) is evaluated *before* the `rec` call
decides whether to recurse. For scalar parameters, this check is cheap. For
large state vectors, it dominates runtime.

**Partial convergence detection:** Instead of comparing all parameters, the
compiler identifies which parameters are *actively changing* (via range analysis
on the `rec` arguments) and only checks those. Parameters that are passed
through unchanged (e.g., `rec(x, res)` where `x` is unchanged) skip the
comparison entirely — the compiler statically knows `x == x`.

**Convergence prediction:** For functions with known contraction ratios (from
`rad` analysis), the compiler can insert a cheap scalar pre-check: "has the
radius decreased below ULP?" If yes, skip the full vector comparison and
collapse immediately.


Tier 3: Research-Grade Optimizations
--------------------------------------

### 3.1 State-Space Trajectory Extrapolation (Aitken Δ²)

Execution in JPL-- represents a discrete dynamical system converging toward a
fixed-point attractor. Rather than computing every sequential step, the runtime
can sample initial states and extrapolate.

**Aitken's Δ² process:** Given three consecutive iterates `S₀, S₁, S₂`, the
extrapolated fixed point is:

    S_∞ ≈ S₀ - (S₁ - S₀)² / (S₂ - 2·S₁ + S₀)

This assumes approximately geometric convergence, which holds for Newton's
method and most contraction mappings.

**Validation:** After extrapolation, the compiler inserts a check: evaluate
`rad` at the extrapolated state. Both conditions must hold:

1. `rad(S_∞) < rad(S₂)` — the extrapolated radius is strictly smaller than
   the current radius (the radius is still decreasing).
2. `rad(S_∞) < ULP(S_∞)` for floats, or `rad(S_∞) < 1` for integers — the
   extrapolated state is within one unit of the fixed point. This reuses the
   existing fixed-point collapse criterion: the state is close enough that a
   real iteration would collapse. `ULP(S_∞)` is the unit in the last place of
   the extrapolated value itself, computed via the same ULP-distance function
   used for convergence checks.

If both conditions hold, accept the extrapolation and skip all remaining
iterations. Otherwise, fall back to sequential iteration from `S₂`.

**When it works:** Newton's method on `f32` converges in ~6 iterations. With
Aitken extrapolation from the first 3 iterates, convergence drops to ~4
iterations — a 33% reduction. For functions that converge slowly (hundreds of
iterations), the savings are dramatic: potentially skipping from iteration 3
directly to the fixed point.

**When it fails:** Functions with non-geometric convergence (oscillating,
sublinear) produce bad extrapolations that fail the `rad` validation. The
fallback is always correct. The worst case is wasted work computing the
extrapolation.

**Semantic caution:** Extrapolation changes which intermediate `res` values are
computed. For pure convergent functions the final value is identical, but the
trajectory differs. This optimization must preserve the observable result (the
final `res` at convergence), not the intermediate states.


### 3.2 Algebraic Fixed-Point Resolution

Because `rec` terminates when `args == params`, the fixed-point equation is
implicit in the function body. A CAS can sometimes solve this equation
algebraically:

```
fn f(x : float, g : float) : float {
    ret (g + x / g) / 2.0
    ret rec(x, res)
    rad g - res
}
```

The fixed-point condition is `res = (g + x / res) / 2`, i.e., `res = x / res`,
i.e., `res = sqrt(x)`. The CAS solves this and replaces the entire function
with `sqrtf`.

This is a generalization of §2.1 (pattern matching) but uses symbolic algebra
rather than template matching. It can discover closed forms that no human
pattern-matched.

**Feasibility:** Practical for polynomial and rational fixed-point equations.
Impractical for transcendental equations. A reasonable middle ground is to
attempt CAS resolution with a timeout and fall back to pattern matching.


### 3.3 Separability Analysis for Image Kernels

**This is the big reach goal.**

Many 2D operations over images are *separable* — they can be decomposed into
two 1D passes (horizontal then vertical) for an asymptotic speedup from
O(n² · k²) to O(n² · 2k), where k is the kernel radius.

A JPL-- function operating on an `rgba[,]` image (via `array` and `sum`
expressions) expresses the kernel as nested loops with `rec` convergence. The
compiler's goal is to automatically detect when the kernel is separable and
rewrite it as two 1D passes.

**Detection:** A 2D kernel `K(i, j)` is separable if it can be factored as
`K(i, j) = H(i) · V(j)` for some functions `H` and `V`. In the JPL-- IR, this
manifests as:

1. The `sum` or `array` expression iterates over two dimensions `[i, j]`.
2. The body expression can be algebraically factored into terms that depend
   only on `i` and terms that depend only on `j`.
3. The combining operation is multiplication (for multiplicative separability)
   or the terms are independent sums (for additive separability).

**Procedure:**
1. **Symbolic factoring.** Analyze the body of the 2D `sum`/`array` expression.
   Partition sub-expressions into i-dependent, j-dependent, and constant sets.
2. **Separability test.** If the body is a product of an i-only term and a
   j-only term, or a sum of such products, the kernel is separable.
3. **Rewrite.** Emit two nested 1D passes:
   ```
   // Original: sum[i:H, j:W] f(img, i, j)
   // Rewritten:
   let horizontal = array[i:H] sum[j:W] H_part(img, i, j)
   let result     = array[j:W] sum[i:H] V_part(horizontal, i, j)
   ```
4. **Validate.** For `rad`-verified kernels, the compiler must verify that the
   rewritten passes have equivalent fixed-point behavior. This may require
   proving commutativity of the combining operation.

**Examples of separable kernels:**
- Gaussian blur: `exp(-(i² + j²) / 2σ²) = exp(-i²/2σ²) · exp(-j²/2σ²)`
- Box blur: averaging over a rectangular window
- Sobel edge detection (partially separable)
- Bilinear interpolation

**Why JPL-- makes this easier than C:** In JPL--, the kernel is a pure
expression with no side effects, no pointer aliasing, no mutation. The compiler
has perfect knowledge of the data flow. Separability analysis reduces to
algebraic factoring of a pure expression — the same kind of symbolic
manipulation that `rad` verification already requires.

**Combined with range-narrowing:** If the kernel's per-pixel computation is over
a small domain (e.g., color channels clamped to `[0, 255]`), the 1D passes can
each be tabulated as LUTs. A separable Gaussian blur on 8-bit color channels
becomes two LUT lookups per pixel per pass — negligible compute.


### 3.4 Convergence Wavefront Scheduling

For `array` expressions where each element is an independent `rec`-convergent
computation (e.g., per-pixel iterative refinement on an image), different
elements converge at different rates. The compiler emits a wavefront scheduler:

1. **Initialize:** All elements are active.
2. **Iterate:** Execute one `rec` step for all active elements (SIMD).
3. **Compact:** Elements that hit their fixed point are retired. Remaining
   active elements are compacted into dense SIMD registers.
4. **Repeat** until all elements are retired.

This avoids the "slowest lane" problem where SIMD execution is bottlenecked by
the single element that takes the most iterations. The compaction step keeps
SIMD utilization high even as elements converge at different rates.

**Implementation on WASM SIMD:** Use `i32x4.bitmask` to detect converged lanes,
`i8x16.swizzle` to compact active lanes, and a scalar loop over the remaining
stragglers when the active count drops below SIMD width.


### 3.5 Multi-Resolution Convergence (V-Cycle)

For image-processing functions where convergence is slow at full resolution,
the compiler can automatically generate a multi-resolution hierarchy:

1. **Downsample** the image to a coarser resolution.
2. **Converge** the function at coarse resolution (cheap — fewer pixels, same
   `rec` structure).
3. **Upsample** the coarse result as an initial guess for the fine resolution.
4. **Converge** at fine resolution (fast — the initial guess is already close
   to the fixed point, so `rad` is small from the start).

This is the V-cycle from multigrid methods, applied to recognized stencil
kernels. **Depth-1 only:** one coarse level, one fine level. W-cycles and full
multigrid are out of scope.

**Detection:** Three conditions must all hold:

1. **2D array parameter.** The function takes a 2D array as input and the
   `rec` body iterates over it.

2. **Bounded-stencil access.** Every `ArrayGet` node inside the `rec` body
   has index expressions of the form `param ± literal`, where `|literal| ≤ 3`
   (the stencil radius threshold). The compiler walks the `rec` body IR, finds
   all `ArrayGet` nodes, checks that their index sub-expressions are
   `Param ± Literal`, and extracts the maximum offset. If any access falls
   outside this bound, the pass does not fire.

3. **Recognized kernel pattern.** The kernel matches a pattern from the
   known-safe whitelist (see below). The compiler does **not** attempt to prove
   coarse-fine fixed-point equivalence for arbitrary nonlinear kernels — that
   is a research problem in numerical analysis, not a compiler problem. If the
   kernel is not on the whitelist, the pass does not fire.

**Known-safe kernel whitelist:**
- Box average (uniform weighted sum over a rectangular stencil)
- Gaussian blur (exponential weights, separable or full)
- Laplacian diffusion / iterative smoothing
- Bilateral filter (approximate, pattern-matched by weight structure)

These are kernels where coarse-fine fixed-point equivalence is established by
numerical analysis literature and the pass can fire unconditionally upon
detection.

**Guess parameter identification:** The compiler inspects the `rec` call
arguments to classify parameters. A parameter is the "guess" if the
corresponding `rec` argument differs from the `Param` node (i.e., it changes
across iterations). A parameter is the "input" if the `rec` argument is
identical to the `Param` node. In `rec(x, res)`, `x` is the input and `res`
is the guess. The upsampled coarse result is substituted as the initial value
of the guess parameter in the fine-resolution pass.

This is the most speculative optimization in this document, but the payoff is
enormous: O(n) total work for problems that naively require O(n · k) where k
is the iteration count.


### 3.6 Linear Speculative Execution (Exponential Search Multi-Pass)

JPL-- has no divergent control flow — no `if/else`, no short-circuit evaluation,
no exception handling. Every `rec` iteration evaluates the same structural
equations. This means speculative execution is not a tree (as in CPU branch
prediction) but a single linear pipeline. There is exactly one possible future.

**Prerequisite: Total Arithmetic (§1.3).** This optimization is impossible
without Total Arithmetic. When Thread A computes past the actual fixed point, it
enters garbage states. If any garbage-state operation could trap (`SIGFPE` from
division by zero, `NaN` propagation into an assertion), the speculator would
need rollback machinery. Total Arithmetic guarantees Thread A can compute
canonical garbage indefinitely — every operation maps to a defined result, the
ALU pipeline never stalls, and Thread B simply discards the garbage when it
finds the valid fixed point. Complex control-flow rollbacks are replaced with
simple memory truncation.

**Why this is unique to JPL--:** In a language with `if/else`, speculative
execution must hedge — the CPU guesses which branch is taken, and if wrong, it
rolls back. This creates an exponential speculation tree and requires complex
rollback machinery. In JPL--, there is no branching to speculate on. The only
question is "has the fixed point been reached?" and the answer doesn't affect
the computation — Thread A computes the same instructions regardless. There is
no rollback, no mis-speculation penalty, no side effects to undo.

**Two execution strategies:** The compiler selects between two variants based on
the weight of the `rec` body relative to the convergence check.

**Strategy A — Separate buffers, redundant compute (heavy convergence check):**

When the convergence check is expensive (large state vectors, element-wise
comparison), both threads compute independently into separate buffers. Thread B
redundantly recomputes the `rec` body to obtain values for comparison. This
sounds wasteful but the dep chains are maximally short — neither thread waits on
the other's stores, and the redundant ALU work is hidden behind latency that
would otherwise be idle.

**Strategy B — Shared buffer, trailing consumer (cheap convergence check):**

When the convergence check is cheap (scalar parameters, one `cmp`), Thread A
writes iteration results to a sequential buffer and Thread B trails behind,
reading Thread A's results and checking for convergence. Thread B stays at least
one cache line behind Thread A to avoid contention. The hardware prefetcher
perfectly streams the sequential writes from Thread A into L1, and Thread B's
reads hit warm cache. Thread A's ALU pipeline stays 100% saturated because there
are no branches, no traps (Total Arithmetic), and no convergence checks — pure
feed-forward compute.

**The exponential search model (applies to both strategies):**

```
batch_size = 4

loop:
    ┌─────────────────────────────────────────────────────────┐
    │  Thread A (compute):                                     │
    │    Starting from current state S, compute batch_size     │
    │    iterations of the rec body. Pack independent          │
    │    invocations into SIMD lanes. No convergence checking. │
    │    Pure compute. Cannot trap (Total Arithmetic).         │
    │    Maximally short dep chain.                            │
    │                                                          │
    │  Thread B (check):                                       │
    │    Check fixed-point convergence for this batch.         │
    │    Either from its own redundant compute (Strategy A)    │
    │    or by reading Thread A's buffer (Strategy B).         │
    │    SIMD vector reduce: any convergence in this batch?    │
    └─────────────────────────────────────────────────────────┘

    sync()

    if Thread B found convergence:
        return result at first_converged_index
    else:
        advance S to end of batch
        batch_size = min(batch_size * 2, MAX_BATCH)
```

**Exponential doubling:** The batch size starts at 4 and doubles each round (4,
8, 16, 32, ...) up to a cap (e.g., 256). This is standard exponential search:

- If convergence happens at step N, total work is at most 2N (geometric sum).
- Fast-converging functions (Newton's method, 4-6 iterations) are caught in the
  first batch. Zero overhead.
- Slow-converging functions amortize the sync cost across geometrically growing
  batches. The sync-to-compute ratio shrinks exponentially.

The batch cap prevents buffer bloat. Once hit, the search continues at constant
batch size. Two flat buffers (or one for Strategy B), allocated once, reused
every round. No ring buffer. Previous batches are dead.

**Applicability:**

- On arm64 (native lowering): Two hardware threads. Each has its own buffer.
  A single atomic flag for sync. `dmb` barrier suffices. This is the ideal
  target — full control over thread placement, cache partitioning, and
  prefetch hints.
- On WASM (current): Not directly viable with WASM threads due to
  `SharedArrayBuffer` overhead. However, the principle applies within a single
  thread as a code structuring technique: separating the compute basic block
  from the convergence-check basic block helps the WASM engine's OOO scheduler
  overlap them at the instruction level.
- On GPU (future): Each wavefront is already a linear pipeline. The
  convergence check is a warp-level ballot (`__ballot_sync` on CUDA,
  `subgroupBallot` on Vulkan SPIR-V). This maps naturally to the GPU execution
  model where all threads in a warp execute in lockstep — which is exactly the
  JPL-- execution model.

**Interaction with other optimizations:** Linear speculation composes with
Aitken extrapolation (§3.1). Thread B can simultaneously check convergence AND
compute the Aitken Δ² extrapolation from the last three states. If the
extrapolation validates (via `rad`), Thread B signals halt with the extrapolated
result. Thread A never needs to know — it just stops. The exponential search
finds the batch where convergence happens; Aitken pinpoints the exact value
within that batch.


Optimization Pipeline Summary
------------------------------

The optimizations compose in a specific order during compilation:

```
Source JPL--
    │
    ▼
[Parse + Type Check + rad Verification]
    │
    ▼
[Total Arithmetic Lowering]               ← Tier 1.3
  Canonicalize zero-divisor results to zero.
  Eliminate traps and keep the float domain NaNless.
    │
    ▼
[Range Narrowing]                          ← Tier 1.1
  Propagate intervals from clamp/max/min.
  Annotate every expression with its range.
    │
    ▼
[Absorption Elimination]                   ← Tier 1.4
  Constant-fold variables at saturation boundaries.
  Prune dead computation.
    │
    ▼
[Closed-Form Pattern Match]               ← Tier 2.1
  Replace recognized rec patterns with direct computation.
    │
    ▼
[Algebraic Fixed-Point Resolution]        ← Tier 3.2
  Attempt CAS solve on remaining rec loops. Timeout and skip if intractable.
    │
    ▼
[LUT Tabulation]                          ← Tier 1.1
  Tabulate functions with small state-space cardinality.
  Propagate output ranges upward through call DAG.
    │
    ▼
[Separability Analysis]                   ← Tier 3.3
  Factor 2D kernels into 1D passes where possible.
    │
    ▼
[Unroll from Lyapunov Bounds]             ← Tier 2.2
  Fully unroll rec loops with small proven iteration counts.
    │
    ▼
[SIMD Vectorization]                      ← Tier 1.6
  Pack independent invocations into SIMD lanes.
  Apply LUT-via-swizzle where applicable (Tier 2.3).
    │
    ▼
[Aitken Extrapolation Insertion]          ← Tier 3.1
  For remaining rec loops, optionally insert extrapolation after 3 iterations.
    │
    ▼
[Convergence Wavefront Scheduling]        ← Tier 3.4
  For array-of-rec patterns, emit wavefront compaction.
    │
    ▼
[Linear Speculation Scheduling]           ← Tier 3.6
  For remaining rec loops with expensive convergence checks,
  split compute and check into separate schedulable units.
    │
    ▼
[WASM 3.0 Emission]
  rec       → loop backedge (or `return_call` at tail sites)
  arrays    → GC struct/array types
  ref check → ref.eq fast path
  SIMD      → relaxed SIMD instructions
    │
    ▼
[Optional: arm64 via Wasmtime/V8]
  Let existing WASM engines handle register allocation,
  instruction selection, and native code generation.
```

Each pass depends on information from previous passes (ranges, absorption
regions, iteration bounds) and produces information consumed by later passes.
The single-pass definition order of JPL-- ensures this pipeline processes
functions bottom-up through the call DAG — each function is fully optimized
before its callers are compiled.


Guiding Principle
-----------------

Every optimization in this document is either *enabled* or *enhanced* by the
termination guarantee. LUT tabulation is sound because `rad` proves the
function halts. Unrolling is bounded because `rad` bounds iterations.
Extrapolation is safe because fallback always terminates. Separability analysis
operates on pure expressions because JPL-- has no side effects.

The `rad` keyword generates zero runtime code, but it is the single construct
that makes every optimization in this pipeline possible. That is the design
thesis of JPL--: one proof obligation per function unlocks an entire category of
compiler transforms that are unsound in general-purpose languages.
