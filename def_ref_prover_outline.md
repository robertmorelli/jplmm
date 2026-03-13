# `def` / `ref` Prover Outline

This note summarizes:

1. Which properties of JPL-- make refinement proofs more tractable than in a conventional language.
2. Which proof techniques Z3 could use to prove `ref foo` refines `def foo`.

The intended refinement question is:

- same signature
- same observable result
- same total behavior on all inputs in the supported subset

For recursive functions, the right proof object is a relational one:

- `Eq_foo(args)` means the `def` and `ref` versions of `foo` return the same value on `args`

That relation is itself recursive, so the prover is really proving a fixed point over the paired semantics of the two bodies.

## JPL-- Properties That Make Proofs Tractable

### 1. Pure expression semantics

- Function bodies are expression-driven and deterministic.
- There is no mutable heap model that affects user semantics.
- There are no hidden side effects inside arithmetic or recursion.
- Local `let` bindings and `res` updates are explicit in the syntax.

Why this helps:

- The verifier can model a function as a pure state transformer on parameters plus `res`.
- Refinement becomes semantic equality, not observational equivalence under aliasing, mutation, or reordering.

### 2. No ordinary control flow

- No `if`, `else`, boolean operators, or arbitrary branch structure.
- The only branch-like behavior is fixed-point collapse at `rec(...)`.

Why this helps:

- Control flow is concentrated in one semantic construct.
- Product-program and relational encodings are much smaller than for a CFG-heavy language.

### 3. Explicit recursion operator

- Self-recursion happens only through `rec`.
- `rec` always targets the enclosing function.
- Recursive call sites are syntactically obvious.

Why this helps:

- The prover does not need call-graph discovery for recursive edges.
- Recursive refinement obligations can be extracted directly from IR.

### 4. No mutual recursion / no co-recursion

- Source order plus `rec` rules make the call graph a DAG plus self-loops only.
- No SCC-wide recursive proof is required across multiple functions.

Why this helps:

- Each recursive refinement proof can be done one function at a time.
- CHC encodings stay local instead of requiring mutually recursive relation systems for the whole SCC.

### 5. Explicit ranking witness via `rad`

- Recursive functions already come with a user-provided decreasing measure.
- Multiple `rad`s are allowed, and at least one must justify each recursive site.
- `rad` is scalar and implicitly wrapped in `abs(...)`.

Why this helps:

- The prover gets a candidate induction measure for free.
- Cross-checking `def` and `ref` against each other's `rad`s can give a shared well-founded induction principle.
- This removes much of the invariant-synthesis burden for recursive refinement.

### 6. Bounded recursion under the total fragment

- No `gas inf`.
- `rad` functions are statically total.
- `gas N` functions are runtime bounded.

Why this helps:

- Recursive proofs are about total fixed points, not divergence-sensitive equivalence.
- For `gas N`, bounded unrolling is complete in principle.

### 7. Total arithmetic

- Integer add/sub/mul saturate instead of wrapping.
- Integer division/mod by zero return `0`.
- Float operations are NaN-free by construction.
- No arithmetic traps or exceptions.

Why this helps:

- No undefined behavior.
- No proof obligations about "is this operation even defined?"
- No mismatch between source proof semantics and backend trap behavior.

### 8. Finite scalar domains

- `int` is 32-bit.
- `float` is 32-bit single precision.

Why this helps:

- Many scalar fragments are finite-state exactly.
- Exact bit-precise proof is possible with bit-vectors / float encodings.
- Exhaustive techniques are possible for small kernels and bounded inputs.

### 9. Saturation instead of wraparound

- Saturation makes scalar evolution monotone more often than modular arithmetic does.
- It avoids wraparound cycles that complicate ranking arguments.

Why this helps:

- Decrease proofs are often simpler.
- Abstract interpretation and monotonicity reasoning become more useful.

### 10. Fixed-point collapse is explicit and deterministic

- `rec(args...)` collapses to current `res` when arguments equal current params under the spec's equality rules.

Why this helps:

- Base-case behavior is not hidden in arbitrary branch structure.
- Recursive refinement can be phrased as:
  - collapse behavior matches
  - recursive successors are equivalent
  - local step expressions are equal

### 11. Sequenced `ret` / `res` semantics

- `ret` updates `res`.
- Later expressions can read `res`.
- A recursive function therefore has a linearized "step program" before each recursive transition.

Why this helps:

- The prover can summarize the body as a recurrence over `(params, res)`.
- This is much easier than reasoning over arbitrary SSA CFGs with phi nodes.

