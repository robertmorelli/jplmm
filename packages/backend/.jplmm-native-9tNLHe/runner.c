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

static int jplmm_eq_struct_Tracker(int32_t a, int32_t b) {
  if (a == b) return 1;
  if (a == 0 || b == 0) return 0;
  if (!(jplmm_eq_f32_ulp1(jplmm_word_load_f32(a, 0), jplmm_word_load_f32(b, 0)))) return 0;
  if (!(jplmm_eq_f32_ulp1(jplmm_word_load_f32(a, 1), jplmm_word_load_f32(b, 1)))) return 0;
  if (!(jplmm_eq_f32_ulp1(jplmm_word_load_f32(a, 2), jplmm_word_load_f32(b, 2)))) return 0;
  if (!(jplmm_eq_f32_ulp1(jplmm_word_load_f32(a, 3), jplmm_word_load_f32(b, 3)))) return 0;
  return 1;
}

static int32_t step(int32_t state);
static int32_t blend_tracker(int32_t current, int32_t next, int32_t steps);
static int32_t iterate(int32_t state, int32_t steps);
static float score(int32_t state);
static float main__generic(void);
static float main(void);
static int32_t __codex_examples_entry(int32_t seed);

static int32_t step(int32_t state) {
  int32_t res = 0;
  for (;;) {
    res = ({ int32_t jplmm_struct_31 = jplmm_alloc_words(4);
       jplmm_word_store_f32(jplmm_struct_31, 0, jplmm_nan_to_zero_f32(jplmm_total_div_f32(jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_3 = state;
       if (jplmm_field_base_3 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_3, 0); })) * (({ int32_t jplmm_field_base_5 = state;
       if (jplmm_field_base_5 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_5, 3); }))))) + (({ int32_t jplmm_field_base_8 = state;
       if (jplmm_field_base_8 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_8, 2); })))), jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_11 = state;
       if (jplmm_field_base_11 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_11, 3); })) + (1.0f))))));
       jplmm_word_store_f32(jplmm_struct_31, 1, jplmm_nan_to_zero_f32(jplmm_total_div_f32(jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_16 = state;
       if (jplmm_field_base_16 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_16, 1); })) + (jplmm_nan_to_zero_f32(jplmm_total_div_f32(jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_18 = state;
       if (jplmm_field_base_18 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_18, 2); })) - (({ int32_t jplmm_field_base_20 = state;
       if (jplmm_field_base_20 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_20, 0); })))), 2.0f))))), 2.0f)));
       jplmm_word_store_f32(jplmm_struct_31, 2, ({ int32_t jplmm_field_base_28 = state;
       if (jplmm_field_base_28 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_28, 2); }));
       jplmm_word_store_f32(jplmm_struct_31, 3, ({ int32_t jplmm_field_base_30 = state;
       if (jplmm_field_base_30 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_30, 3); }));
       jplmm_struct_31; });
    return res;
  }
}

static int32_t blend_tracker(int32_t current, int32_t next, int32_t steps) {
  int32_t res = 0;
  float gate = 0.0f;
  for (;;) {
    gate = jplmm_nan_to_zero_f32((float)(jplmm_min_i32(1, jplmm_max_i32(0, steps))));
    res = ({ int32_t jplmm_struct_81 = jplmm_alloc_words(4);
       jplmm_word_store_f32(jplmm_struct_81, 0, jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_42 = current;
       if (jplmm_field_base_42 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_42, 0); })) + (jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((gate) * (jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_45 = next;
       if (jplmm_field_base_45 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_45, 0); })) - (({ int32_t jplmm_field_base_47 = current;
       if (jplmm_field_base_47 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_47, 0); })))))))))));
       jplmm_word_store_f32(jplmm_struct_81, 1, jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_52 = current;
       if (jplmm_field_base_52 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_52, 1); })) + (jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((gate) * (jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_55 = next;
       if (jplmm_field_base_55 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_55, 1); })) - (({ int32_t jplmm_field_base_57 = current;
       if (jplmm_field_base_57 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_57, 1); })))))))))));
       jplmm_word_store_f32(jplmm_struct_81, 2, jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_62 = current;
       if (jplmm_field_base_62 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_62, 2); })) + (jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((gate) * (jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_65 = next;
       if (jplmm_field_base_65 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_65, 2); })) - (({ int32_t jplmm_field_base_67 = current;
       if (jplmm_field_base_67 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_67, 2); })))))))))));
       jplmm_word_store_f32(jplmm_struct_81, 3, jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_72 = current;
       if (jplmm_field_base_72 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_72, 3); })) + (jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((gate) * (jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_75 = next;
       if (jplmm_field_base_75 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_75, 3); })) - (({ int32_t jplmm_field_base_77 = current;
       if (jplmm_field_base_77 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_77, 3); })))))))))));
       jplmm_struct_81; });
    return res;
  }
}

