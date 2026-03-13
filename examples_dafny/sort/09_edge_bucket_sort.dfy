// Generated from the JPL-- example corpus.
// Category: sort
// Example: 09_edge_bucket_sort

datatype Vec4 = Vec4(a: int, b: int, c: int, d: int)

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

method Stage4A(v: Vec4) returns (out: Vec4)
  decreases *
{
  out := Vec4(MinInt(v.a, v.b), MaxInt(v.a, v.b), MinInt(v.c, v.d), MaxInt(v.c, v.d));
}

method Stage4B(v: Vec4) returns (out: Vec4)
  decreases *
{
  out := Vec4(MinInt(v.a, v.c), MinInt(v.b, v.d), MaxInt(v.a, v.c), MaxInt(v.b, v.d));
}

method Stage4C(v: Vec4) returns (out: Vec4)
  decreases *
{
  out := Vec4(v.a, MinInt(v.b, v.c), MaxInt(v.b, v.c), v.d);
}

method Sort4(v: Vec4) returns (out: Vec4)
  decreases *
{
  var a := Stage4A(v);
  var b := Stage4B(a);
  out := Stage4C(b);
}

method MakeVec4Blocks(seed: int, n: int) returns (blocks: array<Vec4>)
  decreases *
{
  blocks := new Vec4[n];
  var i := 0;
  while i < n
    decreases *
  {
    blocks[i] := Vec4(
      ClampInt(AbsInt(seed + 3 + i * 5), 0, 255),
      ClampInt(AbsInt(seed + 7 + i * 7), 0, 255),
      ClampInt(AbsInt(seed + 11 + i * 9), 0, 255),
      ClampInt(AbsInt(seed + 13 + i * 11), 0, 255)
    );
    i := i + 1;
  }
}

method Checksum(blocks: array<Vec4>, n: int) returns (out: int)
  decreases *
{
  out := 0;
  var i := 0;
  while i < n
    decreases *
  {
    var s := Sort4(blocks[i]);
    out := out + (s.b + s.c) / 2;
    i := i + 1;
  }
}

method Entry(seed: int) returns (digest: int)
  decreases *
{
  var n := 6;
  var blocks := MakeVec4Blocks(seed, n);
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
