#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static inline int32_t jplmm_clamp_i64_to_i32(int64_t x) {
  if (x < -2147483648LL) return -2147483648;
  if (x > 2147483647LL) return 2147483647;
  return (int32_t)x;
}

static inline int32_t jplmm_sat_add_i32(int32_t a, int32_t b) {
  return jplmm_clamp_i64_to_i32((int64_t)a + (int64_t)b);
}

static inline int32_t jplmm_sat_sub_i32(int32_t a, int32_t b) {
  return jplmm_clamp_i64_to_i32((int64_t)a - (int64_t)b);
}

static inline int32_t jplmm_sat_mul_i32(int32_t a, int32_t b) {
  return jplmm_clamp_i64_to_i32((int64_t)a * (int64_t)b);
}

static inline int32_t jplmm_sat_neg_i32(int32_t a) {
  return a == -2147483648 ? 2147483647 : -a;
}

static inline int32_t jplmm_total_div_i32(int32_t a, int32_t b) {
  if (b == 0) return 0;
  if (a == -2147483648 && b == -1) return 2147483647;
  return a / b;
}

static inline int32_t jplmm_total_mod_i32(int32_t a, int32_t b) {
  if (b == 0) return 0;
  if (a == -2147483648 && b == -1) return 0;
  return a % b;
}

static inline float jplmm_nan_to_zero_f32(float x) {
  return isnan(x) ? 0.0f : x;
}

static inline float jplmm_total_div_f32(float a, float b) {
  return b == 0.0f ? 0.0f : jplmm_nan_to_zero_f32(a / b);
}

static inline float jplmm_total_mod_f32(float a, float b) {
  return b == 0.0f ? 0.0f : jplmm_nan_to_zero_f32(fmodf(a, b));
}

static inline int32_t jplmm_abs_i32(int32_t x) {
  return x < 0 ? jplmm_sat_neg_i32(x) : x;
}

static inline int32_t jplmm_max_i32(int32_t a, int32_t b) { return a > b ? a : b; }
static inline int32_t jplmm_min_i32(int32_t a, int32_t b) { return a < b ? a : b; }
static inline int32_t jplmm_clamp_i32(int32_t x, int32_t lo, int32_t hi) { return jplmm_min_i32(jplmm_max_i32(x, lo), hi); }
static inline float jplmm_max_f32(float a, float b) { return a > b ? a : b; }
static inline float jplmm_min_f32(float a, float b) { return a < b ? a : b; }
static inline float jplmm_clamp_f32(float x, float lo, float hi) { return jplmm_min_f32(jplmm_max_f32(x, lo), hi); }

static inline int32_t jplmm_trunc_sat_f32_to_i32(float x) {
  if (!isfinite(x)) return x < 0 ? -2147483648 : 2147483647;
  if (x < (float)-2147483648) return -2147483648;
  if (x > (float)2147483647) return 2147483647;
  return (int32_t)x;
}

static inline int jplmm_eq_f32_ulp1(float a, float b) {
  union { float f; uint32_t u; } ua = { a }, ub = { b };
  uint32_t oa = (ua.u & 0x80000000u) ? (~ua.u) : (ua.u | 0x80000000u);
  uint32_t ob = (ub.u & 0x80000000u) ? (~ub.u) : (ub.u | 0x80000000u);
  uint32_t diff = oa > ob ? oa - ob : ob - oa;
  return diff <= 1u;
}

static uint8_t *jplmm_heap = NULL;
static int32_t jplmm_heap_size = 8;
static int32_t jplmm_heap_capacity = 0;

static void jplmm_panic(const char *message) {
  fprintf(stderr, "%s\n", message);
  abort();
}

static void jplmm_ensure_heap_capacity(int32_t needed) {
  if (jplmm_heap_capacity == 0) {
    jplmm_heap_capacity = 1 << 20;
    while (jplmm_heap_capacity < needed) {
      jplmm_heap_capacity <<= 1;
    }
    jplmm_heap = (uint8_t *)calloc((size_t)jplmm_heap_capacity, 1u);
    if (!jplmm_heap) {
      jplmm_panic("failed to allocate JPL heap");
    }
    return;
  }
  if (needed <= jplmm_heap_capacity) {
    return;
  }
  int32_t nextCapacity = jplmm_heap_capacity;
  while (nextCapacity < needed) {
    nextCapacity <<= 1;
  }
  uint8_t *next = (uint8_t *)realloc(jplmm_heap, (size_t)nextCapacity);
  if (!next) {
    jplmm_panic("failed to grow JPL heap");
  }
  memset(next + jplmm_heap_capacity, 0, (size_t)(nextCapacity - jplmm_heap_capacity));
  jplmm_heap = next;
  jplmm_heap_capacity = nextCapacity;
}

