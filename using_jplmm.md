# Using JPLMM

`jplmm` is the toolchain for the JPL-- language.

JPL-- is designed around a very specific idea:

- no ordinary `if` / `else` control flow
- recursion is expressed with `rec(...)`
- termination is explained with `rad ...` or bounded with `gas ...`
- array indexing is clamped to the nearest valid edge
- `array` / `sum` comprehension bounds are clamped to at least `1`

That gives the language a distinctive feel: straight-line evaluation, explicit fixed-point recursion, and extremely predictable execution.

Preferred surface syntax now uses `fun` and `out`.

`def` and `ref` are also available for function definitions.

- `fun`: allow normal and research-grade optimizer passes
- `def`: allow normal optimizer passes, but block research-grade passes like Aitken / linear speculation for that function
- `ref`: prove that this body refines an earlier `fun` / `def` of the same name, then ship the refined body under that earlier policy

Legacy aliases are still accepted for compatibility with older files.

## Quick Start

From the repo root:

```bash
npm install
node packages/cli/src/index.js -v examples/control/01_tracker_settle_a.jplmm
```

Common CLI modes:

- `-p`: parse only
- `-t`: parse + resolve + typecheck
- `-v`: verify recursion / proofs and print analysis
- `-i`: optimize and print optimizer summaries
- `-s`: emit WAT
- `-a`: emit native C
- `-r`: run
- `--experimental`: legacy explicit opt-in flag; research passes are on by default now
- `--safe`: disable all optional optimizer passes
- `--disable-pass <name>`: disable one optimizer pass without disabling the others

Examples:

```bash
node packages/cli/src/index.js -r examples/control/01_tracker_settle_a.jplmm
node packages/cli/src/index.js -v examples/control/02_grid_relax_a.jplmm
node packages/cli/src/index.js -s examples/showcase/05_metric_screen_builder.jplmm
node packages/cli/src/index.js -s --safe examples/showcase/05_metric_screen_builder.jplmm
node packages/cli/src/index.js -i --disable-pass aitken examples/control/01_tracker_settle_a.jplmm
```

## File Entry

JPLMM supports two ways to run a file:

- explicit top-level commands like `out`, `print`, `read image`, `write image`
- an implicit zero-argument `main`

If a file contains executable top-level commands, those run.

If a file contains only definitions and there is a zero-argument accepted `main(): ...`, `run` treats that as the entry point automatically.

That includes:

- `fun main(): ...`
- `def main(): ...`
- a `fun` / `def main(): ...` later replaced by a proven `ref main(): ...`

Good editor test files for implicit `main()` right now:

- `examples/control/01_tracker_settle_a.jplmm`
- `examples/control/02_grid_relax_a.jplmm`

The VS Code extension run button follows the same rule.

## Core Function Semantics

Function bodies execute statement-by-statement in order.

The important function-level keywords are:

- `fun` / `def`: baseline implementation
- `ref`: replacement implementation that must be proven equivalent to the current baseline
- `ret <expr>`: evaluate `<expr>` and store it in `res`
- `res`: the current accumulated result
- `rec(...)`: recursive self-call for the enclosing function
- `rad <expr>`: proof measure for convergence / termination
- `gas <N>`: bounded runtime fuel
- `gas inf`: opt out of the totality guarantee

### `ref`

`ref` is how you keep a readable spec implementation and a hand-optimized implementation in the same file.

Typical shape:

```jpl
def clamp_hi(x:int): int {
  ret min(max(x, 0), 255);
}

ref clamp_hi(n:int): int {
  ret clamp(n, 0, 255);
}
```

The compiler:

- checks that the earlier definition already exists
- checks that the signature still matches
- tries to prove the refined body equivalent to the current accepted implementation
- emits a compile error if it cannot prove that
- otherwise keeps the `ref` body and continues as if there were only one definition

Today the strongest exact checker is for non-recursive scalar `int` functions, with additional fast paths for canonical matches and zero-argument exact execution.
It also has a recursive scalar-`int` proof path now when both implementations admit a shared decreasing `rad` and the inductive step closes.

Still intentionally conservative today:

