import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const outRoot = join(root, 'examples');

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

function write(relPath, contents) {
  const full = join(outRoot, relPath);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, `${contents.trim()}\n`);
}

function imageExample(name, idx) {
  const edgeDiv = 2 + (idx % 4);
  const blurDiv = 3 + (idx % 5);
  const highlight = 8 + (idx % 7);
  const shadow = 6 + ((idx * 3) % 7);
  const tintR = 16 + idx * 3;
  const tintG = 8 + idx * 2;
  const tintB = 4 + idx;
  return `
struct Pixel { r:int, g:int, b:int }

fn clamp8(x:int): int {
  ret clamp(x, 0, 255);
}

fn mk(r:int, g:int, b:int): Pixel {
  ret Pixel { clamp8(r), clamp8(g), clamp8(b) };
}

fn sample(img:Pixel[][], h:int, w:int, y:int, x:int): Pixel {
  ret img[clamp(y, 0, h - 1)][clamp(x, 0, w - 1)];
}

fn blur_px(img:Pixel[][], h:int, w:int, y:int, x:int): Pixel {
  ret mk(
    (sample(img, h, w, y - 1, x - 1).r + sample(img, h, w, y - 1, x).r + sample(img, h, w, y - 1, x + 1).r + sample(img, h, w, y, x - 1).r + sample(img, h, w, y, x).r + sample(img, h, w, y, x + 1).r + sample(img, h, w, y + 1, x - 1).r + sample(img, h, w, y + 1, x).r + sample(img, h, w, y + 1, x + 1).r) / 9,
    (sample(img, h, w, y - 1, x - 1).g + sample(img, h, w, y - 1, x).g + sample(img, h, w, y - 1, x + 1).g + sample(img, h, w, y, x - 1).g + sample(img, h, w, y, x).g + sample(img, h, w, y, x + 1).g + sample(img, h, w, y + 1, x - 1).g + sample(img, h, w, y + 1, x).g + sample(img, h, w, y + 1, x + 1).g) / 9,
    (sample(img, h, w, y - 1, x - 1).b + sample(img, h, w, y - 1, x).b + sample(img, h, w, y - 1, x + 1).b + sample(img, h, w, y, x - 1).b + sample(img, h, w, y, x).b + sample(img, h, w, y, x + 1).b + sample(img, h, w, y + 1, x - 1).b + sample(img, h, w, y + 1, x).b + sample(img, h, w, y + 1, x + 1).b) / 9
  );
}

fn edge_x(img:Pixel[][], h:int, w:int, y:int, x:int): Pixel {
  ret mk(
    abs(sample(img, h, w, y, x + 1).r - sample(img, h, w, y, x - 1).r),
    abs(sample(img, h, w, y, x + 1).g - sample(img, h, w, y, x - 1).g),
    abs(sample(img, h, w, y, x + 1).b - sample(img, h, w, y, x - 1).b)
  );
}

fn edge_y(img:Pixel[][], h:int, w:int, y:int, x:int): Pixel {
  ret mk(
    abs(sample(img, h, w, y + 1, x).r - sample(img, h, w, y - 1, x).r),
    abs(sample(img, h, w, y + 1, x).g - sample(img, h, w, y - 1, x).g),
    abs(sample(img, h, w, y + 1, x).b - sample(img, h, w, y - 1, x).b)
  );
}

fn accent_px(img:Pixel[][], h:int, w:int, y:int, x:int): Pixel {
  let base = sample(img, h, w, y, x);
  let blur = blur_px(img, h, w, y, x);
  let ex = edge_x(img, h, w, y, x);
  let ey = edge_y(img, h, w, y, x);
  ret mk(
    base.r + ex.r / ${edgeDiv} + ey.r / ${highlight} - blur.r / ${blurDiv} + ${tintR},
    base.g + ex.g / ${highlight} + ey.g / ${edgeDiv} - blur.g / ${shadow} + ${tintG},
    base.b + ex.b / ${shadow} + ey.b / ${highlight} - blur.b / ${blurDiv} + ${tintB}
  );
}

fn stage_a(img:Pixel[][], h:int, w:int): Pixel[][] {
  ret array [y:h, x:w] accent_px(img, h, w, y, x);
}

fn stage_b(img:Pixel[][], h:int, w:int): Pixel[][] {
  ret array [y:h, x:w] mk(
    (stage_a(img, h, w)[y][x].r + blur_px(img, h, w, y, x).r) / 2,
    (stage_a(img, h, w)[y][x].g + edge_x(img, h, w, y, x).g) / 2,
    (stage_a(img, h, w)[y][x].b + edge_y(img, h, w, y, x).b) / 2
  );
}

fn pipeline(img:Pixel[][], h:int, w:int): Pixel[][] {
  ret stage_b(img, h, w);
}

fn row_energy(img:Pixel[][], h:int, w:int): int[] {
  let out = pipeline(img, h, w);
  ret array [y:h] sum [x:w] (out[y][x].r + out[y][x].g + out[y][x].b) / 3;
}

fn column_energy(img:Pixel[][], h:int, w:int): int[] {
  let out = pipeline(img, h, w);
  ret array [x:w] sum [y:h] (out[y][x].r + out[y][x].g + out[y][x].b) / 3;
}
`;
}

