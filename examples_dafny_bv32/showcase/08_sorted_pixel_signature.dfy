// Generated from the JPL-- example corpus.
// Category: showcase
// Example: 08_sorted_pixel_signature

datatype Pixel = Pixel(r: bv32, g: bv32, b: bv32)
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

method Sample(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (p: Pixel)
  decreases *
{
  p := img[ClampInt(y, 0, h - 1)][ClampInt(x, 0, w - 1)];
}

function Luma(p: Pixel): bv32 {
  (p.r * (3 as bv32) + p.g * (4 as bv32) + p.b) / (8 as bv32)
}

method Block4(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (out: Vec4)
  decreases *
{
  var p00 := Sample(img, h, w, y, x);
  var p01 := Sample(img, h, w, y, x + 1);
  var p10 := Sample(img, h, w, y + 1, x);
  var p11 := Sample(img, h, w, y + 1, x + 1);
  out := Vec4(Luma(p00), Luma(p01), Luma(p10), Luma(p11));
}

function Sort4(v: Vec4): Vec4 {
  var s1 := Vec4(Min32(v.a, v.b), Max32(v.a, v.b), Min32(v.c, v.d), Max32(v.c, v.d));
  var s2 := Vec4(Min32(s1.a, s1.c), Min32(s1.b, s1.d), Max32(s1.a, s1.c), Max32(s1.b, s1.d));
  Vec4(s2.a, Min32(s2.b, s2.c), Max32(s2.b, s2.c), s2.d)
}

method BlockMetric(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (out: bv32)
  decreases *
{
  var block := Block4(img, h, w, y, x);
  var sorted := Sort4(block);
  var pix := Sample(img, h, w, y, x);
  var base := Luma(pix);
  out := (sorted.b + sorted.c + base / (4 as bv32)) / (2 as bv32);
}

method RowProfile(img: array<array<Pixel>>, h: int, w: int) returns (out: array<bv32>)
  decreases *
{
  out := new bv32[h];
  var y := 0;
  while y < h
    decreases *
  {
    var acc: bv32 := 0 as bv32;
    var x := 0;
    while x < w
      decreases *
    {
      var value := BlockMetric(img, h, w, y * 2, x * 2);
      acc := acc + value;
      x := x + 1;
    }
    out[y] := acc;
    y := y + 1;
  }
}

method MakeImage(seed: int, h: int, w: int) returns (img: array<array<Pixel>>)
  decreases *
{
  img := new array<Pixel>[h * 2 + 1];
  var y := 0;
  while y < h * 2 + 1
    decreases *
  {
    var row := new Pixel[w * 2 + 1];
    var x := 0;
    while x < w * 2 + 1
      decreases *
    {
      row[x] := Pixel(
        Clamp8FromInt(AbsInt(seed + 5 + y * 7 + x * 11)),
        Clamp8FromInt(AbsInt(seed + 9 + y * 5 + x * 13)),
        Clamp8FromInt(AbsInt(seed + 13 + y * 3 + x * 17))
      );
      x := x + 1;
    }
    img[y] := row;
    y := y + 1;
  }
}

method Entry(seed: int) returns (digest: bv32)
  decreases *
{
  var h := 4;
  var w := 5;
  var image := MakeImage(seed, h, w);
  var profile := RowProfile(image, h, w);
  digest := 0 as bv32;
  var i := 0;
  while i < h
    decreases *
  {
    digest := digest + profile[i];
    i := i + 1;
  }
}

method {:main} Main()
  decreases *
{
  var acc: bv32 := 0 as bv32;
  var i := 0;
  while i < 120
    decreases *
  {
    var current := Entry(7);
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\n";
}
