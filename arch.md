JPL-- Compiler Architecture
============================

Overview
--------

The JPL-- compiler is a TypeScript monorepo organized into independent packages
with strict dependency boundaries. Each package owns its types, its tests, and
a clean interface. Information flows forward through the pipeline — no package
reaches back into an earlier stage.

```
                         ┌─────────────────────┐
                         │      cli / lsp       │  entry points
                         └──────────┬──────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
          ▼                         ▼                         ▼
   ┌─────────────┐          ┌─────────────┐          ┌──────────────┐
   │   grammar    │          │   frontend   │          │    verify     │
   │ (tree-sitter)│────────▶│  CST → AST   │────────▶│  rad proofs   │
   └─────────────┘          └─────────────┘          └──────┬───────┘
                                                            │
                                              Verified AST + ProofMap
                                                            │
                                                     ┌──────▼───────┐
                                                     │      ir       │
                                                     │  AST → IR     │
                                                     └──────┬───────┘
                                                            │
                                                      Canonical IR
                                                            │
                                                     ┌──────▼───────┐
                                                     │   optimize    │
                                                     │  4-group      │
                                                     │  pipeline     │
                                                     └──────┬───────┘
                                                            │
                                                      Machine IR
                                                            │
                                                     ┌──────▼───────┐
                                                     │   backend     │
                                                     │  WASM 3.0     │
                                                     └──────────────┘
```


Package Map
-----------

```
jplmm/
├── packages/
│   ├── grammar/        tree-sitter grammar + syntax queries
│   ├── ast/            typed AST node definitions (the lingua franca)
│   ├── frontend/       parse → resolve → typecheck
│   ├── verify/         termination verification (rad, gas)
│   ├── ir/             optimization IR (flat, SSA-like)
│   ├── optimize/       4-group optimization pipeline
│   ├── backend/        IR → WASM 3.0 bytecode
│   ├── lsp/            language server protocol
│   └── cli/            command-line driver
│
├── tree-sitter-jplmm/  generated parser (C + WASM)
├── tsconfig.json
├── package.json
└── turbo.json           monorepo build orchestration
```


Package Dependency Graph
------------------------

Arrows mean "depends on." No cycles. No back-edges.

```
grammar ──▶ (standalone, no deps)

ast ──▶ (standalone, no deps)

frontend ──▶ grammar, ast

verify ──▶ ast
       ──▶ (optional) z3-solver (WASM, lazy-loaded)

ir ──▶ ast

optimize ──▶ ir
         ──▶ (optional) experimental passes bring own deps

backend ──▶ ir

lsp ──▶ grammar, ast, frontend, verify, ir, optimize

cli ──▶ grammar, ast, frontend, verify, ir, optimize, backend
```


Package Details
---------------

### grammar

The tree-sitter grammar definition for JPL--. This is a standalone package
that produces a C parser compiled to WASM for use in the frontend and LSP.

**Contents:**
- `grammar.js` — tree-sitter grammar rules (~30 productions)
- `queries/highlights.scm` — syntax highlighting for editors
- `queries/locals.scm` — scope resolution hints for tree-sitter
- `test/corpus/` — tree-sitter native test cases (input → expected tree)

**Output:** `tree-sitter-jplmm.wasm` — the compiled parser

**Keywords in grammar:** `fn`, `let`, `ret`, `res`, `rec`, `rad`, `gas`,
`inf`, `int`, `float`, `void`, `array`, `sum`, `struct`, `read`, `write`,
`image`, `to`, `print`, `show`, `time`

**No keywords:** `if`, `then`, `else`, `true`, `false`, `bool`, `return`,
`assert`


### ast

Typed AST node definitions as TypeScript discriminated unions. This is the
shared language that the frontend produces and the verifier, IR builder, and
LSP consume.

**Contents:**
- `nodes.ts` — discriminated unions for every AST node
- `types.ts` — JPL-- type system (int, float, void, arrays, structs)
- `visitor.ts` — generic visitor and transformer (fold/map over AST)
- `printer.ts` — AST → source text (for `-p` flag and debugging)

**Key design choice:** The AST is immutable. Every phase reads the same tree.
Annotations (types, ranges, proof results) are attached via external side-tables
(`Map<NodeId, T>`) rather than by mutating AST nodes. This means the AST
definition is simple and stable — it changes only when the language syntax
changes, never when a new analysis is added.