function matrixExample(name, idx) {
  const laplaceScale = (idx % 3) + 2;
  const gain = 2 + (idx % 4);
  return `
fn dot_row(a:float[][], b:float[][], row:int, col:int, shared:int): float {
  ret sum [k:shared] a[row][k] * b[k][col];
}

fn transpose(a:float[][], rows:int, cols:int): float[][] {
  ret array [j:cols, i:rows] a[i][j];
}

fn matmul(a:float[][], b:float[][], rows:int, cols:int, shared:int): float[][] {
  ret array [i:rows, j:cols] dot_row(a, b, i, j, shared);
}

fn laplace(a:float[][], rows:int, cols:int): float[][] {
  ret array [i:rows, j:cols]
    (a[clamp(i - 1, 0, rows - 1)][j] + a[clamp(i + 1, 0, rows - 1)][j] + a[i][clamp(j - 1, 0, cols - 1)] + a[i][clamp(j + 1, 0, cols - 1)] - a[i][j] * 4.0) / ${laplaceScale}.0;
}

fn row_norm(a:float[][], row:int, cols:int): float {
  ret sqrt(sum [k:cols] a[row][k] * a[row][k]);
}

fn normalize(a:float[][], rows:int, cols:int): float[][] {
  ret array [i:rows, j:cols] a[i][j] / max(1.0, row_norm(a, i, cols));
}

fn enrich(a:float[][], rows:int, cols:int): float[][] {
  let base = normalize(a, rows, cols);
  let smooth = laplace(base, rows, cols);
  ret array [i:rows, j:cols] base[i][j] + smooth[i][j] / ${gain}.0;
}

fn pipeline(a:float[][], rows:int, cols:int): float[][] {
  let t = transpose(enrich(a, rows, cols), rows, cols);
  let g = matmul(t, a, cols, cols, rows);
  ret normalize(g, cols, cols);
}

fn diagonal_energy(a:float[][], rows:int, cols:int): float {
  let out = pipeline(a, rows, cols);
  ret sum [i:min(rows, cols)] out[i][i] * out[i][i];
}
`;
}

function signalExample(name, idx) {
  const w0 = (idx % 5) + 1;
  const w1 = ((idx + 2) % 5) + 1;
  const w2 = ((idx + 4) % 5) + 1;
  return `
fn moving3(signal:float[], n:int): float[] {
  ret array [i:n]
    (signal[clamp(i - 1, 0, n - 1)] + signal[i] + signal[clamp(i + 1, 0, n - 1)]) / 3.0;
}

fn fir5(signal:float[], n:int): float[] {
  ret array [i:n]
    (signal[clamp(i - 2, 0, n - 1)] * ${w0}.0 + signal[clamp(i - 1, 0, n - 1)] * ${w1}.0 + signal[i] * ${w2}.0 + signal[clamp(i + 1, 0, n - 1)] * ${w1}.0 + signal[clamp(i + 2, 0, n - 1)] * ${w0}.0) / ${(w0 + w1 + w2 + w1 + w0).toFixed(1)};
}

fn derivative(signal:float[], n:int): float[] {
  ret array [i:n] (signal[clamp(i + 1, 0, n - 1)] - signal[clamp(i - 1, 0, n - 1)]) / 2.0;
}

fn modulate(signal:float[], n:int): float[] {
  ret array [i:n] sin(signal[i]) + cos(signal[i] / 2.0) + derivative(signal, n)[i] / 4.0;
}

fn prefix(signal:float[], n:int): float[] {
  ret array [i:n] sum [j:i + 1] signal[j];
}

fn envelope(signal:float[], n:int): float[] {
  let shaped = modulate(fir5(moving3(signal, n), n), n);
  ret array [i:n] sqrt(abs(shaped[i] * shaped[i] + prefix(shaped, n)[i] / ${idx + 3}.0));
}

fn pipeline(signal:float[], n:int): float[] {
  ret prefix(envelope(signal, n), n);
}

fn total_energy(signal:float[], n:int): float {
  let out = pipeline(signal, n);
  ret sum [i:n] out[i] * out[i];
}
`;
}

