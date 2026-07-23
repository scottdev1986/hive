const std = @import("std");
const builtin = @import("builtin");
const generated = @import("session_protocol_generated");

/// Maximum opaque checkpoint payload accepted by the streamed producer and
/// legacy contiguous importer (§18 / §23). The old allocating producer stays
/// at 64 MiB; larger checkpoints must use the bounded streaming path.
pub const checkpoint_max_bytes: usize = 512 * 1024 * 1024;
pub const checkpoint_contiguous_max_bytes: usize = 64 * 1024 * 1024;
pub const checkpoint_stream_chunk_bytes: usize = 64 * 1024;

fn buildIdBytes(comptime value: *const [64]u8) [32]u8 {
    var result: [32]u8 = undefined;
    inline for (0..32) |index| {
        const high = std.fmt.charToDigit(value[index * 2], 16) catch
            @compileError("invalid legacy checkpoint build id");
        const low = std.fmt.charToDigit(value[index * 2 + 1], 16) catch
            @compileError("invalid legacy checkpoint build id");
        result[index] = (high << 4) | low;
    }
    return result;
}

pub const legacy_engine_build_id: [32]u8 = switch (builtin.target.cpu.arch) {
    .aarch64 => buildIdBytes("9b78f469a4efe2e513d4377766c2a5092fcaca5146a2d401e2709bece542118b"),
    .x86_64 => buildIdBytes("ea592b32749f04556e942e0358c3360e423659f4d6bb23b719f81fc14b2cf349"),
    else => @splat(0),
};

pub fn acceptsEngineBuildId(candidate: *const [32]u8, current: *const [32]u8) bool {
    // DELIBERATELY coarse outer-envelope gate: sessiond does not know the
    // engine's c_abi/runtime-safety build configuration. The inner HVGCP001
    // decoder applies that precise second gate before reading engine state.
    if (std.mem.eql(u8, candidate, current)) return true;
    return switch (builtin.target.cpu.arch) {
        .aarch64, .x86_64 => std.mem.eql(u8, candidate, &legacy_engine_build_id),
        else => false,
    };
}

// ── HVTCP001 envelope (116 bytes, network byte order) ───────────────────────

pub const header_bytes: usize = generated.checkpoint.header_bytes;
pub const magic = generated.checkpoint.magic;
pub const version: u16 = generated.checkpoint.version;
pub const flags_v1: u32 = generated.checkpoint.flags;
pub const engine_build_id_bytes: usize = generated.checkpoint.engine_build_id_bytes;
pub const payload_sha256_bytes: usize = generated.checkpoint.payload_sha256_bytes;

// HVTCP001 field offsets (network layout, §23 / CHECKPOINT_HEADER.offsets).
// Local table is dual-sourced against generated.checkpoint.offset: if the
// generator re-emits a moved boundary and this table is not updated, comptime fails.
pub const off = struct {
    pub const magic: usize = 0;
    pub const version: usize = 8;
    pub const header_bytes: usize = 10;
    pub const flags: usize = 12;
    pub const through_seq: usize = 16;
    pub const created_mono_nanos: usize = 24;
    pub const columns: usize = 32;
    pub const rows: usize = 36;
    pub const cell_width_px: usize = 40;
    pub const cell_height_px: usize = 44;
    pub const engine_build_id: usize = 48;
    pub const payload_length: usize = 80;
    pub const payload_sha256: usize = 84;
};