**Node IDs:** Every AST node has a unique `NodeId` (a monotonic integer assigned
during construction). This is the key into all side-tables.

**Core node types:**

```typescript
type Expr =
  | { tag: "int_lit"; value: number; id: NodeId }
  | { tag: "float_lit"; value: number; id: NodeId }
  | { tag: "void_lit"; id: NodeId }
  | { tag: "var"; name: string; id: NodeId }
  | { tag: "binop"; op: BinOp; left: Expr; right: Expr; id: NodeId }
  | { tag: "unop"; op: UnOp; operand: Expr; id: NodeId }
  | { tag: "call"; name: string; args: Expr[]; id: NodeId }
  | { tag: "index"; array: Expr; indices: Expr[]; id: NodeId }
  | { tag: "field"; struct: Expr; field: string; id: NodeId }
  | { tag: "struct_cons"; name: string; fields: Expr[]; id: NodeId }
  | { tag: "array_cons"; elements: Expr[]; id: NodeId }
  | { tag: "array_expr"; bindings: Binding[]; body: Expr; id: NodeId }
  | { tag: "sum_expr"; bindings: Binding[]; body: Expr; id: NodeId }
  | { tag: "res"; id: NodeId }
  | { tag: "rec"; args: Expr[]; id: NodeId }

type Stmt =
  | { tag: "let"; lvalue: LValue; expr: Expr; id: NodeId }
  | { tag: "ret"; expr: Expr; id: NodeId }
  | { tag: "rad"; expr: Expr; id: NodeId }
  | { tag: "gas"; limit: number | "inf"; id: NodeId }

type Cmd =
  | { tag: "fn_def"; name: string; params: Param[]; ret_type: Type;
      body: Stmt[]; id: NodeId }
  | { tag: "let_cmd"; lvalue: LValue; expr: Expr; id: NodeId }
  | { tag: "struct_def"; name: string; fields: StructField[]; id: NodeId }
  | { tag: "read_image"; filename: string; target: Argument; id: NodeId }
  | { tag: "write_image"; expr: Expr; filename: string; id: NodeId }
  | { tag: "print"; message: string; id: NodeId }
  | { tag: "show"; expr: Expr; id: NodeId }
  | { tag: "time"; cmd: Cmd; id: NodeId }

type Program = { commands: Cmd[] }
```


### frontend

Transforms tree-sitter CST into the typed AST. Three sub-phases, each a
pure function.

**Contents:**
- `parse.ts` — runs tree-sitter, walks CST, produces untyped AST
- `resolve.ts` — name resolution and scope checking
- `typecheck.ts` — type inference and checking
- `errors.ts` — diagnostic types with line/column information

**Sub-phase: parse**

Input: source text → tree-sitter CST
Output: untyped AST (all `Expr`, `Stmt`, `Cmd` nodes, but `Type` fields unfilled)

Handles: lexical validation (integer range `[-2^31, 2^31-1]`, float via
`strtof` equivalent), keyword rejection (`if`, `true`, etc.), newline
squashing.

**Sub-phase: resolve**

Input: untyped AST
Output: resolved AST + `ScopeMap: Map<NodeId, ScopeEntry>`

Handles: single-pass definition-order binding, shadowing detection, `res` usage
before `ret` detection, `rec` usage before `ret` detection, `rec` in functions
without `rad`/`gas` detection, `rad` and `gas` mutual exclusion check,
at-most-one `gas` statement per function (compile-time error if violated).

This is where the single-pass rule is enforced. Functions are processed in
source order. Each function is added to the scope after its signature is
resolved but before its body is checked — allowing self-recursion via `rec`
but preventing forward references.

**Sub-phase: typecheck**

Input: resolved AST + ScopeMap
Output: typed AST + `TypeMap: Map<NodeId, Type>`

Handles: expression type inference, `ret` type matches function return type,
`rec` argument count and types match function params, `rad` expression is `int`
or `float`, struct field types, array element type uniformity, no implicit
int↔float conversions.


### verify

Termination verification for every function containing `rec`. Operates on the
typed AST. Independent of the optimizer — verification happens before IR
lowering and is never invalidated by optimization.