function sort4Template(blockLabel) {
  return `
struct Vec4 { a:int, b:int, c:int, d:int }

fn pack4(a:int, b:int, c:int, d:int): Vec4 {
  ret Vec4 { a, b, c, d };
}

fn stage4_a(v:Vec4): Vec4 {
  ret pack4(min(v.a, v.b), max(v.a, v.b), min(v.c, v.d), max(v.c, v.d));
}

fn stage4_b(v:Vec4): Vec4 {
  ret pack4(min(v.a, v.c), min(v.b, v.d), max(v.a, v.c), max(v.b, v.d));
}

fn stage4_c(v:Vec4): Vec4 {
  ret pack4(v.a, min(v.b, v.c), max(v.b, v.c), v.d);
}

fn sort4(v:Vec4): Vec4 {
  let a = stage4_a(v);
  let b = stage4_b(a);
  ret stage4_c(b);
}

fn sort_${blockLabel}(blocks:Vec4[], n:int): Vec4[] {
  ret array [i:n] sort4(blocks[i]);
}

fn middle_${blockLabel}(blocks:Vec4[], n:int): int[] {
  let out = sort_${blockLabel}(blocks, n);
  ret array [i:n] (out[i].b + out[i].c) / 2;
}
`;
}

function sort8Template(blockLabel) {
  return `
struct Vec8 { a:int, b:int, c:int, d:int, e:int, f:int, g:int, h:int }

fn pack8(a:int, b:int, c:int, d:int, e:int, f:int, g:int, h:int): Vec8 {
  ret Vec8 { a, b, c, d, e, f, g, h };
}

fn stage8_1(v:Vec8): Vec8 {
  ret pack8(min(v.a, v.b), max(v.a, v.b), min(v.c, v.d), max(v.c, v.d), min(v.e, v.f), max(v.e, v.f), min(v.g, v.h), max(v.g, v.h));
}

fn stage8_2(v:Vec8): Vec8 {
  ret pack8(min(v.a, v.c), min(v.b, v.d), max(v.a, v.c), max(v.b, v.d), min(v.e, v.g), min(v.f, v.h), max(v.e, v.g), max(v.f, v.h));
}

fn stage8_3(v:Vec8): Vec8 {
  ret pack8(min(v.a, v.e), min(v.b, v.f), min(v.c, v.g), min(v.d, v.h), max(v.a, v.e), max(v.b, v.f), max(v.c, v.g), max(v.d, v.h));
}

fn stage8_4(v:Vec8): Vec8 {
  ret pack8(v.a, min(v.b, v.c), max(v.b, v.c), v.d, v.e, min(v.f, v.g), max(v.f, v.g), v.h);
}

fn stage8_5(v:Vec8): Vec8 {
  ret pack8(v.a, min(v.b, v.e), min(v.c, v.f), min(v.d, v.g), max(v.b, v.e), max(v.c, v.f), max(v.d, v.g), v.h);
}

fn stage8_6(v:Vec8): Vec8 {
  ret pack8(v.a, v.b, min(v.c, v.e), min(v.d, v.f), max(v.c, v.e), max(v.d, v.f), v.g, v.h);
}

fn stage8_7(v:Vec8): Vec8 {
  ret pack8(v.a, v.b, v.c, min(v.d, v.e), max(v.d, v.e), v.f, v.g, v.h);
}

fn sort8(v:Vec8): Vec8 {
  let s1 = stage8_1(v);
  let s2 = stage8_2(s1);
  let s3 = stage8_3(s2);
  let s4 = stage8_4(s3);
  let s5 = stage8_5(s4);
  let s6 = stage8_6(s5);
  ret stage8_7(s6);
}

fn sort_${blockLabel}(blocks:Vec8[], n:int): Vec8[] {
  ret array [i:n] sort8(blocks[i]);
}

fn middle_${blockLabel}(blocks:Vec8[], n:int): int[] {
  let out = sort_${blockLabel}(blocks, n);
  ret array [i:n] (out[i].d + out[i].e) / 2;
}
`;
}

function sortExample(name, idx) {
  if (idx % 2 === 0) {
    return `${sort4Template(name.replace(/[^a-z0-9]+/gi, '_').toLowerCase())}
fn checksum(blocks:Vec4[], n:int): int {
  let mids = middle_${name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}(blocks, n);
  ret sum [i:n] mids[i];
}
`;
  }
  return `${sort8Template(name.replace(/[^a-z0-9]+/gi, '_').toLowerCase())}
fn checksum(blocks:Vec8[], n:int): int {
  let mids = middle_${name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}(blocks, n);
  ret sum [i:n] mids[i];
}
`;
}