- gas-based recursive refinements are rejected as unproven
- calls to recursive helper functions inside the recursive proof subset are rejected as unproven
- if the inductive proof does not close, the compiler errors instead of guessing

### `ret` and `res`

`res` does not have a default value. You only get to use it after at least one `ret`.

This is valid:

```jpl
fun sq_plus_one(x:int): int {
  ret x * x;
  ret res + 1;
}
```

This is invalid:

```jpl
fun bad(x:int): int {
  let y = res + 1;
  ret y;
}
```

There is also an ignored-value check for `ret` now:

- if one `ret` is overwritten by another `ret`
- and no `rec` or `res` read the earlier value in between
- the compiler raises `IGNORED_RET`

That keeps the “every expression matters” style honest.

### `rec`

`rec(...)` is the only thing in the language that acts like branching.

At runtime a `rec(...)` expression:

1. evaluates its arguments
2. compares them to the current parameters
3. collapses to `res` if they match
4. otherwise performs the recursive step

That means JPL-- is not “cyclomatic complexity zero” in the classic McCabe sense.
But it does usually have very low source-level complexity.

### `rad`

`rad` is the proof that the recursive process shrinks toward a fixed point.

Typical shapes:

- `rad x`
- `rad abs(x)`
- `rad g - res`

`rad` is compile-time proof material. It is erased at runtime.

### `gas`

`gas N` says “this recursion may keep going, but only for `N` non-collapsing recursive steps.”

`gas inf` is the explicit escape hatch. It is valid, but verification reports it as unverified.

You may not mix `rad` and `gas` in the same function.

## Arrays, Sums, and Indexing

JPL-- now has safe edge semantics by default.

### Indexing

Array indexing clamps to the nearest valid element.

So if `a` has length `n`:

- `a[-5]` behaves like `a[0]`
- `a[n + 100]` behaves like `a[n - 1]`

This applies per dimension.

### `array` and `sum`

Comprehension bounds clamp to at least `1`.

So these expressions are always evaluated at least once:

```jpl
array [i:n] e
sum [i:n] e
```

If `n` evaluates below `1`, the effective bound becomes `1`.

That means:

- `array [i:0] e` produces a one-element array
- `sum [i:0] e` evaluates `e` once at `i = 0`

### Constant Bound Diagnostic

If the compiler can prove a comprehension bound is a constant below `1`, it raises a hard error:

- code: `CONST_BOUND_CLAMP`
- message: `const value clamped to 1`

This applies to both `array` and `sum`.

The intent is:

- dynamic bounds are still safe and clamp at runtime
- obviously degenerate constant bounds are called out immediately

## Structs

Structs are positional.

```jpl
struct Pair { left:int, right:int }

fun swap(p:Pair): Pair {
  ret Pair { p.right, p.left };
}
```

Field access uses `.`:

```jpl
p.left
```

Field assignment inside a function uses a `let` target:

```jpl
let p.right = p.left + 1;
```

## Top-Level Commands

Outside functions, JPLMM supports:

- `let`
- `out`
- `print`
- `read image`
- `write image`
- `time`
- definitions (`fun`, `def`, `ref`, `struct`)

Examples:

```jpl
print "hello";
out 1 + 2;
time out 4 * 5;
```

## Diagnostics You Will Commonly See

- `UNUSED_LET`: a binding was never used
- `IGNORED_RET`: a `ret` value was overwritten before any `res` / `rec` observed it
- `REC_NO_PROOF`: `rec` was used without `rad` or `gas`
- `RAD_GAS_MIX`: the function mixes `rad` and `gas`
- `MAIN_ARITY`: `main` must take zero parameters
- `REF_NO_BASE`: a `ref` appeared before any baseline definition of that name
- `REF_SIGNATURE`: a `ref` changed the parameter or return types
- `REF_MISMATCH`: the compiler found a counterexample showing the `ref` changes behavior
- `REF_UNPROVEN`: the compiler could not prove the `ref` equivalent with the current checker
- `CONST_BOUND_CLAMP`: constant `array` / `sum` bound below `1`
- `THROWS_ERROR_IMPOSSIBLE`: `throwserror` was used