**Contents:**
- `verify.ts` — orchestrator: iterates functions, dispatches to strategies
- `structural.ts` — structural decrease detection
- `symbolic.ts` — symbolic factorization and sign analysis
- `smt.ts` — Z3 WASM binding (lazy-loaded, optional)
- `report.ts` — proof obligation pretty-printing for `-v` flag

**Verification strategies (tried in order):**

1. **Structural** (`structural.ts`): Detects patterns like `rad x` with
   `rec(max(0, x-1))` — the argument is provably less than the parameter.
   Handles most simple recursive functions (fib, gcd, structural recursion).

2. **Symbolic** (`symbolic.ts`): For more complex `rad` expressions, factors
   the difference `rad(params) - rad(rec_args)` and checks that all factors
   have known sign. Uses the implicit `abs()` wrapping on `rad` and the ULP
   precondition on the proof obligation. This is where the Babylonian method
   proof lives — factoring reveals the contraction ratio.

3. **SMT** (`smt.ts`): If structural and symbolic fail, submits the proof
   obligation to Z3 (loaded as WASM via `z3-solver` npm package). The query
   is: "given `|a_i - p_i| >= ULP(p_i)` for some `i`, prove
   `abs(R(a...)) < abs(R(p...))`." Z3 handles this over QF_NRA (quantifier-free
   nonlinear real arithmetic). NaN-free Total Float Arithmetic means the float
   domain maps cleanly to reals without domain exceptions.

4. **Reject**: If all strategies fail, compilation fails with a diagnostic
   suggesting `gas N`.

**Output:** `ProofMap: Map<FuncId, ProofResult>` where `ProofResult` is:
- `{ status: "verified", method: "structural" | "symbolic" | "smt" }`
- `{ status: "bounded", limit: number }` (for `gas N`)
- `{ status: "unverified" }` (for `gas inf`, with compiler warning)

**Z3 is lazy-loaded.** Most programs are verified by structural or symbolic
analysis. Z3's ~10MB WASM blob is only loaded when the first two strategies
fail. This keeps the common case fast.


### ir

The optimization IR. A flat, SSA-like representation designed for analysis and
transformation. Separate from the AST — the AST is tree-shaped and close to
source syntax; the IR is flat and close to execution.

**Contents:**
- `nodes.ts` — IR node types (see optimizer architecture doc for full listing)
- `builder.ts` — AST → IR lowering
- `printer.ts` — IR → human-readable text for debugging
- `types.ts` — IR-level type info with range annotations

**Key differences from AST:**
- `rec` in tail position is desugared into `RecTail` — an explicit loop
  backedge with updated parameter slots (stack-neutral; emitted as a loop
  or `return_call`). `rec` in non-tail position becomes `RecCall` — a
  genuine recursive call that requires a call frame (e.g., Fibonacci's
  `rec(x-1) + rec(x-2)` produces O(2^n) call depth). Pass 4.3 lowers
  `RecTail` vs `RecCall` differently.
- `ret` becomes assignment to a `res` SSA variable
- `rad` is preserved as a `RadExpr` IR node marked **dead**. It generates no
  code in the default pipeline — sentinel lowering and WASM emission skip dead
  nodes. However, the expression is available in the IR graph for experimental
  Pass 2.4 (Aitken Extrapolation) to copy and inline into `AitkenGuard` as a
  runtime validation check. After inlining, the original `RadExpr` remains dead
  and is dropped during emission. This resolves the tension between "`rad`
  generates no runtime code" (true by default) and "Aitken needs `rad` at
  runtime" (true when the experimental pass is enabled).
- `gas` is lowered to a fuel counter variable + decrement + exit check
- Sentinel nodes (`TotalDiv`, `TotalMod`, `NanToZero`, `SatAdd`, etc.) are first-class
- Every node carries a `NodeId` for side-table annotations

**AST → IR lowering** happens once in `builder.ts`. This is the boundary
between "source-level semantics" and "optimization-level semantics." After this
point, the AST is never consulted again.


### optimize

The four-group optimization pipeline. See the Optimizer Architecture document
for detailed pass descriptions, IR node tables, and the pass dependency DAG.

