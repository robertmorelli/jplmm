# JPL-- Semantics And Proof Rules

This document describes what the JPLMM compiler actually uses today when it says:

- a `rad` proof succeeded
- a `ref` proof succeeded
- a proof timed out
- a proof is unproven
- a proof found a real mismatch

This is a truth document for the current implementation, not a wish list.

## 1. Ground Truth

There are several different notions of "semantics" in the compiler:

1. Surface JPL-- semantics
   The language described by [spec.md](/Users/robertmorelli/Documents/personal-repos/jplmm/spec.md).

2. Canonical IR semantics
   The executable, optimizer-facing semantics used by the compiler after lowering and canonicalization.

3. Shared symbolic proof semantics
   The prover's symbolic model of values and expressions:
   - scalars
   - arrays as total read-functions / closures
   - structs
   - `res`
   - `rec` sites

4. Backend/Wasm-facing semantics
   The structured lowering description used for debug output and backend inspection.

Important:

- `rad` proofs use canonical IR plus the shared symbolic proof semantics.
- non-recursive `ref` proofs use canonical IR plus the shared symbolic proof semantics.
- recursive `ref` proofs use that same shared symbolic base, plus an induction frame over a shared `rad`.

So today the system is unified around:

- one main symbolic value model
- one main equality notion
- one main canonical IR proof boundary
- one recursive induction path layered on top of the same value semantics

The machine-readable compiler semantics dump now also exposes an adjacent-floor
ladder for non-backend compilation stages:

- `raw_ir`
- `canonical_ir`
- `canonical_range_facts` for the canonical range facts guard elimination actually consumes
- `guard_elided_ir`
- `final_optimized_ir`
- `closed_form_impl_ir` when a closed-form implementation is selected
- `lut_impl_semantics` when a LUT implementation is selected

Each IR floor now includes node-level semantic data, not just whole-function
summaries:

- every function body expression is serialized with its IR node id, rendered IR, and shared symbolic value semantics
- top-level global expressions are serialized the same way
- this is the same symbolic semantic layer used by the prover, not a second debug-only model

The current verified adjacent-floor edges are:

- `raw_ir -> canonical_ir`
- `canonical_ir -> canonical_range_facts`
- `canonical_ir -> guard_elided_ir`
- `guard_elided_ir -> final_optimized_ir`

and, for closed-form countdown implementations:

- `final_optimized_ir -> closed_form_impl_ir`

and, for LUT implementations:

- `final_optimized_ir -> lut_impl_semantics`

That last edge is currently justified by the closed-form matcher theorem, not by
the generic recursive SMT/induction path.

The LUT edge is justified by exact finite-domain re-enumeration of the LUT table
against `final_optimized_ir`, plus the explicit runtime fallback rule:

- inside the enumerated integer domain, return `table[flatten(args)]`
- outside that domain, fall back to `final_optimized_ir`

Closed-form countdown selection is intentionally limited to explicitly
nonnegative bounded countdown parameters like `int(0,_)`. The older unbounded
match was not sound over all JPL-- integers.

The `canonical_range_facts` edge is intentionally scoped:

- it certifies the subset of canonical range facts that guard elimination actually consumed
- the semantics JSON records the consumed expr ids plus owner function, rendered canonical expression, and interval
- it does not yet claim that the entire canonical range map is globally proved

Each adjacent-floor edge now also carries a pass-local certificate record in the
machine-readable semantics JSON:

- `raw_ir -> canonical_ir` includes the canonicalization pass order, emitted rewrite stats, and a validator that rechecks the derived operator-count deltas and target canonical form
- `canonical_ir -> canonical_range_facts` records the exact consumed expr ids and validates that they are attached to canonical IR expressions
- `canonical_ir -> guard_elided_ir` records the consumed fact ids plus removed guard counts and validates them against the structural diff
- `guard_elided_ir -> final_optimized_ir` records the fact that the executable program is unchanged and later choices are artifact-level implementations
- `final_optimized_ir -> closed_form_impl_ir` records the selected closed-form matcher instances and rechecks that the matcher rediscovers them
- `final_optimized_ir -> lut_impl_semantics` records the LUT domain/table shape and validates that the table length matches the declared finite domain

