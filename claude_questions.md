# Claude Questions

Questions from reading the spec, arch, opt_guide, and opt_arch. Grouped by
topic. Each question states why it matters for implementation.

---

## Language Semantics

**Q1. Which `res` value does `rad` see?**

In the Babylonian example:

    fun sqrt_iter(x : float, g : float) : float {
        ret (g + max(x, 0.0) / g) / 2.0   // res = new guess
        rad g - res                         // which res is this?
        ret rec(max(x, 0.0), res)
    }

`rad` is compile-time, but it references `res`, which is a runtime-accumulated
value. When the verifier evaluates `rad` symbolically to check the proof
obligation, it treats `res` as "the symbolic value of the last `ret` that
precedes this `rad` statement in the function body." Is that the correct
interpretation? This rule is implicit in the examples but never stated as a
rule. `verify/symbolic.ts` needs to know exactly which `ret` value `res`
refers to when it appears inside a `rad` expression.

---

**Q2. Multiple `gas` statements: compile-time error or silently idempotent?**

The spec says `gas N` initializes a fuel counter "if not already active,"
implying a second `gas` statement is a no-op. But it also says `rad` and `gas`
are mutually exclusive. It does not say whether two `gas` statements in one
function is an error or valid. Should `resolve.ts` reject it, warn, or accept
the first and ignore the rest?

---

**Q3. Shadowing in `array`/`sum` loop variables**

The spec says shadowing is illegal. `array` and `sum` introduce loop variable
bindings: `array [i : N] expr`. If an outer scope already has a variable `i`,
is `array [i : N] ...` a shadowing error? Nested `array` expressions with the
same loop variable name (common in image processing) would also be shadowed:

    array [i : H] array [i : W] ...   // second i shadows first?

This is either a very restrictive rule that makes idiomatic code hard to write,
or loop variables get special treatment. Which is it?

---

**Q4. `res` type vs `rad` type constraint**

The spec says "`rad <expr>` — the expression must have type `int` or `float`."
A function can return a struct or array. If the function returns `float[,]`,
then `res` has type `float[,]`, which cannot appear in `rad` directly. The
Babylonian example uses `rad g - res` where the return type is `float`, so it
works. But what if a programmer writes `rad res` in a function returning a
struct? The typecheck correctly rejects it. Is there a meaningful constraint
on which return types can use `rad` vs. being forced to use `gas`? Should the
spec note that `rad`-verified functions with array/struct return types must
express their Lyapunov function in terms of scalar parameters only?

---

**Q5. `-0.0` and angular convergence**

The spec says negative zero and positive zero are considered equal in the
fixed-point collapse check. The NanToZero guard canonicalizes to `+0.0`.
This is fine for most functions. But `atan2(-0.0, -1.0) = -π` and
`atan2(+0.0, -1.0) = +π` are distinct values. If a function converges to `-π`
but the convergence check treats `-0.0 == +0.0`, it will collapse to `+π`
instead. The practical scope is narrow but real for angular state spaces. The
spec should acknowledge this explicitly rather than leaving it as a trap.

---

**Q6. `rec` collapse when both sides are `±inf`**

The spec says "`inf == inf` is true, so fixed-point collapse succeeds if both
sides saturate to the same infinity." What about `-inf == -inf`? And what about
`inf` vs `-inf` — obviously not equal, but worth stating explicitly since the
NaN-free arithmetic changes usual IEEE behavior. The spec covers the `+inf`
case but not `-inf` explicitly.

---

## Verification

**Q7. Proof obligation for multiple `rec` calls in one expression**

The Fibonacci example has two `rec` calls in a single expression:

    ret max(res, rec(max(0, x - 1)) + rec(max(0, x - 2)))

The proof obligation is stated per `rec` call site: for each one, at least one
`rad` expression must strictly decrease. Here `rad x` must prove both
`max(0, x-1) < x` and `max(0, x-2) < x`. Those are independent obligations.
The spec says this. But what is the evaluation model when both `rec` calls are
in one expression — are they evaluated left-to-right, and does the collapse of
one affect the execution context of the other? The spec doesn't address
evaluation order within a single expression.

---

**Q8. Proof obligation for `rec` with array-type parameters**

The proof obligation is:

    Given: exists i such that |a_i - p_i| >= ULP(p_i)
    Prove: abs(R(a...)) < abs(R(p...))

For struct parameters, "differ by at least one ULP in at least one component"
presumably means differ in at least one field. For array parameters, does it
mean at least one element differs? If so, the precondition becomes very weak
for large arrays (almost always true). Does the verifier handle this case or
is `rad` over arrays just unsupported in practice (arrays always use `gas`)?

---

**Q9. Aitken validation: "ULP" of what?**

opt_guide §3.1 states the validation condition as:
`rad(S_∞) < rad(S₂)` AND `rad(S_∞) < ULP`

The first condition makes sense. The second is underspecified. Is it:
- `ULP(S_∞)` — the ULP of the extrapolated value itself?
- `1` — the integer ULP (making this the fixed-point collapse criterion)?
- `ULP(rad(S₂))` — one ULP of the current radius?

For float functions, these give very different thresholds. The validation
logic in `verify/smt.ts` and the `AitkenGuard` IR node both need the same
definition.

---

## IR and Implementation

**Q10. What does the `rec` loop look like in IR for multi-statement functions?**

