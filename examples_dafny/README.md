# JPL-- Matched Dafny Examples

This folder mirrors the generated JPL-- examples corpus with benchmarkable Dafny equivalents.

It currently contains 112 generated files across these categories:

- image: 24
- matrix: 20
- signal: 20
- sort: 20
- control: 16
- showcase: 12

Each file is standalone, contains a seeded entry workload, and a `Main` method that executes a small benchmark loop suitable for codegen/runtime comparison.

The float-heavy matrix, signal, and control families are emitted as fixed-point integer analogues so the generated Dafny code stays runnable and benchmarkable on the available backend.
