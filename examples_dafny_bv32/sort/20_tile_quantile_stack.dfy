// Generated from the JPL-- example corpus.
// Category: sort
// Example: 20_tile_quantile_stack

datatype Vec8 = Vec8(a: bv32, b: bv32, c: bv32, d: bv32, e: bv32, f: bv32, g: bv32, h: bv32)

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

function Stage8_1(v: Vec8): Vec8 {
  Vec8(Min32(v.a, v.b), Max32(v.a, v.b), Min32(v.c, v.d), Max32(v.c, v.d), Min32(v.e, v.f), Max32(v.e, v.f), Min32(v.g, v.h), Max32(v.g, v.h))
}

function Stage8_2(v: Vec8): Vec8 {
  Vec8(Min32(v.a, v.c), Min32(v.b, v.d), Max32(v.a, v.c), Max32(v.b, v.d), Min32(v.e, v.g), Min32(v.f, v.h), Max32(v.e, v.g), Max32(v.f, v.h))
}

function Stage8_3(v: Vec8): Vec8 {
  Vec8(Min32(v.a, v.e), Min32(v.b, v.f), Min32(v.c, v.g), Min32(v.d, v.h), Max32(v.a, v.e), Max32(v.b, v.f), Max32(v.c, v.g), Max32(v.d, v.h))
}

function Stage8_4(v: Vec8): Vec8 {
  Vec8(v.a, Min32(v.b, v.c), Max32(v.b, v.c), v.d, v.e, Min32(v.f, v.g), Max32(v.f, v.g), v.h)
}

function Stage8_5(v: Vec8): Vec8 {
  Vec8(v.a, Min32(v.b, v.e), Min32(v.c, v.f), Min32(v.d, v.g), Max32(v.b, v.e), Max32(v.c, v.f), Max32(v.d, v.g), v.h)
}

function Stage8_6(v: Vec8): Vec8 {
  Vec8(v.a, v.b, Min32(v.c, v.e), Min32(v.d, v.f), Max32(v.c, v.e), Max32(v.d, v.f), v.g, v.h)
}

function Stage8_7(v: Vec8): Vec8 {
  Vec8(v.a, v.b, v.c, Min32(v.d, v.e), Max32(v.d, v.e), v.f, v.g, v.h)
}

function Sort8(v: Vec8): Vec8 {
  var s1 := Stage8_1(v);
  var s2 := Stage8_2(s1);
  var s3 := Stage8_3(s2);
  var s4 := Stage8_4(s3);
  var s5 := Stage8_5(s4);
  var s6 := Stage8_6(s5);
  Stage8_7(s6)
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
      Clamp8FromInt(AbsInt(seed + 3 + i * 5)),
      Clamp8FromInt(AbsInt(seed + 7 + i * 7)),
      Clamp8FromInt(AbsInt(seed + 11 + i * 9)),
      Clamp8FromInt(AbsInt(seed + 13 + i * 11)),
      Clamp8FromInt(AbsInt(seed + 17 + i * 13)),
      Clamp8FromInt(AbsInt(seed + 19 + i * 15)),
      Clamp8FromInt(AbsInt(seed + 23 + i * 17)),
      Clamp8FromInt(AbsInt(seed + 29 + i * 19))
    );
    i := i + 1;
  }
}

method Checksum(blocks: array<Vec8>, n: int) returns (out: bv32)
  decreases *
{
  out := 0 as bv32;
  var i := 0;
  while i < n
    decreases *
  {
    var s := Sort8(blocks[i]);
    out := out + (s.d + s.e) / (2 as bv32);
    i := i + 1;
  }
}

method Entry(seed: int) returns (digest: bv32)
  decreases *
{
  var n := 6;
  var blocks := MakeVec8Blocks(seed, n);
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
