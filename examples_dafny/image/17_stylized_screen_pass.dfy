// Generated from the JPL-- example corpus.
// Category: image
// Example: 17_stylized_screen_pass

datatype Pixel = Pixel(r: int, g: int, b: int)

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
    ClampInt((p00.r + p01.r + p02.r + p10.r + p11.r + p12.r + p20.r + p21.r + p22.r) / 9, 0, 255),
    ClampInt((p00.g + p01.g + p02.g + p10.g + p11.g + p12.g + p20.g + p21.g + p22.g) / 9, 0, 255),
    ClampInt((p00.b + p01.b + p02.b + p10.b + p11.b + p12.b + p20.b + p21.b + p22.b) / 9, 0, 255)
  );
}

method EdgeX(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (p: Pixel)
  decreases *
{
  var left := Sample(img, h, w, y, x - 1);
  var right := Sample(img, h, w, y, x + 1);
  p := Pixel(AbsInt(right.r - left.r), AbsInt(right.g - left.g), AbsInt(right.b - left.b));
}

method EdgeY(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (p: Pixel)
  decreases *
{
  var up := Sample(img, h, w, y - 1, x);
  var down := Sample(img, h, w, y + 1, x);
  p := Pixel(AbsInt(down.r - up.r), AbsInt(down.g - up.g), AbsInt(down.b - up.b));
}

method AccentPx(img: array<array<Pixel>>, h: int, w: int, y: int, x: int) returns (p: Pixel)
  decreases *
{
  var base := Sample(img, h, w, y, x);
  var blur := BlurPx(img, h, w, y, x);
  var ex := EdgeX(img, h, w, y, x);
  var ey := EdgeY(img, h, w, y, x);
  p := Pixel(
    ClampInt(base.r + ex.r / 2 + ey.r / 10 - blur.r / 4 + 64, 0, 255),
    ClampInt(base.g + ex.g / 10 + ey.g / 2 - blur.g / 12 + 40, 0, 255),
    ClampInt(base.b + ex.b / 12 + ey.b / 10 - blur.b / 4 + 20, 0, 255)
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
        ClampInt((base.r + blur.r) / 2, 0, 255),
        ClampInt((base.g + ex.g) / 2, 0, 255),
        ClampInt((base.b + ey.b) / 2, 0, 255)
      );
      x := x + 1;
    }
    out[y] := row;
    y := y + 1;
  }
}

method ColumnEnergy(img: array<array<Pixel>>, h: int, w: int) returns (out: array<int>)
  decreases *
{
  var pipeline := StageB(img, h, w);
  out := new int[w];
  var x := 0;
  while x < w
    decreases *
  {
    var acc := 0;
    var y := 0;
    while y < h
      decreases *
    {
      var p := pipeline[y][x];
      acc := acc + (p.r + p.g + p.b) / 3;
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
      var r := ClampInt(AbsInt(seed + 5 + y * 7 + x * 11), 0, 255);
      var g := ClampInt(AbsInt(seed + 9 + y * 5 + x * 13), 0, 255);
      var b := ClampInt(AbsInt(seed + 13 + y * 3 + x * 17), 0, 255);
      row[x] := Pixel(r, g, b);
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
  var img := MakeImage(seed, h, w);
  var out := ColumnEnergy(img, h, w);
  digest := 0;
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
  var acc := 0;
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
