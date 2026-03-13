// Generated from the JPL-- example corpus.
// Category: control
// Example: 10_grid_relax_e


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

function AbsReal(x: int): int {
  if x < 0 then -x else x
}

function MaxReal(a: int, b: int): int {
  if a > b then a else b
}

function MinReal(a: int, b: int): int {
  if a < b then a else b
}

function FromInt(x: int): int {
  x * 1024
}

function FixedMul(a: int, b: int): int {
  (a * b) / 1024
}

function FixedDiv(a: int, b: int): int {
  if b == 0 then 0 else (a * 1024) / b
}

method NormalizeAngle(x: int) returns (y: int)
  decreases *
{
  var out := x;
  while out > 3217
    decreases *
  {
    out := out - 6434;
  }
  while out < -3217
    decreases *
  {
    out := out + 6434;
  }
  y := out;
}

method SinApprox(x: int) returns (y: int)
  decreases *
{
  var z := NormalizeAngle(x);
  var sign := 1;
  if z < 0 {
    sign := -1;
    z := -z;
  }
  if z > 1608 {
    z := 3217 - z;
  }
  var numerator := 4 * z * (3217 - z);
  y := sign * (numerator / 10106);
}

method CosApprox(x: int) returns (y: int)
  decreases *
{
  y := SinApprox(x + 1608);
}

method SqrtApprox(x: int) returns (y: int)
  decreases *
{
  if x <= 0 {
    y := 0;
    return;
  }
  var g := if x > 1024 then x else 1024;
  var i := 0;
  while i < 8
    decreases *
  {
    g := (g + FixedDiv(x, g)) / 2;
    i := i + 1;
  }
  y := g;
}

method Smooth(grid: array<array<int>>, h: int, w: int) returns (out: array<array<int>>)
  decreases *
{
  out := new array<int>[h];
  var y := 0;
  while y < h
    decreases *
  {
    var row := new int[w];
    var x := 0;
    while x < w
      decreases *
    {
      row[x] := (
        grid[y][x] +
        grid[ClampInt(y - 1, 0, h - 1)][x] +
        grid[ClampInt(y + 1, 0, h - 1)][x] +
        grid[y][ClampInt(x - 1, 0, w - 1)] +
        grid[y][ClampInt(x + 1, 0, w - 1)]
      ) / 4;
      x := x + 1;
    }
    out[y] := row;
    y := y + 1;
  }
}

method Relax(grid: array<array<int>>, h: int, w: int, steps: int) returns (out: array<array<int>>)
  decreases *
{
  var next := Smooth(grid, h, w);
  if steps <= 0 {
    out := grid;
    return;
  }
  out := Relax(next, h, w, steps - 1);
}

method Metric(grid: array<array<int>>, h: int, w: int) returns (out: int)
  decreases *
{
  var settled := Relax(grid, h, w, 7);
  out := 0;
  var y := 0;
  while y < h
    decreases *
  {
    var x := 0;
    while x < w
      decreases *
    {
      out := out + settled[y][x];
      x := x + 1;
    }
    y := y + 1;
  }
}

method MakeGrid(seed: int, h: int, w: int) returns (grid: array<array<int>>)
  decreases *
{
  grid := new array<int>[h];
  var y := 0;
  while y < h
    decreases *
  {
    var row := new int[w];
    var x := 0;
    while x < w
      decreases *
    {
      row[x] := (AbsInt(seed + 7 + y * 5 + x * 9) * 1024) / 4 + (y * 1024) / 3 + (x * 1024) / 5;
      x := x + 1;
    }
    grid[y] := row;
    y := y + 1;
  }
}

method Entry(seed: int) returns (digest: int)
  decreases *
{
  var h := 4;
  var w := 5;
  var grid := MakeGrid(seed, h, w);
  digest := Metric(grid, h, w);
}

method {:main} Main()
  decreases *
{
  var acc := 0;
  var i := 0;
  while i < 40
    decreases *
  {
    var current := Entry(7);
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\n";
}