static void jplmm_reset_heap(void) {
  jplmm_ensure_heap_capacity(8);
  jplmm_heap_size = 8;
}

static int32_t jplmm_alloc_bytes(int32_t bytes) {
  if (bytes < 0) {
    jplmm_panic("negative allocation request");
  }
  int32_t aligned = (bytes + 7) & ~7;
  int32_t base = jplmm_heap_size;
  jplmm_ensure_heap_capacity(base + aligned);
  memset(jplmm_heap + base, 0, (size_t)aligned);
  jplmm_heap_size += aligned;
  return base;
}

static int32_t jplmm_alloc_words(int32_t words) {
  return jplmm_alloc_bytes(words * 4);
}

static inline int32_t jplmm_word_load_i32(int32_t handle, int32_t word) {
  int32_t value = 0;
  memcpy(&value, jplmm_heap + handle + (word * 4), sizeof(value));
  return value;
}

static inline float jplmm_word_load_f32(int32_t handle, int32_t word) {
  float value = 0.0f;
  memcpy(&value, jplmm_heap + handle + (word * 4), sizeof(value));
  return value;
}

static inline void jplmm_word_store_i32(int32_t handle, int32_t word, int32_t value) {
  memcpy(jplmm_heap + handle + (word * 4), &value, sizeof(value));
}

static inline void jplmm_word_store_f32(int32_t handle, int32_t word, float value) {
  memcpy(jplmm_heap + handle + (word * 4), &value, sizeof(value));
}

static inline void jplmm_copy_words(int32_t dstHandle, int32_t dstWord, int32_t srcHandle, int32_t srcWord, int32_t count) {
  memcpy(jplmm_heap + dstHandle + (dstWord * 4), jplmm_heap + srcHandle + (srcWord * 4), (size_t)count * 4u);
}

static inline int32_t jplmm_array_rank(int32_t handle) {
  return jplmm_word_load_i32(handle, 0);
}

static inline int32_t jplmm_array_dim(int32_t handle, int32_t index) {
  return jplmm_word_load_i32(handle, 1 + index);
}

static int32_t jplmm_array_total_cells(int32_t handle) {
  int32_t total = 1;
  int32_t rank = jplmm_array_rank(handle);
  for (int32_t i = 0; i < rank; i += 1) {
    total = jplmm_sat_mul_i32(total, jplmm_array_dim(handle, i));
  }
  return total;
}

static int32_t jplmm_array_stride(int32_t handle, int32_t index) {
  int32_t stride = 1;
  int32_t rank = jplmm_array_rank(handle);
  for (int32_t i = index + 1; i < rank; i += 1) {
    stride = jplmm_sat_mul_i32(stride, jplmm_array_dim(handle, i));
  }
  return stride;
}

static int32_t jplmm_array_slice(int32_t source, int32_t consumedRank, int32_t offsetCells) {
  int32_t srcRank = jplmm_array_rank(source);
  if (consumedRank > srcRank) {
    jplmm_panic("array index rank mismatch");
  }
  int32_t dstRank = srcRank - consumedRank;
  int32_t totalCells = 1;
  int32_t handle = 0;
  for (int32_t i = 0; i < dstRank; i += 1) {
    int32_t dim = jplmm_array_dim(source, consumedRank + i);
    totalCells = jplmm_sat_mul_i32(totalCells, dim);
  }
  handle = jplmm_alloc_words(1 + dstRank + totalCells);
  jplmm_word_store_i32(handle, 0, dstRank);
  for (int32_t i = 0; i < dstRank; i += 1) {
    jplmm_word_store_i32(handle, 1 + i, jplmm_array_dim(source, consumedRank + i));
  }
  jplmm_copy_words(handle, 1 + dstRank, source, 1 + srcRank + offsetCells, totalCells);
  return handle;
}

static int32_t jplmm_array_alloc_r1(int32_t d0) {
  int32_t total = 1;
  total = jplmm_sat_mul_i32(total, d0);
  int32_t handle = jplmm_alloc_words(1 + 1 + total);
  jplmm_word_store_i32(handle, 0, 1);
  jplmm_word_store_i32(handle, 1, d0);
  return handle;
}

