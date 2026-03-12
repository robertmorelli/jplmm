JPL-- Optimizer Architecture
=============================

The optimizer is split into four sequential groups. Each group reads the IR and
annotations from all previous groups but never reaches back. Within each group,
passes are ordered but individually toggleable.

```
Typed AST (from frontend + verifier)
    │
    ▼
┌──────────────────────┐
│  1. CANONICALIZE      │  Normalize math, expand totality, compute facts
└──────────┬───────────┘
           │  Canonical IR + AnalysisFacts
           ▼
┌──────────────────────┐
│  2. ALGEBRAIC         │  Rewrite what is computed
└──────────┬───────────┘
           │  Algebraic IR (rec loops may be gone)
           ▼
┌──────────────────────┐
│  3. STRUCTURAL        │  Reshape how computation is organized
└──────────┬───────────┘
           │  Structural IR (loops unrolled, passes split, buffers allocated)
           ▼
┌──────────────────────┐
│  4. MACHINE           │  Lower to target hardware idioms
└──────────┬───────────┘
           │  Machine IR (WASM-ready)
           ▼
        WASM 3.0 Emit
```


Group 1: CANONICALIZE
---------------------

**Purpose:** Normalize the IR so that all downstream groups see clean, total,
fully-annotated math. No undefined operations, no implicit behaviors, no
surprises. Every node has range and cardinality annotations.

**This group does not change the program's structure.** It changes the
mathematical surface (making it total) and attaches metadata (ranges, signs,
cardinalities) that all later groups consume.

### Pass 1.1: Total Arithmetic Expansion

Rewrites the IR so that every operation is total. This must happen first because
all algebraic transforms (CAS, SymPy, Z3) need to assume complete math.

**IR nodes consumed:**

| IR Node | Transform | Emits |
|---------|-----------|-------|
| `Div(a, b)` where `b : int` | Replace with `TotalDiv(a, b)` | `TotalDiv(a,b)` = `(b == 0) ? 0 : (a / b)` |
| `Mod(a, b)` where `b : int` | Replace with `TotalMod(a, b)` | `TotalMod(a,b)` = `(b == 0) ? 0 : (a % b)` |
| `Div(a, b)` where `b : float` | Replace with `NanToZero(TotalDiv(a, b))` | Zero-divisor → `0.0`, then NaN→0 |
| `Mod(a, b)` where `b : float` | Replace with `NanToZero(TotalMod(a, b))` | Zero-divisor → `0.0`, then NaN→0 |
| `Add/Sub/Mul` where operand type is `float` | Wrap in `NanToZero(...)` in canonical IR | Ensures globally NaNless float domain |
| `Call("sqrt", x)` | Wrap in `NanToZero(Call("sqrt", x))` | `NanToZero` sentinel node |
| `Call("log", x)` | Wrap in `NanToZero(Call("log", x))` | `NanToZero` sentinel node |
| `Call("pow", x, y)` | Wrap in `NanToZero(Call("pow", x, y))` | `NanToZero` sentinel node |
| `Call("asin", x)` | Wrap in `NanToZero(Call("asin", x))` | `NanToZero` sentinel node |
| `Call("acos", x)` | Wrap in `NanToZero(Call("acos", x))` | `NanToZero` sentinel node |

`TotalDiv`, `TotalMod`, and `NanToZero` are **sentinel IR nodes** — they mark
where totality/NaN-elimination were enforced. They survive through the
algebraic and structural groups untouched. The machine group lowers them to
branchless instructions.

This design means the algebraic group sees `TotalDiv(a, b)`/`TotalMod(a, b)`
and can reason about them directly: zero-divisor is already canonicalized to
zero, and no trap path exists. The machine group later expands these nodes to
safe-divisor plus branchless `select`.


### Pass 1.2: Saturating Arithmetic Expansion

Makes saturating semantics explicit in the IR. Upstream, `Add(a, b)` meant
"maybe wrapping, maybe saturating." After this pass, it means "saturating" with
explicit clamp nodes.

**IR nodes consumed:**

| IR Node | Transform | Emits |
|---------|-----------|-------|
| `Add(a, b)` where both `: int` | `SatAdd(a, b)` | New node with saturating semantics |
| `Sub(a, b)` where both `: int` | `SatSub(a, b)` | New node with saturating semantics |
| `Mul(a, b)` where both `: int` | `SatMul(a, b)` | New node with saturating semantics |
| `Neg(a)` where `a : int` | `SatNeg(a)` | `-INT32_MIN = INT32_MAX` |

