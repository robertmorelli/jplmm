JPL-- Specification
===================

*Proving termination is shrimply finding a discrete Lyapunov function for your function.*

JPL-- (pronounced "JPL minus minus") is a deliberately non-Turing-complete
language derived from JPL. Every function in a JPL-- program must be paired
with a finite radius function that proves termination. All such programs are
decidable, though what they compute is unverified. JPL-- has no conditional
expressions or statements. All branching must be expressed as fixed-point
convergence.

JPL-- modifies JPL as described below. Where not explicitly changed, the
original JPL specification applies.

Design Philosophy
-----------------

Highly expressive non-Turing-complete languages are interesting because
anything you write in them must terminate. Multiplicative-exponential linear
logic (MELL) attempted to walk this line, but its decidability remains a
notoriously unsolved, EXPSPACE-hard problem. By requiring an explicit radius
function — a discrete Lyapunov function — we bypass the need for an omniscient
compiler entirely.

JPL-- embraces the finite nature of real computers. There is no infinite tape.
An `int` has `2^32` states. A `float` has `2^32` states. Every program is a
finite state machine. We exploit this to guarantee termination.

### Core Principles

1. **No control flow.** There is no `if/then/else`, no `&&`, no `||`. The only
   mechanism that resembles branching is `rec` collapsing to `res` when
   arguments match parameters (fixed-point detection).

2. **Totality by construction.** Every recursive function must provide either a
   `rad` expression (discrete Lyapunov function, statically verified) or a `gas`
   budget (runtime fuel counter). `rad` makes the function provably total. `gas
   N` makes it bounded. `gas inf` is a Turing-complete escape hatch that opts
   out of the termination guarantee entirely.

3. **Saturating arithmetic.** Integer addition, subtraction, and multiplication
   saturate at `INT32_MAX` / `INT32_MIN` instead of wrapping via two's complement.
   This ensures the state space forms a bounded lattice with a topological
   ordering, rather than a cycle. Float arithmetic retains IEEE 754 semantics
   (which already saturates to `inf`/-`inf`).

4. **Fixed-point collapse.** Recursion terminates not via explicit base cases
   but via convergence: when a `rec` call's arguments are identical to the
   current parameters (within machine epsilon for floats, exact equality for
   integers), the call collapses to the current `res` value.

5. **Single-pass definition order.** Functions are defined and verified in
   source order. A function may only call functions defined above it or itself
   via `rec`. Mutual recursion is structurally impossible. This makes
   termination verification compositional — each function is verified in
   isolation.

### On the Nature of `rad`

A `rad` expression maps the n-dimensional parameter space of a function to a
non-negative scalar. It is, in effect, a ranking function over the finite state
space `[0, 2^32)^n`. The worst-case `rad` function is a space-filling curve
through this space — it visits every reachable state exactly once before
reaching zero. Such a function would permit `(2^32)^n` iterations, which is the
absolute upper bound on any `rad`-verified computation. In practice, useful
`rad` functions are far simpler: `abs(x)` for structural recursion (linear),
`abs(g - res)` for Newton's method (logarithmic). The gap between the
space-filling worst case and the typical case is where expressiveness lives.


Lexical Syntax
--------------

JPL-- inherits JPL's lexical syntax with the following changes.

### Removed Keywords

The following JPL keywords are removed:

`if`, `then`, `else`, `true`, `false`, `bool`

### Added Keywords

The following keywords are added:

`ret`, `res`, `rec`, `rad`, `gas`, `inf`

### Unchanged

All other lexical rules (float literals, strings, variables, whitespace,
comments, newline escapes) are inherited from JPL unchanged.

### Changed Literal Ranges

Integer literals must fit in a 32-bit signed two's complement value. An integer
literal outside the range `-2^31` to `2^31 - 1` is a compile-time error.

Float literals are converted to 32-bit IEEE 754 single-precision values. Use
the C library function `strtof` (not `strtod`) or equivalent. Literals that
convert to infinity are not supported.


Type Syntax
-----------

JPL-- modifies JPL's type syntax. All scalar types are 32-bit:

```
type : int
     | float
     | <type> [ , ... ]
     | <variable>
     | void
```

The `bool` type is removed. There are no boolean values in JPL--.

`int` is a 32-bit signed integer. `float` is a 32-bit IEEE 754 single-precision
float. This is a deliberate departure from JPL's 64-bit types. The rationale:

1. **Saturating arithmetic in a register.** A 32-bit saturating add is trivial
   in a 64-bit register: perform the 64-bit add, then clamp to `[INT32_MIN,
   INT32_MAX]`. No overflow detection intrinsics, no platform-specific builtins,
   no branching.
2. **Smaller state space.** `2^32` states per scalar means the finite state
   machine argument is tighter. Fuel counters under `gas` exhaust faster.
   Verification is over a smaller domain.
