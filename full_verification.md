# JPL-- Full Verification Plan

This document describes the intended "top to bottom" verification story for the
compiler above raw code generation.

Scope:

- include surface AST and every stable compiler IR / artifact layer below it
- stop before exact Wasm instruction equivalence
- treat non-research passes as the main target
- make every stable layer emit machine-readable semantics
- check that each lower layer is a refinement, sound consequence, or faithful
  implementation of the layer above it

This is not a claim that all of this is already finished.
It is the truth-oriented plan for how full compiler verification should work in
this repo.

For what the compiler already means today when it says "`rad` proved" or
"`ref` proved", see [semantics.md](/Users/robertmorelli/Documents/personal-repos/jplmm/semantics.md).

## 1. Goal

The goal is a semantic ladder:

1. surface JPL-- program
2. typed / resolved AST semantics
3. lowered raw IR semantics
4. canonical IR semantics
5. post-analysis / post-rewrite IR semantics
6. selected implementation semantics for non-research optimizations
7. backend-facing structured lowering semantics

Each stable edge must produce an explicit verification record.

If every edge is justified, then the whole compiler is justified by composition.

This is the core statement:

- every stable compiler layer emits semantics
- every edge proves something precise about those semantics
- the composition of those edge proofs is the compiler correctness story

## 2. What Counts As A "Layer"

Not every internal helper deserves its own proof boundary.
The right proof boundaries are the stable, inspectable stages that already
exist in the codebase.

Today those are:

1. surface AST after parse / resolve / typecheck
2. raw IR from [packages/ir/src/builder.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/ir/src/builder.ts)
3. canonical IR from [packages/optimize/src/canonicalize.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/optimize/src/canonicalize.ts)
4. range facts from [packages/optimize/src/range.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/optimize/src/range.ts)
5. post-guard-elimination IR from [packages/optimize/src/guard_elimination.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/optimize/src/guard_elimination.ts)
6. implementation artifacts from [packages/optimize/src/pipeline.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/optimize/src/pipeline.ts)
7. backend/Wasm-facing lowering semantics from [packages/backend/src/index.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/backend/src/index.ts)

Current machine-readable ladder status:

- `raw_ir`
- `canonical_ir`
- `guard_elided_ir`
- `final_optimized_ir`
- `closed_form_impl_ir` when a verified closed-form implementation is selected
- `lut_impl_semantics` when a verified LUT implementation is selected

Current verified edges in semantics mode:

- `raw_ir -> canonical_ir`
- `canonical_ir -> guard_elided_ir`
- `guard_elided_ir -> final_optimized_ir`
- `final_optimized_ir -> closed_form_impl_ir` via the closed-form countdown matcher when that pass applies
- `final_optimized_ir -> lut_impl_semantics` via exact finite-domain table re-enumeration, with explicit fallback to `final_optimized_ir` outside the LUT domain

The initial full-verification target should cover the non-research path:

- AST -> raw IR
- raw IR -> canonical IR
- canonical IR -> range facts
- canonical IR + range facts -> guard-elided IR
- canonical IR -> closed form implementation
- canonical IR -> LUT implementation
- optimized IR / implementation artifacts -> backend-facing semantics

One important correction from the live codebase:

- closed-form countdown lowering is now intentionally restricted to explicitly nonnegative bounded countdown parameters like `int(0,_)`
- the older unbounded form was not sound over all JPL-- integers, and the new semantics ladder exposed that

The research passes can be added later:

- Aitken
- linear speculation

## 3. One Semantics Per Layer

The compiler should not rely on ad hoc comparison logic at each pass.
Each layer should emit one semantic object in a shared style.

The intended semantic forms are:

### 3.1 Surface / Typed AST Semantics

The AST semantics should be a denotational meaning for:

- pure scalar expressions
- arrays as total clamped-domain read functions
- structs as product values
- `sum` as bounded folds
- `ret`, `res`, `rec`, `rad`, `gas`

This semantics should be close to the language spec and easy to inspect.

### 3.2 Raw IR Semantics

Raw IR semantics should preserve the same meaning but in lowered form:

- explicit operators
- explicit result types
- explicit array / struct constructors and reads
- explicit `rec` and `res`

The raw IR semantic object should not be "whatever the runtime interpreter
does"; it should be a structured semantic form derived from IR nodes.

### 3.3 Canonical IR Semantics

Canonical IR is already the main proof boundary in the current prover.

Its semantics should make explicit:

- saturating integer operators
- total division / modulo
- `nan_to_zero`
- normalized commutative structure
- arrays as functions
- sums as folds

