// Generated from the JPL-- example corpus.
// Category: image
// Example: 08_edge_heatmap_builder

datatype Pixel = Pixel(r: bv32, g: bv32, b: bv32)

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
  var yy := ClampInt(y, 0, h - 1);
  var xx := ClampInt(x, 0, w - 1);
  p := img[yy][xx];
}

method BlurPx(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (p: Pixel)
  decreases *
{
  var p00 := Sample(img, h, w, y - 1, x - 1);
  var p01 := Sample(img, h, w, y - 1, x);
  var p02 := Sample(img, h, w, y - 1, x + 1);
  var p10 := Sample(img, h, w, y, x - 1);
  var p11 := Sample(img, h, w, y, x);
  var p12 := Sample(img, h, w, y, x + 1);
  var p20 := Sample(img, h, w, y + 1, x - 1);
  var p21 := Sample(img, h, w, y + 1, x);
  var p22 := Sample(img, h, w, y + 1, x + 1);
  p := Pixel(
    Clamp8((p00.r + p01.r + p02.r + p10.r + p11.r + p12.r + p20.r + p21.r + p22.r) / (9 as bv32)),
    Clamp8((p00.g + p01.g + p02.g + p10.g + p11.g + p12.g + p20.g + p21.g + p22.g) / (9 as bv32)),
    Clamp8((p00.b + p01.b + p02.b + p10.b + p11.b + p12.b + p20.b + p21.b + p22.b) / (9 as bv32))
  );
}

method EdgeX(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (p: Pixel)
  decreases *
{
  var left := Sample(img, h, w, y, x - 1);
  var right := Sample(img, h, w, y, x + 1);
  p := Pixel(AbsDiff32(right.r, left.r), AbsDiff32(right.g, left.g), AbsDiff32(right.b, left.b));
}

method EdgeY(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (p: Pixel)
  decreases *
{
  var up := Sample(img, h, w, y - 1, x);
  var down := Sample(img, h, w, y + 1, x);
  p := Pixel(AbsDiff32(down.r, up.r), AbsDiff32(down.g, up.g), AbsDiff32(down.b, up.b));
}

method AccentPx(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (p: Pixel)
  decreases *
{
  var base := Sample(img, h, w, y, x);
  var blur := BlurPx(img, h, w, y, x);
  var ex := EdgeX(img, h, w, y, x);
  var ey := EdgeY(img, h, w, y, x);
  p := Pixel(
    BlendChannel(base.r, ex.r, (5 as bv32), ey.r, (8 as bv32), blur.r, (5 as bv32), (37 as bv32)),
    BlendChannel(base.g, ex.g, (8 as bv32), ey.g, (5 as bv32), blur.g, (6 as bv32), (22 as bv32)),
    BlendChannel(base.b, ex.b, (6 as bv32), ey.b, (8 as bv32), blur.b, (5 as bv32), (11 as bv32))
  );
}

method StageA(img: array<array<Pixel>>, h: int, w: int) returns (out: array<array<Pixel>>)
  decreases *
{
  out := new array<Pixel>[h];
  var y := 0;
  while y < h
    decreases *
  {
    var row := new Pixel[w];
    var x := 0;
    while x < w
      decreases *
    {
      row[x] := AccentPx(img, h, w, y, x);
      x := x + 1;
    }
    out[y] := row;
    y := y + 1;
  }
}

method StageB(img: array<array<Pixel>>, h: int, w: int) returns (out: array<array<Pixel>>)
  decreases *
{
  var lifted := StageA(img, h, w);
  out := new array<Pixel>[h];
  var y := 0;
  while y < h
    decreases *
  {
    var row := new Pixel[w];
    var x := 0;
    while x < w
      decreases *
    {
      var blur := BlurPx(img, h, w, y, x);
      var ex := EdgeX(img, h, w, y, x);
      var ey := EdgeY(img, h, w, y, x);
      var base := lifted[y][x];
      row[x] := Pixel(
        Clamp8((base.r + blur.r) / (2 as bv32)),
        Clamp8((base.g + ex.g) / (2 as bv32)),
        Clamp8((base.b + ey.b) / (2 as bv32))
      );
      x := x + 1;
    }
    out[y] := row;
    y := y + 1;
  }
}

method ColumnEnergy(img: array<array<Pixel>>, h: int, w: int) returns (out: array<bv32>)
  decreases *
{
  var pipeline := StageB(img, h, w);
  out := new bv32[w];
  var x := 0;
  while x < w
    decreases *
  {
    var acc: bv32 := 0 as bv32;
    var y := 0;
    while y < h
      decreases *
    {
      var p := pipeline[y][x];
      acc := acc + (p.r + p.g + p.b) / (3 as bv32);
      y := y + 1;
    }
    out[x] := acc;
    x := x + 1;
  }
}

method MakeImage(seed: int, h: int, w: int) returns (img: array<array<Pixel>>)
  decreases *
{
  img := new array<Pixel>[h];
  var y := 0;
  while y < h
    decreases *
  {
    var row := new Pixel[w];
    var x := 0;
    while x < w
      decreases *
    {
      var r := Clamp8FromInt(AbsInt(seed + 5 + y * 7 + x * 11));
      var g := Clamp8FromInt(AbsInt(seed + 9 + y * 5 + x * 13));
      var b := Clamp8FromInt(AbsInt(seed + 13 + y * 3 + x * 17));
      row[x] := Pixel(r, g, b);
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
  var img := MakeImage(seed, h, w);
  var out := ColumnEnergy(img, h, w);
  digest := 0 as bv32;
  var i := 0;
  while i < w
    decreases *
  {
    digest := digest + out[i];
    i := i + 1;
  }
}

method {:main} Main()
  decreases *
{
  var acc: bv32 := 0 as bv32;
  var i := 0;
  while i < 180
    decreases *
  {
    var current := Entry(7);
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\n";
}