3. **GPU alignment.** 32-bit is the native scalar width on virtually all GPU
   hardware. JPL-- programs compile naturally to shader-like backends.

Array dimensions remain 64-bit integers (to allow large arrays). Only scalar
`int` and `float` values used in computation are 32-bit.


Expressions
-----------

JPL-- significantly restricts JPL's expression syntax. The following expression
forms are **removed**:

- Boolean literals: `true`, `false`
- Conditional expressions: `if <expr> then <expr> else <expr>`
- Boolean operators: `&&`, `||`, `!`
- Comparison operators: `<`, `>`, `<=`, `>=`, `==`, `!=`

The following expression forms are **retained** from JPL:

```
expr : <integer>
     | <float>
     | void
     | <variable>
     | <variable> { <expr> , ... }
     | [ <expr> , ... ]
     | ( <expr> )
     | <expr> + <expr>
     | <expr> - <expr>
     | <expr> * <expr>
     | <expr> / <expr>
     | <expr> % <expr>
     | - <expr>
     | <expr>.<variable>
     | <expr> [ <expr> , ... ]
     | array [ <variable> : <expr> , ... ] <expr>
     | sum [ <variable> : <expr> , ... ] <expr>
     | <variable> ( <expr> , ... )
```

The following expression forms are **added**:

```
expr : res
     | rec ( <expr> , ... )
```

#### `res` — Current Result

The keyword `res` refers to the current accumulated result value within a
function body. Its type is the return type of the enclosing function.

**`res` has no default value.** Using `res` before any `ret` statement has
executed is a compile-time error. The compiler tracks `res` initialization
statically: `res` becomes available after the first `ret` in the function body,
and any reference to `res` that appears before that first `ret` is rejected.

```
fn bad(x : int) : int {
    let y = res + 1       // ERROR: res used before any ret
    ret y
}
```

```
fn good(x : int) : int {
    ret x * x             // res is now initialized
    ret res + 1           // OK: res holds x * x
}
```

`res` is only valid inside a function body. Using `res` at the top level is a
compile-time error.

#### `rec` — Convergent Recursion

`rec(expr, ...)` initiates a recursive call to the enclosing function. The
number of arguments must match the function's parameter count. `rec` always
refers to the enclosing function — there is no cross-function `rec`. See
"Binding" below for why mutual recursion is excluded by design.

**Ordering constraint:** A `rec` expression may only appear in an expression
that follows at least one `ret` statement in the function body. This is a
compile-time error:

```
fn bad(x : int) : int {
    ret rec(x - 1)          // ERROR: no prior ret, res has no meaningful value
    rad x
}
```

This is correct:

```
fn good(x : int) : int {
    ret clamp(x, 0, 1)      // res now has a base case value
    ret rec(max(0, x - 1))   // OK: rec can collapse to res
    rad x
}
```

The rationale is that `rec` may collapse to `res`, so `res` must hold a
value before any `rec` is evaluated. Without a prior `ret`, `res` is
uninitialized — using it is a compile-time error, not a silent default.
Requiring an explicit `ret` before any `rec` forces the programmer to define
what the fixed point converges *to*.

**Fixed-point collapse rule:** Before executing the recursive call, the runtime
(or compiled code) checks whether the evaluated arguments are identical to the
current parameter values. For integer and struct types, this is exact bitwise
equality. For float types, this is equality within one ULP (unit in the last
place) — equivalently, the float representations differ by at most 1 in their
integer bit-pattern interpretation. For array types, this is element-wise
comparison under the same rules, plus equal dimensions.

If the arguments match the current parameters under these rules, the `rec`
expression evaluates to the current value of `res` without making the recursive
call. This is the **only** branching mechanism in JPL--.

`rec` may only appear inside a function body. Using `rec` at the top level is a
compile-time error. A function that contains `rec` must also contain at least
one `rad` or `gas` statement.


Statements
----------

JPL-- modifies JPL's statement syntax as follows.

### Removed Statements

- `assert` statements are removed (no booleans).
- `return` statements are removed (replaced by `ret`).

### Retained Statements

```
stmt : let <lvalue> = <expr>
```

### Added Statements

```
stmt : ret <expr>
     | rad <expr>
     | gas <integer>
     | gas inf
```

#### `ret` — Result Accumulation

`ret <expr>` assigns the value of `<expr>` to `res`. The expression must have
the same type as the function's declared return type.

Multiple `ret` statements may appear in a function body. They execute
sequentially, each updating `res`. The value of `res` after the last statement
in the function body executes is the function's return value, unless a `rec`
expression triggers further iteration.

#### `rad` — Radius Declaration (compile-time only)

