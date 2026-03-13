# JPL-- More Comparable Dafny Examples

This folder contains 56 generated Dafny examples for the exact integer-heavy JPL-- families.

Categories included:

- image: 24
- sort: 20
- showcase: 12

These files use Dafny `bv32` values so the generated Go backend lowers hot arithmetic to native `uint32` operations.

The goal is a more comparable codegen benchmark than the broader fixed-point analogue corpus.