static int32_t jplmm_array_alloc_r2(int32_t d0, int32_t d1) {
  int32_t total = 1;
  total = jplmm_sat_mul_i32(total, d0);
  total = jplmm_sat_mul_i32(total, d1);
  int32_t handle = jplmm_alloc_words(1 + 2 + total);
  jplmm_word_store_i32(handle, 0, 2);
  jplmm_word_store_i32(handle, 1, d0);
  jplmm_word_store_i32(handle, 2, d1);
  return handle;
}

static int jplmm_eq_array_arr2_f32(int32_t a, int32_t b) {
  if (a == b) return 1;
  if (a == 0 || b == 0) return 0;
  if (jplmm_array_rank(a) != 2 || jplmm_array_rank(b) != 2) return 0;
  if (jplmm_array_dim(a, 0) != jplmm_array_dim(b, 0)) return 0;
  if (jplmm_array_dim(a, 1) != jplmm_array_dim(b, 1)) return 0;
  int32_t total = jplmm_array_total_cells(a);
  for (int32_t i = 0; i < total; i += 1) {
    if (!(jplmm_eq_f32_ulp1(jplmm_word_load_f32(a, 3 + i), jplmm_word_load_f32(b, 3 + i)))) return 0;
  }
  return 1;
}

static int jplmm_eq_array_arr1_f32(int32_t a, int32_t b) {
  if (a == b) return 1;
  if (a == 0 || b == 0) return 0;
  if (jplmm_array_rank(a) != 1 || jplmm_array_rank(b) != 1) return 0;
  if (jplmm_array_dim(a, 0) != jplmm_array_dim(b, 0)) return 0;
  int32_t total = jplmm_array_total_cells(a);
  for (int32_t i = 0; i < total; i += 1) {
    if (!(jplmm_eq_f32_ulp1(jplmm_word_load_f32(a, 2 + i), jplmm_word_load_f32(b, 2 + i)))) return 0;
  }
  return 1;
}

static int32_t smooth(int32_t grid, int32_t h, int32_t w);
static int32_t blend_grid(int32_t grid, int32_t next, int32_t h, int32_t w, int32_t steps);
static int32_t relax(int32_t grid, int32_t h, int32_t w, int32_t steps);
static float metric(int32_t grid, int32_t h, int32_t w);
static float main__generic(void);
static float main(void);
static int32_t __codex_examples_entry(int32_t seed);

