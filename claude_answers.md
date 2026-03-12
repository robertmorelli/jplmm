# Claude Answers

Answers to questions from claude_questions.md, gemini_questions.md, and
codex_questions.md. Where gemini_answers.md and codex_answers.md already give
a good answer I say so briefly. Where they contradict each other I resolve it.
Where they're thin or wrong I say more.

---

## Language Semantics

**C1. Which `res` value does `rad` see?**
`res` in a `rad` expression resolves to the symbolic value produced by the
nearest preceding `ret` statement in source order. In `ret A; rad X; ret B`,
the verifier treats `res` in `X` as the symbolic value of `A`. This is the
correct answer from both existing answers. `verify/symbolic.ts` should build a
statement-local `res` binding by walking the function body in order and
tracking the current `res` symbolic value at each statement.

**C2. Multiple `gas` statements: compile-time error.**
Both existing answers agree: at most one `gas` per function. `resolve.ts`
rejects it.

**C3. Shadowing in `array`/`sum` loop variables.**
No shadowing including loop binders. `array [i : N] array [i : M] ...` is an
error. Both existing answers agree. The idiomatic response is `array [i : N]
array [j : M] ...`. The resolver handles this the same as any other binding:
adding `i` to the scope before entering the inner `array`, so the inner `i`
shadows and is rejected.

**C4. `rad` scalar requirement for composite-return functions.**
`rad` must be `int` or `float`. A function returning `float[,]` can still use
`rad`, but must formulate the measure over scalar parameters or derived scalars
— not raw `res`. E.g. `rad to_int(sum[i:H, j:W] abs(res[i,j] - params.prev[i,j]))`.
Both existing answers agree.

**C5. `-0.0` and angular convergence.**
Add to spec: fixed-point collapse treats `-0.0 == +0.0`; functions sensitive to
sign of zero (angular state spaces using `atan2`) may produce off-by-π results
at the convergence boundary. This is a deliberate tradeoff; programmers must
handle angular wraparound manually.

**C6. `-inf == -inf` collapse.**
`+inf == +inf` and `-inf == -inf` both trigger fixed-point collapse. Opposite-
sign infinities do not. Add both cases explicitly to the spec Fixed-Point
Epsilon section.

**C7. Multiple `rec` in one expression — evaluation model.**

Both existing answers say "left-to-right, independent." That's correct but
incomplete. The deeper issue: the spec says `rec` uses an "iterative
(stack-neutral)" model, but this only cleanly applies to tail-position `rec`.

For non-tail-position `rec` (like Fibonacci), each `rec` call is an
**independent recursive evaluation** of the enclosing function with new
arguments — it runs to completion before the outer expression continues. The
Fibonacci expression `rec(max(0, x-1)) + rec(max(0, x-2))` spawns two
full recursive evaluations of `fib` in sequence, left-to-right. Stack depth
is O(n). This is correct and expected; `rad x` bounds it.

The "iterative (stack-neutral)" description in the spec applies specifically
to **tail-position** `rec` sites, which can be lowered to loops or
`return_call`. Non-tail `rec` is genuinely recursive. The spec should say this
explicitly rather than implying all `rec` is iterative. The arch needs a clear
IR distinction:
- Tail-position `rec` → `RecTail` node → loop backedge or `return_call`
- Non-tail-position `rec` → `RecCall` node → actual function call

Proof obligations are independent per call site regardless of position.

**C8. Array-parameter proof precondition.**
"Differ" for arrays means: dimension mismatch, or at least one element differs
by at least one ULP under element-wise rules. In v1, restrict `rad`-verified
functions with array-valued parameters to patterns where the array is an
"input" (passed through unchanged in `rec`) and only scalar parameters change.
The verifier can detect this statically: if a `Param` that is array-typed
appears identically in the `rec` argument list, it is classified as input and
excluded from the proof precondition. If an array-typed param appears modified
in `rec`, fall back to `gas`.

**Q. Multiple `gas` and `gas` fuel semantics.**
`gas N` limits the number of times a single call instance reaches a non-
collapsing `rec` transition. It is **per-call-instance**, not per-total-work.
For a function like Fibonacci using `gas 100`, each recursive call spawns an
independent instance with its own fuel of 100. This means `gas N` bounds the
depth of any one branch, not the total call tree. This should be stated
explicitly in the spec.