`rad <expr>` declares a convergence radius (discrete Lyapunov function). The
expression must have type `int` or `float`. **`rad` is purely a compile-time
construct.** It generates no runtime code. The compiler analyzes the `rad`
expression symbolically to prove that `rec` calls converge, then erases it.
Think of `rad` as a proof annotation, not a statement — it exists in the same
layer as Rust lifetimes or Dafny `decreases` clauses.

**Implicit `abs()` wrapping:** The compiler implicitly wraps every `rad`
expression in `abs(...)`. The programmer writes `rad (g - res)` and the
compiler treats it as `rad abs(g - res)`. This means:

- `rad` is always non-negative.
- `rad` is bounded below by zero.
- The programmer doesn't need to reason about sign — just write the expression
  that measures "distance to the fixed point."

A strictly decreasing non-negative quantity over a finite set must reach zero.
That's the entire termination argument.

**Proof obligation:** For every `rec` call in the function, the compiler must
verify that the radius strictly decreases, **given that the `rec` arguments
differ from the current parameters by at least one ULP in at least one
component.** More precisely:

Let `f(p1, p2, ..., pn)` be a function containing `rad R` and `rec(a1, a2,
..., an)`. The compiler must verify:

    Given: exists i such that |a_i - p_i| >= ULP(p_i)
    Prove: abs(R(a1, ..., an)) < abs(R(p1, ..., pn))

where `R(...)` denotes the `rad` expression evaluated with the given parameter
values, and `ULP(p_i)` is the unit in the last place for the type of `p_i` (1
for integers, the float ULP for floats).

The `exists i` precondition is critical: it gives the prover a concrete
hypothesis to work with. Without it, the obligation would be vacuously
impossible at the fixed point (where args equal params and the radius is
already zero). With it, the prover knows at least one parameter has moved by a
distinguishable amount.

If the compiler cannot verify the proof obligation, compilation fails with a
fatal error. There is no fallback, no runtime fuel insertion, no "best effort."
`rad` is a proof — it compiles or it doesn't. If the programmer cannot express
a valid Lyapunov function, they should use `gas` instead.

A function may contain multiple `rad` statements. For each `rec` call, **at
least one** `rad` expression must strictly decrease.

**Array and struct parameters in the proof obligation:** When a function has
array or struct parameters, "differ by at least one ULP in at least one
component" means at least one element (for arrays) or at least one field (for
structs) differs by at least one ULP. The `rad` expression itself must still
evaluate to a scalar `int` or `float` — it cannot be an array or struct.

In v1, the compiler accepts `rad` obligations involving array/struct parameters
only in restricted analyzable forms where the `rad` expression is a scalar
function of scalar-typed parameters alone (e.g., `rad n` in a function that also
takes an array, where convergence is structural on the scalar `n`). Functions
whose termination depends on the array content converging must use `gas` until
full array-content `rad` analysis is implemented.

#### `gas` — Fuel Escape Hatch

`gas` provides an alternative to `rad` for functions where a Lyapunov function
is impractical or impossible to express. A function must contain at least one
`rad` or `gas` statement if it uses `rec`, but not both — `rad` and `gas` are
mutually exclusive within a single function.

**`gas N`** (where `N` is an integer literal) inserts a runtime fuel counter
that limits the function to `N` recursive iterations. If the fuel is exhausted
before `rec` collapses, the function returns the current value of `res`. No
static verification is performed.

A function must contain **at most one** `gas` statement. Multiple `gas`
statements in a single function are a compile-time error.

**Fuel semantics:** `gas N` limits the number of non-collapsing `rec`
transitions within a **single call instance** of the function, not the total
recursive work across all instances. If a `gas` function calls itself via
`rec`, the spawned instance begins with its own fresh fuel counter of `N`. Gas
counts loop iterations for tail-position `rec`; for non-tail `rec`, each
spawned instance has independent fuel.

```
fn collatz(x : int) : int {
    let even_step = x / 2
    let odd_step  = 3 * x + 1
    // x % 2 is 0 or 1; use it to blend the two steps without conditionals
    ret even_step + (x % 2) * (odd_step - even_step)
    ret rec(res)
    gas 1000
}
```

This demonstrates bounded divergence: the function applies one Collatz-like
step per iteration and exhausts fuel if no fixed point is reached, returning
the final `res`. It is not a functional Collatz implementation — the fixed-
point collapse fires when `res == x` (step output equals input), which does
not correspond to reaching 1. `gas 1000` is the termination mechanism.

This is decidable — the function always terminates in at most `N` iterations —
but the termination is not structurally proven. The compiler emits no warnings.

**`gas inf`** removes the fuel counter entirely. The function may diverge. This
is a genuine Turing-complete escape hatch.

```
fn spin(x : int) : int {
    ret x
    ret rec(x + 1)
    gas inf
}
```

The compiler must emit a warning for every function using `gas inf`:

```
Warning: spin() uses `gas inf` — termination is not guaranteed.
JPL-- is Turing-complete under `gas inf`. This function may diverge.
```