`SatAdd`, `SatSub`, `SatMul`, `SatNeg` are IR nodes that carry saturating
semantics. The algebraic group knows these can't overflow. The machine group
lowers them to 64-bit promote → op → clamp → truncate.

Float arithmetic is untouched — IEEE 754 already saturates to `±inf`.


### Pass 1.3: Range Analysis

Propagates value intervals through the IR. Every expression node gets a
`[lo, hi]` annotation. This is the foundation for LUT tabulation, absorption
detection, and guard elimination.

**IR nodes consumed:**

| IR Node | Range Rule | Example |
|---------|------------|---------|
| `IntLit(k)` | `[k, k]` | `IntLit(5)` → `[5, 5]` |
| `Call("clamp", x, lo, hi)` | `[lo.val, hi.val]` | `clamp(x, 0, 255)` → `[0, 255]` |
| `Call("max", a, b)` | `[max(a.lo, b.lo), max(a.hi, b.hi)]` | `max(0, x)` where `x ∈ [-100, 100]` → `[0, 100]` |
| `Call("min", a, b)` | `[min(a.lo, b.lo), min(a.hi, b.hi)]` | `min(x, 255)` where `x ∈ [0, 1000]` → `[0, 255]` |
| `Call("abs", a)` | `[0, max(abs(a.lo), abs(a.hi))]` | `abs(x)` where `x ∈ [-50, 30]` → `[0, 50]` |
| `SatAdd(a, b)` | `[clamp(a.lo+b.lo), clamp(a.hi+b.hi)]` | Saturating bounds |
| `SatMul(a, b)` | Four-corner analysis | Product of interval endpoints |
| `Mod(a, b)` | `[-(abs(b.hi)-1), abs(b.hi)-1]` | `x % 10` → `[-9, 9]` |
| `Param(name)` | `[INT32_MIN, INT32_MAX]` (default) | Narrowed by callers |
| `Rec(args)` | Transfer function from current ranges | Propagated from rec arguments |

**Outputs:**
- `RangeMap: Map<NodeId, [lo, hi]>` — interval per expression
- `CardinalityMap: Map<FuncId, number>` — product of param ranges per function
- `AbsorptionSet: Set<NodeId>` — expressions proven to be at saturation boundary


### Pass 1.4: NanToZero Guard Elimination

Uses range analysis to remove `NanToZero` sentinel nodes where the input is
provably in-domain.

**IR nodes consumed:**

| IR Node | Condition to Eliminate | Example |
|---------|----------------------|---------|
| `NanToZero(Call("sqrt", x))` | `x.range.lo >= 0` | `sqrt(max(0, x))` — guard removed |
| `TotalDiv(a, b)` | `b.range` excludes 0 | `a / clamp(b, 1, 100)` — simplify to `Div(a, b)` |
| `TotalMod(a, b)` | `b.range` excludes 0 | `a % clamp(b, 1, 100)` — simplify to `Mod(a, b)` |
| `NanToZero(Call("log", x))` | `x.range.lo > 0` | `log(max(1, x))` — guard removed |
| `NanToZero(expr)` | `expr` proven NaN-free | remove wrapper |

This is the payoff of doing Total Arithmetic first and range analysis second.
Most `NanToZero`, `TotalDiv`, and `TotalMod` nodes get eliminated before the
algebraic group ever sees them. The remaining sentinels survive to machine
lowering.


Group 2: ALGEBRAIC
-------------------

**Purpose:** Rewrite *what* is computed. Replace `rec` loops with closed-form
expressions, substitute entire functions with lookup tables, inject
extrapolation formulas. These transforms change the mathematical computation
while preserving the result.

**This group may eliminate `rec` nodes entirely.** A function that was a
convergent loop may become a single expression or a table lookup after this
group. All transforms here are target-independent — they produce abstract IR
that could run on any backend.


### Pass 2.1: Closed-Form Pattern Matching

Matches known `rec` + `ret` structures and replaces them with direct
computation.

**IR nodes consumed:**