static int32_t iterate(int32_t state, int32_t steps) {
  int32_t res = 0;
  int32_t next = 0;
  int32_t jplmm_rec_98_0 = 0;
  int32_t jplmm_rec_98_1 = 0;
  for (;;) {
    next = blend_tracker(state, step(state), steps);
    res = state;
    jplmm_rec_98_0 = next;
    jplmm_rec_98_1 = jplmm_max_i32(0, jplmm_sat_sub_i32(steps, 1));
    if (jplmm_eq_struct_Tracker(jplmm_rec_98_0, state) && jplmm_rec_98_1 == steps) {
      return res;
    }
    state = jplmm_rec_98_0;
    steps = jplmm_rec_98_1;
    continue;
    return res;
  }
}

static float score(int32_t state) {
  float res = 0.0f;
  int32_t out = 0;
  for (;;) {
    out = iterate(state, 4);
    res = jplmm_nan_to_zero_f32(jplmm_nan_to_zero_f32((({ int32_t jplmm_field_base_108 = out;
       if (jplmm_field_base_108 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_108, 0); })) + (jplmm_nan_to_zero_f32(jplmm_total_div_f32(({ int32_t jplmm_field_base_110 = out;
       if (jplmm_field_base_110 == 0) {
         jplmm_panic("field access on null struct");
       }
       jplmm_word_load_f32(jplmm_field_base_110, 1); }), 4.0f)))));
    return res;
  }
}

static const float main__lut[1] = { 6.824845314025879f };

static float main__generic(void) {
  float res = 0.0f;
  for (;;) {
    res = score(({ int32_t jplmm_struct_120 = jplmm_alloc_words(4);
       jplmm_word_store_f32(jplmm_struct_120, 0, 0.0f);
       jplmm_word_store_f32(jplmm_struct_120, 1, 0.0f);
       jplmm_word_store_f32(jplmm_struct_120, 2, 8.0f);
       jplmm_word_store_f32(jplmm_struct_120, 3, 2.0f);
       jplmm_struct_120; }));
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
  int32_t state = 0;
  float out = 0.0f;
  for (;;) {
    state = ({ int32_t jplmm_struct_152 = jplmm_alloc_words(4);
       jplmm_word_store_f32(jplmm_struct_152, 0, jplmm_nan_to_zero_f32(jplmm_total_div_f32(jplmm_nan_to_zero_f32((float)(jplmm_abs_i32(jplmm_sat_add_i32(seed, 16)))), 3.0f)));
       jplmm_word_store_f32(jplmm_struct_152, 1, jplmm_nan_to_zero_f32(jplmm_total_div_f32(jplmm_nan_to_zero_f32((float)(jplmm_abs_i32(jplmm_sat_add_i32(seed, 18)))), 3.0f)));
       jplmm_word_store_f32(jplmm_struct_152, 2, jplmm_nan_to_zero_f32(jplmm_total_div_f32(jplmm_nan_to_zero_f32((float)(jplmm_abs_i32(jplmm_sat_add_i32(seed, 23)))), 3.0f)));
       jplmm_word_store_f32(jplmm_struct_152, 3, jplmm_nan_to_zero_f32(jplmm_total_div_f32(jplmm_nan_to_zero_f32((float)(jplmm_abs_i32(jplmm_sat_add_i32(seed, 14)))), 3.0f)));
       jplmm_struct_152; });
    out = score(state);
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