Those ladder schemas and validators are now shared proof-side code, not CLI-only
logic:

- the floor and edge builders live in [packages/proof/src/compiler_ladder.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/proof/src/compiler_ladder.ts)
- the CLI consumes that shared ladder module instead of rebuilding compiler semantics on its own

The optimizer also now has an opt-in proof-gated admission path for locally
checkable pass certificates:

- [packages/optimize/src/certificates.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/optimize/src/certificates.ts) exports independent validators for canonicalization, guard elimination, closed form, LUT, and consumed range-fact certificates
- [packages/optimize/src/pipeline.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/optimize/src/pipeline.ts) can be asked to keep the previous floor when one of those local certificate checks fails instead of blindly admitting the pass result
- today that path is opt-in via `proofGateCertificates`; the default optimizer behavior is unchanged

The ladder now also records lightweight expr ancestry between adjacent IR floors:

- each optimize result carries provenance maps from lower-floor expr ids back to the upper-floor expr ids they came from
- the semantics JSON serializes those provenance maps for `raw -> canonical`, `canonical -> guard_elided`, and `guard_elided -> final_optimized`
- this is intentionally a simple ancestry map, not yet a full rewrite proof

## 2. Canonical IR Is The Main Proof Boundary

Most proof work is done after:

1. parse
2. resolve
3. typecheck
4. IR lowering
5. canonicalization

This matters because canonical IR makes several language semantics explicit:

- saturating integer arithmetic
- total division / modulo
- `nan_to_zero`
- `res`
- `rec`
- array indexing / comprehension structure

The canonical proof helpers live in:

- [packages/proof/src/ir.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/proof/src/ir.ts)
- [packages/proof/src/scalar.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/proof/src/scalar.ts)

## 3. Shared Symbolic Proof Semantics

The shared symbolic layer models values as:

- scalar expressions
- arrays
- structs
- void
- opaque fallback values

### 3.1 Scalars

Scalar expressions include:

- literals
- variables
- unary / binary arithmetic
- saturating ops
- total div / total mod
- interpreted builtins like `max`, `min`, `abs`, `clamp`, `to_float`, `to_int`
- symbolic reads from arrays
- symbolic `sum`

`sum` now has active proof semantics, not an opaque fallback:

- small constant sums are unrolled in the proof engine before SMT
- larger or symbolic sums lower to bounded fold semantics in SMT
- integer sums accumulate with saturating `+`
- float sums accumulate with real `+`

### 3.2 Arrays

Arrays are modeled as mathematical values, not mutable memory objects.

The shared proof layer uses:

- parameter arrays
- abstract arrays
- array comprehensions
- array choices
- array slices

Semantically, arrays are treated as:

- shape
- plus a total read function

That means:

- `array[i:N] body` is a closure-like read function
- parameter types like `int[n][m]` bind `n` / `m` to the array's runtime dimensions at function entry
- array literals are normalized into closure semantics instead of remaining special memory-shaped values
- recursive abstract arrays are modeled as typed read-functions
- indexing is a symbolic read with clamped indices
- comparison normalization beta-reduces derived reads like `read(array[i:N] body, x)` back into scalar/body semantics before SMT
- bounded params and comprehension/sum binders contribute range facts to that normalization
- affine `div` / `mod` patterns over positive extents are simplified before SMT when the remainder is known to stay in-range
- array equality is extensional equality over clamped in-domain indices

This is the main "arrays are functions" move, and it is the active semantic form used by the prover.

Important current limit:

- eligible non-recursive helper calls can now be beta-reduced even when they take array/struct arguments
- helper calls that cannot be beta-reduced but whose arguments flatten to scalar leaves, like recursive struct helpers used through field projection, now stay as shared abstract calls instead of going opaque
- if a helper cannot stay inside the shared symbolic encoding, it still falls back to an opaque symbolic value
- recursive/general interprocedural array reasoning is still a real remaining gap

## 3.2.1 Raw IR Denotation