**Contents:**
```
optimize/
├── pipeline.ts            pass orchestrator
├── pass.ts                pass interface definition
├── metadata.ts            shared annotation types (ranges, cardinalities)
│
├── canonicalize/          Group 1: normalize math, compute facts
│   ├── total-arith.ts         1.1 Total Arithmetic expansion
│   ├── saturating.ts          1.2 Saturating arithmetic expansion
│   ├── range-analysis.ts      1.3 Range propagation
│   └── guard-elim.ts          1.4 NanToZero/TotalDiv/TotalMod elimination
│
├── algebraic/             Group 2: rewrite what is computed
│   ├── pattern-match.ts       2.1 Closed-form pattern matching
│   ├── cas-resolve.ts         2.2 CAS fixed-point resolution (experimental)
│   ├── lut-tabulate.ts        2.3 LUT tabulation
│   └── aitken.ts              2.4 Aitken extrapolation (experimental)
│
├── structural/            Group 3: reshape execution structure
│   ├── unroll.ts              3.1 Lyapunov-derived unrolling
│   ├── separability.ts        3.2 2D→1D pass splitting (experimental)
│   ├── wavefront.ts           3.3 Convergence wavefront (experimental)
│   └── linear-spec.ts         3.4 Linear speculation (experimental)
│
└── machine/               Group 4: lower to target hardware
    ├── simd.ts                4.1 SIMD vectorization
    ├── sentinel-lower.ts      4.2 TotalDiv/TotalMod/NanToZero/Sat* expansion
    ├── tailcall.ts            4.3 rec loop/tail-call lowering
    └── gc-types.ts            4.4 WasmGC type mapping
```

**Pass interface:**

```typescript
interface Pass {
  name: string;
  group: "canonicalize" | "algebraic" | "structural" | "machine";
  experimental: boolean;
  run(ir: IR, meta: Metadata): { ir: IR; meta: Metadata };
}
```

Every pass is a pure function from `(IR, Metadata)` to `(IR, Metadata)`. Passes
don't hold state, don't access globals, and don't call each other directly.
The pipeline orchestrator runs them in order and threads the metadata through.

**Pipeline configuration:**

```typescript
const defaultPipeline: Pass[] = [
  // Group 1: Canonicalize
  totalArith,
  saturating,
  rangeAnalysis,
  guardElim,
  // Group 2: Algebraic
  patternMatch,
  lutTabulate,
  // Group 3: Structural
  unroll,
  // Group 4: Machine
  simd,
  sentinelLower,
  tailcall,
  gcTypes,
];

const experimentalPipeline: Pass[] = [
  ...defaultPipeline.slice(0, 6),  // Groups 1 + 2 (non-experimental)
  casResolve,                       // 2.2
  aitken,                           // 2.4
  ...defaultPipeline.slice(6, 7),  // unroll
  separability,                     // 3.2
  wavefront,                        // 3.3
  linearSpec,                       // 3.4
  ...defaultPipeline.slice(7),     // Group 4
];
```

Individual passes are toggled via CLI flags:
- `--enable-pass=aitken` — add a specific experimental pass
- `--disable-pass=simd` — remove a specific pass
- `--experimental` — enable all experimental passes
- `--dump-ir-after=range-analysis` — print IR after a specific pass (debugging)


### backend

Emits WASM 3.0 bytecode from the machine-lowered IR.

**Contents:**
- `emit.ts` — IR → WASM module structure (functions, types, tables, memory)
- `encode.ts` — WASM binary format encoder (LEB128, sections, etc.)
- `runtime.ts` — builtin function implementations (sqrt, sin, etc.)
- `link.ts` — resolves builtin calls, image I/O, command-line args

**WASM 3.0 features used:**
- `return_call` — tail calls for tail-position `rec` sites
- `struct.new` / `array.new` — WasmGC for JPL-- structs and arrays
- `ref.eq` — O(1) convergence check for GC references
- `call_ref` — typed function references (statically resolved)
- `i32x4.*` / `f32x4.*` — SIMD for vectorized kernels
- `v128.bitselect` — branchless NaN-to-zero in SIMD lanes
- `i8x16.swizzle` — vectorized LUT lookups
- `memory.atomic.*` — shared memory for linear speculation (experimental)


### lsp

Language server providing real-time IDE features. Reuses the frontend, verifier,
IR builder, and Group 1 (Canonicalize) of the optimizer. Does not run Groups
2-4 or the backend.

**LSP pipeline:** `parse → resolve → typecheck → verify → IR lower → Group 1`

Group 1 is cheap — it's a single forward pass over the IR that attaches range
annotations and sentinel nodes. It produces the `RangeMap` and `CardinalityMap`
side-tables that power hover information. Running it in the LSP adds negligible
latency compared to verification.