| Pattern (IR shape) | Detection | Replacement IR |
|--------------------|-----------|---------------|
| `Ret(Div(Add(g, Div(x, g)), Lit(2)))` + `Rec(x, res)` | Babylonian method | `Call("sqrt", x)` |
| `Ret(a)` + `Rec(Min(Abs(a),Abs(b)), Mod(Max(...),Min(...)))` | Euclidean GCD | `Call("__gcd", a, b)` |
| `Ret(Add(a, Lit(c)))` + `Rec(res)` + `Rad(Sub(target, res))` | Linear convergence | Direct arithmetic |

Each pattern is a template match on the IR subgraph rooted at `Ret` and `Rec`
nodes. The `Rec` node's arguments are compared structurally to the function's
`Param` nodes to identify which parameters change and how.

**Key IR nodes:** `Rec`, `Ret`, `Res`, `Param`, `Rad`


### Pass 2.2: Algebraic Fixed-Point Resolution (Experimental, Optional)

Attempts to solve the fixed-point equation algebraically via a CAS plugin.

**No Pyodide dependency.** This pass is opt-in at build time. The default
toolchain ships without any CAS. To enable, provide a plugin implementing
the `CASResolver` interface (see `optimizer/cas-plugin.ts`). The pattern
matcher (Pass 2.1) is the primary algebraic optimization; this pass is a
reach goal that can discover closed forms Pass 2.1 doesn't know.

**IR nodes consumed:**

| IR Node | CAS Treatment |
|---------|---------------|
| `Rec(args...)` | Defines the recurrence: `args = f(params)` |
| `Ret(expr)` | Defines the iterate: `res = expr` |
| `Param(name)` | Free variables in the equation |
| `Res` | The unknown to solve for |

The CAS solves `Res = body(Params, Res)` for `Res` in terms of `Params`.
If successful, the entire `Rec` loop is replaced with the closed-form
expression. The `Rad` node is erased (it was already verified and is
compile-time only).