**`gas inf` exists to demonstrate a precise claim:** the `rad` mechanism is the
sole difference between a decidable language and a Turing-complete one. Removing
one expression per function — replacing `rad <expr>` with `gas inf` — crosses
the boundary. The cost of totality is one line.

Programs containing `gas inf` are valid JPL-- but are excluded from the
decidability guarantee. The compiler flag `-v` (verify) will report such
functions as `UNVERIFIED (gas inf)` rather than `VERIFIED`.


Semantics
---------

### Binding

JPL-- uses **single-pass, definition-order binding**. This is inherited from
JPL but takes on critical importance in JPL--: it is the mechanism that
eliminates mutual recursion entirely.

Definitions are interpreted strictly in order of appearance (line by line). It
is always a compile-time error for a JPL-- program to refer to a name that has
not yet been bound. This means:

- A function `f` may call any function defined **above** it in the source file.
- A function `f` may call **itself** via `rec` (self-recursion).
- A function `f` may **not** call a function `g` defined below it.
- Therefore, **mutual recursion is impossible.** Two functions cannot call each
  other because whichever is defined first cannot reference the one below it.

This is not an incidental restriction — it is a deliberate design choice that
makes termination verification compositional. Each function's termination proof
depends only on (a) its own `rad` expression and (b) the already-verified
termination of functions defined above it. There is no need for global Lyapunov
functions across call cycles, no need for strongly-connected-component analysis
of the call graph, and no possibility of co-recursion smuggling in
non-termination through the back door.

Shadowing is illegal, as in JPL: it is a compile-time error to bind a name
that is already visible from the current scope.

**Loop binders in `array` and `sum` expressions** introduce names into scope
and are subject to the same no-shadowing rule. `array [i : N] ...` binds `i`;
if `i` is already in scope, it is a compile-time error. Nested loops must use
distinct binder names:

```
array [i : H] array [j : W] ...   // OK: i and j are distinct
array [i : H] array [i : W] ...   // ERROR: inner i shadows outer i
```

This is restrictive but keeps the single-pass resolver trivial. The idiomatic
style for multi-dimensional iteration is `i`, `j`, `k`, matching mathematical
convention for matrix indices.

### Execution Model

A function body executes as follows:

1. `res` is uninitialized. It becomes available after the first `ret`.
2. Execute each statement in order:
   - `let` binds a variable.
   - `ret <expr>` evaluates `<expr>` and assigns the result to `res`.
   - `rad <expr>` is erased — it does not exist at runtime.
   - `gas N` initializes a fuel counter with budget `N`.
3. When a `rec(args...)` expression is encountered during evaluation:
   a. Evaluate all argument expressions.
   b. Compare arguments to current parameters (fixed-point check).
   c. If they match (within epsilon): yield current `res`.
   d. If they differ and this is a `gas` function: decrement fuel, return
      `res` if exhausted.
   e. If they differ, behavior depends on the position of the `rec` expression:
      - **Tail-position `rec`:** The `rec` result flows directly to `res`
        (i.e., the `rec` is the entire right-hand side of a `ret` statement
        with no further operations wrapping it). This is semantically
        equivalent to updating the parameters and restarting the function
        body. The required semantic model is **iterative (stack-neutral)**.
        Backends may lower tail-position `rec` to native tail calls (e.g.,
        WASM `return_call`) or an explicit loop with mutable parameter slots.
      - **Non-tail-position `rec`:** The `rec` is embedded inside a larger
        expression (e.g., `rec(x-1) + rec(x-2)` in Fibonacci). Each such
        call is **evaluated to completion independently** before the outer
        expression continues. This is genuine recursive evaluation — the
        call stack grows proportionally to the call tree depth (O(n) for
        linear recursion, O(2^n) for binary tree recursion). Compilers lower
        non-tail `rec` to ordinary call frames; `return_call` does not apply.
      The IR distinguishes these as `RecTail` (stack-neutral, loopable) and
      `RecCall` (genuinely recursive, requires call frame) nodes.
4. The value of `res` after the final statement is the function's return value.

Note that for `rad` functions, steps 3d is absent — the `rad` proof guarantees
convergence, so no runtime checking is needed. The compiled output of a `rad`
function is identical to what you'd write by hand: a tight loop with a
fixed-point check and nothing else.

### Saturating Arithmetic

Integer arithmetic in JPL-- saturates instead of wrapping. All values are
32-bit, but operations are performed in 64-bit registers and clamped:

- `INT32_MAX + 1 = INT32_MAX` (2147483647)
- `INT32_MIN - 1 = INT32_MIN` (-2147483648)
- `INT32_MAX * 2 = INT32_MAX`
- `INT32_MIN * 2 = INT32_MIN`
- `-INT32_MIN = INT32_MAX` (not `INT32_MIN` as in two's complement)

**Implementation:** Promote operands to 64-bit, perform the operation, clamp
the result to `[INT32_MIN, INT32_MAX]`, truncate back to 32-bit. This is
branchless on all 64-bit architectures:

```
int64_t r = (int64_t)a + (int64_t)b;
if (r > INT32_MAX) r = INT32_MAX;
if (r < INT32_MIN) r = INT32_MIN;
return (int32_t)r;
```

Division and modulus retain truncation-toward-zero semantics, but division by
zero is **not** an error. See "Total Arithmetic" below.

Float arithmetic retains full IEEE 754 single-precision semantics, which
already saturates to ±infinity.

### Total Arithmetic

JPL-- defines canonical results for all mathematically undefined operations.
No operation in JPL-- can trap, fault, or produce a hardware exception. The
arithmetic surface is total — every input maps to a defined output.

This is not merely a convenience. It is a mandatory architectural requirement
for the linear speculative execution model (see Optimization Goals §3.6). When
Thread A speculatively computes past the actual fixed point, it enters garbage
states. If any garbage-state operation could trap (e.g., `SIGFPE` from integer
division by zero), the speculator would need rollback machinery, destroying the
branchless pipeline. Total Arithmetic ensures Thread A can compute garbage
indefinitely without ever stopping. Thread B finds the valid fixed point and
silently discards the garbage.

**Integer rules:**

- `x / 0 = 0`
- `x % 0 = 0`
- All other integer operations are already total under saturating semantics.

**Implementation (branchless, WASM 3.0):**

```wasm
;; Safe integer divide/mod with total semantics:
;; y_is_zero = (y == 0)
;; y_safe    = y | y_is_zero      ;; avoids trap by making divisor nonzero
;; raw       = x / y_safe (or x % y_safe)
;; result    = select(0, raw, y_is_zero)
```

`select` is a branchless conditional move, so the lowering remains branch-free
and trap-free.

**Float rules — NaN-free Total Float Arithmetic:**

JPL-- eliminates `NaN` from the float domain entirely. Every IEEE 754 operation
that would produce `NaN` instead produces `0.0`. This is not a lossy
approximation — it is a deliberate architectural choice with three consequences:

1. **`rad` proofs become strictly sound over the reals.** `NaN` was a
   mathematical void that broke SMT solvers and SymPy. The distance from any
   value to `0.0` is computable. The distance to `NaN` was undefined. With
   `NaN` gone, Z3 can treat floats as continuous real numbers with clamp/step
   functions, and SymPy can algebraically reduce them without domain errors.

2. **Fixed-point collapse always succeeds.** `NaN != NaN` under IEEE 754, so a
   `rec` call with `NaN` arguments would never collapse — it would loop forever
   (or exhaust fuel). With `NaN` mapped to `0.0`, `0.0 == 0.0` succeeds and
   convergence is guaranteed.

3. **The SIMD pipeline remains unconditional.** `NaN` propagation is toxic —
   one `NaN` infects every downstream operation. By killing it at the source,
   no lane in a SIMD register can enter a `NaN`-poisoned state.

| Operation | IEEE 754 Result | JPL-- Result |
|-----------|----------------|--------------|
| `0.0 / 0.0` | `NaN` | `0.0` |
| `inf - inf` | `NaN` | `0.0` |
| `0.0 * inf` | `NaN` | `0.0` |
| `sqrt(x < 0)` | `NaN` | `0.0` |
| `log(x ≤ 0)` | `-inf` or `NaN` | `0.0` |
| `x % 0.0` | `NaN` | `0.0` |
| `x / 0.0` | `±inf` or `NaN` | `0.0` |

`±inf` may still arise from non-zero-divisor operations (e.g. overflow in
transcendentals). It is well-behaved under comparison (`inf == inf` is true),
so fixed-point collapse remains well-defined.

**Implementation (branchless, WASM 3.0):**

In canonical IR, the compiler emits NaN-to-zero canonicalization after float
operations, then lets optimization remove redundant guards:

```wasm
;; Example canonicalization pattern
;; value = <float-op>
local.tee $temp
local.get $temp
f32.eq          ;; returns 1 (true) if NOT NaN, 0 (false) if NaN
                ;; because NaN != NaN under IEEE 754
f32.const 0.0
select          ;; if true: keep result. if false (NaN): return 0.0
```

This is a pure ALU select — no branches, no traps, no pipeline flushes. The
`select` instruction is a single-cycle conditional move on all WASM engines.

For float division and modulus, canonical lowering first enforces
`x / 0.0 = 0.0` and `x % 0.0 = 0.0`, then applies NaN-to-zero as needed. This
keeps the float domain NaNless while remaining branchless.

**Consequence:** JPL-- has no runtime errors from arithmetic. The only runtime
errors are array out-of-bounds, `sum`/`array` with non-positive bounds, and I/O
failures. Division by zero, which is a runtime error in JPL, is a defined
operation in JPL--. `NaN`, which is a silent poison in IEEE 754, does not exist
in JPL--.

### Fixed-Point Epsilon

For float comparisons in fixed-point collapse:

- Two float values `a` and `b` are considered equal if
  `ULPDistance(a, b) <= 1`, where ULP distance is computed over a monotonic
  ordering of float bit-patterns:
  `ord(u) = (u & 0x80000000) ? ~u : (u | 0x80000000)`, with
  `u = bitcast<u32>(value)`.
- This is a 1-ULP tolerance that naturally scales with magnitude.
- `NaN` cannot occur in JPL-- (see Total Arithmetic above). This eliminates the
  IEEE 754 pitfall where `NaN != NaN` would prevent fixed-point collapse.
- Negative zero and positive zero are considered equal under this rule
  (adjacent in the ordered representation).
- `+inf == +inf` and `-inf == -inf` are both true, so fixed-point collapse
  succeeds when both sides saturate to the **same-sign** infinity. `+inf` and
  `-inf` are not equal and do not collapse.
- **Note on `-0.0`:** Negative and positive zero are adjacent in the ULP
  ordering and collapse to each other. This is correct for most numeric
  convergence. However, functions sensitive to signed-zero semantics (e.g.,
  `atan2(-0.0, -1.0) = -π` vs `atan2(+0.0, -1.0) = +π`) may observe a
  sign-bit flip at the fixed point. JPL-- favors convergence stability over
  IEEE signed-zero pedantry; programmers must bound angular wraparound
  manually.

For integer comparisons: exact 32-bit equality.

For struct comparisons: field-wise under the above rules.

For array comparisons: dimension equality, then element-wise under the above
rules.


Commands
--------

JPL-- inherits JPL's command syntax with the following changes:

### Removed Commands

- `assert` commands are removed (no booleans).

### Modified Commands

Function syntax gains `ret`, `res`, `rec`, and `rad`:

```
cmd  : fn <variable> ( <binding> , ... ) : <type> { ;
           <stmt> ; ... ;
       }
```

Where `<stmt>` now includes `ret` and `rad` statements, and expressions within
the body may use `res` and `rec`.

### Retained Commands

```
cmd  : read image <string> to <argument>
     | write image <expr> to <string>
     | struct <variable> { ... }
     | let <lvalue> = <expr>
     | print <string>
     | show <expr>
     | time <cmd>
     | fn <variable> ( <binding> , ... ) : <type> { ... }
```


Builtin Functions
-----------------

JPL-- retains all JPL builtin math functions, operating on 32-bit types:

- `sqrt`, `exp`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `log` (one
  `float` argument, returning `float`) — these use single-precision (`sqrtf`,
  `sinf`, etc. in C)
- `pow`, `atan2` (two `float` arguments, returning `float`)
- `to_float` (converts `int` to `float`, i.e. `i32` to `f32`)
- `to_int` (converts `float` to `int`, i.e. `f32` to `i32`, with `+inf`
  mapping to `INT32_MAX` and `-inf` to `INT32_MIN`. `NaN` cannot occur in
  JPL--.)

JPL-- adds the following builtin functions:

- `max(a, b)` — returns the greater of two values (both `int` or both `float`)
- `min(a, b)` — returns the lesser of two values (both `int` or both `float`)
- `abs(a)` — absolute value (`int` or `float`)
- `clamp(x, lo, hi)` — equivalent to `min(max(x, lo), hi)`

These are added because, without `if/then/else`, they are the primary mechanism
for bounding values and expressing piecewise behavior.


Verification
------------

### Static Verification

The JPL-- compiler performs termination verification for every function
containing `rec`. The verification procedure is:

1. **Identify all `rec` call sites** in the function body.

2. **Identify all `rad` expressions** in the function body.

3. **For each `rec` call site**, attempt to prove that at least one `rad`
   expression strictly decreases when the function's parameters are replaced
   with the `rec` call's arguments.

4. **Verification methods** (in order of preference):
   a. **Structural decrease on integers:** If the `rad` expression is a
      parameter or simple arithmetic on parameters, and the `rec` argument is
      provably less (e.g., `max(0, x - 1)` < `x` when `x > 0`), accept.
   b. **Symbolic simplification:** Factor the difference `rad(params) -
      rad(rec_args)` and verify all factors have known sign under the function's
      type constraints.
   c. **SMT query:** Submit the proof obligation to an SMT solver (e.g., Z3)
      with the constraint that `rec_args ≠ params` (they differ by more than
      epsilon).
   d. **Reject.** If all methods fail, the program does not compile. The
      compiler must suggest `gas N` as an alternative and explain why
      verification failed.

### Verification Failures

If no `rad` expression can be proven to decrease for a given `rec` call site,
compilation fails. The error message must identify:
- The function name
- The `rec` call site (line number)
- The `rad` expressions that were checked
- Why each failed (e.g., "could not prove (x - 1) < x for all x : int")
- A suggestion: "consider using `gas N` if a convergence proof is not possible"

The compiler flag `-v` (verify) performs only lexing, parsing, type checking,
and termination verification, printing the proof obligations and their
resolution status. Functions using `rad` are reported as `VERIFIED` with the
proof method (structural, symbolic, or SMT). Functions using `gas N` are
reported as `BOUNDED (N iterations)`. Functions using `gas inf` are reported
as `UNVERIFIED (gas inf)`.


Example Programs
----------------

### Square Root (Babylonian Method)

```
fn sqrt_iter(x : float, g : float) : float {
    ret (g + max(x, 0.0) / g) / 2.0
    rad g - res
    ret rec(max(x, 0.0), res)
}
```

**How it works:**
- `ret` computes one Babylonian step: `res = (g + x/g) / 2`
- `rad g - res` declares the step size as the convergence measure (the compiler
  implicitly wraps this in `abs()`)
- `ret rec(max(x,0), res)` recurses with the new guess
- When `res ≈ g` (within 1 ULP), `rec` collapses and returns `res`

**Proof obligation:** `abs(res - (res + x/res)/2)` < `abs(g - res)`, i.e., the
next step size is smaller than the current step size. This factors as a
contraction with ratio `(g² - x)² / (4(g² + x)²)` < 1, which holds for all
`g > 0`, `x > 0`, `g² ≠ x`.

### Fibonacci

```
fn fib(x : int) : int {
    ret clamp(x, 0, 1)
    ret max(res, rec(max(0, x - 1)) + rec(max(0, x - 2)))
    rad x
}
```

**How it works:**
- `ret clamp(x, 0, 1)` sets `res` to the base case value (0 or 1)
- The second `ret` takes the max of the base case and the recursive sum
- `rad x` declares structural decrease on the input
- `rec(max(0, x-1))` collapses when `max(0, x-1) == x`, i.e., when `x <= 0`
  (saturating arithmetic: `max(0, 0-1) = max(0, INT32_MIN)` ... wait, `0-1 = -1`,
  `max(0,-1) = 0`, so at `x=0`, `rec(0)` matches params, collapse to `res=0`)

**Proof obligation:** `max(0, x-1) < x` and `max(0, x-2) < x` when `x > 0`.
Trivially true.

### Absolute Value (Without Conditionals)

```
fn my_abs(x : int) : int {
    ret max(x, -x)
}
```

No `rec`, no `rad` needed. This is a pure non-recursive function.

### Integer Square Root (Floor)

```
fn isqrt(x : int, g : int) : int {
    let next = (g + x / max(g, 1)) / 2
    ret max(next, 1)
    rad g - res
    ret rec(x, res)
}
```

### GCD (Euclidean Algorithm)

```
fn gcd(a : int, b : int) : int {
    ret a
    ret rec(min(abs(a), abs(b)), max(abs(a), abs(b)) % min(abs(a), abs(b)))
    rad b
}
```

**Proof obligation:** The second argument to `rec` is `a % b`, and `abs(a % b)
< abs(b)` when `b ≠ 0`. When `b = 0`, `min(abs(a), abs(0)) = 0`, so
`rec(0, ...)` — and since `b` was the second param, we need to check the
collapse condition. At `b = 0`, `min(abs(a), 0) = 0` = `a` only if `a = 0`,
so it collapses when both are 0 and returns `res = a = 0`. Otherwise, the
Euclidean algorithm proceeds with strictly decreasing `b`.

### Non-Terminating Program (REJECTED)

```
fn diverge(x : int) : int {
    ret rec(x + 1)
    rad x
}
```

**Rejected:** The compiler evaluates `rad x` as `abs(x)`. It must prove
`abs(x + 1) < abs(x)` given `x + 1 ≠ x` (i.e., `x < INT32_MAX`). This fails:
for positive `x`, `abs(x + 1) = x + 1 > x = abs(x)`. Note: with saturating
arithmetic, `x + 1` saturates at `INT32_MAX` and `rec` would eventually
collapse, but the `rad` obligation still fails statically.


Differences from JPL (Summary)
------------------------------

| Feature                     | JPL                    | JPL--                         |
|-----------------------------|------------------------|-------------------------------|
| Boolean type                | Yes (`bool`)           | No                            |
| Conditional expressions     | `if/then/else`         | None                          |
| Boolean operators           | `&&`, `\|\|`, `!`      | None                          |
| Comparison operators        | `<`, `>`, `==`, etc.   | None                          |
| Assertions                  | `assert`               | None                          |
| Scalar width                | 64-bit (`i64`, `f64`)  | 32-bit (`i32`, `f32`)         |
| Return statements           | `return <expr>`        | `ret <expr>` (accumulation)   |
| Function result             | Last `return`          | Final `res` after all `ret`s  |
| Recursion                   | Unrestricted           | `rec` with `rad` proof        |
| Mutual recursion            | Allowed                | Impossible (single-pass)      |
| Definition order            | Single-pass            | Single-pass (load-bearing)    |
| Integer overflow            | Wrapping (2's comp)    | Saturating                    |
| Division by zero            | Runtime error          | Defined (`x / 0 = 0`)        |
| Arithmetic traps            | Yes (`SIGFPE`, etc.)   | None (Total Arithmetic)       |
| `NaN`                       | IEEE 754 (`NaN`)       | Does not exist (mapped to 0.0)|
| Termination                 | Not guaranteed         | Guaranteed (verified)         |
| Turing complete             | Yes                    | No (by design)                |
| Branching mechanism         | `if/then/else`         | Fixed-point collapse only     |
| `res` keyword               | N/A                    | Current accumulated result    |
| `rad` keyword               | N/A                    | Discrete Lyapunov function    |
| `rec` keyword               | N/A                    | Convergent recursive call     |
| `gas` keyword               | N/A                    | Fuel escape hatch             |
| `gas inf`                   | N/A                    | Turing-complete escape hatch  |
| Builtin `max/min/abs/clamp` | No                     | Yes                           |


Compiler Command Line Interface
-------------------------------

JPL-- inherits JPL's CLI with one addition:

- `-v` (verify): Perform lexing, parsing, type checking, and termination
  verification. Print each function's proof obligations and their status:
  `VERIFIED` (with method: structural, symbolic, or SMT) for `rad` functions,
  `BOUNDED` for `gas N` functions, or `UNVERIFIED` for `gas inf` functions.

All other flags (`-l`, `-p`, `-t`, `-i`, `-s`) behave as in JPL.


Theoretical Notes
-----------------

### Relationship to Primitive Recursive Functions

JPL-- is strictly more expressive than primitive recursive functions (it can
express Ackermann-like growth patterns as long as a decreasing radius exists)
but strictly less expressive than general recursive functions (it cannot express
non-terminating computations).

### Relationship to System T / System F

Gödel's System T achieves totality through higher-order primitive recursion.
JPL-- achieves it through explicit Lyapunov functions on a finite state space.
The approaches are complementary: System T proves termination by structural
induction on natural numbers; JPL-- proves it by well-foundedness of an
explicit measure.

### Why Not Just Use `decreases` Clauses?

Languages like Dafny already support `decreases` clauses. JPL-- differs in
three ways:

1. `rad` is not an annotation on top of existing control flow — it IS the
   control flow. There is no `if/else` to fall back on.
2. JPL-- embraces machine finiteness. The state space is finite, so
   termination is always decidable in principle (though potentially
   exponential to verify). The `rad` function provides a polynomial witness.
3. JPL-- separates termination (verified) from correctness (unverified).
   This is a deliberate design choice: verify what's undecidable in general
   (halting), leave what's domain-specific (correctness) to the programmer.

### On Single-Pass Binding and Compositional Verification

The single-pass definition-order rule is not inherited from JPL out of
convenience — it is a cornerstone of the termination guarantee.

Mutual recursion (co-recursion) is the primary mechanism by which termination
proofs become non-compositional. If function `f` calls `g` and `g` calls `f`,
the termination of `f` depends on the termination of `g` and vice versa. This
creates a circular proof obligation that requires a global Lyapunov function
spanning both functions — effectively a proof about the entire
strongly-connected component of the call graph, not about any individual
function.

By requiring single-pass definition order, the call graph is a DAG. Every
function's termination proof depends only on:

1. Its own `rad` expression (local Lyapunov function).
2. The already-verified termination of functions defined above it.

This makes verification compositional, incremental, and embarrassingly
parallelizable. It also means a JPL-- program can be verified function by
function as it is parsed — there is no whole-program analysis phase.

### On Supertasks

Supertasks — infinite sequences of operations completed in finite time — do not
exist on real machines. JPL-- makes this explicit. The float epsilon in
fixed-point collapse is not a hack; it's an acknowledgment that IEEE 754
floating point has `2^32` states (single precision), and any trajectory through
that space must terminate. The `rad` function simply provides a witness that it terminates
quickly (polynomially in the state space) rather than requiring exhaustive
enumeration.


Implementation Limits
---------------------

JPL-- inherits all JPL implementation limits (nesting depth 64, rank 64,
tuple width 64, max 64 arguments).

Additionally:
- `gas N` is limited to `N <= 2^32`. Larger fuel budgets are a compile-time
  error. If you need more than 4 billion iterations, you should be looking
  harder for a `rad` expression.
- `gas inf` has no iteration limit (by definition).