For multiple `rec` expressions per iteration: gas is decremented once per
loop iteration (i.e., per full execution of the function body), not once per
`rec` expression evaluated. If two `rec` calls appear in one expression and
neither collapses, that is still one iteration.

**Q. Collatz example.**
Both existing answers confirm: the example is an illustration of bounded
divergence, not a working Collatz implementation. The comment "no conditionals,
so we use a trick" is misleading. Replace the comment or add a note: "This
demonstrates `gas` — the function applies Collatz-like steps and exhausts fuel
if no fixed point is found, returning the final `res`. It does not compute the
Collatz sequence length."

---

## Total Arithmetic and Float Semantics

**NanToZero and `-0.0` — resolving the contradiction.**

gemini_answers says `NanToZero` canonicalizes to `+0.0`. codex_answers says
`NanToZero` should preserve non-NaN payloads including `-0.0`. **Codex is
correct.** `NanToZero(x)` maps NaN → `+0.0` and passes everything else
through unchanged. `-0.0` is not NaN; it is a valid IEEE 754 value and must
not be altered. The spec says "every IEEE 754 operation that would produce NaN
instead produces `0.0`" — this is about NaN specifically. `-0.0` is already
defined and total.

The zero-divisor rules (`x / 0.0 = 0.0`, `x % 0.0 = 0.0`) produce `+0.0` as
the canonical result, not because of NanToZero but because the total arithmetic
rules explicitly define the divisor-zero case. These are separate mechanisms.

Implementation: `NanToZero` in IR and in WASM uses the `f32.eq` self-comparison
trick, which correctly leaves `-0.0` alone (`-0.0 == -0.0` is `true`, so the
select returns the value, not zero).

**ULPDistance implementation.**

The spec gives the formula. Canonical TypeScript:

```typescript
function ulpDistance(a: number, b: number): number {
  // Both values must already be f32
  const buf = new ArrayBuffer(8);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  f[0] = a; const ua = u[0];
  f[1] = b; const ub = u[1];
  // Monotonic ordering: negative floats get bit-flipped, positive get sign set
  const oa = (ua & 0x80000000) ? (~ua >>> 0) : (ua | 0x80000000);
  const ob = (ub & 0x80000000) ? (~ub >>> 0) : (ub | 0x80000000);
  return Math.abs((oa | 0) - (ob | 0));  // signed subtract, then abs
}
```

Infinities have valid bit patterns and sort correctly in this ordering
(`-inf` at one extreme, `+inf` at the other). `+inf` and `MAX_FLOAT` are 1
ULP apart by this encoding, which is correct and consistent with the spec.
Special-case: if either input is NaN, this is unreachable in JPL-- (NaN
eliminated upstream).

**ULP tolerance: hard-code to 1.** Not configurable. Changing it changes
language semantics. The verifier and runtime collapse check must use the same
implementation — share a utility function, do not duplicate. This is the most
likely source of subtle bugs; a single source of truth is mandatory.

**`rec` argument saturation.**
Fixed-point checks operate on post-saturation, post-NanToZero values. The
equality comparison sees language-level values, not pre-saturation intermediates.

---

## Verification

**C9. Aitken validation ULP.**
Resolving the ambiguity: accept the extrapolation if and only if:
1. `rad(S_∞) < rad(S₂)` — the extrapolated state is closer to the fixed point
   than the last computed state, AND
2. The extrapolated state passes the same fixed-point collapse check that `rec`
   would use — i.e., `ULPDistance(S_∞[i], S₂[i]) <= 1` for all components `i`.

Condition 2 reuses the existing collapse check rather than introducing a new
"ULP of the radius" criterion. This is the correct interpretation of the
codex answer ("fixed-point proximity under normal collapse tolerance"). The
`AitkenGuard` IR node should store a reference to the collapse-check logic,
not invent its own epsilon.