static int32_t smooth(int32_t grid, int32_t h, int32_t w) {
  int32_t res = 0;
  for (;;) {
    res = ({ int32_t jplmm_array_62;
       int32_t jplmm_total_62 = 0;
       int32_t jplmm_body_cells_62 = 0;
       int32_t jplmm_dim_62_0 = 0;
       int32_t jplmm_dim_62_1 = 0;
      {
        int32_t jplmm_extent_62_0 = jplmm_max_i32(1, h);
        if (jplmm_dim_62_0 == 0) {
          jplmm_dim_62_0 = jplmm_extent_62_0;
        } else if (jplmm_dim_62_0 != jplmm_extent_62_0) {
          jplmm_panic("array body produced ragged dimensions");
        }
        for (int32_t y = 0; y < jplmm_extent_62_0; y += 1) {
          {
            int32_t jplmm_extent_62_1 = jplmm_max_i32(1, w);
            if (jplmm_dim_62_1 == 0) {
              jplmm_dim_62_1 = jplmm_extent_62_1;
            } else if (jplmm_dim_62_1 != jplmm_extent_62_1) {
              jplmm_panic("array body produced ragged dimensions");
            }
            for (int32_t x = 0; x < jplmm_extent_62_1; x += 1) {
              jplmm_total_62 += 1;
            }
          }
        }
      }
       jplmm_array_62 = jplmm_array_alloc_r2(jplmm_dim_62_0, jplmm_dim_62_1);
       int32_t jplmm_cursor_62 = 0;
      {
        int32_t jplmm_extent_62_0 = jplmm_max_i32(1, h);
        if (jplmm_dim_62_0 == 0) {
          jplmm_dim_62_0 = jplmm_extent_62_0;
        } else if (jplmm_dim_62_0 != jplmm_extent_62_0) {
          jplmm_panic("array body produced ragged dimensions");
        }
        for (int32_t y = 0; y < jplmm_extent_62_0; y += 1) {
          {
            int32_t jplmm_extent_62_1 = jplmm_max_i32(1, w);
            if (jplmm_dim_62_1 == 0) {
              jplmm_dim_62_1 = jplmm_extent_62_1;
            } else if (jplmm_dim_62_1 != jplmm_extent_62_1) {
              jplmm_panic("array body produced ragged dimensions");
            }
            for (int32_t x = 0; x < jplmm_extent_62_1; x += 1) {
              jplmm_word_store_f32(jplmm_array_62, 3 + jplmm_cursor_62, jplmm_nan_to_zero_f32(jplmm_total_div_f32(jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_index_base_7 = ({ int32_t jplmm_index_base_5 = grid;
                 if (jplmm_index_base_5 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_5) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_5 = 0;
                 int32_t jplmm_idx_5_0 = jplmm_clamp_i32(y, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_5, 0) - 1));
                 jplmm_offset_5 += jplmm_idx_5_0 * jplmm_array_stride(jplmm_index_base_5, 0);
                 jplmm_array_slice(jplmm_index_base_5, 1, jplmm_offset_5); });
                 if (jplmm_index_base_7 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_7) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_7 = 0;
                 int32_t jplmm_idx_7_0 = jplmm_clamp_i32(x, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_7, 0) - 1));
                 jplmm_offset_7 += jplmm_idx_7_0 * jplmm_array_stride(jplmm_index_base_7, 0);
                 jplmm_word_load_f32(jplmm_index_base_7, 2 + jplmm_offset_7); })) + (({ int32_t jplmm_index_base_19 = ({ int32_t jplmm_index_base_17 = grid;
                 if (jplmm_index_base_17 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_17) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_17 = 0;
                 int32_t jplmm_idx_17_0 = jplmm_clamp_i32(jplmm_clamp_i32(jplmm_sat_sub_i32(y, 1), 0, jplmm_sat_sub_i32(h, 1)), 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_17, 0) - 1));
                 jplmm_offset_17 += jplmm_idx_17_0 * jplmm_array_stride(jplmm_index_base_17, 0);
                 jplmm_array_slice(jplmm_index_base_17, 1, jplmm_offset_17); });
                 if (jplmm_index_base_19 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_19) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_19 = 0;
                 int32_t jplmm_idx_19_0 = jplmm_clamp_i32(x, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_19, 0) - 1));
                 jplmm_offset_19 += jplmm_idx_19_0 * jplmm_array_stride(jplmm_index_base_19, 0);
                 jplmm_word_load_f32(jplmm_index_base_19, 2 + jplmm_offset_19); }))))) + (({ int32_t jplmm_index_base_32 = ({ int32_t jplmm_index_base_30 = grid;
                 if (jplmm_index_base_30 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_30) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_30 = 0;
                 int32_t jplmm_idx_30_0 = jplmm_clamp_i32(jplmm_clamp_i32(jplmm_sat_add_i32(y, 1), 0, jplmm_sat_sub_i32(h, 1)), 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_30, 0) - 1));
                 jplmm_offset_30 += jplmm_idx_30_0 * jplmm_array_stride(jplmm_index_base_30, 0);
                 jplmm_array_slice(jplmm_index_base_30, 1, jplmm_offset_30); });
                 if (jplmm_index_base_32 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_32) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_32 = 0;
                 int32_t jplmm_idx_32_0 = jplmm_clamp_i32(x, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_32, 0) - 1));
                 jplmm_offset_32 += jplmm_idx_32_0 * jplmm_array_stride(jplmm_index_base_32, 0);
                 jplmm_word_load_f32(jplmm_index_base_32, 2 + jplmm_offset_32); }))))) + (({ int32_t jplmm_index_base_45 = ({ int32_t jplmm_index_base_36 = grid;
                 if (jplmm_index_base_36 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_36) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_36 = 0;
                 int32_t jplmm_idx_36_0 = jplmm_clamp_i32(y, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_36, 0) - 1));
                 jplmm_offset_36 += jplmm_idx_36_0 * jplmm_array_stride(jplmm_index_base_36, 0);
                 jplmm_array_slice(jplmm_index_base_36, 1, jplmm_offset_36); });
                 if (jplmm_index_base_45 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_45) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_45 = 0;
                 int32_t jplmm_idx_45_0 = jplmm_clamp_i32(jplmm_clamp_i32(jplmm_sat_sub_i32(x, 1), 0, jplmm_sat_sub_i32(w, 1)), 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_45, 0) - 1));
                 jplmm_offset_45 += jplmm_idx_45_0 * jplmm_array_stride(jplmm_index_base_45, 0);
                 jplmm_word_load_f32(jplmm_index_base_45, 2 + jplmm_offset_45); }))))) + (({ int32_t jplmm_index_base_58 = ({ int32_t jplmm_index_base_49 = grid;
                 if (jplmm_index_base_49 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_49) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_49 = 0;
                 int32_t jplmm_idx_49_0 = jplmm_clamp_i32(y, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_49, 0) - 1));
                 jplmm_offset_49 += jplmm_idx_49_0 * jplmm_array_stride(jplmm_index_base_49, 0);
                 jplmm_array_slice(jplmm_index_base_49, 1, jplmm_offset_49); });
                 if (jplmm_index_base_58 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_58) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_58 = 0;
                 int32_t jplmm_idx_58_0 = jplmm_clamp_i32(jplmm_clamp_i32(jplmm_sat_add_i32(x, 1), 0, jplmm_sat_sub_i32(w, 1)), 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_58, 0) - 1));
                 jplmm_offset_58 += jplmm_idx_58_0 * jplmm_array_stride(jplmm_index_base_58, 0);
                 jplmm_word_load_f32(jplmm_index_base_58, 2 + jplmm_offset_58); })))), 4.0f)));
              jplmm_cursor_62 += 1;
            }
          }
        }
      }
       jplmm_array_62; });
    return res;
  }
}