comptime {
    if (checkpoint_max_bytes != generated.limits.checkpoint_bytes)
        @compileError("checkpoint payload limit drifted from generated protocol");
    if (header_bytes != 116) @compileError("CHECKPOINT_HEADER.bytes must be 116");
    if (magic.len != 8) @compileError("CHECKPOINT_HEADER.magic must be 8 ASCII bytes");
    if (engine_build_id_bytes != 32) @compileError("engineBuildId must be 32 bytes");
    if (payload_sha256_bytes != 32) @compileError("payloadSha256 must be 32 bytes");
    if (off.payload_sha256 + payload_sha256_bytes != header_bytes)
        @compileError("payload_sha256 offset + width must equal header_bytes");
    // F4 drift guard: every interior offset must match the generated projection.
    if (off.magic != generated.checkpoint.offset.magic)
        @compileError("checkpoint offset magic drifted from generated");
    if (off.version != generated.checkpoint.offset.version)
        @compileError("checkpoint offset version drifted from generated");
    if (off.header_bytes != generated.checkpoint.offset.header_bytes)
        @compileError("checkpoint offset header_bytes drifted from generated");
    if (off.flags != generated.checkpoint.offset.flags)
        @compileError("checkpoint offset flags drifted from generated");
    if (off.through_seq != generated.checkpoint.offset.through_seq)
        @compileError("checkpoint offset through_seq drifted from generated");
    if (off.created_mono_nanos != generated.checkpoint.offset.created_mono_nanos)
        @compileError("checkpoint offset created_mono_nanos drifted from generated");
    if (off.columns != generated.checkpoint.offset.columns)
        @compileError("checkpoint offset columns drifted from generated");
    if (off.rows != generated.checkpoint.offset.rows)
        @compileError("checkpoint offset rows drifted from generated");
    if (off.cell_width_px != generated.checkpoint.offset.cell_width_px)
        @compileError("checkpoint offset cell_width_px drifted from generated");
    if (off.cell_height_px != generated.checkpoint.offset.cell_height_px)
        @compileError("checkpoint offset cell_height_px drifted from generated");
    if (off.engine_build_id != generated.checkpoint.offset.engine_build_id)
        @compileError("checkpoint offset engine_build_id drifted from generated");
    if (off.payload_length != generated.checkpoint.offset.payload_length)
        @compileError("checkpoint offset payload_length drifted from generated");
    if (off.payload_sha256 != generated.checkpoint.offset.payload_sha256)
        @compileError("checkpoint offset payload_sha256 drifted from generated");
    // Width lock: last field still covers the full header when widths move alone.
    if (generated.checkpoint.width.payload_sha256 != payload_sha256_bytes)
        @compileError("checkpoint width payload_sha256 drifted from generated size");
    if (off.payload_sha256 + generated.checkpoint.width.payload_sha256 != header_bytes)
        @compileError("generated payload_sha256 offset + width must equal header_bytes");
}

/// Decoded / to-encode HVTCP001 header fields (excluding the trailing opaque payload).
pub const CheckpointHeader = struct {
    through_seq: u64,
    created_mono_nanos: u64,
    columns: u32,
    rows: u32,
    /// Unsigned fixed-point 16.16 cell width in pixels; 0 when unknown.
    cell_width_px_16_16: u32,
    /// Unsigned fixed-point 16.16 cell height in pixels; 0 when unknown.
    cell_height_px_16_16: u32,
    engine_build_id: [32]u8,
    payload_length: u32,
    payload_sha256: [32]u8,
};

pub const EnvelopeError = error{
    WrongMagic,
    WrongVersion,
    WrongHeaderBytes,
    WrongFlags,
    Truncated,
    PayloadLengthMismatch,
    PayloadSha256Mismatch,
    PayloadTooLarge,
    EngineMismatch,
};

pub const Error = error{
    CheckpointUnavailable,
    EngineMismatch,
    PayloadTooLarge,
    JournalPressure,
    IoFailed,
    Internal,
    Closed,
} || EnvelopeError || std.mem.Allocator.Error;

// ── Envelope encode / decode ────────────────────────────────────────────────

/// Encode the 116-byte HVTCP001 header into `out`. Network byte order.
pub fn encodeHeader(header: CheckpointHeader, out: *[header_bytes]u8) void {
    @memset(out, 0);
    @memcpy(out[off.magic..][0..8], magic);
    std.mem.writeInt(u16, out[off.version..][0..2], version, .big);
    std.mem.writeInt(u16, out[off.header_bytes..][0..2], @as(u16, @intCast(header_bytes)), .big);
    std.mem.writeInt(u32, out[off.flags..][0..4], flags_v1, .big);
    std.mem.writeInt(u64, out[off.through_seq..][0..8], header.through_seq, .big);
    std.mem.writeInt(u64, out[off.created_mono_nanos..][0..8], header.created_mono_nanos, .big);
    std.mem.writeInt(u32, out[off.columns..][0..4], header.columns, .big);
    std.mem.writeInt(u32, out[off.rows..][0..4], header.rows, .big);
    std.mem.writeInt(u32, out[off.cell_width_px..][0..4], header.cell_width_px_16_16, .big);
    std.mem.writeInt(u32, out[off.cell_height_px..][0..4], header.cell_height_px_16_16, .big);
    @memcpy(out[off.engine_build_id..][0..32], &header.engine_build_id);
    std.mem.writeInt(u32, out[off.payload_length..][0..4], header.payload_length, .big);
    @memcpy(out[off.payload_sha256..][0..32], &header.payload_sha256);
}