**SMT timeout and determinism.**
Use solver resource limits (`rlimit` in Z3) rather than wall-clock timeout as
the primary bound. Wall-clock is non-deterministic across machines; rlimit is
reproducible. The CLI blocks with a fixed rlimit; hitting it produces
`UNVERIFIED` with a specific diagnostic ("SMT query exceeded resource limit;
consider `gas N`"). The LSP cancels in-flight queries on edit; it does not need
determinism.

**Symbolic verification scope for v1.**
Move a minimal symbolic verifier into Phase 1 alongside structural. The minimum
needed for Phase 2 demos is:
- Sum-of-products factoring to verify `abs(g - res) > abs(res - new_res)` style
  obligations (Babylonian, isqrt)
- Monotone decrease of linear expressions (`max(0, x-k) < x for x > 0`)

Leave transcendental CAS (SymPy, polynomial root-finding) for Phase 5 or never.
The full Z3 path stays in Phase 3. This resolves the phase ordering problem for
the sqrt demo.

---

## IR and Implementation

**C10. Concrete IR loop structure for tail-position `rec`.**
Both existing answers converge on the right shape: explicit loop header with
phi-like state variables. Concretely:

```
function $sqrt_iter:
  block $body (param $x f32, param $g f32, result f32):
    local $res f32
    ;; ret (g + x/g) / 2
    ... compute ...
    local.set $res
    ;; fixed-point check: ULP(next_arg - $g) <= 1?
    ... check ...
    br_if $exit  ;; collapse: return $res
    ;; re-enter with new args
    br $body (with $x = ..., $g = $res)
  end
```

This is a WASM `block`/`br` loop. The loop header has explicit param slots for
each function parameter (including a fuel parameter for `gas` functions). The
`rec` desugaring in `ir/builder.ts` always produces this shape — it is the
canonical loop form. `return_call` at the backedge is an optional machine-group
optimization, not part of the canonical IR.

**C11. `gas` fuel parameter ABI.**
Wrapper strategy: the public WASM function has the original signature. It calls
an internal `$funcname_gas` with an extra `i32` fuel parameter initialized to
`N`. Callers are unaffected. The optimizer must not inline the wrapper away
without also propagating the fuel parameter. `gas inf` functions have no fuel
parameter and no wrapper.

**C12. Range analysis: iterative fixed-point.**
Both existing answers agree: iterative with widening. The widening threshold
should be conservative (e.g., after 3 iterations without stabilization, widen
to `[INT32_MIN, INT32_MAX]`). For `rec` bodies, the range of the `rec` node
is initialized to `[INT32_MIN, INT32_MAX]` and narrowed on each iteration.
Saturating arithmetic guarantees termination of the analysis.

**C13. LUT tabulation evaluator requirements.**
The compile-time evaluator needs to run the full JPL-- execution model on
lowered IR. Candidates must have all callees already tabulated or evaluable
(no runtime-only effects, no I/O). The evaluator can be simple: it does not
need to be fast, only correct. Total arithmetic guarantees no traps. Add a
compile-time recursion depth guard as a safety net even though `rad` bounds
it — defense in depth during development.

**C14. Phase ordering.**
Minimal symbolic verification moves to Phase 2 (alongside structural). The
split:
- Phase 2: structural decrease + minimal symbolic (sum-of-products, monotone
  linear decrease). Enough for sqrt, isqrt, GCD, fib demos.
- Phase 3: Z3 integration for hard cases + detailed `-v` report output.

**C15. CAS dependency.**
No Pyodide in the compiler. Pass 2.2 is optional, plugin-based, experimental.
If pursued, evaluate `algebrite` (pure JS, ~200KB) or a custom polynomial
solver. The pattern matcher (Pass 2.1) handles the cases that matter for demos.

**C16. Tier numbering collision.**
opt_arch pass numbering is canonical. Rename opt_guide Tier 2.4 to avoid
collision with Pass 2.4 (Aitken). The partial-convergence-detection
optimization (only checking actively-changing params) is not a separate pass
— it is an analysis in Pass 4.3 (Rec Control-Flow Lowering) that statically
identifies which params are unchanged in `rec` arguments and skips their
collapse checks. Note this in opt_arch Pass 4.3.

**C17. Missing `select` in opt_guide §1.3 code block.**
Fix the code block. Full branchless expansion for `x / y` with `x/0 = 0`:

```wasm
local.get $y
i32.eqz              ;; is_zero = (y == 0)
local.set $is_zero
local.get $y
local.get $is_zero
i32.or               ;; y_safe = y | is_zero
local.set $y_safe
local.get $x
local.get $y_safe
i32.div_s            ;; raw = x / y_safe (no trap)
i32.const 0
local.get $is_zero
select               ;; result = is_zero ? 0 : raw
```

**C18. Source file extension: `.jplmm`**

**C19. Collatz example: see Language Semantics section above.**

---

## Gemini Questions

**G1.1. LUT memory management across multiple large tables.**
Per-function thresholds remain. Add a per-module LUT budget (e.g., 1MB total).
When the budget would be exceeded, score candidates by estimated speedup
(calls in hot loops score higher) and tabulate in order until the budget is
hit. Non-tabulated functions fall through to the optimizer. Track total LUT
bytes in `CardinalityMap` output.

**G1.2. Cascading range resolution when output range depends on own parameters.**
One monomorphic body with interval transfer summaries. No specialization in v1.
If a function's output range depends on its input range (it always does), the
transfer summary is a function from input intervals to output intervals, not a
fixed interval. `range-analysis.ts` stores transfer summaries and applies them
at call sites. This is standard abstract interpretation — compute a fixed-point
over the call graph bottom-up. Single-pass definition order means this is
exactly one bottom-up pass, no cycles to iterate.

**G1.3. Absorption brittleness.**
Pass 1.4 absorption detection is an optimization only. Missed absorptions leave
correct, slower code. Use pass statistics (`misses: N`) to track this and
surface it under `--dump-ranges`. Do not make the compiler depend on absorption
for correctness.

**G2.1. NanToZero guard cost.**
The 4-instruction sequence is ~1ns on modern hardware when not eliminated. The
performance bet is: Pass 1.4 eliminates most guards (functions that `clamp`,
`max`, `min` their inputs before transcendentals), leaving guards only on
genuinely uncertain paths. Gate on benchmarks. If guard elimination quality is
poor, the first optimization is to improve range analysis coverage, not to
remove the canonical-IR strategy.

**G2.3. `rec` argument saturation.**
Fixed-point checks see post-saturation values. This is necessary and correct —
saturated values ARE the language-level values.

**G3.1. Multi-`rec` heterogeneous convergence.**
As established in C7: each `rec` in a non-tail expression is an independent
recursive evaluation running to completion. There is no interleaving. `rec(x)`
finishes, its value is stored in a temporary, then `rec(y)` runs. "Convergence
at different rates" does not apply to non-tail multi-rec — each call runs its
own loop to convergence before the outer expression continues.

For SIMD contexts (Pass 4.1), if two *independent invocations* of a function
are packed into lanes, convergence wavefront applies. That is different from
two `rec` calls in one expression.

**G3.2. Register/stack pressure for multi-`rec`.**
Lower to ANF early in `ir/builder.ts`. Each `rec(args)` result becomes a named
temporary. The loop structure serializes non-tail `rec` calls into sequential
recursive calls with results stored in locals. No simultaneous live-range
overlap between them. Stack pressure is bounded by function nesting depth
(limited to 64 by implementation limits).

**G4.1. Z3 timeout determinism.**
Use `rlimit` (Z3 resource limit) as the primary bound, wall-clock as a safety
net. Fixed solver seed. `unknown` result is deterministic at the same rlimit
across machines. CLI fails hard on timeout; LSP reports `pending` then `failed`.

**G4.2. ULP distance at infinities.**
`+inf` and `-inf` have valid bit patterns in the monotonic encoding and sort
at the extremes. ULP distance between them is `0xFFFFFFFF` (maximum), so they
never collapse. `+inf == +inf` (same bit pattern) has ULP distance 0 and
correctly collapses. No special-casing needed; the encoding handles it.

**G5.1. WASM atomics overhead in Strategy B.**
Correct concern. True two-thread linear speculation on WASM is not viable with
current `SharedArrayBuffer` + `memory.atomic` overhead. Pass 3.4 should be
marked "arm64 native target only" in the opt_arch description. On WASM, the
structural separation of compute and check blocks (without actual threading)
is a code structuring hint for the JIT's instruction scheduler, not a
correctness guarantee. The speculative pass should not be in the default
WASM pipeline.

**G5.2. Aitken + linear speculation rollback.**
Thread B owns validation. If `rad(S_∞) < rad(S₂)` and collapse check passes,
Thread B atomically writes the result and sets a halt flag. Thread A polls
the flag at batch boundaries (not per-iteration). If validation fails, Thread B
does nothing; Thread A continues normally. No rollback signal needed because
Thread A never committed to the extrapolated result.

**G6.1. WasmGC allocation pressure in `rec` loops.**
The biggest performance cliff in the implementation. Rule: `rec` loops that
allocate new `array.new` or `struct.new` on every iteration are not candidates
for the default loop-based lowering without escape analysis. Group 3 must
detect whether array-typed `rec` arguments are fresh allocations or pass-
throughs. If fresh, hoist to a mutable linear-memory buffer and use `array.copy`
semantics. If pass-through (`rec(x, res)` where `x` is the input array),
`ref.eq` handles the convergence check in O(1). This is the performance
argument for keeping most image-processing kernels as "input array stays
constant, scalar params converge."

**G6.2. `ref.eq` false negatives.**
Correctness is guaranteed by structural fallback. `ref.eq` is a best-effort
O(1) check. Improve hit rate through: (a) the compiler never creating
structurally-duplicate arrays when a reference could be reused, (b) making
the "input array unchanged in `rec`" pattern the canonical image-kernel idiom.
Full hash-consing is overkill for v1.

**G7.2. Phase ordering.**
Answered above: minimal symbolic moves to Phase 2.

---

## Codex Questions (selected)

**C1.1. NodeId stability for LSP.**
Derive NodeId from the tree-sitter node's byte range (start offset + length).
Byte ranges are stable across edits to unrelated code. When a function body
changes, its nodes get new ranges (and new IDs); the LSP invalidates only those
scopes. This is simpler than a separate stable ID scheme and leverages
tree-sitter's existing incremental edit model.

**C1.5. Reject legacy JPL keywords when?**
At parse time via the grammar. The tree-sitter grammar does not include `if`,
`then`, `else`, `true`, `false`, `bool`, `return`, `assert` as keywords. They
parse as identifiers. `resolve.ts` then rejects any identifier matching a
legacy keyword with a specific error: "error: `if` is not a keyword in JPL--;
did you mean to use fixed-point convergence via `rec`?" This gives better error
messages than a lexer-level rejection.

**C1.7. Float literal edge cases.**
Use `strtof` (or equivalent). Accept subnormals — they are valid f32 values.
Reject literals that `strtof` maps to `±inf` with a compile-time error. Treat
underflow to `±0.0` as valid (this is subnormal territory). The only rejection
criterion is overflow to infinity.

**C2.4/C2.5. `gas` decrement rule.**
Gas is decremented once per non-collapsing iteration of the function body, not
once per `rec` expression. If a function body contains two `rec` expressions
and both fail to collapse, that is one iteration decrement. Gas counts loop
iterations, not `rec` expression evaluations. The fuel counter is initialized
once at function entry (or passed in for tail-call lowering) and decremented
at the loop backedge.

**C2.6. Struct collapse rule with mixed int/float fields.**
Field-wise: int fields require exact equality, float fields require ULP
distance ≤ 1. A struct collapses if and only if ALL fields collapse under their
respective rules. If any field fails, no collapse.

**C3.1. Where is `TotalDiv` introduced?**
In Pass 1.1 only. `ir/builder.ts` emits raw `Div`/`Mod` nodes. Pass 1.1 wraps
them in `TotalDiv`/`TotalMod` sentinels. This keeps the IR builder simple and
makes totality an explicit optimization-group concern, not a builder concern.

**C4.4. ULP tolerance configurable?**
No. Hard-coded to 1. Changing it changes language semantics. Experimentation
should happen by forking the language spec, not by adding a flag.

**C4.5. Shared verifier and runtime collapse implementation.**
Mandatory. A single `collapseCheck(a, b, type)` function in a shared utility
package (e.g., `packages/ast/collapse.ts`) is used by both `verify/` and the
runtime code emitted by `backend/`. If they ever diverge, you get proofs that
don't correspond to runtime behavior. This is a hard invariant.

**C5.1. Symbolic algebra scope for v1.**
Minimum viable symbolic verifier (Phase 2):
- Detect monotone decrease: `max(0, x - k) < x` for `k > 0`
- Detect sum-of-products sign: factor `rad(params) - rad(rec_args)` and check
  that all factors have statically-known sign under type constraints
- Handle implicit `abs()` wrapping on `rad` expressions

Out of scope for v1: polynomial root-finding, transcendental simplification,
multi-variable constraint solving (those fall to Z3).

**C6.3. Enforcing sentinel opaqueness.**
Each sentinel node type implements a `foldConstant(inputs: Literal[]): Literal`
method. The constant folder in algebraic passes MUST call this method rather
than pattern-matching through the sentinel. Enforce this with a TypeScript
type constraint: the constant folder receives `SentinelNode | Literal` and must
dispatch to `foldConstant` for sentinels. A linter rule can catch direct
structural matching on sentinel types.

**C6.4. Metadata structure.**
Immutable persistent maps (use a structural sharing map, e.g., immer or a
simple `Object.freeze` wrapper). Passes return new `(ir, meta)` pairs; they
never mutate the input. This makes debugging trivial (snapshot any intermediate
state) and is necessary for the LSP's incremental pipeline where old metadata
must be preserved until new metadata is ready.

**C7.1. Total Arithmetic always first.**
Yes, and it should be hard-coded as the first pass — not toggleable. A pipeline
that disables Pass 1.1 is not a valid JPL-- compiler. The `--no-optimize` flag
skips optimization passes (Groups 2-4) but not canonicalization (Group 1).
Group 1 is part of the semantic contract, not optimization.

**C7.4. `requires`/`provides` pass metadata.**
Worth implementing. Each pass declares:
```typescript
interface Pass {
  requires: MetadataKey[];  // fails if missing
  provides: MetadataKey[];  // guarantees after run
  invalidates: MetadataKey[]; // metadata this pass may make stale
}
```
The orchestrator validates before running. This catches dependency issues at
pipeline construction time, not at runtime.

**C8.1. Feature detection for tail-call vs loop.**
Check WASM tail-call support at startup (or accept a `--target-features` flag).
Default to loop-based lowering (universally supported). Emit `return_call` only
when tail calls are confirmed available. The IR represents all `rec` as
`RecTail`/`RecCall` nodes; the machine pass selects lowering based on the
target capability flag.

**C8.6. WASM engine compatibility matrix.**
Primary (must pass all tests): Wasmtime, Node.js/V8.
Secondary (best-effort): Chrome, Safari WebKit.
Out of scope: embedded/IoT WASM runtimes.
WasmGC is required for structs and arrays; engines without WasmGC fall back to
linear memory layout (a separate backend target, not v1).

**C9.1. LSP phase latency budget.**
- Per-keystroke: tree-sitter reparse only (~1-5ms)
- Debounced 100ms: resolve + typecheck on affected scope
- Debounced 300ms: structural + minimal symbolic verification
- Async no-deadline: Z3 (cancelled on next edit)
- On explicit save or `--verify` flag: full verification including Z3

**C10.1. Non-negotiable golden tests.**
All spec example programs (sqrt_iter, fib, gcd, my_abs, isqrt, collatz, spin),
all spec rejection cases (bad res, bad rec, diverge), branchless arithmetic
corner cases (`INT32_MAX + 1`, `INT32_MIN - 1`, `0 / 0`, `0.0 / 0.0`,
`sqrt(-1.0)`, `log(0.0)`), gas exhaustion with known counts, ULP collapse
at adjacent floats. These must pass before any optimizer change merges.

**C11.4. Should V-cycle stay OPEN?**
Yes. V-cycle remains OPEN until: (a) Pass 3.2 (Separability) is stable and
shipped, (b) at least one whitelist pattern (Gaussian blur) is implemented
end-to-end and benchmarked, (c) the stencil-detection sub-analysis has a
concrete implementation plan. The current opt_arch placeholder is the right
status.