### 12. Single-pass binding and topological calls

- A function may call earlier functions and itself, but not later functions.

Why this helps:

- Callee summaries can be solved bottom-up.
- Recursive refinement of one function does not require solving the whole program at once.

### 13. Structs and arrays are value-like

- Struct equality is fieldwise.
- Array equality is extensional.
- No pointer identity enters the user-level semantics.

Why this helps:

- Proofs can target values, not alias graphs.
- Relational semantics are cleaner.

### 14. Arrays already behave like total finite-domain mappings

- Array construction is functional.
- Indexing is total because indices are clamped by the spec.
- Array equality is extensional.
- The programmer already writes arrays as mappings from indices to values.

Why this helps:

- In proof IR, arrays can be normalized to:
  - shape
  - plus a total read function over the clamped index domain
- This turns many array proofs into ordinary function-equivalence proofs.
- LUT-backed arrays and arithmetic-backed arrays can share one semantic representation.

### 15. No user-visible UB

- No trap-on-divide-by-zero semantics.
- No NaN poison.
- No branching on undefined comparisons.

Why this helps:

- Refinement can be plain semantic equality.
- There is no Alive2-style "poison/UB preservation" problem at the source level.

### 16. The language is deliberately proof-oriented

- `rad` is part of the language design, not an afterthought.
- The spec already frames functions as finite-state transition systems with explicit convergence structure.

Why this helps:

- The prover can reuse the source language's own semantic decomposition instead of reverse-engineering it from low-level IR.

## Important Caveats

These do not destroy decidability, but they do affect solver strategy and completeness costs.

### Arrays are not globally finite in the simple scalar sense

- Array dimensions are 64-bit.
- Array values may be large.
- Extensional equality over arrays is expensive.

Consequence:

- Scalar completeness is much easier than full-array completeness.
- Full exact proof for all array programs may require symbolic arrays, bounded representations, or explicit function-graph construction.

### Arrays should become intensional arrays in proof IR, not runtime closures

The useful normalization is:

- not "arrays are arbitrary higher-order closures" in the language runtime
- but "arrays are represented canonically in the prover as shape + total read function"
- and, by default, Z3 should be told that an array comprehension is this read
  function rather than a native SMT Array sort

Consequence:

- surface syntax can remain ordinary array syntax
- proof IR can treat indexing as function application after clamping normalization
- array comprehensions can beta-reduce before they ever need array theory
- backend/runtime still remain free to lower arrays as:
  - dense LUTs
  - sparse tables
  - recomputation
  - arithmetic closed forms

This keeps the proof model uniform without forcing the implementation model to become higher-order.

### Array storage can be delayed until an observation boundary

The language can keep telling the user they have an `array`, while the compiler
internally treats it as an intensional mapping for as long as possible.

That means:

- `array [...] ...` stays as the user-facing syntax
- indexing still behaves exactly like array indexing
- equality still means extensional equality
- but there is no semantic promise that a concrete flat memory object already exists

Materialization can be deferred until something actually forces a storage
representation, such as:

- backend lowering that needs an explicit memory layout
- I/O-like boundaries such as printing or writing an image
- interop / ABI boundaries
- optimization choices where a dense LUT is cheaper than recomputation

Why this helps:

- the proof engine can reason about one canonical array semantics
- the optimizer can choose the backing strategy late
- "array vs function" stops being a semantic distinction and becomes a codegen decision

This is better described as an abstraction barrier than a lie: the language
guarantees array behavior, not a specific storage strategy.

### Floating-point exactness is still hard

- The language removes NaN, which helps a lot.
- But single-precision transcendental functions still complicate exact bit-precise proofs.

Consequence:

- Many proofs will want layered encodings:
  - exact bit-precise where feasible
  - abstract or axiomatized for harder builtins

### Non-tail recursion can blow up proof search

- The semantics are still deterministic, but the recursive tree can be large.

Consequence:

- CHC / PDR style methods are more attractive than naive unfolding.

## Z3 Techniques That Could Prove Refinement

## 1. Direct SMT equivalence on canonical IR

Best for:

- non-recursive functions
- straight-line scalar code
- small summarized helper calls

Idea:

- Lower both `def` and `ref` to canonical JPL-- IR.
- Encode both results as formulas over the same symbolic inputs.
- Ask Z3 whether the outputs can differ.

Typical theories:

- bit-vectors (`QF_BV`) for exact 32-bit integers
- floating-point theory (`QF_FP`) or bitvectorized float encodings
- arrays / datatypes when needed

