import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  imageNames,
  showcaseNames,
  sortNames,
} from "./examples_catalog.mjs";

const root = process.cwd();
const outRoot = join(root, "examples_dafny_bv32");
const SEED_BASE = 7;
const totalComparableExampleCount = imageNames.length + sortNames.length + showcaseNames.length;

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

function write(relPath, contents) {
  const full = join(outRoot, relPath);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, `${contents.trim()}\n`);
}

function iterationsForCategory(category) {
  switch (category) {
    case "image":
      return 180;
    case "sort":
      return 250;
    case "showcase":
      return 120;
    default:
      return 64;
  }
}

function header(category, name, idx) {
  return `// Generated from the JPL-- example corpus.
// Category: ${category}
// Example: ${String(idx + 1).padStart(2, "0")}_${name}`;
}

function intHelpers() {
  return `
function AbsInt(x: int): int {
  if x < 0 then -x else x
}

function ClampInt(x: int, lo: int, hi: int): int {
  if x < lo then lo else if x > hi then hi else x
}
`;
}

function bv32Helpers() {
  return `
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
  const iterations = iterationsForCategory("image");
  return `${header("image", name, idx)}

datatype Pixel = Pixel(r: bv32, g: bv32, b: bv32)
${intHelpers()}
${bv32Helpers()}
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
    BlendChannel(base.r, ex.r, (${edgeDiv} as bv32), ey.r, (${highlight} as bv32), blur.r, (${blurDiv} as bv32), (${tintR} as bv32)),
    BlendChannel(base.g, ex.g, (${highlight} as bv32), ey.g, (${edgeDiv} as bv32), blur.g, (${shadow} as bv32), (${tintG} as bv32)),
    BlendChannel(base.b, ex.b, (${shadow} as bv32), ey.b, (${highlight} as bv32), blur.b, (${blurDiv} as bv32), (${tintB} as bv32))
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
datatype Vec4 = Vec4(a: bv32, b: bv32, c: bv32, d: bv32)
${intHelpers()}
${bv32Helpers()}
function Sort4(v: Vec4): Vec4 {
  var s1 := Vec4(Min32(v.a, v.b), Max32(v.a, v.b), Min32(v.c, v.d), Max32(v.c, v.d));
  var s2 := Vec4(Min32(s1.a, s1.c), Min32(s1.b, s1.d), Max32(s1.a, s1.c), Max32(s1.b, s1.d));
  Vec4(s2.a, Min32(s2.b, s2.c), Max32(s2.b, s2.c), s2.d)
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
      Clamp8FromInt(AbsInt(seed + 3 + i * 5)),
      Clamp8FromInt(AbsInt(seed + 7 + i * 7)),
      Clamp8FromInt(AbsInt(seed + 11 + i * 9)),
      Clamp8FromInt(AbsInt(seed + 13 + i * 11))
    );
    i := i + 1;
  }
}
`;
}

function sort8Template() {
  return `
datatype Vec8 = Vec8(a: bv32, b: bv32, c: bv32, d: bv32, e: bv32, f: bv32, g: bv32, h: bv32)
${intHelpers()}
${bv32Helpers()}
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
`;
}

function sortExample(name, idx) {
  const iterations = iterationsForCategory("sort");
  if (idx % 2 === 0) {
    return `${header("sort", name, idx)}
${sort4Template()}
method Checksum(blocks: array<Vec4>, n: int) returns (out: bv32)
  decreases *
{
  out := 0 as bv32;
  var i := 0;
  while i < n
    decreases *
  {
    var s := Sort4(blocks[i]);
    out := out + (s.b + s.c) / (2 as bv32);
    i := i + 1;
  }
}

method Entry(seed: int) returns (digest: bv32)
  decreases *
{
  var n := 6;
  var blocks := MakeVec4Blocks(seed, n);
  digest := Checksum(blocks, n);
}

method {:main} Main()
  decreases *
{
  var acc: bv32 := 0 as bv32;
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
  return `${header("sort", name, idx)}
${sort8Template()}
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
  const iterations = iterationsForCategory("showcase");
  return `${header("showcase", name, idx)}

datatype Pixel = Pixel(r: bv32, g: bv32, b: bv32)
datatype Vec4 = Vec4(a: bv32, b: bv32, c: bv32, d: bv32)
${intHelpers()}
${bv32Helpers()}
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
  out := (sorted.b + sorted.c + base / (${weight} as bv32)) / (2 as bv32);
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
  write(`image/${String(idx + 1).padStart(2, "0")}_${name}.dfy`, imageExample(name, idx));
}
for (const [idx, name] of sortNames.entries()) {
  write(`sort/${String(idx + 1).padStart(2, "0")}_${name}.dfy`, sortExample(name, idx));
}
for (const [idx, name] of showcaseNames.entries()) {
  write(`showcase/${String(idx + 1).padStart(2, "0")}_${name}.dfy`, showcaseExample(name, idx));
}

write("README.md", `
# JPL-- More Comparable Dafny Examples

This folder contains ${totalComparableExampleCount} generated Dafny examples for the exact integer-heavy JPL-- families.

Categories included:

- image: ${imageNames.length}
- sort: ${sortNames.length}
- showcase: ${showcaseNames.length}

These files use Dafny \`bv32\` values so the generated Go backend lowers hot arithmetic to native \`uint32\` operations.

The goal is a more comparable codegen benchmark than the broader fixed-point analogue corpus.
`);

console.log(`generated ${totalComparableExampleCount} comparable Dafny examples in ${outRoot}`);
