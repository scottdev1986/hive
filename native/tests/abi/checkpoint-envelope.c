#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const uint8_t fixture[] =
  "HVTCP001"
  "\000\001" "\000\164" "\000\000\000\000"
  "\000\000\000\000\000\000\000\052"
  "\000\000\000\000\000\000\000\007"
  "\000\000\000\120" "\000\000\000\030"
  "\000\011\000\000" "\000\022\000\000"
  "\000\001\002\003\004\005\006\007"
  "\010\011\012\013\014\015\016\017"
  "\020\021\022\023\024\025\026\027"
  "\030\031\032\033\034\035\036\037"
  "\000\000\000\003"
  "\272\170\026\277\217\001\317\352"
  "\101\101\100\336\135\256\042\043"
  "\260\003\141\243\226\027\172\234"
  "\264\020\377\141\362\000\025\255";

static uint16_t read_be16(const uint8_t *bytes) {
  return (uint16_t)(((uint16_t)bytes[0] << 8U) | bytes[1]);
}

static uint32_t read_be32(const uint8_t *bytes) {
  return ((uint32_t)bytes[0] << 24U) |
    ((uint32_t)bytes[1] << 16U) |
    ((uint32_t)bytes[2] << 8U) |
    bytes[3];
}

static uint64_t read_be64(const uint8_t *bytes) {
  return ((uint64_t)read_be32(bytes) << 32U) | read_be32(bytes + 4);
}

int main(void) {
  static const uint8_t payload_sha256[32] = {
    0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
    0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
    0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
    0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad
  };
  if (sizeof(fixture) != 117U) return 1;
  if (memcmp(fixture, "HVTCP001", 8U) != 0) return 2;
  if (read_be16(fixture + 8) != 1U) return 3;
  if (read_be16(fixture + 10) != 116U) return 4;
  if (read_be32(fixture + 12) != 0U) return 5;
  if (read_be64(fixture + 16) != 42U) return 6;
  if (read_be64(fixture + 24) != 7U) return 7;
  if (read_be32(fixture + 32) != 80U) return 8;
  if (read_be32(fixture + 36) != 24U) return 9;
  if (read_be32(fixture + 40) != 0x00090000U) return 10;
  if (read_be32(fixture + 44) != 0x00120000U) return 11;
  if (fixture[48] != 0U || fixture[79] != 31U) return 12;
  if (read_be32(fixture + 80) != 3U) return 13;
  if (memcmp(fixture + 84, payload_sha256, sizeof(payload_sha256)) != 0)
    return 14;

  /* Dual-source lock: when HVTCP001_FIXTURE_PATH is set, the on-disk 116-byte
   * fixture (consumed by Zig @embedFile) must match this C static array byte
   * for byte — otherwise Zig and C can drift while both suites stay green. */
  const char *path = getenv("HVTCP001_FIXTURE_PATH");
  if (path != NULL) {
    FILE *file = fopen(path, "rb");
    if (file == NULL) return 20;
    uint8_t disk[116];
    const size_t n = fread(disk, 1U, sizeof(disk), file);
    int trailing = fgetc(file);
    fclose(file);
    if (n != sizeof(disk)) return 21;
    if (trailing != EOF) return 22;
    if (memcmp(disk, fixture, sizeof(disk)) != 0) return 23;
  }
  return 0;
}