This is already the closest thing to the compiler's proof core.

### 3.4 Analysis Semantics

Some passes do not produce a new executable program.
They produce facts.

The important example is range analysis.

Its semantic object is not "a transformed tree."
It is a set of sound facts over the canonical IR:

- interval facts for nodes
- parameter range/cardinality information
- any supporting assumptions or hints

### 3.5 Implementation Semantics

Some "optimizations" are not really IR rewrites.
They are alternate implementations chosen for a function.

That includes:

- closed forms
- LUTs

For these, the semantic object is:

- the same function meaning
- plus implementation-specific metadata showing how the function will be
  realized

This is why they should be proved as implementation refinement, not raw
tree-to-tree equality.

### 3.6 Backend-Facing Semantics

This layer should stay above instruction-level semantics.

It should explain:

- implementation shape chosen per function
- recursion strategy
- collapse strategy
- total arithmetic helpers
- aggregate lowering behavior

This is already partially exposed in the current Wasm semantics JSON.

## 4. Edge Types

Not every edge is an "equivalence proof."
The compiler needs three different kinds of edge verification.

### 4.1 Refinement / Equivalence

Use this when both layers are executable semantics for the same program:

- AST -> raw IR
- raw IR -> canonical IR
- canonical IR -> post-guard-elimination IR
- implementation semantics -> backend-facing lowering semantics

The exact strength can vary:

- alpha-equivalence
- symbolic equality
- inductive equality
- implementation-specific correctness proof

### 4.2 Soundness

Use this for analyses that produce facts instead of a replacement program:

- range analysis

This proof must mean:

- every fact reported by the analysis is semantically valid for the program it
  annotates

### 4.3 Implementation Correctness

Use this when the lower layer is a chosen implementation strategy:

- canonical IR -> closed form
- canonical IR -> LUT

This proof must mean:

- executing the chosen implementation yields the same result as executing the
  canonical IR semantics

## 5. The Verification Ladder

This is the intended ladder for the non-research compiler.

### 5.1 Surface AST -> Typed AST

Source:

- parsed / resolved / typechecked AST

Target semantics:

- typed AST semantics

Proof obligation:

- the frontend accepted program is well-typed and semantically identical to the
  surface program described by the spec

Status today:

- parse / resolve / typecheck exist and are heavily tested
- there is not yet a first-class exported "typed AST semantics object"
- this is one of the first missing pieces for full-stack AST verification

### 5.2 Typed AST -> Raw IR

Source:

- typed AST

Target:

- raw IR from [packages/ir/src/builder.ts](/Users/robertmorelli/Documents/personal-repos/jplmm/packages/ir/src/builder.ts)

Proof obligation:

- raw IR semantics refines typed AST semantics

Key challenge:

- proving that AST constructs like comprehensions, sums, field updates, and
  recursion are lowered faithfully

Why it is tractable:

- the IR builder is a direct structural lowering
- JPL-- has no arbitrary control-flow graph reconstruction problem

### 5.3 Raw IR -> Canonical IR

Source:

- raw IR

Target:

- canonical IR

Proof obligation:

- canonicalization preserves semantics exactly

This includes:

- totalization rewrites
- saturating operator insertion
- `nan_to_zero` insertion
- commutative operand normalization

Why it is tractable:

- canonicalization is local and explicit
- this is one of the easiest strong proof steps in the pipeline

### 5.4 Canonical IR -> Range Facts

Source:

- canonical IR

Target:

- range-analysis facts

Proof obligation:

- every emitted range/cardinality fact is sound for the canonical IR semantics

Important:

- this is not an equivalence step
- it is an analysis-soundness step

### 5.5 Canonical IR + Range Facts -> Guard-Elided IR

Source:

- canonical IR
- sound range facts

Target:

- guard-elided IR

Proof obligation:

- removing each guard is semantics-preserving under the proved range facts

This includes:

- `nan_to_zero`
- `total_div`
- `total_mod`

Why it is tractable:

- the transformation is local
- the analysis that justifies it is explicit

### 5.6 Canonical IR -> Closed Form Implementation

Source:

- canonical IR

Target:

- closed form implementation artifact

Proof obligation:

- the chosen closed form computes the same function as the canonical IR

This should be proved per recognized family, not by one giant generic solver
story.

### 5.7 Canonical IR -> LUT Implementation

Source:

- canonical IR

Target:

- LUT artifact

Proof obligation:

- table lookup equals canonical function result over the tabulated domain

Why it is especially tractable:

- LUT generation is very close to "correct by construction"
- the table is produced by evaluating the semantics over a finite domain

