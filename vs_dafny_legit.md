# JPL-- vs Dafny Examples (Exact-Match Rows Only)

Generated at: 2026-03-13T05:17:37.925Z
Examples benchmarked: 56
Available Dafny targets: go
Exact-comparison rows: 56
Approximate-analogue rows: 0
Approximation note: matrix, signal, and control rows use generated fixed-point Dafny analogues instead of the original JPL float semantics.
Timing note: JPL native timings are measured by running the compiled arm64 runner process once per case, so they include one process launch per benchmark case.

## Summary

- JPL native faster than the fastest available Dafny target in 56/56 cases
- JPL wasm faster than the fastest available Dafny target in 56/56 cases
- JPL wasm: 33 fastest finishes
- JPL native arm64: 23 fastest finishes

## Results

| Example | Category | Class | Iterations | JPL Wasm (ms) | JPL Native (ms) | Dafny Target | Dafny (ms) | Fastest | Native vs Dafny | Wasm vs Dafny | Note |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | --- |
| image/01_box_blur_energy.jplmm | image | exact | 180 | 165.622 | 129.687 | go | 325.023 | JPL native arm64 | 2.506x | 1.962x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/02_edge_emboss_tonemap.jplmm | image | exact | 180 | 175.728 | 131.510 | go | 334.668 | JPL native arm64 | 2.545x | 1.904x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/03_luma_gradient_mix.jplmm | image | exact | 180 | 191.846 | 166.335 | go | 332.482 | JPL native arm64 | 1.999x | 1.733x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/04_color_lift_stack.jplmm | image | exact | 180 | 170.052 | 129.981 | go | 332.424 | JPL native arm64 | 2.557x | 1.955x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/05_detail_boost_grid.jplmm | image | exact | 180 | 167.714 | 129.850 | go | 340.928 | JPL native arm64 | 2.626x | 2.033x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/06_highlight_balance_pass.jplmm | image | exact | 180 | 188.462 | 147.401 | go | 327.786 | JPL native arm64 | 2.224x | 1.739x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/07_channel_push_field.jplmm | image | exact | 180 | 168.007 | 128.800 | go | 334.628 | JPL native arm64 | 2.598x | 1.992x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/08_edge_heatmap_builder.jplmm | image | exact | 180 | 175.629 | 135.045 | go | 335.300 | JPL native arm64 | 2.483x | 1.909x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/09_soft_focus_pipeline.jplmm | image | exact | 180 | 169.422 | 133.241 | go | 334.520 | JPL native arm64 | 2.511x | 1.974x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/10_contrast_ramp_blend.jplmm | image | exact | 180 | 164.310 | 130.195 | go | 334.092 | JPL native arm64 | 2.566x | 2.033x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/11_spectral_tint_pass.jplmm | image | exact | 180 | 165.810 | 130.569 | go | 332.923 | JPL native arm64 | 2.550x | 2.008x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/12_embossed_luma_stack.jplmm | image | exact | 180 | 167.406 | 131.434 | go | 333.778 | JPL native arm64 | 2.540x | 1.994x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/13_motion_hint_filter.jplmm | image | exact | 180 | 167.997 | 129.588 | go | 334.334 | JPL native arm64 | 2.580x | 1.990x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/14_vivid_mix_painter.jplmm | image | exact | 180 | 165.631 | 130.566 | go | 330.679 | JPL native arm64 | 2.533x | 1.996x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/15_row_energy_sampler.jplmm | image | exact | 180 | 169.020 | 130.365 | go | 332.750 | JPL native arm64 | 2.552x | 1.969x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/16_column_energy_sampler.jplmm | image | exact | 180 | 170.313 | 132.144 | go | 333.272 | JPL native arm64 | 2.522x | 1.957x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/17_stylized_screen_pass.jplmm | image | exact | 180 | 169.933 | 128.409 | go | 323.913 | JPL native arm64 | 2.523x | 1.906x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/18_sharpened_edge_stack.jplmm | image | exact | 180 | 167.641 | 128.221 | go | 330.889 | JPL native arm64 | 2.581x | 1.974x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/19_cinematic_grade_pass.jplmm | image | exact | 180 | 177.076 | 130.001 | go | 350.019 | JPL native arm64 | 2.692x | 1.977x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/20_halo_reducer_pass.jplmm | image | exact | 180 | 224.147 | 161.913 | go | 328.085 | JPL native arm64 | 2.026x | 1.464x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/21_detail_smoother_pass.jplmm | image | exact | 180 | 164.712 | 136.683 | go | 366.025 | JPL native arm64 | 2.678x | 2.222x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/22_pixel_fusion_pass.jplmm | image | exact | 180 | 170.851 | 139.860 | go | 363.825 | JPL native arm64 | 2.601x | 2.129x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/23_color_balance_stack.jplmm | image | exact | 180 | 189.084 | 179.920 | go | 362.268 | JPL native arm64 | 2.013x | 1.916x | JPL and Dafny use the same integer-oriented algorithm family here. |
| image/24_microcontrast_stage.jplmm | image | exact | 180 | 176.482 | 198.025 | go | 340.878 | JPL wasm | 1.721x | 1.932x | JPL and Dafny use the same integer-oriented algorithm family here. |
| showcase/01_vision_block_metrics.jplmm | showcase | exact | 120 | 3.277 | 3.930 | go | 313.457 | JPL wasm | 79.767x | 95.651x | JPL and Dafny use the same integer-oriented algorithm family here. |
| showcase/02_stylized_block_profile.jplmm | showcase | exact | 120 | 3.330 | 4.189 | go | 313.597 | JPL wasm | 74.860x | 94.177x | JPL and Dafny use the same integer-oriented algorithm family here. |
| showcase/03_ranked_luma_tiles.jplmm | showcase | exact | 120 | 3.560 | 4.378 | go | 314.672 | JPL wasm | 71.870x | 88.383x | JPL and Dafny use the same integer-oriented algorithm family here. |
| showcase/04_sorted_detail_profile.jplmm | showcase | exact | 120 | 3.414 | 3.592 | go | 311.285 | JPL wasm | 86.651x | 91.169x | JPL and Dafny use the same integer-oriented algorithm family here. |
| showcase/05_metric_screen_builder.jplmm | showcase | exact | 120 | 3.722 | 5.941 | go | 338.491 | JPL wasm | 56.973x | 90.954x | JPL and Dafny use the same integer-oriented algorithm family here. |
| showcase/06_feature_tile_ranker.jplmm | showcase | exact | 120 | 3.456 | 4.451 | go | 311.391 | JPL wasm | 69.954x | 90.090x | JPL and Dafny use the same integer-oriented algorithm family here. |
| showcase/07_block_energy_mosaic.jplmm | showcase | exact | 120 | 3.688 | 4.310 | go | 313.384 | JPL wasm | 72.707x | 84.970x | JPL and Dafny use the same integer-oriented algorithm family here. |
| showcase/08_sorted_pixel_signature.jplmm | showcase | exact | 120 | 1.239 | 3.950 | go | 318.094 | JPL wasm | 80.527x | 256.821x | JPL and Dafny use the same integer-oriented algorithm family here. |
| showcase/09_luma_band_ranker.jplmm | showcase | exact | 120 | 1.216 | 4.134 | go | 314.535 | JPL wasm | 76.093x | 258.717x | JPL and Dafny use the same integer-oriented algorithm family here. |
| showcase/10_screen_profile_field.jplmm | showcase | exact | 120 | 1.538 | 4.199 | go | 357.874 | JPL wasm | 85.222x | 232.751x | JPL and Dafny use the same integer-oriented algorithm family here. |
| showcase/11_detail_metric_tiles.jplmm | showcase | exact | 120 | 1.550 | 4.900 | go | 318.799 | JPL wasm | 65.058x | 205.622x | JPL and Dafny use the same integer-oriented algorithm family here. |
| showcase/12_profiled_block_stack.jplmm | showcase | exact | 120 | 1.357 | 5.142 | go | 320.428 | JPL wasm | 62.313x | 236.152x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/01_median_block_stack.jplmm | sort | exact | 250 | 1.045 | 35.179 | go | 304.122 | JPL wasm | 8.645x | 291.153x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/02_row_sort_network.jplmm | sort | exact | 250 | 1.777 | 4.112 | go | 369.004 | JPL wasm | 89.736x | 207.700x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/03_column_rank_pass.jplmm | sort | exact | 250 | 0.853 | 4.051 | go | 301.590 | JPL wasm | 74.449x | 353.409x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/04_tile_median_builder.jplmm | sort | exact | 250 | 1.868 | 4.495 | go | 296.264 | JPL wasm | 65.907x | 158.617x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/05_histogram_hint_sort.jplmm | sort | exact | 250 | 0.827 | 4.680 | go | 292.529 | JPL wasm | 62.503x | 353.669x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/06_ranked_window_pass.jplmm | sort | exact | 250 | 1.768 | 4.135 | go | 310.326 | JPL wasm | 75.042x | 175.569x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/07_top_band_stack.jplmm | sort | exact | 250 | 1.001 | 3.782 | go | 297.314 | JPL wasm | 78.604x | 297.128x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/08_quartile_block_sort.jplmm | sort | exact | 250 | 1.808 | 4.008 | go | 305.934 | JPL wasm | 76.338x | 169.211x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/09_edge_bucket_sort.jplmm | sort | exact | 250 | 0.819 | 3.632 | go | 298.309 | JPL wasm | 82.129x | 364.440x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/10_median_profile_stack.jplmm | sort | exact | 250 | 1.831 | 3.938 | go | 346.330 | JPL wasm | 87.948x | 189.101x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/11_window_rank_energy.jplmm | sort | exact | 250 | 0.896 | 3.603 | go | 298.656 | JPL wasm | 82.889x | 333.322x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/12_neighbor_band_sort.jplmm | sort | exact | 250 | 2.463 | 4.261 | go | 536.366 | JPL wasm | 125.889x | 217.755x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/13_median_trace_pass.jplmm | sort | exact | 250 | 0.884 | 4.037 | go | 306.950 | JPL wasm | 76.043x | 347.048x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/14_block_order_stack.jplmm | sort | exact | 250 | 2.048 | 4.641 | go | 306.168 | JPL wasm | 65.966x | 149.499x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/15_ranked_tile_stage.jplmm | sort | exact | 250 | 1.117 | 4.320 | go | 331.584 | JPL wasm | 76.761x | 296.797x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/16_adaptive_sort_pass.jplmm | sort | exact | 250 | 2.855 | 4.099 | go | 300.317 | JPL wasm | 73.271x | 105.207x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/17_contrast_bucket_sort.jplmm | sort | exact | 250 | 1.210 | 3.600 | go | 307.531 | JPL wasm | 85.424x | 254.097x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/18_midband_sort_stage.jplmm | sort | exact | 250 | 1.782 | 4.964 | go | 337.768 | JPL wasm | 68.049x | 189.558x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/19_ordered_block_field.jplmm | sort | exact | 250 | 0.841 | 4.304 | go | 299.839 | JPL wasm | 69.658x | 356.386x | JPL and Dafny use the same integer-oriented algorithm family here. |
| sort/20_tile_quantile_stack.jplmm | sort | exact | 250 | 1.730 | 4.338 | go | 310.807 | JPL wasm | 71.647x | 179.657x | JPL and Dafny use the same integer-oriented algorithm family here. |