static int32_t blend_grid(int32_t grid, int32_t next, int32_t h, int32_t w, int32_t steps) {
  int32_t res = 0;
  float gate = 0.0f;
  for (;;) {
    gate = jplmm_nan_to_zero_f32((float)(jplmm_min_i32(1, jplmm_max_i32(0, steps))));
    res = ({ int32_t jplmm_array_93;
       int32_t jplmm_total_93 = 0;
       int32_t jplmm_body_cells_93 = 0;
       int32_t jplmm_dim_93_0 = 0;
       int32_t jplmm_dim_93_1 = 0;
      {
        int32_t jplmm_extent_93_0 = jplmm_max_i32(1, h);
        if (jplmm_dim_93_0 == 0) {
          jplmm_dim_93_0 = jplmm_extent_93_0;
        } else if (jplmm_dim_93_0 != jplmm_extent_93_0) {
          jplmm_panic("array body produced ragged dimensions");
        }
        for (int32_t y = 0; y < jplmm_extent_93_0; y += 1) {
          {
            int32_t jplmm_extent_93_1 = jplmm_max_i32(1, w);
            if (jplmm_dim_93_1 == 0) {
              jplmm_dim_93_1 = jplmm_extent_93_1;
            } else if (jplmm_dim_93_1 != jplmm_extent_93_1) {
              jplmm_panic("array body produced ragged dimensions");
            }
            for (int32_t x = 0; x < jplmm_extent_93_1; x += 1) {
              jplmm_total_93 += 1;
            }
          }
        }
      }
       jplmm_array_93 = jplmm_array_alloc_r2(jplmm_dim_93_0, jplmm_dim_93_1);
       int32_t jplmm_cursor_93 = 0;
      {
        int32_t jplmm_extent_93_0 = jplmm_max_i32(1, h);
        if (jplmm_dim_93_0 == 0) {
          jplmm_dim_93_0 = jplmm_extent_93_0;
        } else if (jplmm_dim_93_0 != jplmm_extent_93_0) {
          jplmm_panic("array body produced ragged dimensions");
        }
        for (int32_t y = 0; y < jplmm_extent_93_0; y += 1) {
          {
            int32_t jplmm_extent_93_1 = jplmm_max_i32(1, w);
            if (jplmm_dim_93_1 == 0) {
              jplmm_dim_93_1 = jplmm_extent_93_1;
            } else if (jplmm_dim_93_1 != jplmm_extent_93_1) {
              jplmm_panic("array body produced ragged dimensions");
            }
            for (int32_t x = 0; x < jplmm_extent_93_1; x += 1) {
              jplmm_word_store_f32(jplmm_array_93, 3 + jplmm_cursor_93, jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_index_base_78 = ({ int32_t jplmm_index_base_76 = grid;
                 if (jplmm_index_base_76 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_76) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_76 = 0;
                 int32_t jplmm_idx_76_0 = jplmm_clamp_i32(y, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_76, 0) - 1));
                 jplmm_offset_76 += jplmm_idx_76_0 * jplmm_array_stride(jplmm_index_base_76, 0);
                 jplmm_array_slice(jplmm_index_base_76, 1, jplmm_offset_76); });
                 if (jplmm_index_base_78 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_78) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_78 = 0;
                 int32_t jplmm_idx_78_0 = jplmm_clamp_i32(x, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_78, 0) - 1));
                 jplmm_offset_78 += jplmm_idx_78_0 * jplmm_array_stride(jplmm_index_base_78, 0);
                 jplmm_word_load_f32(jplmm_index_base_78, 2 + jplmm_offset_78); })) + (jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((gate) * (jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_index_base_84 = ({ int32_t jplmm_index_base_82 = next;
                 if (jplmm_index_base_82 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_82) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_82 = 0;
                 int32_t jplmm_idx_82_0 = jplmm_clamp_i32(y, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_82, 0) - 1));
                 jplmm_offset_82 += jplmm_idx_82_0 * jplmm_array_stride(jplmm_index_base_82, 0);
                 jplmm_array_slice(jplmm_index_base_82, 1, jplmm_offset_82); });
                 if (jplmm_index_base_84 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_84) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_84 = 0;
                 int32_t jplmm_idx_84_0 = jplmm_clamp_i32(x, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_84, 0) - 1));
                 jplmm_offset_84 += jplmm_idx_84_0 * jplmm_array_stride(jplmm_index_base_84, 0);
                 jplmm_word_load_f32(jplmm_index_base_84, 2 + jplmm_offset_84); })) - (({ int32_t jplmm_index_base_89 = ({ int32_t jplmm_index_base_87 = grid;
                 if (jplmm_index_base_87 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_87) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_87 = 0;
                 int32_t jplmm_idx_87_0 = jplmm_clamp_i32(y, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_87, 0) - 1));
                 jplmm_offset_87 += jplmm_idx_87_0 * jplmm_array_stride(jplmm_index_base_87, 0);
                 jplmm_array_slice(jplmm_index_base_87, 1, jplmm_offset_87); });
                 if (jplmm_index_base_89 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_89) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_89 = 0;
                 int32_t jplmm_idx_89_0 = jplmm_clamp_i32(x, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_89, 0) - 1));
                 jplmm_offset_89 += jplmm_idx_89_0 * jplmm_array_stride(jplmm_index_base_89, 0);
                 jplmm_word_load_f32(jplmm_index_base_89, 2 + jplmm_offset_89); })))))))))));
              jplmm_cursor_93 += 1;
            }
          }
        }
      }
       jplmm_array_93; });
    return res;
  }
}