### 5.8 Optimized Program / Implementations -> Backend-Facing Semantics

Source:

- optimized IR
- selected implementation artifacts

Target:

- structured backend semantics

Proof obligation:

- backend lowering semantics faithfully represent the optimized program or its
  chosen implementation artifact

This should stop above exact Wasm instruction validation.

## 6. Current Status By Layer

This section is intentionally blunt.

### 6.1 Already Strong Today

- canonical IR proof semantics are real
- `rad` verification on canonical IR is real
- `ref` verification on canonical IR is real
- arrays-as-functions semantics are real in the proof layer
- sums-as-folds semantics are real in the proof layer
- backend-facing semantics JSON exists
- machine-readable semantics dump exists and now includes raw / canonical / guard-elided / final optimized IR floors

### 6.2 Partially There

- raw IR now appears in the semantics dump with a first-class machine-readable floor record, but its proof semantics still need the same total/saturating denotation as canonical IR if the raw->canonical edge is to close universally
- optimize pipeline reports exist and adjacent IR-floor verification records now exist in semantics mode, but analysis edges are still much weaker than the eventual end-state
  yet exist as first-class artifacts
- backend-facing semantics exist, but they are not yet connected to upstream
  per-edge proof objects

### 6.3 Not Yet Finished

- typed AST semantics as a first-class machine-readable object
- AST -> raw IR proof record
- raw IR -> canonical IR proof record
- range-analysis soundness artifact
- guard-elimination proof artifact
- closed-form verification artifact
- LUT verification artifact
- one full CLI mode that dumps every layer and every edge check in one schema

## 7. What The External Verification Output Should Contain

The compiler should have a machine-readable mode that emits:

1. input source identity
2. typed AST semantics
3. raw IR
4. raw IR semantics
5. canonical IR
6. canonical IR semantics
7. range facts
8. guard-elided IR
9. implementation artifacts
10. backend-facing semantics
11. edge verification records

Each edge record should include:

- `sourceLayer`
- `targetLayer`
- `obligationKind`
- `status`
- `method`
- `details`
- `counterexample` when one exists
- `timeoutMs`
- `proofInputs`

Suggested obligation kinds:

- `equivalence`
- `refinement`
- `soundness`
- `implementation_correctness`

Suggested statuses:

- `proved`
- `mismatch`
- `unproven`
- `skipped`

This output should be deterministic and suitable for external checking.

## 8. What The Prover Should Reuse Everywhere

The whole point is to avoid duplicated semantic logic.

The shared core should remain:

- arrays as clamped-domain read-functions
- sums as bounded folds
- structs as product values
- shared value equality
- canonical `rec` / `res` / `rad` semantics

Each layer should reuse that core as much as possible instead of inventing a
new proof language per pass.

The better pattern is:

- layer-specific lowering
- shared semantic value language
- edge-specific proof rule

Not:

- one custom theorem prover per optimization

## 9. What Should Be Excluded At First

To keep this project sane, the first full-verification milestone should exclude:

- exact Wasm instruction equivalence
- native codegen equivalence
- research passes
- arbitrary interprocedural helper summarization beyond what the current shared
  symbolic layer can already encode

That still leaves a very strong claim:

- the entire non-research compiler above codegen is semantically checked

## 10. Why This Is Doable Here

This plan would be much worse in a normal compiler.
It is unusually plausible in JPL-- because:

- the language is total by design except where `gas inf` opts out
- recursion structure is explicit
- arrays are already modeled functionally
- sums are already modeled as folds
- canonicalization already exposes total arithmetic explicitly
- the optimizer has relatively few destructive rewrites
- several optimizations are implementation selection, not arbitrary mutation

That means the compiler already wants to be verified in exactly this style.

## 11. Recommended Build Order

If this work is implemented, the best order is:

1. define machine-readable typed AST semantics
2. define machine-readable raw IR semantics
3. add AST -> raw IR edge records
4. add raw IR -> canonical IR edge records
5. add range-analysis soundness records
6. add guard-elimination proof records
7. add closed-form proof records
8. add LUT proof records
9. unify everything in one CLI `semantics` / `verification` output mode

Only after that should the compiler worry about exact instruction-level
translation validation.

## 12. Bottom Line

Yes: full verification down the tree is doable if "the tree" means all stable
compiler layers above raw code generation.

The right target is not:

- "prove every incidental internal helper"

The right target is:

- every stable layer emits semantics
- every edge emits a proof record
- every non-research pass above codegen is justified

That would be a real top-to-bottom verified compiler story for JPL--, even
before exact Wasm instruction proofs exist.