Raw IR is no longer treated as "literal operator syntax" in the proof engine.
Before adjacent-floor verification, the symbolic layer interprets raw operators
with the same denotational meaning canonical IR makes explicit:

- raw integer `+`, `-`, `*`, unary `-` use saturating semantics
- raw `/` and `%` use total semantics
- raw float `+`, `-`, `*`, `/`, `%` use the same `nan_to_zero` / totalized meaning as canonical IR
- raw float calls like `sqrt`, `log`, `pow`, `asin`, and `acos` are denotationally guarded the same way

This is why `raw_ir -> canonical_ir` can now be proved as a real semantic edge instead of only matching by syntax.

### 3.3 Structs

Structs are symbolic product values with fieldwise equality.

### 3.4 Equality In The Shared Layer

Shared equality is implemented by `emitValueEquality(...)`.

Today it can encode equality for:

- scalars
- arrays
- structs
- `void`
- some opaque identity-preserving cases

For arrays, equality is extensional:

- dimensions must match
- reads must match for all valid clamped indices

This is the actual current proof semantics for arrays.

Important current limit:

- array equality only closes when the element-level symbolic reads remain encodable
- if the array body/read contains an opaque helper call or some other non-encodable leaf, array equality returns "cannot encode" rather than proving or disproving

## 4. What Counts As A Successful `rad` Proof

`rad` verification runs through `verifyProgram(...)` in:

- [packages/verify/src/verify.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/verify/src/verify.ts)

For recursive functions, the verifier canonicalizes the program and analyzes each function with:

- `analyzeIrFunction(...)`
- `analyzeIrProofSites(...)`

### 4.1 `rad` Outcomes

A recursive function can end up as:

- `verified`
- `bounded`
- `unverified`
- `rejected`

The proof methods reported are:

- `structural`
- `smt`
- `gas`
- `gas_inf`
- `none`

### 4.2 `gas`

If a function uses `gas N`:

- it is not a `rad` proof
- the function is treated as bounded by fuel
- status is `bounded`

If a function uses `gas inf`:

- status is `unverified`
- this explicitly opts out of the totality guarantee

### 4.3 Structural `rad` Proof

The first `rad` proof strategy is structural.

Today this strategy is intentionally narrow.

It only recognizes forms like:

- `rad x`
- `rad abs(x)`

for an integer parameter `x`, and only when the recursive argument looks like:

- `x - c`
- `max(0, x - c)`

with positive constant-style decrease.

If this succeeds, the proof method is `structural`.

### 4.4 SMT `rad` Proof

If the structural proof does not succeed, the verifier tries SMT.

This SMT proof:

- still runs on canonical IR
- still uses shared symbolic semantics
- builds a symbolic substitution from current params to recursive args
- builds a non-collapse guard
- proves strict decrease of the chosen `rad`

The key query shape is:

- there is some non-collapsing recursive argument change
- but the absolute next measure is not smaller than the current measure

If that query is unsat, the `rad` proof succeeds by SMT.

### 4.5 What `rad` SMT Can Use Today

The current SMT `rad` path can use:

- scalar symbolic expressions with SMT lowering
- arrays in the shared symbolic model
- structs in the shared symbolic model
- extensional equality for non-collapse guards

Important nuance:

- the `rad` expression itself must still be a scalar expression that the current SMT backend can encode
- arrays and structs help through substitutions, non-collapse guards, and recursive-argument semantics
- arrays are not themselves ranking functions
- `sum` can now participate in encoded scalar measures when its body/extent stay inside the shared SMT subset

### 4.6 What Makes A `rad` Proof Fail

The current `rad` path fails when:

- there is no `rad` and no `gas`
- the structural pattern is unsupported and the SMT measure cannot be encoded
- the recursive arguments cannot be symbolized well enough
- Z3 produces a real counterexample
- Z3 times out
- Z3 returns `unknown`

Timeout or `unknown` means unproven, not disproven.

## 5. What Counts As A Successful `ref` Proof

`ref` checking runs through:

