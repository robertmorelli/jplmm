# Gemini Implementation Questions: JPL--

After reviewing the architecture, spec, and the evaluations from Claude and Codex, here are detailed implementation questions that probe the edges of the JPL-- compiler design. These focus on performance cliffs, semantic edge cases, and the practicalities of the research passes.

## 1. Range-Narrowing and Tabulation (Pass 1.1)

1. **LUT Memory Management:** When multiple functions tabulate to 64KB tables, how does the compiler manage the global data section? Is there a threshold where the combined cache footprint of multiple LUTs degrades performance more than computing the functions directly?
2. **Cascading Range Resolution:** Since range narrowing propagates bottom-up through the single-pass call DAG, what happens if the inferred output range of a function depends on its own parameters? Does the compiler instantiate multiple specialized versions of the function, or does it union the return ranges?
3. **Absorption Boundaries:** Pass 1.4 detects saturating absorption (e.g., when a value hits `INT32_MAX`). How brittle is this analysis? If it fails to constant-fold, how much dead computation is left in the binary?

## 2. Total Arithmetic and `NaN` Elimination

1. **The Cost of Safety:** Claude correctly noted that putting `NanToZero` on *every* float operation puts extreme pressure on Pass 1.4 (Guard Elimination). If Pass 1.4 fails to prove a value is NaN-free, what is the exact pipeline latency cost of the 4-instruction branchless `select` sequence on target CPU/GPU architectures?
2. **Signed Zero Semantics:** The spec states `-0.0 == +0.0` for convergence. What does the `NanToZero` canonicalization do to the sign bit of zero? If it forcefully normalizes to `+0.0`, does this break `atan2` or `pow` behaviors that rely on IEEE 754 signed zero?
3. **`rec` Argument Saturation:** If a saturating operation produces `INT32_MAX`, and this is passed to a `rec` call parameter, does the fixed-point check implicitly rely on the parameter's type enforcing saturation? 

## 3. Multi-`rec` Expressions & Lowering

1. **Heterogeneous Convergence Rules:** In an expression like `max(res, rec(x) + rec(y))`, if `rec(x)` converges but `rec(y)` requires 100 more iterations, does the stack-neutral loop continue evaluating both? If so, is `rec(x)` doing harmless redundant work, or is its result masked dynamically?
2. **Register/Stack Pressure:** Lowering multiple independent `rec` calls within the same expression to a flat loop requires preserving the intermediate state of each. How does the backend prevent this from blowing up register pressure or causing unexpected spills to the WASM stack?

## 4. Verification and SMT (Z3) Fallback

1. **Timeout Determinism:** If Z3 verification runs asynchronously in the LSP but synchronously in the CLI, how do we guarantee deterministic compilation? If Z3 hits a 5-second timeout on a slow CI runner but succeeds on a fast developer machine, does the build suddenly fail? 
2. **ULP Distance Edge Cases:** The `ULPDistance(a, b)` function using monotonic bit ordering is clever. How does it handle `+inf` and `-inf`? If the distance between `MAX_FLOAT` and `+inf` is 1 ULP, does an error surface during factoring?

## 5. Linear Speculative Execution (Pass 3.6)

1. **WASM Atomics / Memory Barriers:** Strategy B relies on Thread B trailing Thread A via a shared buffer. In WASM, how exactly is the tail/head pointer synchronized? If you have to use `memory.atomic.wait32` or heavy memory barriers, doesn't that synchronization overhead destroy the ALU saturation benefits of the speculative compute?
2. **Extrapolation Rollback:** When Aitken extrapolation (Pass 3.1) combines with Linear Speculation, who validates the `rad(S_∞) < ULP` check? If Thread B checks it and it fails, how is this communicated back to Thread A without blocking?

## 6. WasmGC and Memory Allocation

1. **GC Pressure in `rec` Loops:** For functions that operate on structs or arrays, does the compiler perform escape analysis to stack-allocate or mutate intermediate results within the `rec` loop? If not, isn't allocating a new `struct.new` or `array.new` on every iteration catastrophic for WasmGC throughput?
2. **Reference Equality False Negatives:** `ref.eq` is brilliant for O(1) convergence checks. However, if two semantically identical arrays are allocated separately, `ref.eq` returns false. Does the compiler enforce aggressive value-numbering / structural sharing to maximize `ref.eq` hits?

## 7. Pass Mechanics and Dependencies

1. **The CAS Dependency (Pass 3.2):** As Claude pointed out, relying on Pyodide/SymPy is extremely heavy. If you fall back to a lightweight JS CAS, do you lose the robust factorization needed for the Babylonian contraction ratio? 
2. **Phase Ordering:** Why does Symbolic Verification run in Phase 3 while Core Optimizations (which seemingly rely on the outputs of the proof, like iteration bounds) run in Phase 2? Does Phase 2 fall back to conservative bounds when Symbolic Verification is absent?
