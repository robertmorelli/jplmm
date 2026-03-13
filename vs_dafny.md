# JPL-- vs Dafny Examples

Generated at: 2026-03-13T05:17:37.925Z
Examples benchmarked: 112
Available Dafny targets: go
Exact-comparison rows: 56
Approximate-analogue rows: 56
Approximation note: matrix, signal, and control rows use generated fixed-point Dafny analogues instead of the original JPL float semantics.
Timing note: JPL native timings are measured by running the compiled arm64 runner process once per case, so they include one process launch per benchmark case.

## Summary

- JPL native faster than the fastest available Dafny target in 112/112 cases
- JPL wasm faster than the fastest available Dafny target in 112/112 cases
- JPL wasm: 89 fastest finishes
- JPL native arm64: 23 fastest finishes

## Results

| Example | Category | Class | Iterations | JPL Wasm (ms) | JPL Native (ms) | Dafny Target | Dafny (ms) | Fastest | Native vs Dafny | Wasm vs Dafny | Note |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | --- |
| control/01_tracker_settle_a.jplmm | control | approximate | 40 | 0.060 | 4.680 | go | 316.535 | JPL wasm | 67.636x | 5275.577x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/02_grid_relax_a.jplmm | control | approximate | 40 | 3.618 | 8.043 | go | 305.532 | JPL wasm | 37.988x | 84.445x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/03_tracker_settle_b.jplmm | control | approximate | 40 | 0.079 | 4.243 | go | 300.757 | JPL wasm | 70.891x | 3815.121x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/04_grid_relax_b.jplmm | control | approximate | 40 | 5.075 | 5.295 | go | 294.797 | JPL wasm | 55.677x | 58.089x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/05_tracker_settle_c.jplmm | control | approximate | 40 | 0.099 | 4.037 | go | 304.207 | JPL wasm | 75.362x | 3062.500x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/06_grid_relax_c.jplmm | control | approximate | 40 | 3.211 | 4.501 | go | 325.085 | JPL wasm | 72.219x | 101.229x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/07_tracker_settle_d.jplmm | control | approximate | 40 | 0.062 | 5.241 | go | 302.656 | JPL wasm | 57.743x | 4881.540x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/08_grid_relax_d.jplmm | control | approximate | 40 | 4.219 | 4.616 | go | 311.956 | JPL wasm | 67.586x | 73.949x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/09_tracker_settle_e.jplmm | control | approximate | 40 | 0.086 | 3.884 | go | 301.668 | JPL wasm | 77.668x | 3490.843x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/10_grid_relax_e.jplmm | control | approximate | 40 | 5.104 | 5.573 | go | 307.335 | JPL wasm | 55.147x | 60.209x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/11_tracker_settle_f.jplmm | control | approximate | 40 | 0.096 | 4.014 | go | 299.161 | JPL wasm | 74.536x | 3116.260x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/12_grid_relax_f.jplmm | control | approximate | 40 | 3.393 | 5.030 | go | 327.533 | JPL wasm | 65.113x | 96.542x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/13_tracker_settle_g.jplmm | control | approximate | 40 | 0.059 | 3.840 | go | 301.578 | JPL wasm | 78.542x | 5144.188x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/14_grid_relax_g.jplmm | control | approximate | 40 | 4.177 | 6.822 | go | 442.216 | JPL wasm | 64.818x | 105.865x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/15_tracker_settle_h.jplmm | control | approximate | 40 | 0.083 | 3.619 | go | 301.162 | JPL wasm | 83.222x | 3623.005x | Dafny uses a generated fixed-point analogue for JPL float control code. |
| control/16_grid_relax_h.jplmm | control | approximate | 40 | 2.810 | 3.694 | go | 298.325 | JPL wasm | 80.752x | 106.170x | Dafny uses a generated fixed-point analogue for JPL float control code. |
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
| matrix/01_gram_pipeline.jplmm | matrix | approximate | 4 | 0.570 | 3.892 | go | 301.337 | JPL wasm | 77.434x | 528.932x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/02_covariance_lift.jplmm | matrix | approximate | 4 | 0.626 | 4.937 | go | 311.518 | JPL wasm | 63.097x | 497.931x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/03_laplace_smoother.jplmm | matrix | approximate | 4 | 0.620 | 4.735 | go | 497.219 | JPL wasm | 105.010x | 802.505x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/04_energy_normalizer.jplmm | matrix | approximate | 4 | 0.621 | 4.486 | go | 328.065 | JPL wasm | 73.134x | 528.037x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/05_feature_correlation.jplmm | matrix | approximate | 4 | 0.761 | 4.332 | go | 309.027 | JPL wasm | 71.336x | 406.081x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/06_channel_projection.jplmm | matrix | approximate | 4 | 0.628 | 4.193 | go | 308.842 | JPL wasm | 73.665x | 491.951x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/07_spectral_spread.jplmm | matrix | approximate | 4 | 0.675 | 4.455 | go | 310.280 | JPL wasm | 69.653x | 459.447x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/08_block_affine_stack.jplmm | matrix | approximate | 4 | 0.586 | 4.855 | go | 300.653 | JPL wasm | 61.928x | 513.169x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/09_matrix_diffusion.jplmm | matrix | approximate | 4 | 0.631 | 4.340 | go | 356.878 | JPL wasm | 82.235x | 565.576x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/10_orthogonalizer.jplmm | matrix | approximate | 4 | 0.576 | 3.679 | go | 297.681 | JPL wasm | 80.919x | 516.732x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/11_transpose_product.jplmm | matrix | approximate | 4 | 0.561 | 4.168 | go | 293.590 | JPL wasm | 70.445x | 523.294x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/12_ridge_like_stack.jplmm | matrix | approximate | 4 | 0.568 | 4.008 | go | 302.823 | JPL wasm | 75.555x | 533.021x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/13_row_whitener.jplmm | matrix | approximate | 4 | 0.563 | 4.197 | go | 316.194 | JPL wasm | 75.332x | 561.209x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/14_kernel_projector.jplmm | matrix | approximate | 4 | 0.571 | 3.976 | go | 301.094 | JPL wasm | 75.729x | 527.310x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/15_harmonic_matrix_pass.jplmm | matrix | approximate | 4 | 0.566 | 4.237 | go | 301.000 | JPL wasm | 71.039x | 531.998x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/16_metric_tensor_stage.jplmm | matrix | approximate | 4 | 0.520 | 4.458 | go | 307.433 | JPL wasm | 68.960x | 591.264x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/17_response_matrix_stack.jplmm | matrix | approximate | 4 | 0.555 | 5.654 | go | 317.880 | JPL wasm | 56.227x | 572.715x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/18_regularized_gram.jplmm | matrix | approximate | 4 | 0.518 | 3.789 | go | 311.648 | JPL wasm | 82.252x | 601.927x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/19_low_rank_hint.jplmm | matrix | approximate | 4 | 0.510 | 4.062 | go | 315.410 | JPL wasm | 77.656x | 617.996x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
| matrix/20_residual_mixer.jplmm | matrix | approximate | 4 | 0.587 | 3.704 | go | 296.507 | JPL wasm | 80.054x | 505.086x | Dafny uses a generated fixed-point integer analogue for JPL float matrix code. |
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
| signal/01_prefix_envelope.jplmm | signal | approximate | 3 | 0.086 | 3.828 | go | 301.105 | JPL wasm | 78.654x | 3504.605x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/02_fir_bank_stage.jplmm | signal | approximate | 3 | 0.071 | 3.612 | go | 302.179 | JPL wasm | 83.659x | 4233.685x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/03_carrier_modulator.jplmm | signal | approximate | 3 | 0.072 | 3.182 | go | 297.558 | JPL wasm | 93.520x | 4144.724x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/04_sine_lift_stack.jplmm | signal | approximate | 3 | 0.066 | 3.712 | go | 300.861 | JPL wasm | 81.057x | 4541.306x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/05_energy_tracker.jplmm | signal | approximate | 3 | 0.122 | 3.589 | go | 297.856 | JPL wasm | 83.000x | 2436.450x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/06_phase_envelope.jplmm | signal | approximate | 3 | 0.117 | 3.849 | go | 412.679 | JPL wasm | 107.217x | 3530.941x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/07_resonant_prefix.jplmm | signal | approximate | 3 | 0.070 | 3.809 | go | 310.157 | JPL wasm | 81.432x | 4412.404x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/08_wave_shaper.jplmm | signal | approximate | 3 | 0.072 | 3.751 | go | 316.079 | JPL wasm | 84.257x | 4410.387x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/09_soft_band_stack.jplmm | signal | approximate | 3 | 0.077 | 3.645 | go | 308.554 | JPL wasm | 84.649x | 3996.354x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/10_spectral_hint.jplmm | signal | approximate | 3 | 0.078 | 4.840 | go | 297.003 | JPL wasm | 61.358x | 3809.786x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/11_windowed_motion.jplmm | signal | approximate | 3 | 0.072 | 3.642 | go | 298.004 | JPL wasm | 81.816x | 4131.776x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/12_pulse_smoother.jplmm | signal | approximate | 3 | 0.071 | 4.385 | go | 299.809 | JPL wasm | 68.370x | 4232.624x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/13_ridge_detector.jplmm | signal | approximate | 3 | 0.076 | 3.945 | go | 301.907 | JPL wasm | 76.520x | 3957.310x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/14_derivative_envelope.jplmm | signal | approximate | 3 | 0.072 | 3.350 | go | 307.354 | JPL wasm | 91.745x | 4251.561x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/15_harmonic_bank.jplmm | signal | approximate | 3 | 0.256 | 4.017 | go | 303.892 | JPL wasm | 75.645x | 1186.307x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/16_integrated_signal.jplmm | signal | approximate | 3 | 0.071 | 3.821 | go | 305.770 | JPL wasm | 80.018x | 4329.486x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/17_cascaded_fir.jplmm | signal | approximate | 3 | 0.107 | 5.206 | go | 309.345 | JPL wasm | 59.424x | 2879.852x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/18_cyclic_lifter.jplmm | signal | approximate | 3 | 0.070 | 4.455 | go | 308.515 | JPL wasm | 69.251x | 4417.829x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/19_dense_modulator.jplmm | signal | approximate | 3 | 0.074 | 4.206 | go | 297.681 | JPL wasm | 70.777x | 3997.970x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
| signal/20_wave_energy_field.jplmm | signal | approximate | 3 | 0.068 | 4.597 | go | 296.523 | JPL wasm | 64.505x | 4355.312x | Dafny uses generated fixed-point arithmetic and approximated trig/sqrt for JPL float signal code. |
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