// Generated from the JPL-- example corpus.
// Category: matrix
// Example: 08_block_affine_stack


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

method DotRow(a: array<array<int>>, b: array<array<int>>, row: int, col: int, shared: int) returns (out: int)
  decreases *
{
  out := 0;
  var k := 0;
  while k < shared
    decreases *
  {
    out := out + FixedMul(a[row][k], b[k][col]);
    k := k + 1;
  }
}

method Transpose(a: array<array<int>>, rows: int, cols: int) returns (out: array<array<int>>)
  decreases *
{
  out := new array<int>[cols];
  var j := 0;
  while j < cols
    decreases *
  {
    var row := new int[rows];
    var i := 0;
    while i < rows
      decreases *
    {
      row[i] := a[i][j];
      i := i + 1;
    }
    out[j] := row;
    j := j + 1;
  }
}

method MatMul(a: array<array<int>>, b: array<array<int>>, rows: int, cols: int, shared: int) returns (out: array<array<int>>)
  decreases *
{
  out := new array<int>[rows];
  var i := 0;
  while i < rows
    decreases *
  {
    var row := new int[cols];
    var j := 0;
    while j < cols
      decreases *
    {
      row[j] := DotRow(a, b, i, j, shared);
      j := j + 1;
    }
    out[i] := row;
    i := i + 1;
  }
}

method Laplace(a: array<array<int>>, rows: int, cols: int) returns (out: array<array<int>>)
  decreases *
{
  out := new array<int>[rows];
  var i := 0;
  while i < rows
    decreases *
  {
    var row := new int[cols];
    var j := 0;
    while j < cols
      decreases *
    {
      var up := a[ClampInt(i - 1, 0, rows - 1)][j];
      var down := a[ClampInt(i + 1, 0, rows - 1)][j];
      var left := a[i][ClampInt(j - 1, 0, cols - 1)];
      var right := a[i][ClampInt(j + 1, 0, cols - 1)];
      row[j] := (up + down + left + right - a[i][j] * 4) / 3;
      j := j + 1;
    }
    out[i] := row;
    i := i + 1;
  }
}

method RowNorm(a: array<array<int>>, row: int, cols: int) returns (out: int)
  decreases *
{
  var acc := 0;
  var k := 0;
  while k < cols
    decreases *
  {
    acc := acc + FixedMul(a[row][k], a[row][k]);
    k := k + 1;
  }
  out := SqrtApprox(acc);
}

method Normalize(a: array<array<int>>, rows: int, cols: int) returns (out: array<array<int>>)
  decreases *
{
  out := new array<int>[rows];
  var i := 0;
  while i < rows
    decreases *
  {
    var norm := RowNorm(a, i, cols);
    var scale := MaxReal(1024, norm);
    var row := new int[cols];
    var j := 0;
    while j < cols
      decreases *
    {
      row[j] := FixedDiv(a[i][j], scale);
      j := j + 1;
    }
    out[i] := row;
    i := i + 1;
  }
}

method Enrich(a: array<array<int>>, rows: int, cols: int) returns (out: array<array<int>>)
  decreases *
{
  var base := Normalize(a, rows, cols);
  var smooth := Laplace(base, rows, cols);
  out := new array<int>[rows];
  var i := 0;
  while i < rows
    decreases *
  {
    var row := new int[cols];
    var j := 0;
    while j < cols
      decreases *
    {
      row[j] := base[i][j] + smooth[i][j] / 5;
      j := j + 1;
    }
    out[i] := row;
    i := i + 1;
  }
}

method Pipeline(a: array<array<int>>, rows: int, cols: int) returns (out: array<array<int>>)
  decreases *
{
  var enriched := Enrich(a, rows, cols);
  var t := Transpose(enriched, rows, cols);
  var g := MatMul(t, a, cols, cols, rows);
  out := Normalize(g, cols, cols);
}

method DiagonalEnergy(a: array<array<int>>, rows: int, cols: int) returns (out: int)
  decreases *
{
  var grid := Pipeline(a, rows, cols);
  var n := MinInt(rows, cols);
  out := 0;
  var i := 0;
  while i < n
    decreases *
  {
    out := out + FixedMul(grid[i][i], grid[i][i]);
    i := i + 1;
  }
}

method MakeMatrix(seed: int, rows: int, cols: int) returns (a: array<array<int>>)
  decreases *
{
  a := new array<int>[rows];
  var i := 0;
  while i < rows
    decreases *
  {
    var row := new int[cols];
    var j := 0;
    while j < cols
      decreases *
    {
      row[j] := (AbsInt(seed + 7 + i * 5 + j * 11) * 1024) / 3 + (i * 1024) / 2 + (j * 1024) / 3;
      j := j + 1;
    }
    a[i] := row;
    i := i + 1;
  }
}

method Entry(seed: int) returns (digest: int)
  decreases *
{
  var rows := 4;
  var cols := 5;
  var a := MakeMatrix(seed, rows, cols);
  digest := DiagonalEnergy(a, rows, cols);
}

method {:main} Main()
  decreases *
{
  var acc := 0;
  var i := 0;
  while i < 4
    decreases *
  {
    var current := Entry(7);
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\n";
}