**Contents:**
- `server.ts` — LSP protocol handler (textDocument/didChange, etc.)
- `diagnostics.ts` — real-time error reporting from frontend + verifier
- `hover.ts` — hover info: types, inferred ranges, rad proof status
- `completion.ts` — keyword and variable completion
- `semantic-tokens.ts` — tree-sitter query-based semantic highlighting

**Incremental pipeline:** On every keystroke, tree-sitter incrementally
reparses only the changed region. The LSP re-runs resolve + typecheck on
affected scopes. Verification is re-run only on functions whose `rad`
expression or `rec` arguments changed. Group 1 re-runs on affected functions
to refresh range annotations.

**Z3 async handling:** When structural and symbolic verification fail, the LSP
reports a `pending` proof status immediately (hover shows "verifying via
SMT...") and kicks off the Z3 WASM load + query asynchronously. The diagnostic
is non-blocking — the user can keep typing. If they edit the `rad` expression
while Z3 is running, the in-flight query is cancelled and restarted. The hover
updates to `verified` or `failed` when the query resolves.

**Hover features:**
- Hover on a variable → show type and inferred range (e.g., `x : int [0, 255]`)
- Hover on `rad` → show proof status (`VERIFIED via structural`, `VERIFIED via
  SMT`, `PENDING (loading Z3...)`, `BOUNDED (gas 1000)`, `UNVERIFIED (gas inf)`)
- Hover on `rec` → show contraction ratio if known (e.g., `ratio ≤ 0.25`)
- Hover on a function name → show state-space cardinality and LUT eligibility


### cli

Command-line driver. Parses arguments, dispatches to the appropriate pipeline
stages, and prints output.

**Contents:**
- `main.ts` — argument parsing and flag dispatch
- `flags.ts` — flag definitions and validation

**Flags (inherited from JPL + additions):**

| Flag | Action |
|------|--------|
| `-l` | Lex only. Print tokens. |
| `-p` | Parse only. Pretty-print AST as s-expressions. |
| `-t` | Typecheck only. No codegen. |
| `-v` | Verify. Print proof obligations and status per function. |
| `-i` | Emit IR. Print human-readable IR after optimization. |
| `-s` | Emit WASM text format (.wat). |
| (none) | Full compilation. Emit WASM binary (.wasm). |
| `--experimental` | Enable all Tier 3 optimization passes. |
| `--enable-pass=X` | Enable a specific pass. |
| `--disable-pass=X` | Disable a specific pass. |
| `--dump-ir-after=X` | Print IR after pass X (debugging). |
| `--dump-ranges` | Print range analysis results (debugging). |
| `--no-optimize` | Skip all optimization passes. Emit naïve WASM. |


Data Flow Summary
-----------------

```
Source text (.jplmm)
    │
    │  tree-sitter
    ▼
CST (concrete syntax tree)
    │
    │  frontend/parse.ts
    ▼
Untyped AST
    │
    │  frontend/resolve.ts
    ▼
Resolved AST + ScopeMap
    │
    │  frontend/typecheck.ts
    ▼
Typed AST + TypeMap
    │
    ├───────────────────────────────────┐
    │                                   │
    │  verify/verify.ts                 │  lsp/ (diagnostics)
    ▼                                   │
Verified AST + ProofMap                 │
    │                                   │
    │  ir/builder.ts                    │
    ▼                                   │
Canonical IR                            │
    │                                   │
    │  optimize/canonicalize/ ──────────┤  lsp/ runs Group 1 only
    ▼                          (ranges, │  for hover info: ranges,
Annotated IR + RangeMap        cardina- │  cardinalities, LUT
    │                          lities)  │  eligibility
    │  optimize/ Groups 2-4             │
    ▼                                   │
Machine IR                              │
    │                                   │
    │  backend/emit.ts                  │
    ▼                                   │
WASM 3.0 binary (.wasm)                │
                                        │
                                (LSP stops after
                                 Group 1 canonicalize)
```


Watchouts
---------

### Statement Order Invariant

The spec requires `res` to be uninitialized until the first `ret`, and `rec` to
appear only after at least one `ret`. These checks live in `resolve.ts` and are
a simple linear scan because JPL-- has no divergent control flow. The invariant
to maintain: **nothing between parse and resolve may reorder statements.** The
pipeline is `parse → resolve → typecheck`, each a pure function on an immutable
AST. There is no desugaring pass, no AST normalization, no statement rewriting
between these phases. If AST-level desugaring is ever introduced, it must be
proven statement-order-preserving.

### Sentinel Node Propagation Through Algebraic Passes

Group 1 introduces sentinel nodes (`TotalDiv`, `TotalMod`, `NanToZero`) that carry
totality guarantees. Group 2 (Algebraic) may perform constant folding and
symbolic manipulation that encounters these sentinels. The rule:

**Algebraic passes treat sentinel nodes as opaque wrappers with known value
semantics.** Constant folding must implement the sentinel's semantic, not strip
the wrapper:

- `TotalDiv(Lit(9), Lit(3))` → `Lit(3)` (normal division)
- `TotalDiv(Lit(9), Lit(0))` → `Lit(0)` (zero-divisor canonicalization)
- `TotalMod(Lit(9), Lit(0))` → `Lit(0)` (zero-divisor canonicalization)
- `NanToZero(Lit(3.0))` → `Lit(3.0)` (3.0 is not NaN)
- `NanToZero(TotalDiv(Lit(0.0), Lit(0.0)))` → `Lit(0.0)` (NaN-free semantic)

If the input is not a compile-time constant, the sentinel survives untouched
to Group 4 (Machine) for branchless lowering. This is enforced by giving each
sentinel node type a `foldConstant(inputs: Literal[]): Literal` method that the
constant folder must call instead of pattern-matching through the wrapper.

### Z3 Asynchronous Boundary in LSP

Z3 compiled to WASM is ~10-15MB. Lazy-loading it in `verify/smt.ts` is correct,
but the LSP must handle the async gap. The design:

- Proof status has three states: `verified`, `pending`, `failed`.
- When structural and symbolic verification fail, the LSP immediately reports
  `pending` (hover: "verifying via SMT...").
- Z3 load + query runs asynchronously. The diagnostic is non-blocking.
- If the user edits the `rad` expression while Z3 is running, cancel the
  in-flight query and restart after the next typecheck cycle.
- Hover updates to `verified` or `failed` when the query resolves.
- The CLI simply blocks on Z3. It is not interactive.

### Dead `RadExpr` Node Lifecycle

The `rad` expression is preserved in the IR as a dead `RadExpr` node. The
default pipeline never materializes it into runtime code. However:

- Pass 2.4 (Aitken) copies the `RadExpr` and inlines it into `AitkenGuard`.
  The inlined copy becomes live code. The original stays dead.
- Pass 1.3 (Range Analysis) may read the `RadExpr` to compute contraction
  ratios for unroll bound estimation.
- Pass 1.4 (Guard Elimination) does not touch `RadExpr`.
- WASM emission skips all nodes marked dead.

The invariant: **`RadExpr` is never deleted from the IR, only cloned.** Passes
that need it read or clone it. Passes that don't need it ignore it. It is
dropped silently at emission time.


Testing Strategy
----------------

Each package has its own test suite. Tests are isolated — a test for
`range-analysis.ts` constructs a tiny IR fragment, runs the pass, and checks
the output ranges. It doesn't touch the parser, the verifier, or any other
pass.

**Test categories:**

| Package | Test Type | Example |
|---------|-----------|---------|
| grammar | tree-sitter corpus | `fn f(x:int):int { ret x }` → expected CST |
| frontend | snapshot tests | source → AST → pretty-printed source (round-trip) |
| frontend | error tests | `if x then y` → `error: 'if' is not a keyword in JPL--` |
| verify | proof tests | `rad x` + `rec(max(0,x-1))` → `VERIFIED structural` |
| verify | rejection tests | `rad x` + `rec(x+1)` → `REJECTED: abs(x+1) not < abs(x)` |
| ir | lowering tests | AST fragment → expected IR nodes |
| optimize | per-pass unit tests | IR fragment → pass → expected IR fragment |
| optimize | integration tests | source → full pipeline → expected WASM behavior |
| backend | binary tests | IR → WASM → run in Wasmtime → check output |
| lsp | protocol tests | mock LSP messages → expected responses |

**End-to-end tests:** A set of JPL-- programs with known outputs. Compile, run
in Wasmtime (or a WASM browser engine), check stdout. These programs cover:
- Babylonian sqrt
- Fibonacci
- GCD
- Image blur (when image I/O is implemented)
- Intentionally rejected programs (bad `rad`, `res` before `ret`, etc.)
- `gas N` programs that exhaust fuel
- `gas inf` programs (with timeout)


Build System
------------

Turborepo for monorepo orchestration. Each package builds independently.
The build graph mirrors the dependency graph — `frontend` doesn't build until
`grammar` and `ast` are done.

```
turbo.json:
{
  "pipeline": {
    "build": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["build"] },
    "lint": {}
  }
}
```

**Key tooling:**
- `tree-sitter-cli` — generates the parser from `grammar.js`
- `tsc` — TypeScript compilation
- `vitest` — test runner
- `esbuild` — bundling for CLI and LSP distribution
- `z3-solver` — optional WASM dependency, not bundled by default


Implementation Order
--------------------

### Phase 1: Minimum Viable Compiler

1. `grammar/` — tree-sitter grammar, corpus tests
2. `ast/` — node types, visitor, printer
3. `frontend/` — parse, resolve, typecheck
4. `verify/structural.ts` — structural decrease only
5. `ir/` — AST → IR lowering (naïve, no sentinel nodes yet)
6. `backend/` — naïve WASM emission with loop-based `rec` lowering and
   optional `return_call` at tail sites
7. `cli/` — wire everything together with `-l`, `-p`, `-t`, `-v`, `-s`

**Result:** Programs compile and run. Termination is verified for simple cases.
Nothing is optimized. This is the foundation everything else builds on.

### Phase 2: Core Optimizations

8.  `verify/symbolic.ts` (minimal) — sum-of-products factorization and
    monotone linear decrease. Required here because the marquee Phase 2 demos
    (`sqrt_iter` Babylonian method, `isqrt`) use `rad g - res`, which the
    structural verifier cannot prove. The minimal symbolic verifier handles
    linear-decrease and simple contraction patterns; hard nonlinear cases fall
    through to Phase 3's Z3 integration.
9.  `optimize/canonicalize/total-arith.ts` — sentinel nodes
10. `optimize/canonicalize/saturating.ts` — SatAdd/Sub/Mul nodes
11. `optimize/canonicalize/range-analysis.ts` — interval propagation
12. `optimize/canonicalize/guard-elim.ts` — remove unnecessary sentinels
13. `optimize/algebraic/pattern-match.ts` — sqrt, gcd patterns
14. `optimize/algebraic/lut-tabulate.ts` — compile-time tabulation
15. `optimize/structural/unroll.ts` — Lyapunov-bounded unrolling
16. `optimize/machine/sentinel-lower.ts` — branchless expansions
17. `optimize/machine/simd.ts` — vectorization

**Result:** Programs are fast. The marquee demos work: sqrt compiles to
`sqrtf`, small-domain functions become LUTs, Newton's method is fully unrolled.

### Phase 3: Verification Depth

18. `verify/symbolic.ts` (full) — extend the minimal symbolic verifier with
    advanced factorization, contraction-ratio computation, and sign analysis
    for nonlinear `rad` expressions
19. `verify/smt.ts` — Z3 integration for cases symbolic analysis cannot prove
20. `verify/report.ts` — detailed `-v` output

**Result:** The full `rad` proof pipeline is complete. Complex `rad`
expressions (Babylonian quadratic contraction, GCD modulus decrease) are
verified by the symbolic pass. Truly hard nonlinear cases fall through to Z3.

### Phase 4: Developer Experience

20. `lsp/` — diagnostics, hover, completion, semantic tokens
21. Editor extensions (VS Code, Neovim) using tree-sitter queries

**Result:** Writing JPL-- feels like writing in a language with first-class
tooling. Hover on `rad` shows proof status. Hover on variables shows ranges.
Errors appear as you type.

### Phase 5: Research Optimizations

22. `optimize/algebraic/cas-resolve.ts`
23. `optimize/algebraic/aitken.ts`
24. `optimize/structural/separability.ts`
25. `optimize/structural/wavefront.ts`
26. `optimize/structural/linear-spec.ts`
27. `optimize/machine/gc-types.ts` — WasmGC reference equality fast-paths

**Result:** The paper demos. Separable filters auto-detected. Convergence
wavefronts on images. Linear speculation with exponential search.
