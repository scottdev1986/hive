/* Gate 6 (M1-B1) live proof — HEADLESS checkpoint authoring path.
 *
 * Adjudicated split (queen, 2026-07-18): checkpoint AUTHORING belongs to a
 * headless libghostty-vt terminal (the host/sessiond side, which owns the
 * ordered output stream); the embedded UI surface is a restore-only
 * consumer (hive_ghostty_surface_restore_checkpoint_v1). This harness
 * qualifies the authoring contract against the SHIPPED lib-vt artifact:
 * export determinism, import round-trip, rejection of truncation /
 * targeted header corruption (magic, version, engine-build-id binding,
 * payload digest, body) / fuzzed garbage, null-argument safety, and
 * no-poisoning after failed imports.
 *
 * Format facts (hive_checkpoint.zig): payload = "HVGCP001" magic(8) +
 * version u16(2) + engine build id (self-hashing identity string starting
 * at offset 10: pinned commit + zig toolchain shas + the patch sources
 * themselves) + structural terminal/handler/pending state, bounded at
 * max_payload_bytes (64 MiB). decode() validates magic, version, build
 * id, structural completeness (r.done()), and the size bound. It has NO
 * body integrity digest BY DESIGN: at-rest/in-flight integrity is the
 * HOST transport envelope's job (HVTCP001, which carries a payload
 * sha256 — native/tests/abi/checkpoint-envelope.c), so a body bit-flip
 * may import as different-but-well-formed state at this layer. That
 * layering is part of the fork contract and is exercised as such below.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <ghostty/vt.h>

/* Hive fork-contract symbols (native/include/hive_ghostty_bridge.h;
 * signatures pinned there and by scripts/check-ghostty-abi.sh — declared
 * locally because the bridge header pulls in the embedded-app ghostty.h,
 * which the vt-only artifact deliberately does not ship). */
extern const char *hive_ghostty_engine_build_id_v1(void);
extern GhosttyResult hive_ghostty_terminal_checkpoint_export_v1(
    GhosttyTerminal terminal,
    void *(*alloc_fn)(void *context, size_t length, size_t alignment),
    void *context, uint8_t **payload, size_t *length);
extern GhosttyResult hive_ghostty_terminal_checkpoint_import_v1(
    GhosttyTerminal terminal, const uint8_t *payload, size_t length);

static int failures = 0;
#define CHECK(cond, name)                                            \
  do {                                                               \
    if (!(cond)) {                                                   \
      failures++;                                                    \
      (void)fprintf(stderr, "FAIL: %s (%s:%d)\n", name, __FILE__, __LINE__); \
    }                                                                \
  } while (0)

static void *test_alloc(void *context, size_t length, size_t alignment) {
  void *ptr = NULL;
  (void)context;
  if (alignment < sizeof(void *)) alignment = sizeof(void *);
  if (posix_memalign(&ptr, alignment, length) != 0) return NULL;
  return ptr;
}

static GhosttyTerminal new_terminal(void) {
  GhosttyTerminal t = NULL;
  GhosttyTerminalOptions opts;
  memset(&opts, 0, sizeof(opts));
  opts.cols = 80;
  opts.rows = 24;
  opts.max_scrollback = 1000;
  if (ghostty_terminal_new(NULL, &t, opts) != GHOSTTY_SUCCESS) return NULL;
  return t;
}

static void feed(GhosttyTerminal t, const char *bytes, size_t len) {
  ghostty_terminal_vt_write(t, (const uint8_t *)bytes, len);
}

static uint8_t *export_or_null(GhosttyTerminal t, size_t *len) {
  uint8_t *payload = NULL;
  *len = 0;
  if (hive_ghostty_terminal_checkpoint_export_v1(
          t, test_alloc, NULL, &payload, len) != GHOSTTY_SUCCESS)
    return NULL;
  return payload;
}

/* Deterministic PRNG — no time/random seeding, reproducible corpus. */
static uint64_t rng_state = 0x9e3779b97f4a7c15ULL;
static uint64_t rng_next(void) {
  rng_state ^= rng_state << 13;
  rng_state ^= rng_state >> 7;
  rng_state ^= rng_state << 17;
  return rng_state;
}

