// Generated from the JPL-- example corpus.
// Category: showcase
// Example: 03_ranked_luma_tiles

datatype Pixel = Pixel(r: int, g: int, b: int)
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

method Sample(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (p: Pixel)
  decreases *
{
  p := img[ClampInt(y, 0, h - 1)][ClampInt(x, 0, w - 1)];
}

function Luma(p: Pixel): int {
  (p.r * 3 + p.g * 4 + p.b) / 8
}

method Block4(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (out: Vec4)
  decreases *
{
  var p00 := Sample(img, h, w, y, x);
  var p01 := Sample(img, h, w, y, x + 1);
  var p10 := Sample(img, h, w, y + 1, x);
  var p11 := Sample(img, h, w, y + 1, x + 1);
  out := Vec4(
    Luma(p00),
    Luma(p01),
    Luma(p10),
    Luma(p11)
  );
}

method Stage1(v: Vec4) returns (out: Vec4)
  decreases *
{
  out := Vec4(MinInt(v.a, v.b), MaxInt(v.a, v.b), MinInt(v.c, v.d), MaxInt(v.c, v.d));
}

method Stage2(v: Vec4) returns (out: Vec4)
  decreases *
{
  out := Vec4(MinInt(v.a, v.c), MinInt(v.b, v.d), MaxInt(v.a, v.c), MaxInt(v.b, v.d));
}

method Stage3(v: Vec4) returns (out: Vec4)
  decreases *
{
  out := Vec4(v.a, MinInt(v.b, v.c), MaxInt(v.b, v.c), v.d);
}

method Sort4(v: Vec4) returns (out: Vec4)
  decreases *
{
  var s1 := Stage1(v);
  var s2 := Stage2(s1);
  out := Stage3(s2);
}

method BlockMetric(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (out: int)
  decreases *
{
  var block := Block4(img, h, w, y, x);
  var sorted := Sort4(block);
  var pix := Sample(img, h, w, y, x);
  var base := Luma(pix);
  out := (sorted.b + sorted.c + base / 4) / 2;
}

method RowProfile(img: array<array<Pixel>>, h: int, w: int) returns (out: array<int>)
  decreases *
{
  out := new int[h];
  var y := 0;
  while y < h
    decreases *
  {
    var acc := 0;
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
        ClampInt(AbsInt(seed + 5 + y * 7 + x * 11), 0, 255),
        ClampInt(AbsInt(seed + 9 + y * 5 + x * 13), 0, 255),
        ClampInt(AbsInt(seed + 13 + y * 3 + x * 17), 0, 255)
      );
      x := x + 1;
    }
    img[y] := row;
    y := y + 1;
  }
}

method Entry(seed: int) returns (digest: int)
  decreases *
{
  var h := 4;
  var w := 5;
  var image := MakeImage(seed, h, w);
  var profile := RowProfile(image, h, w);
  digest := 0;
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
  var acc := 0;
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