- [packages/frontend/src/refine.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/frontend/src/refine.ts)
- [packages/proof/src/refinement.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/proof/src/refinement.ts)

The current `ref` statuses are:

- `equivalent`
- `mismatch`
- `unproven`
- `invalid`

The current successful refinement methods are:

- `canonical`
- `exact_zero_arity`
- `symbolic_value_alpha`
- `symbolic_value_smt`
- `symbolic_recursive_induction`

### 5.1 `invalid`

`ref` is `invalid` if the surface rules fail before proof:

- no earlier accepted baseline exists
- signature mismatch
- type mismatch

### 5.2 `canonical`

If baseline and refined canonical IR are alpha-equivalent, refinement succeeds immediately.

This is the strongest simple path because it is exact and semantics-preserving after canonical lowering.

### 5.3 `exact_zero_arity`

If both versions are:

- non-recursive
- zero-argument

then the compiler executes both and compares the runtime result exactly.

If the values match, refinement succeeds by exact execution.

### 5.4 `symbolic_value_alpha`

Before invoking Z3, the non-recursive shared symbolic path now checks whether the
fully lowered symbolic values are syntactically identical.

This is especially useful after helper beta-reduction:

- baseline and refined canonical IR may differ
- but their shared symbolic values may be exactly the same closure/fold/value
  object
- in that case the proof succeeds immediately without solver work
- this now includes array-view normalization cases where helper factoring and
  transpose-like comprehensions collapse back to the same pointwise read
  function

This is stronger than a string-level pretty-print shortcut and weaker than full
symbolic alpha-equivalence over arbitrary renamed binders; today it is exact
syntactic identity of the emitted symbolic value form.

### 5.5 `symbolic_value_smt`

This is the current main non-recursive SMT refinement strategy.

This path now does what it should have done all along:

- lower both baseline and refined functions through canonical IR
- analyze both through the shared symbolic proof semantics
- align parameter names positionally
- build shared value equality with `emitValueEquality(...)`
- ask Z3 whether `not (baseline == refined)` is satisfiable

So non-recursive `ref` is now on the same symbolic foundation as the richer proof paths.

Important current limit:

- this path is only as strong as the symbolic encoding of the final result
- for array returns, that means extensional equality over the returned array must reduce to encodable element reads
- if helper specialization or read normalization still leaves opaque array leaves, the top-level result may still be reported generically as "could not encode return type 'array'"

This includes `sum`:

- constant bounded sums are simplified/unrolled before the SMT query
- symbolic sums are encoded as folds in the shared symbolic SMT layer
- arrays inside those sums still use closure/read-function semantics

This is why examples like:

```jpl
fun foo(a:int): int {
  ret 1
}

ref foo(a:int): int {
  ret (array[i:10] 1)[a]
}
```

now prove successfully.

The refined side lowers through shared array-closure semantics, the read simplifies, and the final equality closes as `1 == 1`.

### 5.6 `symbolic_recursive_induction`

This is the current recursive refinement strategy.

It uses canonical IR plus the shared symbolic value semantics and then adds induction on top.

Its main requirements are:

- no `gas`-based recursive refinement
- a shared scalar `rad` candidate can be found
- every recursive site decreases under that shared measure
- the inductive step closes in Z3

The return type may be:

- `int`
- `float`
- a struct
- an array representable in the shared closure semantics

Recursive helper calls are allowed so long as they stay inside the shared symbolic encoding.

Important current limit:

- "stays inside the shared symbolic encoding" is stricter than "is semantically pure"
- non-recursive helper beta-reduction over array/struct arguments is supported, but recursive/general helper reasoning can still become opaque
- recursive induction also still rejects opaque array leaves

If all of that holds, the refinement succeeds by recursive induction.

Important detail for recursive folds:

- constant small `sum` expressions are unrolled before recursive-site analysis
- that means `sum [i:2] rec(x - (i + 1))` becomes two ordinary recursive proof sites
- larger/symbolic sums still use shared fold semantics in the scalar SMT layer

This path uses:

- `analyzeIrFunction(...)`
- shared symbolic substitutions
- shared equality via `emitValueEquality(...)`
- collapse conditions built from current/refined parameter equality
- inductive hypotheses for recursive sites

This is currently the strongest semantic `ref` path.

## 6. `mismatch` Versus `unproven`

This distinction matters.

### 6.1 `mismatch`

The compiler says `mismatch` only when it has real evidence of semantic difference.

Current ways this can happen:

- zero-arity exact execution differs
- shared symbolic SMT finds a real counterexample
- recursive refinement gets a real runtime-confirmed counterexample in the small checked case

### 6.2 `unproven`

The compiler says `unproven` when it could not finish a proof, for example:

- the function leaves the supported proof subset
- gas-based recursive refinement is requested
- no shared recursive `rad` candidate is available
- the inductive step does not close
- Z3 times out
- Z3 returns `unknown`

This means:

- not proved
- not accepted
- but not necessarily wrong

## 7. Timeouts

All proof attempts are clamped to a hard 2 second budget.

That cap applies to:

- frontend `ref` proving
- verifier `rad` proving
- editor diagnostics / hovers / inlay hints
- CLI proof paths

Timeout means:

- no proof result
- never an automatic mismatch

So the compiler must not say "proved false" when it only means "solver budget exhausted."

## 8. Arrays: What Is True Today

The current compiler state is:

### True Today In Shared Proof Semantics

- arrays are modeled as total read-functions / closures
- indexing is clamped
- comprehension bounds are normalized through positive extents
- array equality is extensional
- array literals are normalized into closure semantics
- recursive/helper-produced arrays are abstract closures, not memory snapshots
- the active canonical proof IR reads arrays through this closure model instead of a mutable-memory theory

### True Today For `rad`

- `rad` proofs already benefit from the shared array semantics where the symbolic backend can use them

### Remaining Limits For `ref`

- gas-based recursive refinement is still rejected as unproven

## 9. Backend / Wasm Semantics

The compiler also has a backend-facing semantics/debug layer for Wasm lowering.

This is useful for inspection and for eventual top-to-bottom proof work.

But today:

- the compiler does not claim full exact proof from source all the way to raw Wasm instructions
- the backend semantics layer is a structured explanation/debug target, not yet the final proof target

So when the compiler says a `rad` or `ref` proof succeeded today, that claim is about:

- source-to-canonical semantic preservation inside the current proof model
- not a full machine-checked source-to-Wasm equivalence proof

## 10. Exact Meaning Of "We Proved It"

Today, "proved" means one of these exact statements:

1. Canonical alpha-equivalence
   The baseline and refined canonical IR are structurally the same modulo renaming.

2. Exact zero-argument execution
   Both zero-arg non-recursive implementations were executed and produced the same runtime value.

3. Exact SMT equivalence in the shared symbolic value model
   Z3 proved that the baseline and refined canonical symbolic values are equal under the current shared symbolic semantics.

4. Exact recursive induction in the shared symbolic value model
   The compiler proved:
   - a shared recursive measure decreases at every recursive site
   - recursive collapse conditions are aligned
   - the inductive step implies equal results

5. `rad` verification
   For every recursive site, at least one declared `rad` obligation was proved:
   - structurally
   - or by SMT on the shared symbolic semantics

Anything else is not currently called a proof.

## 11. Known Gaps

The most important gaps today are:

1. Gas-based recursive refinement is not supported as a semantic equivalence proof.

2. Interprocedural refinement over helper calls with non-scalar arguments is improved but still incomplete; eligible non-recursive helpers are beta-reduced through array/struct semantics, while harder recursive/general cases can still go opaque.

3. Array-return refinement uses shared extensional equality plus array-read beta reduction, but still depends on the element/read-level encoding succeeding all the way through.

4. There is not yet a full exact source-to-Wasm equivalence proof pipeline.

## 12. The Next Unification Step

The next important cleanup is now further down the stack:

- push proof obligations farther toward backend translation validation
- eventually connect the same proof story more tightly to backend lowering artifacts

This document is the correct answer to:

"When JPLMM says it proved something, what exactly did it prove?"