Why useful:

- Fastest exact path for local rewrites.

## 2. Product-program proving

Best for:

- paired reasoning between `def` and `ref`
- both recursive and non-recursive proofs

Idea:

- Build one relational program that executes `def` and `ref` in lockstep or stuttering lockstep.
- Prove that the final outputs are equal whenever the inputs are equal.

Why useful:

- This is the natural semantic shape of refinement.
- It turns two programs into one safety proof.

## 3. CHCs with Z3 Fixedpoint / Spacer

Best for:

- recursive refinement
- inductive relational proofs
- simulation / bisimulation style arguments

Idea:

- Define relational predicates such as:
  - `Eq_foo(args)`
  - optionally `StepEq_foo(args, res_def, res_ref)`
- Encode recursive proof obligations as constrained Horn clauses.
- Ask Spacer to prove that no bad state exists:
  - `Bad(args)` if `Eq_foo(args)` fails

Why useful:

- This is the cleanest general technique for recursive `def` / `ref` equivalence in Z3.
- Spacer is built to synthesize inductive invariants for exactly this kind of recursive safety query.

## 4. Induction over a shared `rad`

Best for:

- recursive functions where both sides admit the same ranking measure
- local recurrence rewrites

Idea:

- Validate that a candidate `rad` decreases for both `def` and `ref`.
- Use that `rad` as a well-founded induction measure.
- Prove:
  - collapse cases agree
  - assuming equality on strictly smaller states, one recursive step preserves equality

Why useful:

- JPL-- already ships the measure.
- This can make recursive refinement much easier than generic CHC solving.

## 5. Cross-validation of `rad`s

Best for:

- quickly finding a usable shared induction principle

Idea:

- Check every `rad` from `def` against `ref`.
- Check every `rad` from `ref` against `def`.
- If one works for both, use it as the common relational measure.

Why useful:

- Great practical heuristic.
- Often avoids synthesizing a new invariant from scratch.

## 6. Exact bit-vector proving

Best for:

- saturating integer semantics
- exact overflow-sensitive proofs
- bit-precise collapse conditions

Idea:

- Encode arithmetic exactly with 32-bit bit-vectors plus helper definitions for saturation and total division/mod.

Why useful:

- Gives exact source semantics for integers.
- Avoids unsound abstraction around saturation.

## 7. Floating-point theory or float-as-bitvector encodings

Best for:

- exact proofs involving float state transitions
- exact ULP-based collapse conditions

Idea:

- Encode float operations in Z3's floating-point theory, or bitcast-based custom semantics if needed for NaN-to-zero canonicalization.

Why useful:

- Lets the prover reason at the actual machine semantics level.

Risk:

- Can be slower than integer-only encodings.

## 8. Arrays and extensional array reasoning

Best for:

- programs whose semantics materially depend on arrays

Idea:

- Use Z3's array theory for symbolic arrays.
- Use extensionality to express observational equality.
- Add dimension constraints explicitly.

Why useful:

- Necessary for exact array refinement beyond scalar summaries.

Risk:

- This is where proofs get much more expensive.

## 9. Algebraic abstraction to simpler theories

Best for:

- proving easy cases quickly
- avoiding expensive exact encodings when unnecessary

Idea:

- First abstract exact semantics into simpler arithmetic / uninterpreted-function summaries.
- Prove easy equalities there.
- Refine only if the abstraction produces a spurious counterexample.

Why useful:

- Good CEGAR story.
- Keeps common proofs fast.

## 10. Intensional-array normalization

Best for:

- proving array comprehensions
- table-to-function rewrites
- function-to-table rewrites
- scalar/array unification in the prover

Idea:

- Normalize every array value to:
  - extents / shape
  - a total read operator on clamped indices
- Treat `array [i : N] e(i)` as a constructor for a read function.
- Treat indexing as read application after clamp normalization.
- Treat array equality as extensional equality over the clamped domain.
- Make the default SMT encoding first-order read functions over indices, not SMT
  array sorts.
- Lower to SMT Array theory only when that encoding is clearly more useful.

Why useful:

- This makes many "array vs scalar" or "table vs arithmetic" rewrites become the same proof problem: function equivalence.
- The optimizer can move freely between:
  - function -> LUT
  - LUT -> function
  - dense <-> sparse
  without changing semantic type.
- `def` can be table-backed while `ref` is arithmetic-backed, or vice versa, and the refinement statement stays identical.

## 11. Delayed materialization / symbolic array persistence