## The Joke Keyword

`throwserror` is an intentionally impossible annotation.

Example:

```jpl
throwserror fun f(x:int): int {
  ret x + 1;
}
```

The function still parses so tooling can recover, but the compiler emits a hard error because JPL-- is supposed to avoid ordinary runtime errors.

## Verification Output

`jplmm -v file.jplmm` now prints two kinds of information:

- proof summaries for recursive functions
- analysis summaries for every function

The analysis summary includes:

- source complexity
- canonical line-coverage witness

### Source Complexity

JPLMM reports a very simple source-level complexity metric:

```text
source complexity = 1 + number of rec(...) sites
```

This is not backend CFG complexity. It is the language-shaped metric that matches JPL-- source semantics.

Examples:

- a function with no `rec` sites has complexity `1`
- a function with one `rec(...)` site has complexity `2`
- a function with `rec(x - 1) + rec(x - 2)` has complexity `3`

This matches the intuition that almost everything is evaluated unconditionally, and `rec` is the only real source-level choice point.

## Canonical Line-Coverage Witnesses

For every function, JPLMM can describe a canonical witness call using the minimal inhabitant of each parameter type:

- `int` -> `0`
- `float` -> `0.0`
- `struct` -> a struct with canonical witnesses in every field
- array rank `n` -> a `1 x 1 x ... x 1` array filled with the canonical element witness

Examples:

- `f(0)`
- `g(0.0, Pair { 0, 0 })`
- `h([[0]])`

Why this is interesting:

- JPL-- function bodies run straight through
- there is no ordinary `if` / `else` tree skipping source lines
- so one canonical witness call gives full source line coverage for that function body

That is the right claim to make in writeups:

- `100% line coverage for every invoked function body`

That is stronger and more honest than claiming general branch coverage.

Important caveats:

- you still need to invoke each function you care about
- `rec` still represents a collapse-vs-recurse choice
- `gas` can still distinguish continue-vs-exhaust paths
- top-level image I/O depends on files existing

So the slogan is:

> One canonical witness per function gives trivial full line coverage of the function body.

## Suggested Workflow

When building a new JPL-- file:

1. write the pure computation with `ret`
2. add `rec(...)` only after a meaningful first `ret`
3. add `rad ...` if the recursion is provably convergent
4. use `gas N` when you want bounded execution instead
5. run `-t`
6. run `-v`
7. run `-r`

For editor-driven work:

1. open a `.jplmm` file in VS Code
2. use the diagnostics panel for frontend errors
3. proof failures from `rad` / `gas` verification appear inline in Problems
4. each function header shows source complexity and its canonical `100%` line-coverage witness
5. parameters and `let` bindings can show inline optimizer range hints such as `: int[0, 50]`
6. safe top-level `out` programs show inline result hints while you edit
7. hover a scalar variable to see any optimizer-proved interval facts such as `int[0, 50]`
8. hover a function name to see its source complexity, canonical witness, coarse total-call bound, and optimizer outlook
9. research-grade matches get a highlighted hover badge when something interesting like Aitken acceleration or linear speculation applies
10. use the run button to execute top-level commands or implicit `main()`
11. use “Debug Active File (WAT)” when you want the generated WAT plus optimization comments

Inline `out` result hints are deliberately conservative.

They appear when the file's top level is made only of:

- definitions
- top-level `let`
- top-level `out`

If the file contains `print`, image I/O, or other executable top-level commands, the editor does not auto-run the file for inline result hints.

The debug WAT view includes top-of-module comments describing:

- which optimizer passes ran
- which specialized implementations were selected
- whether research lowerings were disabled
- when a selected optimization fell back because the WAT backend does not lower it yet

That makes it easier to see when closed forms, LUT lowering, or research passes are actually taking effect.

## Mental Model

If ordinary languages feel like “write a control-flow graph and compute inside it,” JPL-- is closer to:

- define a result
- define a refinement step
- define the condition under which refinement collapses
- prove or bound the number of refinements

That is why the language can support:

- very low source complexity
- simple canonical witnesses
- easy line-coverage stories
- explicit totality / boundedness reporting

without looking like a conventional imperative language.
