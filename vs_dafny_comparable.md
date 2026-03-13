# JPL-- vs Dafny (More Comparable Bv32 Corpus)

Generated at: 2026-03-13T05:22:35.814Z
Examples benchmarked: 56
Available Dafny targets: go
Value-match note: every reported row was checked for exact equality between Dafny's looped benchmark digest and the corresponding repeated JPL result.
Dafny codegen note: this corpus uses `bv32` values so Dafny Go lowers hot scalar arithmetic to `uint32` instead of `_dafny.Int`.
Residual difference note: Dafny arrays still lower through `_dafny.Array` and loop counters still use `_dafny.Int`.
Timing note: JPL native and Dafny both include one process launch per benchmark case; JPL wasm runs in-process.

## Summary

- JPL native faster than Dafny in 56/56 cases
- JPL wasm faster than Dafny in 56/56 cases
- JPL wasm: 29 fastest finishes
- JPL native arm64: 27 fastest finishes

## Results

| Example | Category | Iterations | JPL Wasm (ms) | JPL Native (ms) | Dafny Target | Dafny (ms) | Fastest | Native vs Dafny | Wasm vs Dafny |
| --- | --- | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: |
| image/01_box_blur_energy.jplmm | image | 180 | 176.607 | 144.095 | go | 300.722 | JPL native arm64 | 2.087x | 1.703x |
| image/02_edge_emboss_tonemap.jplmm | image | 180 | 171.418 | 137.730 | go | 338.952 | JPL native arm64 | 2.461x | 1.977x |
| image/03_luma_gradient_mix.jplmm | image | 180 | 170.145 | 136.158 | go | 295.617 | JPL native arm64 | 2.171x | 1.737x |
| image/04_color_lift_stack.jplmm | image | 180 | 169.862 | 135.945 | go | 301.444 | JPL native arm64 | 2.217x | 1.775x |
| image/05_detail_boost_grid.jplmm | image | 180 | 170.276 | 133.853 | go | 290.917 | JPL native arm64 | 2.173x | 1.709x |
| image/06_highlight_balance_pass.jplmm | image | 180 | 179.628 | 133.632 | go | 306.563 | JPL native arm64 | 2.294x | 1.707x |
| image/07_channel_push_field.jplmm | image | 180 | 191.221 | 142.281 | go | 300.717 | JPL native arm64 | 2.114x | 1.573x |
| image/08_edge_heatmap_builder.jplmm | image | 180 | 169.991 | 142.514 | go | 294.303 | JPL native arm64 | 2.065x | 1.731x |
| image/09_soft_focus_pipeline.jplmm | image | 180 | 180.546 | 141.030 | go | 318.948 | JPL native arm64 | 2.262x | 1.767x |
| image/10_contrast_ramp_blend.jplmm | image | 180 | 183.943 | 144.831 | go | 328.074 | JPL native arm64 | 2.265x | 1.784x |
| image/11_spectral_tint_pass.jplmm | image | 180 | 170.708 | 138.375 | go | 295.359 | JPL native arm64 | 2.134x | 1.730x |
| image/12_embossed_luma_stack.jplmm | image | 180 | 168.859 | 134.402 | go | 302.516 | JPL native arm64 | 2.251x | 1.792x |
| image/13_motion_hint_filter.jplmm | image | 180 | 189.757 | 178.976 | go | 298.634 | JPL native arm64 | 1.669x | 1.574x |
| image/14_vivid_mix_painter.jplmm | image | 180 | 173.776 | 136.547 | go | 297.000 | JPL native arm64 | 2.175x | 1.709x |
| image/15_row_energy_sampler.jplmm | image | 180 | 170.883 | 133.823 | go | 306.878 | JPL native arm64 | 2.293x | 1.796x |
| image/16_column_energy_sampler.jplmm | image | 180 | 170.275 | 133.949 | go | 388.100 | JPL native arm64 | 2.897x | 2.279x |
| image/17_stylized_screen_pass.jplmm | image | 180 | 171.986 | 134.455 | go | 295.475 | JPL native arm64 | 2.198x | 1.718x |
| image/18_sharpened_edge_stack.jplmm | image | 180 | 172.363 | 137.491 | go | 303.452 | JPL native arm64 | 2.207x | 1.761x |
| image/19_cinematic_grade_pass.jplmm | image | 180 | 183.787 | 133.365 | go | 295.968 | JPL native arm64 | 2.219x | 1.610x |
| image/20_halo_reducer_pass.jplmm | image | 180 | 164.785 | 132.302 | go | 286.066 | JPL native arm64 | 2.162x | 1.736x |
| image/21_detail_smoother_pass.jplmm | image | 180 | 171.796 | 137.921 | go | 296.692 | JPL native arm64 | 2.151x | 1.727x |
| image/22_pixel_fusion_pass.jplmm | image | 180 | 174.640 | 136.930 | go | 308.248 | JPL native arm64 | 2.251x | 1.765x |
| image/23_color_balance_stack.jplmm | image | 180 | 224.356 | 140.764 | go | 300.397 | JPL native arm64 | 2.134x | 1.339x |
| image/24_microcontrast_stage.jplmm | image | 180 | 177.785 | 138.009 | go | 298.467 | JPL native arm64 | 2.163x | 1.679x |
| showcase/01_vision_block_metrics.jplmm | showcase | 120 | 4.005 | 3.808 | go | 289.757 | JPL native arm64 | 76.099x | 72.342x |
| showcase/02_stylized_block_profile.jplmm | showcase | 120 | 3.974 | 4.025 | go | 288.353 | JPL wasm | 71.637x | 72.568x |
| showcase/03_ranked_luma_tiles.jplmm | showcase | 120 | 5.108 | 4.419 | go | 314.090 | JPL native arm64 | 71.070x | 61.488x |
| showcase/04_sorted_detail_profile.jplmm | showcase | 120 | 5.187 | 4.375 | go | 291.792 | JPL native arm64 | 66.688x | 56.256x |
| showcase/05_metric_screen_builder.jplmm | showcase | 120 | 4.910 | 5.160 | go | 296.513 | JPL wasm | 57.461x | 60.391x |
| showcase/06_feature_tile_ranker.jplmm | showcase | 120 | 1.181 | 4.298 | go | 293.972 | JPL wasm | 68.394x | 249.015x |
| showcase/07_block_energy_mosaic.jplmm | showcase | 120 | 2.216 | 4.299 | go | 306.961 | JPL wasm | 71.410x | 138.546x |
| showcase/08_sorted_pixel_signature.jplmm | showcase | 120 | 1.184 | 3.979 | go | 300.115 | JPL wasm | 75.423x | 253.520x |
| showcase/09_luma_band_ranker.jplmm | showcase | 120 | 1.250 | 4.030 | go | 296.441 | JPL wasm | 73.551x | 237.224x |
| showcase/10_screen_profile_field.jplmm | showcase | 120 | 1.246 | 3.723 | go | 301.998 | JPL wasm | 81.113x | 242.374x |
| showcase/11_detail_metric_tiles.jplmm | showcase | 120 | 0.834 | 4.040 | go | 305.497 | JPL wasm | 75.610x | 366.138x |
| showcase/12_profiled_block_stack.jplmm | showcase | 120 | 0.840 | 4.228 | go | 286.149 | JPL wasm | 67.684x | 340.839x |
| sort/01_median_block_stack.jplmm | sort | 250 | 0.843 | 3.689 | go | 290.940 | JPL wasm | 78.865x | 345.142x |
| sort/02_row_sort_network.jplmm | sort | 250 | 1.677 | 3.927 | go | 287.321 | JPL wasm | 73.174x | 171.283x |
| sort/03_column_rank_pass.jplmm | sort | 250 | 1.111 | 3.692 | go | 288.448 | JPL wasm | 78.119x | 259.727x |
| sort/04_tile_median_builder.jplmm | sort | 250 | 2.297 | 4.325 | go | 285.812 | JPL wasm | 66.083x | 124.435x |
| sort/05_histogram_hint_sort.jplmm | sort | 250 | 0.866 | 3.747 | go | 308.002 | JPL wasm | 82.206x | 355.609x |
| sort/06_ranked_window_pass.jplmm | sort | 250 | 1.679 | 3.479 | go | 279.897 | JPL wasm | 80.448x | 166.738x |
| sort/07_top_band_stack.jplmm | sort | 250 | 0.860 | 3.732 | go | 276.492 | JPL wasm | 74.092x | 321.580x |
| sort/08_quartile_block_sort.jplmm | sort | 250 | 1.794 | 4.139 | go | 287.087 | JPL wasm | 69.369x | 159.993x |
| sort/09_edge_bucket_sort.jplmm | sort | 250 | 0.822 | 3.732 | go | 296.731 | JPL wasm | 79.503x | 361.077x |
| sort/10_median_profile_stack.jplmm | sort | 250 | 1.734 | 4.512 | go | 277.603 | JPL wasm | 61.530x | 160.110x |
| sort/11_window_rank_energy.jplmm | sort | 250 | 1.057 | 3.639 | go | 302.213 | JPL wasm | 83.043x | 285.938x |
| sort/12_neighbor_band_sort.jplmm | sort | 250 | 1.998 | 3.463 | go | 284.454 | JPL wasm | 82.151x | 142.340x |
| sort/13_median_trace_pass.jplmm | sort | 250 | 0.824 | 3.424 | go | 281.978 | JPL wasm | 82.357x | 342.327x |
| sort/14_block_order_stack.jplmm | sort | 250 | 1.771 | 3.537 | go | 279.521 | JPL wasm | 79.024x | 157.799x |
| sort/15_ranked_tile_stage.jplmm | sort | 250 | 0.861 | 3.362 | go | 292.121 | JPL wasm | 86.887x | 339.396x |
| sort/16_adaptive_sort_pass.jplmm | sort | 250 | 1.778 | 3.561 | go | 298.303 | JPL wasm | 83.764x | 167.766x |
| sort/17_contrast_bucket_sort.jplmm | sort | 250 | 0.843 | 3.504 | go | 287.719 | JPL wasm | 82.112x | 341.320x |
| sort/18_midband_sort_stage.jplmm | sort | 250 | 1.676 | 3.651 | go | 282.697 | JPL wasm | 77.433x | 168.648x |
| sort/19_ordered_block_field.jplmm | sort | 250 | 0.937 | 6.394 | go | 301.855 | JPL wasm | 47.209x | 322.021x |
| sort/20_tile_quantile_stack.jplmm | sort | 250 | 2.026 | 3.511 | go | 284.937 | JPL wasm | 81.149x | 140.629x |