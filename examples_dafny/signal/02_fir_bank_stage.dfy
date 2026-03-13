// Generated from the JPL-- example corpus.
// Category: signal
// Example: 02_fir_bank_stage


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

method Moving3(signal: array<int>, n: int) returns (out: array<int>)
  decreases *
{
  out := new int[n];
  var i := 0;
  while i < n
    decreases *
  {
    out[i] := (signal[ClampInt(i - 1, 0, n - 1)] + signal[i] + signal[ClampInt(i + 1, 0, n - 1)]) / 3;
    i := i + 1;
  }
}

method Fir5(signal: array<int>, n: int) returns (out: array<int>)
  decreases *
{
  out := new int[n];
  var i := 0;
  while i < n
    decreases *
  {
    out[i] := (
      signal[ClampInt(i - 2, 0, n - 1)] * 2 +
      signal[ClampInt(i - 1, 0, n - 1)] * 4 +
      signal[i] * 1 +
      signal[ClampInt(i + 1, 0, n - 1)] * 4 +
      signal[ClampInt(i + 2, 0, n - 1)] * 2
    ) / 13;
    i := i + 1;
  }
}

method Derivative(signal: array<int>, n: int) returns (out: array<int>)
  decreases *
{
  out := new int[n];
  var i := 0;
  while i < n
    decreases *
  {
    out[i] := (signal[ClampInt(i + 1, 0, n - 1)] - signal[ClampInt(i - 1, 0, n - 1)]) / 2;
    i := i + 1;
  }
}

method Modulate(signal: array<int>, n: int) returns (out: array<int>)
  decreases *
{
  var deriv := Derivative(signal, n);
  out := new int[n];
  var i := 0;
  while i < n
    decreases *
  {
    var s := SinApprox(signal[i]);
    var c := CosApprox(signal[i] / 2);
    out[i] := s + c + deriv[i] / 4;
    i := i + 1;
  }
}

method Prefix(signal: array<int>, n: int) returns (out: array<int>)
  decreases *
{
  out := new int[n];
  var acc := 0;
  var i := 0;
  while i < n
    decreases *
  {
    acc := acc + signal[i];
    out[i] := acc;
    i := i + 1;
  }
}

method Envelope(signal: array<int>, n: int) returns (out: array<int>)
  decreases *
{
  var moved := Moving3(signal, n);
  var filtered := Fir5(moved, n);
  var shaped := Modulate(filtered, n);
  var pref := Prefix(shaped, n);
  out := new int[n];
  var i := 0;
  while i < n
    decreases *
  {
    out[i] := SqrtApprox(AbsReal(FixedMul(shaped[i], shaped[i]) + pref[i] / 4));
    i := i + 1;
  }
}

method Pipeline(signal: array<int>, n: int) returns (out: array<int>)
  decreases *
{
  var env := Envelope(signal, n);
  out := Prefix(env, n);
}

method TotalEnergy(signal: array<int>, n: int) returns (out: int)
  decreases *
{
  var values := Pipeline(signal, n);
  out := 0;
  var i := 0;
  while i < n
    decreases *
  {
    out := out + FixedMul(values[i], values[i]);
    i := i + 1;
  }
}

method MakeSignal(seed: int, n: int) returns (signal: array<int>)
  decreases *
{
  signal := new int[n];
  var i := 0;
  while i < n
    decreases *
  {
    signal[i] := (AbsInt(seed + 11 + i * 7) * 1024) / 3 + (i * 1024) / 2;
    i := i + 1;
  }
}

method Entry(seed: int) returns (digest: int)
  decreases *
{
  var n := 6;
  var signal := MakeSignal(seed, n);
  digest := TotalEnergy(signal, n);
}

method {:main} Main()
  decreases *
{
  var acc := 0;
  var i := 0;
  while i < 3
    decreases *
  {
    var current := Entry(7);
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\n";
}