/// Decode and validate fixed fields of a 116-byte header. Does not check payload.
pub fn decodeHeader(bytes: *const [header_bytes]u8) EnvelopeError!CheckpointHeader {
    if (!std.mem.eql(u8, bytes[off.magic..][0..8], magic)) return error.WrongMagic;
    const ver = std.mem.readInt(u16, bytes[off.version..][0..2], .big);
    if (ver != version) return error.WrongVersion;
    const hb = std.mem.readInt(u16, bytes[off.header_bytes..][0..2], .big);
    if (hb != header_bytes) return error.WrongHeaderBytes;
    const fl = std.mem.readInt(u32, bytes[off.flags..][0..4], .big);
    if (fl != flags_v1) return error.WrongFlags;

    var engine_build_id: [32]u8 = undefined;
    @memcpy(&engine_build_id, bytes[off.engine_build_id..][0..32]);
    var payload_sha256: [32]u8 = undefined;
    @memcpy(&payload_sha256, bytes[off.payload_sha256..][0..32]);

    return .{
        .through_seq = std.mem.readInt(u64, bytes[off.through_seq..][0..8], .big),
        .created_mono_nanos = std.mem.readInt(u64, bytes[off.created_mono_nanos..][0..8], .big),
        .columns = std.mem.readInt(u32, bytes[off.columns..][0..4], .big),
        .rows = std.mem.readInt(u32, bytes[off.rows..][0..4], .big),
        .cell_width_px_16_16 = std.mem.readInt(u32, bytes[off.cell_width_px..][0..4], .big),
        .cell_height_px_16_16 = std.mem.readInt(u32, bytes[off.cell_height_px..][0..4], .big),
        .engine_build_id = engine_build_id,
        .payload_length = std.mem.readInt(u32, bytes[off.payload_length..][0..4], .big),
        .payload_sha256 = payload_sha256,
    };
}

/// Assemble header + opaque payload into an owned file image. Computes payload SHA-256.
pub const CheckpointFields = struct {
    through_seq: u64,
    created_mono_nanos: u64,
    columns: u32,
    rows: u32,
    cell_width_px_16_16: u32,
    cell_height_px_16_16: u32,
    engine_build_id: *const [32]u8,
};

pub fn assembleEnvelope(
    allocator: std.mem.Allocator,
    fields: CheckpointFields,
    opaque_payload: []const u8,
) Error![]u8 {
    if (opaque_payload.len > checkpoint_contiguous_max_bytes) return error.PayloadTooLarge;
    if (opaque_payload.len > std.math.maxInt(u32)) return error.PayloadTooLarge;

    var sha: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(opaque_payload, &sha, .{});

    const header = CheckpointHeader{
        .through_seq = fields.through_seq,
        .created_mono_nanos = fields.created_mono_nanos,
        .columns = fields.columns,
        .rows = fields.rows,
        .cell_width_px_16_16 = fields.cell_width_px_16_16,
        .cell_height_px_16_16 = fields.cell_height_px_16_16,
        .engine_build_id = fields.engine_build_id.*,
        .payload_length = @intCast(opaque_payload.len),
        .payload_sha256 = sha,
    };

    const total = header_bytes + opaque_payload.len;
    const out = try allocator.alloc(u8, total);
    errdefer allocator.free(out);
    encodeHeader(header, out[0..header_bytes]);
    if (opaque_payload.len > 0) {
        @memcpy(out[header_bytes..][0..opaque_payload.len], opaque_payload);
    }
    return out;
}

/// Parse an assembled checkpoint file: validate header + payload length + sha256.
/// On success returns header; caller slices payload as `file[header_bytes..][0..header.payload_length]`.
pub fn parseEnvelope(file: []const u8) EnvelopeError!CheckpointHeader {
    if (file.len < header_bytes) return error.Truncated;
    const header = try decodeHeader(file[0..header_bytes]);
    if (header.payload_length > checkpoint_max_bytes) return error.PayloadTooLarge;
    const expected_total = header_bytes + @as(usize, header.payload_length);
    if (file.len != expected_total) return error.PayloadLengthMismatch;
    const payload = file[header_bytes..][0..header.payload_length];
    var sha: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(payload, &sha, .{});
    if (!std.mem.eql(u8, &sha, &header.payload_sha256)) return error.PayloadSha256Mismatch;
    return header;
}

/// Verify payload bytes alone against a header's length + digest (import path).
pub fn verifyPayload(header: CheckpointHeader, payload: []const u8) EnvelopeError!void {
    if (payload.len != header.payload_length) return error.PayloadLengthMismatch;
    if (payload.len > checkpoint_max_bytes) return error.PayloadTooLarge;
    var sha: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(payload, &sha, .{});
    if (!std.mem.eql(u8, &sha, &header.payload_sha256)) return error.PayloadSha256Mismatch;
}