static int32_t relax(int32_t grid, int32_t h, int32_t w, int32_t steps) {
  int32_t res = 0;
  int32_t next = 0;
  int32_t jplmm_rec_116_0 = 0;
  int32_t jplmm_rec_116_1 = 0;
  int32_t jplmm_rec_116_2 = 0;
  int32_t jplmm_rec_116_3 = 0;
  for (;;) {
    next = blend_grid(grid, smooth(grid, h, w), h, w, steps);
    res = grid;
    jplmm_rec_116_0 = next;
    jplmm_rec_116_1 = h;
    jplmm_rec_116_2 = w;
    jplmm_rec_116_3 = jplmm_max_i32(0, jplmm_sat_sub_i32(steps, 1));
    if (jplmm_eq_array_arr2_f32(jplmm_rec_116_0, grid) && jplmm_rec_116_1 == h && jplmm_rec_116_2 == w && jplmm_rec_116_3 == steps) {
      return res;
    }
    grid = jplmm_rec_116_0;
    h = jplmm_rec_116_1;
    w = jplmm_rec_116_2;
    steps = jplmm_rec_116_3;
    continue;
    return res;
  }
}

static float metric(int32_t grid, int32_t h, int32_t w) {
  float res = 0.0f;
  int32_t out = 0;
  for (;;) {
    out = relax(grid, h, w, 4);
    res = ({ float jplmm_sum_134 = 0.0f;
      {
        int32_t jplmm_extent_134_0 = jplmm_max_i32(1, h);
        for (int32_t y = 0; y < jplmm_extent_134_0; y += 1) {
          {
            int32_t jplmm_extent_134_1 = jplmm_max_i32(1, w);
            for (int32_t x = 0; x < jplmm_extent_134_1; x += 1) {
              jplmm_sum_134 = jplmm_nan_to_zero_f32((jplmm_sum_134) + (({ int32_t jplmm_index_base_133 = ({ int32_t jplmm_index_base_131 = out;
                 if (jplmm_index_base_131 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_131) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_131 = 0;
                 int32_t jplmm_idx_131_0 = jplmm_clamp_i32(y, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_131, 0) - 1));
                 jplmm_offset_131 += jplmm_idx_131_0 * jplmm_array_stride(jplmm_index_base_131, 0);
                 jplmm_array_slice(jplmm_index_base_131, 1, jplmm_offset_131); });
                 if (jplmm_index_base_133 == 0) {
                   jplmm_panic("indexing null array");
                 }
                 if (jplmm_array_rank(jplmm_index_base_133) < 1) {
                   jplmm_panic("array index rank mismatch");
                 }
                 int32_t jplmm_offset_133 = 0;
                 int32_t jplmm_idx_133_0 = jplmm_clamp_i32(x, 0, jplmm_max_i32(0, jplmm_array_dim(jplmm_index_base_133, 0) - 1));
                 jplmm_offset_133 += jplmm_idx_133_0 * jplmm_array_stride(jplmm_index_base_133, 0);
                 jplmm_word_load_f32(jplmm_index_base_133, 2 + jplmm_offset_133); })));
            }
          }
        }
      }
       jplmm_sum_134; });
    return res;
  }
}

