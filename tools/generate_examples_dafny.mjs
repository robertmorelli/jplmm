import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  controlNames,
  imageNames,
  matrixNames,
  showcaseNames,
  signalNames,
  sortNames,
  totalExampleCount,
} from './examples_catalog.mjs';

const root = process.cwd();
const outRoot = join(root, 'examples_dafny');
const SEED_BASE = 7;

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

function write(relPath, contents) {
  const full = join(outRoot, relPath);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, `${contents.trim()}\n`);
}

function iterationsForCategory(category) {
  switch (category) {
    case 'image':
      return 180;
    case 'matrix':
      return 4;
    case 'signal':
      return 3;
    case 'sort':
      return 250;
    case 'control':
      return 40;
    case 'showcase':
      return 120;
    default:
      return 64;
  }
}

function header(category, name, idx) {
  return `// Generated from the JPL-- example corpus.\n// Category: ${category}\n// Example: ${String(idx + 1).padStart(2, '0')}_${name}`;
}

function intHelpers() {
  return `
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
`;
}

function realHelpers() {
  return `
${intHelpers()}
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
`;
}

function imageExample(name, idx) {
  const edgeDiv = 2 + (idx % 4);
  const blurDiv = 3 + (idx % 5);
  const highlight = 8 + (idx % 7);
  const shadow = 6 + ((idx * 3) % 7);
  const tintR = 16 + idx * 3;
  const tintG = 8 + idx * 2;
  const tintB = 4 + idx;
  const iterations = iterationsForCategory('image');
  return `${header('image', name, idx)}

datatype Pixel = Pixel(r: int, g: int, b: int)
${intHelpers()}
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
    ClampInt(base.r + ex.r / ${edgeDiv} + ey.r / ${highlight} - blur.r / ${blurDiv} + ${tintR}, 0, 255),
    ClampInt(base.g + ex.g / ${highlight} + ey.g / ${edgeDiv} - blur.g / ${shadow} + ${tintG}, 0, 255),
    ClampInt(base.b + ex.b / ${shadow} + ey.b / ${highlight} - blur.b / ${blurDiv} + ${tintB}, 0, 255)
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
  while i < ${iterations}
    decreases *
  {
    var current := Entry(${SEED_BASE});
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\\n";
}`;
}

function matrixExample(name, idx) {
  const laplaceScale = (idx % 3) + 2;
  const gain = 2 + (idx % 4);
  const iterations = iterationsForCategory('matrix');
  return `${header('matrix', name, idx)}
${realHelpers()}
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
      row[j] := (up + down + left + right - a[i][j] * 4) / ${laplaceScale};
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
      row[j] := base[i][j] + smooth[i][j] / ${gain};
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
  while i < ${iterations}
    decreases *
  {
    var current := Entry(${SEED_BASE});
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\\n";
}`;
}

function signalExample(name, idx) {
  const w0 = (idx % 5) + 1;
  const w1 = ((idx + 2) % 5) + 1;
  const w2 = ((idx + 4) % 5) + 1;
  const denom = w0 + w1 + w2 + w1 + w0;
  const iterations = iterationsForCategory('signal');
  return `${header('signal', name, idx)}
${realHelpers()}
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
      signal[ClampInt(i - 2, 0, n - 1)] * ${w0} +
      signal[ClampInt(i - 1, 0, n - 1)] * ${w1} +
      signal[i] * ${w2} +
      signal[ClampInt(i + 1, 0, n - 1)] * ${w1} +
      signal[ClampInt(i + 2, 0, n - 1)] * ${w0}
    ) / ${denom};
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
    out[i] := SqrtApprox(AbsReal(FixedMul(shaped[i], shaped[i]) + pref[i] / ${idx + 3}));
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
  while i < ${iterations}
    decreases *
  {
    var current := Entry(${SEED_BASE});
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\\n";
}`;
}