Best for:

- keeping proof IR simple
- avoiding premature memory-layout commitments
- backend freedom to pick the cheapest representation late

Idea:

- Preserve arrays as symbolic/intensional objects through most of the pipeline.
- Only force a concrete storage layout when an observation boundary or backend constraint requires it.

Why useful:

- The prover does not need separate rules for "already materialized array" versus "computed mapping".
- The optimizer can delay dense/sparse/LUT/recompute decisions.
- Surface syntax remains array-centric even if the compiler internally treats arrays as total finite-domain functions.
- `rad` reasoning can focus on scalar measures over those reads instead of being
  blocked by storage representation choices.

## 12. CEGAR (Counterexample-Guided Abstraction Refinement)

Best for:

- scaling a practical prover

Idea:

- Start with a coarse abstraction:
  - ranges
  - uninterpreted helper functions
  - summarized arrays
- If Z3 finds a mismatch, check whether it is real in exact semantics.
- Refine the abstraction only when the counterexample is spurious.

Why useful:

- Natural architecture for a production prover with mixed exact and abstract reasoning.

## 13. Bounded unrolling plus induction

Best for:

- `gas N` functions
- small recursive kernels
- debugging proof failures

Idea:

- Unroll recursion exactly up to a bound.
- Then either conclude directly (`gas N`) or use induction for the general recursive case.

Why useful:

- Complete for `gas N`.
- Useful as a fallback and debugging aid.

## 14. k-Induction

Best for:

- recursive relations where one-step induction is too weak

Idea:

- Prove the property for the first `k` levels.
- Prove that if it holds for `k` smaller states, it holds for the next state.

Why useful:

- Can rescue proofs where ordinary structural induction over `rad` is insufficient.

## 15. PDR / IC3-style safety proving through Spacer

Best for:

- recursive relational safety
- discovering inductive strengthening lemmas

Idea:

- Phrase refinement as "no reachable mismatch state."
- Let Spacer synthesize strengthening invariants.

Why useful:

- Often better than naive unfolding for recursive systems.

## 16. Uninterpreted-function summaries for already-proved callees

Best for:

- modular bottom-up proving

Idea:

- For a previously proved helper function, expose only its input/output relation.
- Replace internal details with a summary predicate or UF plus constraints.

Why useful:

- Keeps the proof modular and small.

## 17. Quantified relational invariants

Best for:

- array extensionality
- statements about all indices / all fields / all recursive descendants

Idea:

- Use quantified formulas when the property is naturally universal.

Why useful:

- Sometimes unavoidable for full array refinement.

Risk:

- Quantifiers can hurt automation and need careful triggers or abstraction.

## 18. Synthesis-assisted proving

Best for:

- finding missing helper invariants
- discovering better shared measures

Idea:

- Use SyGuS-like search, templates, or solver-guided synthesis to propose:
  - relational invariants
  - summary lemmas
  - alternative shared `rad`s

Why useful:

- Could expand the automatically provable recursive fragment.

## 19. Proof by exact function graph construction

Best for:

- "prove everything" mode on small enough domains
- debugging solver disagreements

Idea:

- Explicitly compute the full input/output graph of `def` and `ref`.
- Compare them pointwise.

Why useful:

- This is the clearest completeness story for the finite fragment.

Risk:

- Enormous worst-case blowup.

## Likely Best Practical Stack

For JPL-- specifically, a good staged prover would be:

1. Canonical alpha-equivalence and local rewrite checks.
2. Direct SMT equivalence for non-recursive scalar code.
3. Normalize arrays to intensional arrays (`shape + total read function`) in proof IR.
4. Preserve arrays symbolically until an observation/backend boundary forces materialization.
5. Cross-validate `rad`s.
6. Use shared-`rad` induction for recursive scalar refinement.
7. Escalate to CHCs / Spacer for harder recursive relational proofs.
8. Use CEGAR and array abstraction for larger structured programs.
9. Keep exact graph construction as the completeness backstop for small domains.

## Bottom Line

JPL-- is unusually proof-friendly because it removes most of the things that make refinement painful:

- hidden control flow
- side effects
- mutual recursion
- undefined behavior
- trap semantics
- unstructured recursion

The strongest general Z3 direction is:

- direct SMT for non-recursive fragments
- intensional-array normalization for array semantics
- CHC / Spacer plus shared-`rad` induction for recursive refinement

Alive2 is still useful later as a backend validator, but the primary `def` / `ref` prover should reason in JPL-- semantics first, not LLVM semantics first.
