export const imageNames = [
  'box_blur_energy', 'edge_emboss_tonemap', 'luma_gradient_mix', 'color_lift_stack', 'detail_boost_grid', 'highlight_balance_pass', 'channel_push_field', 'edge_heatmap_builder', 'soft_focus_pipeline', 'contrast_ramp_blend', 'spectral_tint_pass', 'embossed_luma_stack', 'motion_hint_filter', 'vivid_mix_painter', 'row_energy_sampler', 'column_energy_sampler', 'stylized_screen_pass', 'sharpened_edge_stack', 'cinematic_grade_pass', 'halo_reducer_pass', 'detail_smoother_pass', 'pixel_fusion_pass', 'color_balance_stack', 'microcontrast_stage'
];

export const matrixNames = [
  'gram_pipeline', 'covariance_lift', 'laplace_smoother', 'energy_normalizer', 'feature_correlation', 'channel_projection', 'spectral_spread', 'block_affine_stack', 'matrix_diffusion', 'orthogonalizer', 'transpose_product', 'ridge_like_stack', 'row_whitener', 'kernel_projector', 'harmonic_matrix_pass', 'metric_tensor_stage', 'response_matrix_stack', 'regularized_gram', 'low_rank_hint', 'residual_mixer'
];

export const signalNames = [
  'prefix_envelope', 'fir_bank_stage', 'carrier_modulator', 'sine_lift_stack', 'energy_tracker', 'phase_envelope', 'resonant_prefix', 'wave_shaper', 'soft_band_stack', 'spectral_hint', 'windowed_motion', 'pulse_smoother', 'ridge_detector', 'derivative_envelope', 'harmonic_bank', 'integrated_signal', 'cascaded_fir', 'cyclic_lifter', 'dense_modulator', 'wave_energy_field'
];

export const sortNames = [
  'median_block_stack', 'row_sort_network', 'column_rank_pass', 'tile_median_builder', 'histogram_hint_sort', 'ranked_window_pass', 'top_band_stack', 'quartile_block_sort', 'edge_bucket_sort', 'median_profile_stack', 'window_rank_energy', 'neighbor_band_sort', 'median_trace_pass', 'block_order_stack', 'ranked_tile_stage', 'adaptive_sort_pass', 'contrast_bucket_sort', 'midband_sort_stage', 'ordered_block_field', 'tile_quantile_stack'
];

export const controlNames = [
  'tracker_settle_a', 'grid_relax_a', 'tracker_settle_b', 'grid_relax_b', 'tracker_settle_c', 'grid_relax_c', 'tracker_settle_d', 'grid_relax_d', 'tracker_settle_e', 'grid_relax_e', 'tracker_settle_f', 'grid_relax_f', 'tracker_settle_g', 'grid_relax_g', 'tracker_settle_h', 'grid_relax_h'
];

export const showcaseNames = [
  'vision_block_metrics', 'stylized_block_profile', 'ranked_luma_tiles', 'sorted_detail_profile', 'metric_screen_builder', 'feature_tile_ranker', 'block_energy_mosaic', 'sorted_pixel_signature', 'luma_band_ranker', 'screen_profile_field', 'detail_metric_tiles', 'profiled_block_stack'
];

export const exampleCategories = [
  { key: 'image', names: imageNames },
  { key: 'matrix', names: matrixNames },
  { key: 'signal', names: signalNames },
  { key: 'sort', names: sortNames },
  { key: 'control', names: controlNames },
  { key: 'showcase', names: showcaseNames },
];

export const totalExampleCount = exampleCategories.reduce((sum, category) => sum + category.names.length, 0);
