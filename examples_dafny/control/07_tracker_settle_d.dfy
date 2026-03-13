// Generated from the JPL-- example corpus.
// Category: control
// Example: 07_tracker_settle_d


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

datatype Tracker = Tracker(pos: int, vel: int, target: int, gain: int)

method Step(state: Tracker) returns (out: Tracker)
  decreases *
{
  out := Tracker(
    FixedDiv(FixedMul(state.pos, state.gain) + state.target, state.gain + 1024),
    (state.vel + (state.target - state.pos) / 3) / 2,
    state.target,
    state.gain
  );
}

method Iterate(state: Tracker, steps: int) returns (out: Tracker)
  decreases *
{
  var next := Step(state);
  if steps <= 0 {
    out := state;
    return;
  }
  out := Iterate(next, steps - 1);
}

method Score(state: Tracker) returns (out: int)
  decreases *
{
  var settled := Iterate(state, 4);
  out := settled.pos + settled.vel / 4;
}

method MakeTracker(seed: int) returns (state: Tracker)
  decreases *
{
  state := Tracker(
    (AbsInt(seed + 5) * 1024) / 3,
    (AbsInt(seed + 9) * 1024) / 8,
    (AbsInt(seed + 27) * 1024) / 2,
    1024 + (AbsInt(seed + 3) * 1024) / 5
  );
}

method Entry(seed: int) returns (digest: int)
  decreases *
{
  var state := MakeTracker(seed);
  digest := Score(state);
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