static const float main__lut[1] = { 488.28125f };

static float main__generic(void) {
  float res = 0.0f;
  int32_t h = 0;
  int32_t w = 0;
  int32_t grid = 0;
  for (;;) {
    h = 4;
    w = 5;
    grid = ({ int32_t jplmm_array_151;
       int32_t jplmm_total_151 = 0;
       int32_t jplmm_body_cells_151 = 0;
       int32_t jplmm_dim_151_0 = 0;
       int32_t jplmm_dim_151_1 = 0;
      {
        int32_t jplmm_extent_151_0 = jplmm_max_i32(1, h);
        if (jplmm_dim_151_0 == 0) {
          jplmm_dim_151_0 = jplmm_extent_151_0;
        } else if (jplmm_dim_151_0 != jplmm_extent_151_0) {
          jplmm_panic("array body produced ragged dimensions");
        }
        for (int32_t y = 0; y < jplmm_extent_151_0; y += 1) {
          {
            int32_t jplmm_extent_151_1 = jplmm_max_i32(1, w);
            if (jplmm_dim_151_1 == 0) {
              jplmm_dim_151_1 = jplmm_extent_151_1;
            } else if (jplmm_dim_151_1 != jplmm_extent_151_1) {
              jplmm_panic("array body produced ragged dimensions");
            }
            for (int32_t x = 0; x < jplmm_extent_151_1; x += 1) {
              jplmm_total_151 += 1;
            }
          }
        }
      }
       jplmm_array_151 = jplmm_array_alloc_r2(jplmm_dim_151_0, jplmm_dim_151_1);
       int32_t jplmm_cursor_151 = 0;
      {
        int32_t jplmm_extent_151_0 = jplmm_max_i32(1, h);
        if (jplmm_dim_151_0 == 0) {
          jplmm_dim_151_0 = jplmm_extent_151_0;
        } else if (jplmm_dim_151_0 != jplmm_extent_151_0) {
          jplmm_panic("array body produced ragged dimensions");
        }
        for (int32_t y = 0; y < jplmm_extent_151_0; y += 1) {
          {
            int32_t jplmm_extent_151_1 = jplmm_max_i32(1, w);
            if (jplmm_dim_151_1 == 0) {
              jplmm_dim_151_1 = jplmm_extent_151_1;
            } else if (jplmm_dim_151_1 != jplmm_extent_151_1) {
              jplmm_panic("array body produced ragged dimensions");
            }
            for (int32_t x = 0; x < jplmm_extent_151_1; x += 1) {
              jplmm_word_store_f32(jplmm_array_151, 3 + jplmm_cursor_151, jplmm_nan_to_zero_f32((float)(jplmm_sat_mul_i32(jplmm_sat_add_i32(y, 1), jplmm_sat_add_i32(x, 2)))));
              jplmm_cursor_151 += 1;
            }
          }
        }
      }
       jplmm_array_151; });
    res = metric(grid, h, w);
    return res;
  }
}

