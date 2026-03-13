// Generated from the JPL-- example corpus.
// Category: sort
// Example: 14_block_order_stack

datatype Vec8 = Vec8(a: int, b: int, c: int, d: int, e: int, f: int, g: int, h: int)

function MinInt(a: int, b: int): int {
  if a < b then a else b
}

function MaxInt(a: int, b: int): int {
  if a > b then a else b
}

function AbsInt(x: int): int {
  if x < 0 then -x else x
}

function ClampInt(x: int, lo: int, hi: int): int {
  if x < lo then lo else if x > hi then hi else x
}

method Stage81(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(MinInt(v.a, v.b), MaxInt(v.a, v.b), MinInt(v.c, v.d), MaxInt(v.c, v.d), MinInt(v.e, v.f), MaxInt(v.e, v.f), MinInt(v.g, v.h), MaxInt(v.g, v.h));
}

method Stage82(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(MinInt(v.a, v.c), MinInt(v.b, v.d), MaxInt(v.a, v.c), MaxInt(v.b, v.d), MinInt(v.e, v.g), MinInt(v.f, v.h), MaxInt(v.e, v.g), MaxInt(v.f, v.h));
}

method Stage83(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(MinInt(v.a, v.e), MinInt(v.b, v.f), MinInt(v.c, v.g), MinInt(v.d, v.h), MaxInt(v.a, v.e), MaxInt(v.b, v.f), MaxInt(v.c, v.g), MaxInt(v.d, v.h));
}

method Stage84(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(v.a, MinInt(v.b, v.c), MaxInt(v.b, v.c), v.d, v.e, MinInt(v.f, v.g), MaxInt(v.f, v.g), v.h);
}

method Stage85(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(v.a, MinInt(v.b, v.e), MinInt(v.c, v.f), MinInt(v.d, v.g), MaxInt(v.b, v.e), MaxInt(v.c, v.f), MaxInt(v.d, v.g), v.h);
}

method Stage86(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(v.a, v.b, MinInt(v.c, v.e), MinInt(v.d, v.f), MaxInt(v.c, v.e), MaxInt(v.d, v.f), v.g, v.h);
}

method Stage87(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(v.a, v.b, v.c, MinInt(v.d, v.e), MaxInt(v.d, v.e), v.f, v.g, v.h);
}

method Sort8(v: Vec8) returns (out: Vec8)
  decreases *
{
  var s1 := Stage81(v);
  var s2 := Stage82(s1);
  var s3 := Stage83(s2);
  var s4 := Stage84(s3);
  var s5 := Stage85(s4);
  var s6 := Stage86(s5);
  out := Stage87(s6);
}

method MakeVec8Blocks(seed: int, n: int) returns (blocks: array<Vec8>)
  decreases *
{
  blocks := new Vec8[n];
  var i := 0;
  while i < n
    decreases *
  {
    blocks[i] := Vec8(
      ClampInt(AbsInt(seed + 3 + i * 3), 0, 255),
      ClampInt(AbsInt(seed + 5 + i * 5), 0, 255),
      ClampInt(AbsInt(seed + 7 + i * 7), 0, 255),
      ClampInt(AbsInt(seed + 9 + i * 9), 0, 255),
      ClampInt(AbsInt(seed + 11 + i * 11), 0, 255),
      ClampInt(AbsInt(seed + 13 + i * 13), 0, 255),
      ClampInt(AbsInt(seed + 15 + i * 15), 0, 255),
      ClampInt(AbsInt(seed + 17 + i * 17), 0, 255)
    );
    i := i + 1;
  }
}

method Checksum(blocks: array<Vec8>, n: int) returns (out: int)
  decreases *
{
  out := 0;
  var i := 0;
  while i < n
    decreases *
  {
    var s := Sort8(blocks[i]);
    out := out + (s.d + s.e) / 2;
    i := i + 1;
  }
}

method Entry(seed: int) returns (digest: int)
  decreases *
{
  var n := 6;
  var blocks := MakeVec8Blocks(seed, n);
  digest := Checksum(blocks, n);
}

method {:main} Main()
  decreases *
{
  var acc := 0;
  var i := 0;
  while i < 250
    decreases *
  {
    var current := Entry(7);
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\n";
}