function controlExample(name, idx) {
  if (idx % 2 === 0) {
    const gas = 4 + (idx % 6);
    const gain = 2 + (idx % 5);
    return `
struct Tracker { pos:float, vel:float, target:float, gain:float }

fn step(state:Tracker): Tracker {
  ret Tracker {
    (state.pos * state.gain + state.target) / (state.gain + 1.0),
    (state.vel + (state.target - state.pos) / ${gain}.0) / 2.0,
    state.target,
    state.gain
  };
}

fn iterate(state:Tracker): Tracker {
  ret state;
  ret rec(step(state));
  gas ${gas};
}

fn score(state:Tracker): float {
  let out = iterate(state);
  ret out.pos + out.vel / 4.0;
}
`;
  }
  const gas = 3 + (idx % 5);
  const div = 3 + (idx % 4);
  return `
fn smooth(grid:float[][], h:int, w:int): float[][] {
  ret array [y:h, x:w]
    (grid[y][x] + grid[clamp(y - 1, 0, h - 1)][x] + grid[clamp(y + 1, 0, h - 1)][x] + grid[y][clamp(x - 1, 0, w - 1)] + grid[y][clamp(x + 1, 0, w - 1)]) / ${div}.0;
}

fn relax(grid:float[][], h:int, w:int): float[][] {
  ret grid;
  ret rec(smooth(grid, h, w), h, w);
  gas ${gas};
}

fn metric(grid:float[][], h:int, w:int): float {
  let out = relax(grid, h, w);
  ret sum [y:h, x:w] out[y][x];
}
`;
}

function showcaseExample(name, idx) {
  const weight = 2 + (idx % 5);
  return `
struct Pixel { r:int, g:int, b:int }
struct Vec4 { a:int, b:int, c:int, d:int }

fn clamp8(x:int): int {
  ret clamp(x, 0, 255);
}

fn mk(r:int, g:int, b:int): Pixel {
  ret Pixel { clamp8(r), clamp8(g), clamp8(b) };
}

fn luma(p:Pixel): int {
  ret (p.r * 3 + p.g * 4 + p.b) / 8;
}

fn sample(img:Pixel[][], h:int, w:int, y:int, x:int): Pixel {
  ret img[clamp(y, 0, h - 1)][clamp(x, 0, w - 1)];
}

fn block4(img:Pixel[][], h:int, w:int, y:int, x:int): Vec4 {
  ret Vec4 {
    luma(sample(img, h, w, y, x)),
    luma(sample(img, h, w, y, x + 1)),
    luma(sample(img, h, w, y + 1, x)),
    luma(sample(img, h, w, y + 1, x + 1))
  };
}

fn pack4(a:int, b:int, c:int, d:int): Vec4 {
  ret Vec4 { a, b, c, d };
}

fn stage1(v:Vec4): Vec4 {
  ret pack4(min(v.a, v.b), max(v.a, v.b), min(v.c, v.d), max(v.c, v.d));
}

fn stage2(v:Vec4): Vec4 {
  ret pack4(min(v.a, v.c), min(v.b, v.d), max(v.a, v.c), max(v.b, v.d));
}

fn stage3(v:Vec4): Vec4 {
  ret pack4(v.a, min(v.b, v.c), max(v.b, v.c), v.d);
}

fn sort4(v:Vec4): Vec4 {
  let s1 = stage1(v);
  let s2 = stage2(s1);
  ret stage3(s2);
}

fn block_metric(img:Pixel[][], h:int, w:int, y:int, x:int): int {
  let s = sort4(block4(img, h, w, y, x));
  ret (s.b + s.c + luma(sample(img, h, w, y, x)) / ${weight}) / 2;
}

fn metric_grid(img:Pixel[][], h:int, w:int): int[][] {
  ret array [by:h, bx:w] block_metric(img, h, w, by * 2, bx * 2);
}

fn row_profile(img:Pixel[][], h:int, w:int): int[] {
  let metrics = metric_grid(img, h, w);
  ret array [y:h] sum [x:w] metrics[y][x];
}
`;
}

const imageNames = [
  'box_blur_energy', 'edge_emboss_tonemap', 'luma_gradient_mix', 'color_lift_stack', 'detail_boost_grid', 'highlight_balance_pass', 'channel_push_field', 'edge_heatmap_builder', 'soft_focus_pipeline', 'contrast_ramp_blend', 'spectral_tint_pass', 'embossed_luma_stack', 'motion_hint_filter', 'vivid_mix_painter', 'row_energy_sampler', 'column_energy_sampler', 'stylized_screen_pass', 'sharpened_edge_stack', 'cinematic_grade_pass', 'halo_reducer_pass', 'detail_smoother_pass', 'pixel_fusion_pass', 'color_balance_stack', 'microcontrast_stage'
];

