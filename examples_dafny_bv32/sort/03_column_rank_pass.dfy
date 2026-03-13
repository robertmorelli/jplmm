// Generated from the JPL-- example corpus.
// Category: sort
// Example: 03_column_rank_pass

datatype Vec4 = Vec4(a: bv32, b: bv32, c: bv32, d: bv32)

function AbsInt(x: int): int {
  if x < 0 then -x else x
}

function ClampInt(x: int, lo: int, hi: int): int {
  if x < lo then lo else if x > hi then hi else x
}


function Clamp8(x: bv32): bv32 {
  if x > (255 as bv32) then (255 as bv32) else x
}

function Clamp8FromInt(x: int): bv32 {
  if x < 0 then (0 as bv32) else if x > 255 then (255 as bv32) else x as bv32
}

function Min32(a: bv32, b: bv32): bv32 {
  if a < b then a else b
}

function Max32(a: bv32, b: bv32): bv32 {
  if a > b then a else b
}

function AbsDiff32(a: bv32, b: bv32): bv32 {
  if a < b then b - a else a - b
}

function BlendChannel(base: bv32, add1: bv32, div1: bv32, add2: bv32, div2: bv32, sub1: bv32, divs: bv32, bias: bv32): bv32 {
  if base + add1 / div1 + add2 / div2 + bias < sub1 / divs
  then (0 as bv32)
  else Clamp8((base + add1 / div1 + add2 / div2 + bias) - (sub1 / divs))
}

function Sort4(v: Vec4): Vec4 {
  var s1 := Vec4(Min32(v.a, v.b), Max32(v.a, v.b), Min32(v.c, v.d), Max32(v.c, v.d));
  var s2 := Vec4(Min32(s1.a, s1.c), Min32(s1.b, s1.d), Max32(s1.a, s1.c), Max32(s1.b, s1.d));
  Vec4(s2.a, Min32(s2.b, s2.c), Max32(s2.b, s2.c), s2.d)
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
      Clamp8FromInt(AbsInt(seed + 3 + i * 5)),
      Clamp8FromInt(AbsInt(seed + 7 + i * 7)),
      Clamp8FromInt(AbsInt(seed + 11 + i * 9)),
      Clamp8FromInt(AbsInt(seed + 13 + i * 11))
    );
    i := i + 1;
  }
}

method Checksum(blocks: array<Vec4>, n: int) returns (out: bv32)
  decreases *
{
  out := 0 as bv32;
  var i := 0;
  while i < n
    decreases *
  {
    var s := Sort4(blocks[i]);
    out := out + (s.b + s.c) / (2 as bv32);
    i := i + 1;
  }
}

method Entry(seed: int) returns (digest: bv32)
  decreases *
{
  var n := 6;
  var blocks := MakeVec4Blocks(seed, n);
  digest := Checksum(blocks, n);
}

method {:main} Main()
  decreases *
{
  var acc: bv32 := 0 as bv32;
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