static float main(void) {
  int32_t jplmm_lut_index = 0;
  if (1) {
    return main__lut[jplmm_lut_index];
  }
  return main__generic();
}

static int32_t __codex_examples_entry(int32_t seed) {
  int32_t res = 0;
  int32_t h = 0;
  int32_t w = 0;
  int32_t grid = 0;
  float out = 0.0f;
  for (;;) {
    h = 4;
    w = 5;
    grid = ({ int32_t jplmm_array_182;
       int32_t jplmm_total_182 = 0;
       int32_t jplmm_body_cells_182 = 0;
       int32_t jplmm_dim_182_0 = 0;
       int32_t jplmm_dim_182_1 = 0;
      {
        int32_t jplmm_extent_182_0 = jplmm_max_i32(1, h);
        if (jplmm_dim_182_0 == 0) {
          jplmm_dim_182_0 = jplmm_extent_182_0;
        } else if (jplmm_dim_182_0 != jplmm_extent_182_0) {
          jplmm_panic("array body produced ragged dimensions");
        }
        for (int32_t __grid_0_0 = 0; __grid_0_0 < jplmm_extent_182_0; __grid_0_0 += 1) {
          {
            int32_t jplmm_extent_182_1 = jplmm_max_i32(1, w);
            if (jplmm_dim_182_1 == 0) {
              jplmm_dim_182_1 = jplmm_extent_182_1;
            } else if (jplmm_dim_182_1 != jplmm_extent_182_1) {
              jplmm_panic("array body produced ragged dimensions");
            }
            for (int32_t __grid_0_1 = 0; __grid_0_1 < jplmm_extent_182_1; __grid_0_1 += 1) {
              jplmm_total_182 += 1;
            }
          }
        }
      }
       jplmm_array_182 = jplmm_array_alloc_r2(jplmm_dim_182_0, jplmm_dim_182_1);
       int32_t jplmm_cursor_182 = 0;
      {
        int32_t jplmm_extent_182_0 = jplmm_max_i32(1, h);
        if (jplmm_dim_182_0 == 0) {
          jplmm_dim_182_0 = jplmm_extent_182_0;
        } else if (jplmm_dim_182_0 != jplmm_extent_182_0) {
          jplmm_panic("array body produced ragged dimensions");
        }
        for (int32_t __grid_0_0 = 0; __grid_0_0 < jplmm_extent_182_0; __grid_0_0 += 1) {
          {
            int32_t jplmm_extent_182_1 = jplmm_max_i32(1, w);
            if (jplmm_dim_182_1 == 0) {
              jplmm_dim_182_1 = jplmm_extent_182_1;
            } else if (jplmm_dim_182_1 != jplmm_extent_182_1) {
              jplmm_panic("array body produced ragged dimensions");
            }
            for (int32_t __grid_0_1 = 0; __grid_0_1 < jplmm_extent_182_1; __grid_0_1 += 1) {
              jplmm_word_store_f32(jplmm_array_182, 3 + jplmm_cursor_182, jplmm_nan_to_zero_f32((jplmm_nan_to_zero_f32((jplmm_nan_to_zero_f32(jplmm_total_div_f32(jplmm_nan_to_zero_f32((float)(jplmm_abs_i32(jplmm_sat_add_i32(seed, 11)))), 3.0f))) + (jplmm_nan_to_zero_f32(jplmm_total_div_f32(jplmm_nan_to_zero_f32((float)(__grid_0_0)), 2.0f))))) + (jplmm_nan_to_zero_f32(jplmm_total_div_f32(jplmm_nan_to_zero_f32((float)(__grid_0_1)), 3.0f)))));
              jplmm_cursor_182 += 1;
            }
          }
        }
      }
       jplmm_array_182; });
    out = metric(grid, h, w);
    res = jplmm_trunc_sat_f32_to_i32(jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((out) * (1024.0f))));
    return res;
  }
}

int main(int argc, char **argv) {
  long iterations = argc > 1 ? strtol(argv[1], NULL, 10) : 1;
  if (iterations < 1) {
    iterations = 1;
  }
  int32_t result = 0;
  for (long i = 0; i < iterations; i += 1) {
    jplmm_reset_heap();
    result = __codex_examples_entry((argc > 2 ? (int32_t)strtol(argv[2], NULL, 10) : 0));
  }
  printf("%d\n", result);
  return 0;
}