**Timeout:** Configurable resource limit (`rlimit`-based or wall-clock, at
plugin's discretion). If the CAS can't solve it or times out, the pass is
a no-op for that function. `unknown/timeout` is treated as a miss — the
function continues through the pipeline unchanged.


### Pass 2.3: LUT Tabulation

Replaces functions with lookup tables when the state-space cardinality
(from pass 1.3) is below a threshold.

**IR nodes consumed:**

| IR Node | Role |
|---------|------|
| `Func(name, params, body)` | The tabulation candidate |
| `Param(name)` with `range ∈ [lo, hi]` | Defines the LUT dimensions |
| `Rec(...)` | Evaluated at compile time for every input (safe because rad-verified) |
| `Ret(expr)` | Evaluated to produce each table entry |

**Emits:**

| New IR Node | Description |
|-------------|-------------|
| `LUT(table_data, index_exprs)` | Single indexed load replacing entire function body |
| `LUTInline(byte_array)` | For ≤256 entries, inline the table as a constant |
| `LUTRef(global_id)` | For larger tables, reference a global data section |

The function body (including all `Rec` loops) is evaluated at compile time for
every point in the domain. This is sound because `rad` proved termination for
all inputs. The result is a flat array indexed by `(param - range.lo)`.


### Pass 2.4: Aitken Extrapolation Insertion (Experimental)

For `rec` loops that survive passes 2.1–2.3, optionally inserts Aitken Δ²
extrapolation after 3 iterations.

**IR nodes consumed:**

| IR Node | Role |
|---------|------|
| `Rec(args...)` | The loop to accelerate |
| `Res` | The iterate sequence `S₀, S₁, S₂` |
| `Rad(expr)` | Used to validate the extrapolated value |

**Emits:**

| New IR Node | Description |
|-------------|-------------|
| `AitkenGuard(s0, s1, s2, rad_expr)` | Computes extrapolation, validates via two-condition check, falls back if invalid |
| `AitkenResult(extrapolated_value)` | The Δ² result if validation passed |

The `AitkenGuard` node encapsulates the try-extrapolate-or-continue logic.
Validation requires **both**: (1) `rad(S_∞) < rad(S₂)` — radius is still
decreasing; and (2) `rad(S_∞) < ULP(S_∞)` for floats / `rad(S_∞) < 1` for
integers — the extrapolated state is within one ULP of the fixed point, i.e.,
would collapse on the next real iteration. The ULP computation reuses the
same `ULPDistance` function as the fixed-point collapse check.
The structural group decides how to schedule it (inline vs. batched).


Group 3: STRUCTURAL
--------------------

**Purpose:** Reshape *how* the computation is organized. Loop unrolling, pass
splitting, buffer allocation, thread partitioning. These transforms change the
execution structure without changing the mathematical result.

**This group introduces new control-flow and memory nodes** that don't exist in
the algebraic IR: explicit loops, buffers, barriers, batch boundaries.


### Pass 3.1: Lyapunov Unroll

For `rec` loops with statically bounded iteration counts (computed from `rad`
and range analysis), fully unroll the loop into straight-line code.

**IR nodes consumed:**

| IR Node | Role |
|---------|------|
| `Rec(args...)` | The loop to unroll |
| `Rad(expr)` with known contraction ratio | Bounds the iteration count |
| Ranges from pass 1.3 | Determines initial `rad` value |

**Decision logic:**
- `rad x` where `x ∈ [0, N]` and `N ≤ 32` → unroll `N` times
- `rad g - res` with quadratic convergence on `f32` → unroll 6 times
- Otherwise → leave as loop

**Emits:**

| New IR Node | Description |
|-------------|-------------|
| `UnrolledBlock([body₀, body₁, ..., bodyₙ])` | Flat sequence of iteration bodies |
| `FixedPointExit(i, res_i)` | Early exit after iteration `i` if converged |

Each `bodyᵢ` is a copy of the `rec` body with `Param` replaced by the
previous iteration's `Res`. The `FixedPointExit` nodes are the only remaining
convergence checks — one per unrolled iteration.


### Pass 3.2: Separability Rewrite (Experimental)

Detects separable 2D kernels and rewrites them as two 1D passes.

**IR nodes consumed:**

| IR Node | Role |
|---------|------|
| `ArrayExpr(bindings=[i, j], body)` | The 2D kernel |
| `SumExpr(bindings=[i, j], body)` | The 2D reduction |
| `body` sub-expressions | Analyzed for i-only vs j-only dependence |

**Analysis:** Partition `body` sub-expressions into three sets:
- `I_only`: depends on `i` but not `j`
- `J_only`: depends on `j` but not `i`
- `Mixed`: depends on both

If `body = I_only * J_only` (multiplicative) or `body = I_only + J_only`
(additive), the kernel is separable.

**Emits:**

| New IR Node | Description |
|-------------|-------------|
| `SeparablePass(dim, binding, body_part)` | One 1D pass |
| `TempBuffer(dims, element_type)` | Intermediate buffer between passes |


### Pass 3.3: Convergence Wavefront Scheduling (Experimental)

For `ArrayExpr` where each element is an independent `rec` computation,
emits a wavefront scheduler that retires converged elements and compacts
active ones.

**IR nodes consumed:**

| IR Node | Role |
|---------|------|
| `ArrayExpr(bindings, body)` where `body` contains `Rec` | Per-element convergent computation |
| Cardinality of the array | Determines batch sizing |

**Emits:**

| New IR Node | Description |
|-------------|-------------|
| `WavefrontLoop(batch_size, body, converge_check)` | Outer scheduling loop |
| `ActiveMask(bitmask)` | Tracks which elements are still active |
| `Compact(active_mask, data)` | Packs active elements into dense SIMD registers |
| `Retire(converged_indices, results)` | Writes converged elements to output |


### Pass 3.4: Linear Speculation Scheduling (Experimental)

For `rec` loops that survive all previous optimizations, splits compute and
convergence-check into separate schedulable units for two-thread execution.

**Target notes:**
- **arm64 (primary target):** Full two-thread model with hardware threads,
  `dmb` barriers, and per-thread cache partitioning. This is the intended
  deployment platform where the speculation model achieves its full benefit.
- **WASM (current):** True multi-thread speculation via `SharedArrayBuffer`
  is off by default due to `memory.atomic.wait32` overhead. On WASM, this
  pass emits single-thread structural decoupling only — the compute and
  check basic blocks are separated to help the WASM engine's OOO scheduler
  overlap them at the instruction level. Full WASM threading requires the
  target to explicitly enable `--spec-threads`.
- **GPU (future):** Each wavefront is already a linear pipeline; convergence
  check maps to `subgroupBallot`. No changes needed to the IR nodes — only
  to the machine emission target.

**IR nodes consumed:**

| IR Node | Role |
|---------|------|
| `Rec(args...)` | The loop to speculate |
| `FixedPointCheck(args, params)` | The convergence check to decouple |
| `Res` | The per-iteration result to buffer |
| Rec body weight (instruction count) | Determines strategy A vs B |

**Emits:**

| New IR Node | Description |
|-------------|-------------|
| `SpecBatch(size, compute_body, check_body)` | One batch of speculative iterations |
| `SpecDoubling(initial=4, max=256)` | Exponential search schedule |
| `SpecBuffer(element_type, max_size)` | Per-thread flat buffer |
| `SpecSync()` | Barrier between compute and check |
| `SpecHalt(converged_index)` | Signal to stop speculation |

The `SpecBatch` node contains two independent sub-IRs: `compute_body` (Thread
A's work) and `check_body` (Thread B's work). In Strategy A, `check_body`
redundantly recomputes the `rec` body. In Strategy B, `check_body` reads from
Thread A's buffer. The machine group decides which strategy to use based on
target capabilities.


### Pass 3.5: V-Cycle Scheduling (Experimental — OPEN)

**Status: Not yet implemented.** Placeholder for depth-1 V-cycle (coarse →
fine) acceleration of bounded-stencil kernels. See Optimization Goals §3.5
for design rationale, detection criteria, and the known-safe kernel whitelist.

**Prerequisites before this pass can be implemented:**

1. Pass 3.2 (Separability) must be stable — V-Cycle reuses `TempBuffer` and
   `SeparablePass` IR nodes for coarse and fine buffers.
2. A stencil-detection sub-analysis: walk `ArrayGet` index expressions inside
   `Rec` bodies, verify `Param ± Literal` form with `|Literal| ≤ 3`.
3. A kernel pattern-match registry extending Pass 2.1's pattern table, covering
   the whitelist: box average, Gaussian blur, Laplacian diffusion.

**Intended IR nodes (when implemented):**

| New IR Node | Description |
|-------------|-------------|
| `CoarseBuffer(dims, element_type)` | Half-resolution intermediate image |
| `DownsampleExpr(src)` | Box-average downsample, synthesized as `ArrayExpr` |
| `UpsampleExpr(src)` | Bilinear upsample, synthesized as `ArrayExpr` |
| `VCycleSchedule(coarse_body, fine_body, guess_param)` | Outer scheduling node |

The guess parameter substitution: the upsampled coarse result replaces the
initial value of the `res` SSA variable (the guess) before the first `ret` in
the fine-resolution loop body — a targeted IR substitution, not a structural
rewrite. The `DownsampleExpr` and `UpsampleExpr` nodes are injected as IR
directly; single-pass definition order is an AST/source-level rule and does
not apply here.

**Implementation order:** Dead last among all Tier 3 passes, after linear
speculation is stable.


Group 4: MACHINE
-----------------

**Purpose:** Lower abstract IR nodes to target-specific instructions. This is
the only group that knows about WASM 3.0 opcodes, SIMD widths, cache line
sizes, and calling conventions.

**No semantic transforms happen here.** Only mechanical lowering of abstract
nodes to concrete instructions.


### Pass 4.1: SIMD Vectorization

Packs independent scalar operations into SIMD lanes.

**IR nodes consumed → emitted:**

| Abstract IR | WASM 3.0 Emission |
|-------------|-------------------|
| `SatAdd(a, b)` (×4 independent) | `i32x4.add` + `i32x4.min_s` + `i32x4.max_s` |
| `LUT(table, index)` (×16 u8 inputs) | `i8x16.swizzle` |
| `ActiveMask(bitmask)` | `i32x4.bitmask` |
| `Compact(mask, data)` | `i8x16.swizzle` with compaction permutation |
| `NanToZero(expr)` (×4 floats) | `f32x4` op + `f32x4.eq` + `v128.bitselect` |


### Pass 4.2: Sentinel Lowering

Expands sentinel nodes from Group 1 into branchless instruction sequences.

**IR nodes consumed → emitted:**

| Sentinel | WASM 3.0 Expansion |
|----------|-------------------|
| `TotalDiv(a, b)` | `is0=eqz(b)`; `raw=a/(b\|is0)`; `select(0, raw, is0)` |
| `TotalMod(a, b)` | `is0=eqz(b)`; `raw=a%(b\|is0)`; `select(0, raw, is0)` |
| `NanToZero(expr)` | `local.tee` + `f32.eq` + `f32.const 0` + `select` — 4 instructions |
| `SatAdd(a, b)` | `i64.extend_i32_s` × 2 + `i64.add` + clamp + `i32.wrap_i64` |
| `SatSub(a, b)` | Same pattern with `i64.sub` |
| `SatMul(a, b)` | Same pattern with `i64.mul` |
| `SatNeg(a)` | `i64.extend_i32_s` + `i64.sub(0, _)` + clamp + `i32.wrap_i64` |


### Pass 4.3: Rec Control-Flow Lowering

Lowers `rec` nodes to stack-neutral control flow: loop backedges by default,
with `return_call` for tail-position sites when available.

**Partial convergence check optimization (addresses opt_guide Tier 2.4):**
Before emitting the `FixedPointCheck`, this pass performs static analysis on
each `rec` argument. If a `rec` argument is provably identical to its
corresponding `Param` node (e.g., `rec(x, res)` where `x` passes through
unchanged), the corresponding parameter slot is skipped entirely in the
emitted convergence check. Only parameters whose `rec` argument differs from
the `Param` node are included in the check. This eliminates redundant
comparisons without any runtime overhead.

**IR nodes consumed → emitted:**

| Abstract IR | WASM 3.0 Emission |
|-------------|-------------------|
| `RecTail(args...)` (tail-position, not collapsed) | loop backedge / local state update (stack-neutral) |
| `RecTail(args...)` (tail-position) | `return_call $self` when target supports tail calls |
| `RecCall(args...)` (non-tail-position) | ordinary `call $self` — genuine call frame |
| `FixedPointCheck(args, params)` (int) | `i32.eq` per actively-changing param |
| `FixedPointCheck(args, params)` (float) | `i32.reinterpret_f32` + `i32.sub` + `i32.abs` + `i32.le_u(_, 1)` |
| `SpecSync()` | `memory.atomic.notify` + `memory.atomic.wait32` |
| `SpecBuffer(...)` | Linear memory allocation in WASM shared memory |


### Pass 4.4: GC Type Lowering

Maps JPL-- structs and arrays to WasmGC types.

**IR nodes consumed → emitted:**

| Abstract IR | WASM 3.0 Emission |
|-------------|-------------------|
| `Struct(fields)` | `struct.new` with `(type $T (struct (field ...)))` |
| `Array(elements)` | `array.new` with `(type $A (array (mut f32)))` |
| `StructGet(s, field)` | `struct.get $T $field` |
| `ArrayGet(a, indices)` | `array.get $A` |
| `RefEq(a, b)` (convergence fast-path) | `ref.eq` — O(1) pointer compare |


Pass Dependencies (DAG)
------------------------

```
1.1 Total Arithmetic
 │
 ▼
1.2 Saturating Expansion
 │
 ▼
1.3 Range Analysis ←────────── reads 1.1 + 1.2 for precise ranges
 │
 ▼
1.4 Guard Elimination ←─────── reads 1.3 ranges to remove NanToZero/TotalDiv/TotalMod
 │
 ├──────────────────────────┐
 ▼                          ▼
2.1 Pattern Match      2.3 LUT Tabulate ←── reads 1.3 cardinalities
 │                          │
 ▼                          │
2.2 CAS Resolve             │
 │                          │
 ├──────────────────────────┘
 ▼
2.4 Aitken (experimental)
 │
 ├──────────────┬──────────────┬──────────────┐
 ▼              ▼              ▼              ▼
3.1 Unroll   3.2 Separate  3.3 Wavefront  3.4 Linear Spec
 │              │              │              │
 │         3.5 V-Cycle (OPEN, requires 3.2)  │
 │              │              │              │
 └──────────────┴──────────────┴──────────────┘
                        │
                        ▼
              4.1 SIMD Vectorize
                        │
                        ▼
              4.2 Sentinel Lowering
                        │
                        ▼
              4.3 Rec Control-Flow Lowering
                        │
                        ▼
              4.4 GC Type Lowering
                        │
                        ▼
                   WASM 3.0 Emit
```