int main(int argc, char **argv) {
  const char *out_dir = (argc > 1) ? argv[1] : NULL;
  const char *build_id = hive_ghostty_engine_build_id_v1();
  CHECK(build_id != NULL && build_id[0] != '\0', "engine build id non-empty");

  /* Author a terminal with representative state: text, SGR color, a
   * title, an incomplete UTF-8 lead byte (parser/partial-codepoint state
   * the gate explicitly names). */
  GhosttyTerminal author = new_terminal();
  CHECK(author != NULL, "author terminal created");
  static const char content[] =
      "hello \xc3\xa9 world\r\n\x1b[31mred\x1b[0m\x1b]2;hive-title\x1b\\\xc3";
  feed(author, content, sizeof(content) - 1);

  /* Export determinism: two exports of unchanged state are byte-equal. */
  size_t len1 = 0, len2 = 0;
  uint8_t *pay1 = export_or_null(author, &len1);
  uint8_t *pay2 = export_or_null(author, &len2);
  CHECK(pay1 != NULL && len1 > 116, "first export succeeds and exceeds header");
  CHECK(pay2 != NULL && len2 == len1 && memcmp(pay1, pay2, len1) == 0,
        "export is deterministic (two exports byte-identical)");
  free(pay2);

  /* Round-trip: import into a fresh terminal, re-export, byte-identical. */
  GhosttyTerminal restored = new_terminal();
  CHECK(restored != NULL, "restore terminal created");
  CHECK(hive_ghostty_terminal_checkpoint_import_v1(restored, pay1, len1) ==
            GHOSTTY_SUCCESS,
        "import of a valid checkpoint succeeds");
  size_t len3 = 0;
  uint8_t *pay3 = export_or_null(restored, &len3);
  CHECK(pay3 != NULL && len3 == len1 && memcmp(pay1, pay3, len1) == 0,
        "import -> re-export round-trips byte-identically");
  free(pay3);

  /* The restored terminal is live: it accepts further writes and exports. */
  feed(restored, "more\r\n", 6);
  size_t len4 = 0;
  uint8_t *pay4 = export_or_null(restored, &len4);
  CHECK(pay4 != NULL && len4 > 0, "restored terminal stays usable");
  free(pay4);

  /* Truncation: every shortened prefix is rejected, and a rejected import
   * never poisons the terminal for a following valid one. */
  GhosttyTerminal victim = new_terminal();
  CHECK(victim != NULL, "victim terminal created");
  const size_t truncations[] = {0, 1, 57, 115, len1 - 1};
  for (size_t i = 0; i < sizeof(truncations) / sizeof(truncations[0]); i++) {
    CHECK(hive_ghostty_terminal_checkpoint_import_v1(
              victim, pay1, truncations[i]) != GHOSTTY_SUCCESS,
          "truncated checkpoint rejected");
    CHECK(hive_ghostty_terminal_checkpoint_import_v1(victim, pay1, len1) ==
              GHOSTTY_SUCCESS,
          "valid import still succeeds after a rejected truncation");
  }

  /* Targeted corruption at format-locked offsets: magic@0, version@8,
   * ENGINE BUILD ID first byte @10 (build binding: the id is
   * self-hashing over the pinned commit, zig toolchain, and the patch
   * sources, so a different build can never import). */
  const size_t corrupt_offsets[] = {0, 8, 10};
  const char *corrupt_names[] = {
      "magic corruption rejected", "version corruption rejected",
      "engine-build-id corruption rejected (build binding)"};
  for (size_t i = 0; i < sizeof(corrupt_offsets) / sizeof(corrupt_offsets[0]);
       i++) {
    uint8_t *mutant = malloc(len1);
    CHECK(mutant != NULL, "mutant allocation");
    if (mutant == NULL) continue;
    memcpy(mutant, pay1, len1);
    mutant[corrupt_offsets[i]] ^= 0xFFU;
    CHECK(hive_ghostty_terminal_checkpoint_import_v1(
              victim, mutant, len1) != GHOSTTY_SUCCESS,
          corrupt_names[i]);
    free(mutant);
  }

  /* Body corruption: this layer deliberately carries no body digest
   * (integrity = HVTCP001 host envelope), so a tail bit-flip may decode
   * as different-but-well-formed state. The contract here is bounded
   * behavior: no crash, and the terminal stays fully usable either way. */
  {
    uint8_t *mutant = malloc(len1);
    CHECK(mutant != NULL, "body mutant allocation");
    if (mutant != NULL) {
      memcpy(mutant, pay1, len1);
      mutant[len1 - 2] ^= 0xFFU;
      (void)hive_ghostty_terminal_checkpoint_import_v1(victim, mutant, len1);
      free(mutant);
      CHECK(hive_ghostty_terminal_checkpoint_import_v1(victim, pay1, len1) ==
                GHOSTTY_SUCCESS,
            "valid import still succeeds after a body-corrupted attempt");
    }
  }

  /* Fuzz-lite: deterministic garbage, half of it wearing a valid magic to
   * get past the first gate. Import must reject everything, never crash. */
  for (int i = 0; i < 512; i++) {
    size_t flen = (size_t)(rng_next() % 2048U) + 1U;
    uint8_t *fuzz = malloc(flen);
    CHECK(fuzz != NULL, "fuzz allocation");
    if (fuzz == NULL) continue;
    for (size_t b = 0; b < flen; b++) fuzz[b] = (uint8_t)rng_next();
    if ((i % 2) == 0 && flen >= 8) memcpy(fuzz, "HVGCP001", 8);
    CHECK(hive_ghostty_terminal_checkpoint_import_v1(victim, fuzz, flen) !=
              GHOSTTY_SUCCESS,
          "fuzzed payload rejected");
    free(fuzz);
  }
  size_t len5 = 0;
  uint8_t *pay5 = export_or_null(victim, &len5);
  CHECK(pay5 != NULL, "terminal still exports after 512 rejected fuzz imports");
  free(pay5);

  /* Null/degenerate arguments are errors, never crashes. */
  CHECK(hive_ghostty_terminal_checkpoint_import_v1(victim, NULL, 10) !=
            GHOSTTY_SUCCESS,
        "null payload rejected");
  CHECK(hive_ghostty_terminal_checkpoint_import_v1(NULL, pay1, len1) !=
            GHOSTTY_SUCCESS,
        "null terminal rejected");
  {
    uint8_t *out = NULL;
    size_t outlen = 0;
    CHECK(hive_ghostty_terminal_checkpoint_export_v1(NULL, test_alloc, NULL,
                                                     &out, &outlen) !=
              GHOSTTY_SUCCESS,
          "export from null terminal rejected");
    CHECK(hive_ghostty_terminal_checkpoint_export_v1(author, NULL, NULL, &out,
                                                     &outlen) !=
              GHOSTTY_SUCCESS,
          "export with null allocator rejected");
  }

  /* Optional argv[1]: directory to write the authored payload into, as a
   * cross-artifact fixture for the Swift surface-restore live proof
   * (Gate6SurfaceRestoreTests restores this exact payload into a REAL
   * embedded surface — authoring and restoring are different libraries
   * that must agree byte-for-byte on the format). The fed `content`
   * constant above is the other half of that fixture contract; the Swift
   * test asserts the restored screen shows exactly that content. */
  if (out_dir != NULL) {
    char path[4096];
    (void)snprintf(path, sizeof(path), "%s/authored.hvgcp", out_dir);
    FILE *f = fopen(path, "wb");
    CHECK(f != NULL, "fixture file opened for write");
    if (f != NULL) {
      CHECK(fwrite(pay1, 1, len1, f) == len1, "fixture payload written");
      CHECK(fclose(f) == 0, "fixture file closed");
    }
  }

  free(pay1);
  ghostty_terminal_free(author);
  ghostty_terminal_free(restored);
  ghostty_terminal_free(victim);

  if (failures != 0) {
    (void)fprintf(stderr, "headless checkpoint harness: %d failure(s)\n",
                  failures);
    return 1;
  }
  (void)printf("headless checkpoint harness: all checks passed\n");
  return 0;
}
