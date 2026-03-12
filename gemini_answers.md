# Synthesized Answers to JPL-- Implementation Questions

This document addresses the implementation questions raised by Claude, Codex, and Gemini, grouped by major architectural themes.

## 1. Language Semantics & Edge Cases

**Q: Which `res` value does `rad` see?**
`rad` is a compile-time construct that mathematically bounds the distance to the fixed point. It sees the symbolic value of `res` *at the point the `rad` statement appears in the source*. In `ret A; rad X; ret B`, the `rad` evaluates `X` assuming `res = A`.

**Q: Multiple `gas` statements in one function?**
It should be a compile-time error. `gas` defines the fundamental termination guarantee (or lack thereof) for a function. Allowing multiple `gas` statements introduces ambiguity. `resolve.ts` should reject it.

**Q: How does `rec` evaluate when there are multiple calls in one expression?**
Expressions in JPL-- are pure, so evaluation order (left-to-right) shouldn't observably matter for correctness. For the loop-based lowering, the IR builder will evaluate the arguments for *all* `rec` calls, check fixed-point collapse for each independently. If *any* non-collapsed `rec` remains, the loop backedge is taken with the merged state. If they converge at different rates, the collapsed ones freeze their values (harmless redundant compute in the scalar case, or masked in SIMD).

**Q: Shadowing in `array`/`sum` bindings?**
The spec strictly forbids shadowing. `array [i : N]` where `i` is already bound is an error. To avoid making matrix math unbearable (`array [i] array [i]`), the idiomatic JPL-- style enforces distinct indices (`i`, `j`, `k`). It's restrictive but keeps the single-pass resolver absolutely trivial.

**Q: Is `rad res` legal if the function returns a struct/array?**
No. `rad` must evaluate to a scalar `int` or `float`. If a function returns a complex type, its `rad` expression must be formulated securely in terms of scalar parameters, or it must use `gas`.

**Q: The Collatz Example is inaccurate?**
Yes. The example in the spec computes one step of Collatz and recurses passing the step as `x`. It converges if `f(x) == x`, which for Collatz only happens at 1 (sometimes) or cycles. The `gas 1000` exhaustion is the intended exit, returning the 1000th iterate, not the sequence length. The spec should clarify this is an example of bounded divergence, not a functional Collatz implementation.

## 2. Total Arithmetic & Float Edge Cases

**Q: Cost of `NanToZero` guards and elimination failures?**
The cost of the 4-instruction `select` sequence (`local.tee`, `f32.eq`, `f32.const 0.0`, `select`) is very low on WASM engines (single-cycle ALU ops). However, applying it to *every* operation bloats code size. Pass 1.4 (Guard Elimination) is critical. If range analysis fails to prove an input is valid, the guard stays. 

**Q: Signed Zero (`-0.0 == +0.0`) and Angular Convergence?**
The fixed-point check treats them as equal to ensure convergence even if operations dither the sign bit. However, `NanToZero` canonicalizes to `+0.0`. If angular logic (like `atan2`) relies on `-0.0` to return `-π`, squashing it to `+0.0` will jump the result to `+π`. The compiler accepts this tradeoff: total stability over IEEE pedantry. Programmers must bounds-check angular wraparounds manually.

**Q: Fixed-point equality when both sides are `-inf`?**
Yes, `-inf == -inf` evaluates to true for convergence, just like `+inf`.

**Q: Branchless lowering for integer `TotalDiv` / `TotalMod`?**
```wasm
local.get $y
i32.eqz
local.get $y
i32.or          ;; y_safe = y | (y == 0)
i32.div_s       ;; raw = x / y_safe
local.get $y
i32.eqz
select          ;; result = (y == 0) ? 0 : raw
```

## 3. Verification & SMT

**Q: Z3 Timeout Determinism (LSP vs CLI)?**
Z3 runs synchronously in the CLI to guarantee determinism. A hard timeout (e.g., 5 seconds) results in an `UNVERIFIED` failure. The LSP runs async and non-blocking. If a slow machine times out, the build fails. `rad` should strictly rely on structural and symbolic passes for fast paths; hitting Z3 is a last resort.

**Q: "ULP" in Aitken Validation (`rad(S_∞) < ULP`)?**
It means `rad(S_∞) < ULP(S_∞)` for floats (the distance to fixed point is smaller than the precision of the number) or `< 1` for ints. This proves the extrapolated state is within the fixed-point epsilon.

**Q: The `exists i` ULP difference in SMT?**
To prevent vacuously false proofs when `args == params`, the SMT query includes `OR(abs(arg_i - param_i) >= ULP(param_i))`.

## 4. Passes & IR Mechanics

**Q: How are `NodeId`s kept stable for LSP?**
`NodeId`s are derived from the tree-sitter node IDs or byte ranges, making them implicitly stable across edits to unrelated functions, allowing incremental re-verification.

**Q: Range Analysis Fixed-Point or Single-Pass?**
It must be a bounded fixed-point iteration over the `rec` loops within a function. It iterates until ranges stabilize. Saturating arithmetic guarantees the ranges will eventually hit `INT32_MIN` or `INT32_MAX` and stop.

**Q: The CAS Dependency (Pass 3.2 Pyodide)?**
Pyodide is too heavy. Pass 3.2 is a Reach Goal. The Tier 2.1 Pattern Matcher is the practical solution for recognizing Babylonian and Linear convergences.

**Q: Phase Ordering (Symbolic vs Core)?**
Symbolic Verification must run *before* or *during* the lowering to IR, meaning it must be in Phase 1 or 2. If it's Phase 3, you cannot compile `sqrt_iter` using `rad`.

## 5. Execution Model & Hardware Tuning

**Q: `gas N` tail-call visibility?**
If a target supports `return_call`, the fuel counter is passed as a hidden parameter to an internal WASM function `$func_name_fuel`. The exported WASM function wraps it and injects the initial `N` literal.

**Q: Linear Speculation Sync Overhead (Pass 3.6 Strategy B)?**
In WASM, `memory.atomic.wait32` is too slow to trail by a single iteration. The batching strategy (checking every N iterations) amortizes the sync cost. On native ARM64, `dmb` is cheap enough.

**Q: WasmGC Allocation Pressure in `rec` Loops?**
This is the biggest perf cliff in the language. If a `rec` loop reconstructs an array (`array.new`) per iteration, it will thrash the GC. The structural Group 3 passes must perform escape analysis and hoist allocations to mutable `SpecBuffer`s or reuse `.wasm` linear memory for intermediate array states.