function sort4Template() {
  return `
datatype Vec4 = Vec4(a: int, b: int, c: int, d: int)
${intHelpers()}
method Stage4A(v: Vec4) returns (out: Vec4)
  decreases *
{
  out := Vec4(MinInt(v.a, v.b), MaxInt(v.a, v.b), MinInt(v.c, v.d), MaxInt(v.c, v.d));
}

method Stage4B(v: Vec4) returns (out: Vec4)
  decreases *
{
  out := Vec4(MinInt(v.a, v.c), MinInt(v.b, v.d), MaxInt(v.a, v.c), MaxInt(v.b, v.d));
}

method Stage4C(v: Vec4) returns (out: Vec4)
  decreases *
{
  out := Vec4(v.a, MinInt(v.b, v.c), MaxInt(v.b, v.c), v.d);
}

method Sort4(v: Vec4) returns (out: Vec4)
  decreases *
{
  var a := Stage4A(v);
  var b := Stage4B(a);
  out := Stage4C(b);
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
      ClampInt(AbsInt(seed + 3 + i * 5), 0, 255),
      ClampInt(AbsInt(seed + 7 + i * 7), 0, 255),
      ClampInt(AbsInt(seed + 11 + i * 9), 0, 255),
      ClampInt(AbsInt(seed + 13 + i * 11), 0, 255)
    );
    i := i + 1;
  }
}
`;
}

function sort8Template() {
  return `
datatype Vec8 = Vec8(a: int, b: int, c: int, d: int, e: int, f: int, g: int, h: int)
${intHelpers()}
method Stage81(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(MinInt(v.a, v.b), MaxInt(v.a, v.b), MinInt(v.c, v.d), MaxInt(v.c, v.d), MinInt(v.e, v.f), MaxInt(v.e, v.f), MinInt(v.g, v.h), MaxInt(v.g, v.h));
}

method Stage82(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(MinInt(v.a, v.c), MinInt(v.b, v.d), MaxInt(v.a, v.c), MaxInt(v.b, v.d), MinInt(v.e, v.g), MinInt(v.f, v.h), MaxInt(v.e, v.g), MaxInt(v.f, v.h));
}

method Stage83(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(MinInt(v.a, v.e), MinInt(v.b, v.f), MinInt(v.c, v.g), MinInt(v.d, v.h), MaxInt(v.a, v.e), MaxInt(v.b, v.f), MaxInt(v.c, v.g), MaxInt(v.d, v.h));
}

method Stage84(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(v.a, MinInt(v.b, v.c), MaxInt(v.b, v.c), v.d, v.e, MinInt(v.f, v.g), MaxInt(v.f, v.g), v.h);
}

method Stage85(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(v.a, MinInt(v.b, v.e), MinInt(v.c, v.f), MinInt(v.d, v.g), MaxInt(v.b, v.e), MaxInt(v.c, v.f), MaxInt(v.d, v.g), v.h);
}

method Stage86(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(v.a, v.b, MinInt(v.c, v.e), MinInt(v.d, v.f), MaxInt(v.c, v.e), MaxInt(v.d, v.f), v.g, v.h);
}

method Stage87(v: Vec8) returns (out: Vec8)
  decreases *
{
  out := Vec8(v.a, v.b, v.c, MinInt(v.d, v.e), MaxInt(v.d, v.e), v.f, v.g, v.h);
}

method Sort8(v: Vec8) returns (out: Vec8)
  decreases *
{
  var s1 := Stage81(v);
  var s2 := Stage82(s1);
  var s3 := Stage83(s2);
  var s4 := Stage84(s3);
  var s5 := Stage85(s4);
  var s6 := Stage86(s5);
  out := Stage87(s6);
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
      ClampInt(AbsInt(seed + 3 + i * 3), 0, 255),
      ClampInt(AbsInt(seed + 5 + i * 5), 0, 255),
      ClampInt(AbsInt(seed + 7 + i * 7), 0, 255),
      ClampInt(AbsInt(seed + 9 + i * 9), 0, 255),
      ClampInt(AbsInt(seed + 11 + i * 11), 0, 255),
      ClampInt(AbsInt(seed + 13 + i * 13), 0, 255),
      ClampInt(AbsInt(seed + 15 + i * 15), 0, 255),
      ClampInt(AbsInt(seed + 17 + i * 17), 0, 255)
    );
    i := i + 1;
  }
}
`;
}