The arch says `rec` is desugared into "explicit loop + fixed-point check."
For a function with the statement sequence `let A; ret B; rad C; ret rec(D)`,
the loop must: evaluate `A`, evaluate `B` (assign to `res`), check if `D ==
params`, if yes return `res`, else set params to `D` and re-execute from the
top. What does "re-execute from the top" look like as flat SSA-like IR? Is
it a back-edge to a loop header that re-binds all the param SSA values, or
something else? `ir/builder.ts` needs a concrete representation for this. The
arch says `rec` is desugared but doesn't spell out the loop structure.

---

**Q11. `gas N` fuel counter visibility to callers**

For a WASM `return_call` lowering of `gas` functions, the fuel counter must be
an additional `i32` parameter (locals don't survive across tail calls). But
callers of `fun collatz(x: int): int` pass one argument, not two. There are two
options: (a) the public WASM function is a wrapper that calls an internal
`$collatz_fuel` function with the initial fuel, or (b) `gas` functions always
use loop-based lowering rather than `return_call`. Which is it? The arch says
"loop backedge (or `return_call` at tail sites)" but doesn't resolve this for
`gas` functions specifically.

---

**Q12. Range analysis on `rec` arguments: fixed-point or single-pass?**

opt_arch Pass 1.3 says `Rec(args)` gets a range annotation of "transfer
function from current ranges." A `rec` call's range depends on the range of
the next iteration's result, which depends on the range of the `rec` within
that iteration, etc. This is a fixed-point computation within the function. Is
the range analysis actually iterative (run until ranges stabilize) or
single-pass with conservative widening? The choice significantly affects the
quality of range annotations for recursive functions, and therefore the quality
of downstream LUT tabulation and guard elimination.

---

**Q13. LUT tabulation for functions with `let` bindings**

Pass 2.3 tabulates functions by evaluating them at compile time for every
input. The description says the function body including all `rec` loops is
evaluated. But a function body can have `let` bindings that are expressions,
not just parameters. For tabulation, these are evaluated as part of the compile-
time interpreter. Does the compile-time interpreter for tabulation run the full
JPL-- evaluator? Or is there a restriction on which functions are tabulation
candidates (e.g., only functions whose bodies contain no calls to non-tabulated
functions)? The arch mentions cascading tabulation through the call DAG but
doesn't specify the evaluator requirements.

---

## Architecture

**Q14. Symbolic verification before or during Phase 2?**

The implementation order puts `verify/symbolic.ts` in Phase 3, after the core
optimizations in Phase 2. But the Phase 2 demo programs include Babylonian sqrt
(`rad g - res`) and integer sqrt (`rad g - res`), both of which require
symbolic verification to compile with `rad` (structural verification can't
prove contraction for these). If symbolic verification is Phase 3, the Phase 2
demos either can't use `rad` (must use `gas N` instead) or symbolic needs to
move into Phase 2. Which is intended?

---

**Q15. CAS dependency: what is the concrete choice?**

opt_arch Pass 2.2 says "SymPy via Pyodide, or a lightweight JS CAS." Pyodide
is impractical (50MB Python runtime, non-deterministic memory, 500ms timeout
that doesn't reliably bound execution). "A lightweight JS CAS" is not
actionable. Before this pass can be specified enough to implement, there needs
to be a concrete answer: which library, what does its API look like for
fixed-point equation solving, and how does it fail gracefully for transcendental
equations? Or: should Pass 2.2 be demoted to a reach goal and the pattern
matcher (Pass 2.1) treated as the real algebraic optimization?

---

**Q16. Tier 2.4 vs Pass 2.4 name collision**

opt_guide Tier 2.4 is "Speculative Fixed-Point Convergence" — the optimization
of only checking actively-changing parameters in the fixed-point collapse check.
opt_arch Pass 2.4 is "Aitken Extrapolation." These are different things with
the same number. The speculative fixed-point convergence from Tier 2.4 (partial
parameter checking) doesn't appear as a named pass anywhere in opt_arch. Is it
handled implicitly by Pass 4.3 (Rec Control-Flow Lowering) doing static
analysis on which `rec` arguments are unchanged? If so, opt_arch should say so
explicitly, and opt_guide should re-number to avoid the collision.

---

## Minor / Editorial

**Q17. WASM code block in opt_guide §1.3**

The code block shows the safe-divisor trick but stops before the `select`:

    local.get $y
    i32.eqz
    local.get $y
    i32.or
    i32.div_s       ;; ← produces x when y=0, not 0

The comment says "result = (y == 0) ? 0 : raw" which requires a `select`, but
the code doesn't include it. The spec and opt_arch both present the complete expansion
with `select(0, raw, is0)`. Just needs the `select` instructions added to the
code block.

---

**Q18. Source file extension**

The arch mentions `.jpl` in the testing section but JPL-- is a different
language from JPL. What extension do JPL-- source files use — `.jpl`, `.jplmm`,
`.jpl--`? Matters for the tree-sitter grammar, CLI, LSP file association, and
editor extensions.

---

**Q19. Collatz example**

The Collatz example in the spec illustrates `gas`, but the comment "no
conditionals, so we use a trick" implies the function correctly computes
Collatz. It doesn't — it applies one step and then calls `rec(res)` which
makes `x` the previous step result. The fixed-point collapse fires when
`res == x` (the step output equals the input), which in the Collatz orbit
doesn't correspond to reaching 1. The `gas 1000` exhausts and returns the
current `res`. Is the intent to illustrate a function that might not terminate
without gas (legitimate) or to compute the Collatz sequence correctly
(which it doesn't)? The example needs a comment clarifying the intent.