const matrixNames = [
  'gram_pipeline', 'covariance_lift', 'laplace_smoother', 'energy_normalizer', 'feature_correlation', 'channel_projection', 'spectral_spread', 'block_affine_stack', 'matrix_diffusion', 'orthogonalizer', 'transpose_product', 'ridge_like_stack', 'row_whitener', 'kernel_projector', 'harmonic_matrix_pass', 'metric_tensor_stage', 'response_matrix_stack', 'regularized_gram', 'low_rank_hint', 'residual_mixer'
];

const signalNames = [
  'prefix_envelope', 'fir_bank_stage', 'carrier_modulator', 'sine_lift_stack', 'energy_tracker', 'phase_envelope', 'resonant_prefix', 'wave_shaper', 'soft_band_stack', 'spectral_hint', 'windowed_motion', 'pulse_smoother', 'ridge_detector', 'derivative_envelope', 'harmonic_bank', 'integrated_signal', 'cascaded_fir', 'cyclic_lifter', 'dense_modulator', 'wave_energy_field'
];

const sortNames = [
  'median_block_stack', 'row_sort_network', 'column_rank_pass', 'tile_median_builder', 'histogram_hint_sort', 'ranked_window_pass', 'top_band_stack', 'quartile_block_sort', 'edge_bucket_sort', 'median_profile_stack', 'window_rank_energy', 'neighbor_band_sort', 'median_trace_pass', 'block_order_stack', 'ranked_tile_stage', 'adaptive_sort_pass', 'contrast_bucket_sort', 'midband_sort_stage', 'ordered_block_field', 'tile_quantile_stack'
];

const controlNames = [
  'tracker_settle_a', 'grid_relax_a', 'tracker_settle_b', 'grid_relax_b', 'tracker_settle_c', 'grid_relax_c', 'tracker_settle_d', 'grid_relax_d', 'tracker_settle_e', 'grid_relax_e', 'tracker_settle_f', 'grid_relax_f', 'tracker_settle_g', 'grid_relax_g', 'tracker_settle_h', 'grid_relax_h'
];

const showcaseNames = [
  'vision_block_metrics', 'stylized_block_profile', 'ranked_luma_tiles', 'sorted_detail_profile', 'metric_screen_builder', 'feature_tile_ranker', 'block_energy_mosaic', 'sorted_pixel_signature', 'luma_band_ranker', 'screen_profile_field', 'detail_metric_tiles', 'profiled_block_stack'
];

let count = 0;

for (const [idx, name] of imageNames.entries()) {
  write(`image/${String(idx + 1).padStart(2, '0')}_${name}.jplmm`, imageExample(name, idx));
  count += 1;
}
for (const [idx, name] of matrixNames.entries()) {
  write(`matrix/${String(idx + 1).padStart(2, '0')}_${name}.jplmm`, matrixExample(name, idx));
  count += 1;
}
for (const [idx, name] of signalNames.entries()) {
  write(`signal/${String(idx + 1).padStart(2, '0')}_${name}.jplmm`, signalExample(name, idx));
  count += 1;
}
for (const [idx, name] of sortNames.entries()) {
  write(`sort/${String(idx + 1).padStart(2, '0')}_${name}.jplmm`, sortExample(name, idx));
  count += 1;
}
for (const [idx, name] of controlNames.entries()) {
  write(`control/${String(idx + 1).padStart(2, '0')}_${name}.jplmm`, controlExample(name, idx));
  count += 1;
}
for (const [idx, name] of showcaseNames.entries()) {
  write(`showcase/${String(idx + 1).padStart(2, '0')}_${name}.jplmm`, showcaseExample(name, idx));
  count += 1;
}

write('README.md', `
# JPL-- Examples

This folder is a big extension/demo corpus for JPL--.

It currently contains ${count} examples across these categories:

- image: ${imageNames.length}
- matrix: ${matrixNames.length}
- signal: ${signalNames.length}
- sort: ${sortNames.length}
- control: ${controlNames.length}
- showcase: ${showcaseNames.length}

The goal here is breadth and texture for the editor experience: large array programs, structs, comprehensions, fixed-size sorting networks, recursive control kernels, and mixed showcase programs.
`);

console.log(`generated ${count} examples in ${outRoot}`);