function sortExample(name, idx) {
  const iterations = iterationsForCategory('sort');
  if (idx % 2 === 0) {
    return `${header('sort', name, idx)}
${sort4Template()}
method Checksum(blocks: array<Vec4>, n: int) returns (out: int)
  decreases *
{
  out := 0;
  var i := 0;
  while i < n
    decreases *
  {
    var s := Sort4(blocks[i]);
    out := out + (s.b + s.c) / 2;
    i := i + 1;
  }
}

method Entry(seed: int) returns (digest: int)
  decreases *
{
  var n := 6;
  var blocks := MakeVec4Blocks(seed, n);
  digest := Checksum(blocks, n);
}

method {:main} Main()
  decreases *
{
  var acc := 0;
  var i := 0;
  while i < ${iterations}
    decreases *
  {
    var current := Entry(${SEED_BASE});
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\\n";
}`;
  }
  return `${header('sort', name, idx)}
${sort8Template()}
method Checksum(blocks: array<Vec8>, n: int) returns (out: int)
  decreases *
{
  out := 0;
  var i := 0;
  while i < n
    decreases *
  {
    var s := Sort8(blocks[i]);
    out := out + (s.d + s.e) / 2;
    i := i + 1;
  }
}

method Entry(seed: int) returns (digest: int)
  decreases *
{
  var n := 6;
  var blocks := MakeVec8Blocks(seed, n);
  digest := Checksum(blocks, n);
}

method {:main} Main()
  decreases *
{
  var acc := 0;
  var i := 0;
  while i < ${iterations}
    decreases *
  {
    var current := Entry(${SEED_BASE});
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\\n";
}`;
}

function controlExample(name, idx) {
  const iterations = iterationsForCategory('control');
  if (idx % 2 === 0) {
    const gas = 4 + (idx % 6);
    const gain = 2 + (idx % 5);
    return `${header('control', name, idx)}
${realHelpers()}
datatype Tracker = Tracker(pos: int, vel: int, target: int, gain: int)

method Step(state: Tracker) returns (out: Tracker)
  decreases *
{
  out := Tracker(
    FixedDiv(FixedMul(state.pos, state.gain) + state.target, state.gain + 1024),
    (state.vel + (state.target - state.pos) / ${gain}) / 2,
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
  var settled := Iterate(state, ${gas});
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
  while i < ${iterations}
    decreases *
  {
    var current := Entry(${SEED_BASE});
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\\n";
}`;
  }

  const gas = 3 + (idx % 5);
  const div = 3 + (idx % 4);
  return `${header('control', name, idx)}
${realHelpers()}
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
      ) / ${div};
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
  var settled := Relax(grid, h, w, ${gas});
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
  while i < ${iterations}
    decreases *
  {
    var current := Entry(${SEED_BASE});
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\\n";
}`;
}

function showcaseExample(name, idx) {
  const weight = 2 + (idx % 5);
  const iterations = iterationsForCategory('showcase');
  return `${header('showcase', name, idx)}

datatype Pixel = Pixel(r: int, g: int, b: int)
datatype Vec4 = Vec4(a: int, b: int, c: int, d: int)
${intHelpers()}
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
  out := (sorted.b + sorted.c + base / ${weight}) / 2;
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
  while i < ${iterations}
    decreases *
  {
    var current := Entry(${SEED_BASE});
    acc := acc + current;
    i := i + 1;
  }
  print acc, "\\n";
}`;
}

for (const [idx, name] of imageNames.entries()) {
  write(`image/${String(idx + 1).padStart(2, '0')}_${name}.dfy`, imageExample(name, idx));
}
for (const [idx, name] of matrixNames.entries()) {
  write(`matrix/${String(idx + 1).padStart(2, '0')}_${name}.dfy`, matrixExample(name, idx));
}
for (const [idx, name] of signalNames.entries()) {
  write(`signal/${String(idx + 1).padStart(2, '0')}_${name}.dfy`, signalExample(name, idx));
}
for (const [idx, name] of sortNames.entries()) {
  write(`sort/${String(idx + 1).padStart(2, '0')}_${name}.dfy`, sortExample(name, idx));
}
for (const [idx, name] of controlNames.entries()) {
  write(`control/${String(idx + 1).padStart(2, '0')}_${name}.dfy`, controlExample(name, idx));
}
for (const [idx, name] of showcaseNames.entries()) {
  write(`showcase/${String(idx + 1).padStart(2, '0')}_${name}.dfy`, showcaseExample(name, idx));
}

write('README.md', `
# JPL-- Matched Dafny Examples

This folder mirrors the generated JPL-- examples corpus with benchmarkable Dafny equivalents.

It currently contains ${totalExampleCount} generated files across these categories:

- image: ${imageNames.length}
- matrix: ${matrixNames.length}
- signal: ${signalNames.length}
- sort: ${sortNames.length}
- control: ${controlNames.length}
- showcase: ${showcaseNames.length}

Each file is standalone, contains a seeded entry workload, and a \`Main\` method that executes a small benchmark loop suitable for codegen/runtime comparison.

The float-heavy matrix, signal, and control families are emitted as fixed-point integer analogues so the generated Dafny code stays runnable and benchmarkable on the available backend.
`);

console.log(`generated ${totalExampleCount} Dafny examples in ${outRoot}`);
