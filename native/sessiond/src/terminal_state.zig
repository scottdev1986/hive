//! §18/§20/§23 terminal_state — headless VT + durable journal/checkpoint.
//!
//! Owns: feed every PTY output byte through an injected VT engine, write back
//! ONLY PTY-bound effects (GHOSTTY_TERMINAL_OPT_WRITE_PTY), maintain journal.bin,
//! assemble the 116-byte HVTCP001 envelope AROUND the bridge's opaque export,
//! dual-retain verified checkpoints, and import-verify into a FRESH terminal +
//! digest BEFORE atomic rename.
//!
//! Does NOT own: input arbitration, process kill, viewer grants, PTY open/spawn.
//!
//! Assumption A2 (load-bearing): TG2 opaque-payload completeness may still be
//! incomplete. An incomplete / failed checkpoint yields CHECKPOINT_UNAVAILABLE —
//! never a silent "mostly restored" path. Envelope + journal paths are testable
//! with an export double before full TG2 (export double injected via VtEngine).
//!
//! Authority: docs/design/terminal-stack-transition.html §18 limits, §20 wire
//! (exclusive high-water seq), §23 checkpoint create/attach/restore + envelope.
//! Machine source for header layout: CHECKPOINT_HEADER in
//! src/schemas/session-protocol.ts / session_protocol.generated.zig.

const std = @import("std");
const generated = @import("session_protocol_generated");
const hvtcp001_header = @import("hvtcp001_header");

// ── Limits (§18 / TERMINAL_LIMITS) ──────────────────────────────────────────

/// Replay journal capacity per generation (§18).
pub const journal_max_bytes: usize = 64 * 1024 * 1024;
/// Maximum opaque checkpoint payload (§18 / §23).
pub const checkpoint_max_bytes: usize = 64 * 1024 * 1024;
/// Dual retain: newest valid + previous valid (§18).
pub const retained_checkpoints: usize = 2;
/// Stream chunk bound for OUTPUT / SNAPSHOT_BYTES (§18).
pub const stream_chunk_max_bytes: usize = 64 * 1024;
/// Checkpoint after this much new output since last verified checkpoint (§23).
pub const checkpoint_output_interval_bytes: u64 = 2 * 1024 * 1024;
/// Checkpoint after this many nanoseconds of mono time since last verified (§23).
pub const checkpoint_interval_ns: u64 = 30 * std.time.ns_per_s;

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
const off = struct {
    const magic: usize = 0;
    const version: usize = 8;
    const header_bytes: usize = 10;
    const flags: usize = 12;
    const through_seq: usize = 16;
    const created_mono_nanos: usize = 24;
    const columns: usize = 32;
    const rows: usize = 36;
    const cell_width_px: usize = 40;
    const cell_height_px: usize = 44;
    const engine_build_id: usize = 48;
    const payload_length: usize = 80;
    const payload_sha256: usize = 84;
};

comptime {
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

// ── Injected seams (export double before full TG2) ──────────────────────────

/// PTY-bound write sink — only GHOSTTY_TERMINAL_OPT_WRITE_PTY effects land here.
pub const PtyEffectSink = struct {
    context: *anyopaque,
    writeFn: *const fn (context: *anyopaque, bytes: []const u8) anyerror!void,

    pub fn write(self: PtyEffectSink, bytes: []const u8) anyerror!void {
        return self.writeFn(self.context, bytes);
    }
};

/// One headless VT engine instance (live terminal or a fresh verify terminal).
///
/// Production wires libghostty-vt + hive_ghostty_terminal_checkpoint_export_v1 /
/// import_v1. Tests inject an export double so envelope/journal paths are
/// proven without requiring TG2 completeness.
///
/// Contract:
/// - `write` feeds PTY output bytes; may emit PTY-bound effects via the
///   registered sink (engine-owned).
/// - `exportOpaque` returns a slice OWNED BY THE PASSED ZIG ALLOCATOR.
///   Caller always frees with `allocator.free`. The real bridge export
///   (`hive_ghostty_terminal_checkpoint_export_v1`) returns C-allocated
///   memory via the bridge alloc_fn — the host-composition ADAPTER MUST
///   copy that payload into the Zig allocator (or free via the matching
///   C free path) before returning from exportFn. Returning a C heap
///   pointer that TerminalState later `allocator.free`s is heap corruption.
///   On error → CHECKPOINT_UNAVAILABLE (never "mostly restored").
/// - `importOpaque` leaves the destination UNCHANGED on failure (§23).
/// - `digest` is a deterministic semantic fingerprint for restore equality.
pub const VtEngine = struct {
    context: *anyopaque,
    deinitFn: *const fn (context: *anyopaque) void,
    writeFn: *const fn (context: *anyopaque, bytes: []const u8) anyerror!void,
    /// See ownership contract above — Zig-allocator-owned on success.
    exportFn: *const fn (context: *anyopaque, allocator: std.mem.Allocator) anyerror![]u8,
    importFn: *const fn (context: *anyopaque, payload: []const u8) anyerror!void,
    digestFn: *const fn (context: *anyopaque) [32]u8,
    /// Snapshot of PTY-bound effect bytes collected since create/import (for TG2 stream compare).
    effectsFn: *const fn (context: *anyopaque) []const u8,

    pub fn deinit(self: VtEngine) void {
        self.deinitFn(self.context);
    }

    pub fn write(self: VtEngine, bytes: []const u8) anyerror!void {
        return self.writeFn(self.context, bytes);
    }

    pub fn exportOpaque(self: VtEngine, allocator: std.mem.Allocator) anyerror![]u8 {
        return self.exportFn(self.context, allocator);
    }

    pub fn importOpaque(self: VtEngine, payload: []const u8) anyerror!void {
        return self.importFn(self.context, payload);
    }

    pub fn digest(self: VtEngine) [32]u8 {
        return self.digestFn(self.context);
    }

    pub fn effects(self: VtEngine) []const u8 {
        return self.effectsFn(self.context);
    }
};

/// Factory that builds a fresh engine for import-verify (§23: import into a FRESH terminal).
pub const VtEngineFactory = struct {
    context: *anyopaque,
    createFn: *const fn (
        context: *anyopaque,
        allocator: std.mem.Allocator,
        columns: u32,
        rows: u32,
    ) anyerror!VtEngine,

    pub fn create(
        self: VtEngineFactory,
        allocator: std.mem.Allocator,
        columns: u32,
        rows: u32,
    ) anyerror!VtEngine {
        return self.createFn(self.context, allocator, columns, rows);
    }
};

/// Mono-clock source (injectable for deterministic checkpoint-interval tests).
pub const Clock = struct {
    context: *anyopaque,
    nowFn: *const fn (context: *anyopaque) u64,

    pub fn now(self: Clock) u64 {
        return self.nowFn(self.context);
    }
};

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
pub fn assembleEnvelope(
    allocator: std.mem.Allocator,
    fields: struct {
        through_seq: u64,
        created_mono_nanos: u64,
        columns: u32,
        rows: u32,
        cell_width_px_16_16: u32,
        cell_height_px_16_16: u32,
        engine_build_id: *const [32]u8,
    },
    opaque_payload: []const u8,
) Error![]u8 {
    if (opaque_payload.len > checkpoint_max_bytes) return error.PayloadTooLarge;
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

// ── In-memory journal (file persistence is host composition / disk layer) ───

/// Exclusive-high-water byte journal. `start_seq` is the exclusive start of
/// retained bytes (every byte with offset in [start_seq, end_seq) is present).
/// `end_seq` == host `outputSeq` (exclusive next write offset) (§20).
pub const Journal = struct {
    allocator: std.mem.Allocator,
    /// First retained exclusive sequence (bytes below this have been covered by a
    /// verified checkpoint and may have been evicted).
    start_seq: u64 = 0,
    bytes: std.ArrayList(u8) = .{},

    pub fn init(allocator: std.mem.Allocator) Journal {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Journal) void {
        self.bytes.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn endSeq(self: *const Journal) u64 {
        return self.start_seq + self.bytes.items.len;
    }

    pub fn retainedBytes(self: *const Journal) usize {
        return self.bytes.items.len;
    }

    /// Append PTY output; rejects if journal would exceed capacity.
    /// Caller MUST checkpoint/evict when `wouldExceed` before appending.
    pub fn append(self: *Journal, data: []const u8) Error!void {
        if (data.len == 0) return;
        if (self.bytes.items.len + data.len > journal_max_bytes) return error.JournalPressure;
        try self.bytes.appendSlice(self.allocator, data);
    }

    pub fn wouldExceed(self: *const Journal, additional: usize) bool {
        return self.bytes.items.len + additional > journal_max_bytes;
    }

    /// Evict bytes with exclusive end ≤ `through_seq` (i.e. all bytes below
    /// through_seq). Refuses if through_seq is not covered by retained range
    /// start (cannot invent a hole). Never evicts past end_seq.
    pub fn evictThrough(self: *Journal, through_seq: u64) Error!void {
        if (through_seq < self.start_seq) return; // already evicted
        if (through_seq > self.endSeq()) return error.Internal;
        const drop: usize = @intCast(through_seq - self.start_seq);
        if (drop == 0) return;
        const remain = self.bytes.items[drop..];
        // Shift remaining bytes to front.
        std.mem.copyForwards(u8, self.bytes.items[0..remain.len], remain);
        self.bytes.shrinkRetainingCapacity(remain.len);
        self.start_seq = through_seq;
    }

    /// Slice journal bytes beginning exactly at `from_seq` (exclusive high-water
    /// of a checkpoint). Empty if from_seq == end_seq. Error if from_seq is
    /// outside retained range (would invent missing history).
    pub fn sliceFrom(self: *const Journal, from_seq: u64) Error![]const u8 {
        if (from_seq < self.start_seq) return error.CheckpointUnavailable;
        if (from_seq > self.endSeq()) return error.Internal;
        const off_i: usize = @intCast(from_seq - self.start_seq);
        return self.bytes.items[off_i..];
    }
};

// ── Dual-retained checkpoint store ──────────────────────────────────────────

pub const StoredCheckpoint = struct {
    /// Assembled file image (header + opaque payload). Owned.
    file: []u8,
    header: CheckpointHeader,

    pub fn deinit(self: *StoredCheckpoint, allocator: std.mem.Allocator) void {
        allocator.free(self.file);
        self.* = undefined;
    }

    pub fn opaquePayload(self: *const StoredCheckpoint) []const u8 {
        return self.file[header_bytes..][0..self.header.payload_length];
    }
};

/// Newest at index 0, previous at index 1. Both must be import-verified.
pub const CheckpointStore = struct {
    allocator: std.mem.Allocator,
    slots: [retained_checkpoints]?StoredCheckpoint = .{ null, null },

    pub fn init(allocator: std.mem.Allocator) CheckpointStore {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *CheckpointStore) void {
        for (&self.slots) |*slot| {
            if (slot.*) |*cp| cp.deinit(self.allocator);
            slot.* = null;
        }
        self.* = undefined;
    }

    pub fn newest(self: *const CheckpointStore) ?*const StoredCheckpoint {
        if (self.slots[0]) |*cp| return cp;
        return null;
    }

    pub fn previous(self: *const CheckpointStore) ?*const StoredCheckpoint {
        if (self.slots[1]) |*cp| return cp;
        return null;
    }

    /// Push a newly verified checkpoint as newest; demote previous newest;
    /// drop oldest. Takes ownership of `file`.
    pub fn pushVerified(self: *CheckpointStore, file: []u8, header: CheckpointHeader) void {
        if (self.slots[1]) |*old| old.deinit(self.allocator);
        self.slots[1] = self.slots[0];
        self.slots[0] = .{ .file = file, .header = header };
    }
};

// ── TerminalState ───────────────────────────────────────────────────────────

pub const Geometry = struct {
    columns: u32,
    rows: u32,
    cell_width_px_16_16: u32 = 0,
    cell_height_px_16_16: u32 = 0,
};

pub const TerminalState = struct {
    allocator: std.mem.Allocator,
    engine: VtEngine,
    factory: VtEngineFactory,
    clock: Clock,
    /// Raw 32-byte engine build id embedded in every envelope (from bridge; do not compute).
    engine_build_id: [32]u8,

    geometry: Geometry,
    journal: Journal,
    checkpoints: CheckpointStore,

    /// Exclusive next PTY-output byte offset (§20 outputSeq).
    output_seq: u64 = 0,
    /// throughSeq of newest valid checkpoint; 0 when none (§20 checkpointSeq).
    checkpoint_seq: u64 = 0,
    /// Bytes of output since last verified checkpoint (for 2 MiB interval).
    bytes_since_checkpoint: u64 = 0,
    /// Mono nanos of last verified checkpoint (or create).
    last_checkpoint_mono: u64 = 0,
    /// When true, reconnect must surface CHECKPOINT_UNAVAILABLE (no silent approx).
    reconnect_available: bool = true,
    closed: bool = false,

    pub fn init(
        allocator: std.mem.Allocator,
        engine: VtEngine,
        factory: VtEngineFactory,
        clock: Clock,
        engine_build_id: *const [32]u8,
        geometry: Geometry,
    ) TerminalState {
        const now = clock.now();
        return .{
            .allocator = allocator,
            .engine = engine,
            .factory = factory,
            .clock = clock,
            .engine_build_id = engine_build_id.*,
            .geometry = geometry,
            .journal = Journal.init(allocator),
            .checkpoints = CheckpointStore.init(allocator),
            .last_checkpoint_mono = now,
        };
    }

    pub fn deinit(self: *TerminalState) void {
        self.engine.deinit();
        self.journal.deinit();
        self.checkpoints.deinit();
        self.* = undefined;
    }

    pub fn outputSeq(self: *const TerminalState) u64 {
        return self.output_seq;
    }

    pub fn checkpointSeq(self: *const TerminalState) u64 {
        return self.checkpoint_seq;
    }

    pub fn checkpointAvailable(self: *const TerminalState) bool {
        return self.reconnect_available and self.checkpoints.newest() != null;
    }

    /// Feed PTY output: journal first (durability), then VT. On journal pressure,
    /// checkpoint-first then keep draining (§18). Never drops bytes silently.
    pub fn feedOutput(self: *TerminalState, data: []const u8) Error!void {
        if (self.closed) return error.Closed;
        if (data.len == 0) return;

        // Split only for the stream-chunk bound; journal still receives contiguous ranges.
        var offset: usize = 0;
        while (offset < data.len) {
            const take = @min(stream_chunk_max_bytes, data.len - offset);
            const chunk = data[offset..][0..take];
            try self.feedChunk(chunk);
            offset += take;
        }
    }

    fn feedChunk(self: *TerminalState, chunk: []const u8) Error!void {
        if (self.journal.wouldExceed(chunk.len)) {
            // Checkpoint-first, then evict covered prefix; if still no room, mark
            // reconnect unavailable but CONTINUE draining (§18 journal limit).
            const cp_result = self.tryCheckpoint();
            if (cp_result) |_| {
                // Eviction of covered prefix happens inside tryCheckpoint on success.
            } else |_| {
                self.reconnect_available = false;
            }
            if (self.journal.wouldExceed(chunk.len)) {
                // Still over capacity: cannot retain required replay bytes. Mark
                // unavailable and drop oldest only if a verified checkpoint covers them.
                if (self.checkpoints.newest()) |cp| {
                    // Evict only through verified throughSeq; if that frees enough, proceed.
                    try self.journal.evictThrough(cp.header.through_seq);
                }
                if (self.journal.wouldExceed(chunk.len)) {
                    // Required replay would be lost — refuse silent discard of
                    // uncovered bytes; still drain VT so the PTY does not stall,
                    // but reconnect is unavailable and journal retains what it can
                    // by force-dropping ONLY bytes already covered (none left).
                    self.reconnect_available = false;
                    // Drop from the front only up to remaining capacity; uncovered
                    // bytes would be lost → we instead drop the whole journal after
                    // marking unavailable (no verified covering checkpoint remains
                    // that frees space). Journal after this is incomplete.
                    self.journal.bytes.clearRetainingCapacity();
                    self.journal.start_seq = self.output_seq; // hole from prior start..now
                }
            }
        }

        // F1: engine.write FIRST, then journal on success. Journal-before-write
        // left end_seq > output_seq when write failed → later checkpoint used a
        // stale through_seq and restoreInto silently diverged (§23 forbids).
        self.engine.write(chunk) catch {
            self.reconnect_available = false;
            return error.Internal;
        };
        self.journal.append(chunk) catch |err| {
            // Engine accepted bytes the journal could not retain — reconnect
            // would diverge. Never claim a clean restore from here.
            self.reconnect_available = false;
            return err;
        };
        self.output_seq += chunk.len;
        self.bytes_since_checkpoint += chunk.len;

        if (self.shouldCheckpoint()) {
            self.tryCheckpoint() catch {
                // Interval failure does not abort output drain; surface via flag.
                self.reconnect_available = false;
            };
        }
    }

    fn shouldCheckpoint(self: *const TerminalState) bool {
        if (self.bytes_since_checkpoint >= checkpoint_output_interval_bytes) return true;
        const now = self.clock.now();
        if (now -% self.last_checkpoint_mono >= checkpoint_interval_ns) return true;
        return false;
    }

    /// Create a verified checkpoint: export opaque → assemble envelope → import
    /// into a FRESH terminal + digest compare → retain. Failure yields
    /// CHECKPOINT_UNAVAILABLE (and leaves store unchanged).
    pub fn tryCheckpoint(self: *TerminalState) Error!void {
        if (self.closed) return error.Closed;

        // Export opaque payload from the live engine (bridge / double).
        const opaque_payload = self.engine.exportOpaque(self.allocator) catch |err| {
            self.reconnect_available = false;
            return switch (err) {
                error.OutOfMemory => error.OutOfMemory,
                else => error.CheckpointUnavailable,
            };
        };
        defer self.allocator.free(opaque_payload);

        if (opaque_payload.len == 0) {
            // Empty opaque is never a valid complete checkpoint (§23 / A2).
            self.reconnect_available = false;
            return error.CheckpointUnavailable;
        }
        if (opaque_payload.len > checkpoint_max_bytes) {
            self.reconnect_available = false;
            return error.PayloadTooLarge;
        }

        const through_seq = self.output_seq;
        const created = self.clock.now();
        const file = assembleEnvelope(self.allocator, .{
            .through_seq = through_seq,
            .created_mono_nanos = created,
            .columns = self.geometry.columns,
            .rows = self.geometry.rows,
            .cell_width_px_16_16 = self.geometry.cell_width_px_16_16,
            .cell_height_px_16_16 = self.geometry.cell_height_px_16_16,
            .engine_build_id = &self.engine_build_id,
        }, opaque_payload) catch |err| {
            self.reconnect_available = false;
            return err;
        };
        // Ownership: free on every failure path; transfer to store only after verify.
        var retained = false;
        defer if (!retained) self.allocator.free(file);

        // Parse/verify self-consistency of the assembled file.
        const header = parseEnvelope(file) catch {
            self.reconnect_available = false;
            return error.CheckpointUnavailable;
        };

        // Import-verify into a FRESH terminal + compare digests (§23).
        const live_digest = self.engine.digest();
        var fresh = self.factory.create(
            self.allocator,
            self.geometry.columns,
            self.geometry.rows,
        ) catch {
            self.reconnect_available = false;
            return error.CheckpointUnavailable;
        };
        defer fresh.deinit();

        // Import leaves destination unchanged on failure (§23).
        fresh.importOpaque(opaque_payload) catch {
            self.reconnect_available = false;
            return error.CheckpointUnavailable;
        };
        const restored_digest = fresh.digest();
        if (!std.mem.eql(u8, &live_digest, &restored_digest)) {
            // Incomplete opaque payload (A2 / TG2): not a silent "mostly restored".
            self.reconnect_available = false;
            return error.CheckpointUnavailable;
        }

        // Atomic retain (in-memory: push after verify). Disk layer would
        // write temp → fsync → rename; that is host composition.
        self.checkpoints.pushVerified(file, header);
        retained = true;
        self.checkpoint_seq = through_seq;
        self.bytes_since_checkpoint = 0;
        self.last_checkpoint_mono = created;
        self.reconnect_available = true;

        // Evict journal bytes covered by the verified checkpoint.
        try self.journal.evictThrough(through_seq);
    }

    /// Restore path for attach: import newest verified checkpoint into `dest`,
    /// then replay journal bytes beginning exactly at throughSeq. Returns the
    /// high-water after restore (output_seq). Incomplete / missing checkpoint
    /// yields CHECKPOINT_UNAVAILABLE — never approximates.
    pub fn restoreInto(self: *const TerminalState, dest: VtEngine) Error!u64 {
        if (!self.reconnect_available) return error.CheckpointUnavailable;
        const cp = self.checkpoints.newest() orelse return error.CheckpointUnavailable;

        if (!std.mem.eql(u8, &cp.header.engine_build_id, &self.engine_build_id)) {
            return error.EngineMismatch;
        }

        // Re-verify envelope integrity before import. parseEnvelope already
        // checks length + payload SHA-256 — do not re-hash (F6) or leak raw
        // EnvelopeError (no wire code for sha/length mismatch).
        const header = parseEnvelope(cp.file) catch return error.CheckpointUnavailable;
        const payload = cp.opaquePayload();

        dest.importOpaque(payload) catch return error.CheckpointUnavailable;

        // Replay journal from throughSeq exclusively.
        const tail = try self.journal.sliceFrom(header.through_seq);
        if (tail.len > 0) {
            dest.write(tail) catch return error.Internal;
        }
        return self.output_seq;
    }

    /// Disk-style write of newest checkpoint to `dir` as checkpoint-0.bin (and
    /// previous as checkpoint-1.bin). Atomic: write .tmp, fsync, rename.
    pub fn persistCheckpoints(self: *const TerminalState, dir: std.fs.Dir) Error!void {
        if (self.checkpoints.newest()) |cp| {
            try writeAtomic(dir, "checkpoint-0.bin", cp.file);
        }
        if (self.checkpoints.previous()) |cp| {
            try writeAtomic(dir, "checkpoint-1.bin", cp.file);
        }
    }

    /// Persist journal.bin atomically with mode 0600 on the file itself.
    pub fn persistJournal(self: *const TerminalState, dir: std.fs.Dir) Error!void {
        // Layout: 16-byte prefix (start_seq u64 BE + end_seq u64 BE) + raw bytes.
        var prefix: [16]u8 = undefined;
        std.mem.writeInt(u64, prefix[0..8], self.journal.start_seq, .big);
        std.mem.writeInt(u64, prefix[8..16], self.journal.endSeq(), .big);

        const total = prefix.len + self.journal.bytes.items.len;
        const buf = try self.allocator.alloc(u8, total);
        defer self.allocator.free(buf);
        @memcpy(buf[0..16], &prefix);
        if (self.journal.bytes.items.len > 0) {
            @memcpy(buf[16..][0..self.journal.bytes.items.len], self.journal.bytes.items);
        }
        try writeAtomic(dir, "journal.bin", buf);
    }
};

fn writeAtomic(dir: std.fs.Dir, name: []const u8, bytes: []const u8) Error!void {
    // Stack temp name — names are short (checkpoint-0.bin / journal.bin).
    var tmp_buf: [64]u8 = undefined;
    const tmp_name = std.fmt.bufPrint(&tmp_buf, "{s}.tmp", .{name}) catch
        return error.Internal;

    const fd = std.posix.openat(dir.fd, tmp_name, .{
        .ACCMODE = .WRONLY,
        .CREAT = true,
        .TRUNC = true,
        .NOFOLLOW = true,
        .CLOEXEC = true,
    }, 0o600) catch return error.IoFailed;
    const file: std.fs.File = .{ .handle = fd };
    defer file.close();
    file.chmod(0o600) catch return error.IoFailed;
    file.writeAll(bytes) catch return error.IoFailed;
    file.sync() catch return error.IoFailed; // data durable
    dir.rename(tmp_name, name) catch return error.IoFailed;
    // F2 / §23: fsync the directory so the rename itself survives power loss.
    // Without this, checkpoint-0.bin may be absent/zero after crash even though
    // the file fsync succeeded.
    const dir_file: std.fs.File = .{ .handle = dir.fd };
    dir_file.sync() catch return error.IoFailed;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests — positive-control doctrine is mandatory.
// ═══════════════════════════════════════════════════════════════════════════

const testing = std.testing;

/// Liam's 116-byte HVTCP001 fixture — shared binary locked by
/// native/tests/abi/checkpoint-envelope.c via HVTCP001_FIXTURE_PATH (F5).
/// Do not hand-transcribe; edit hvtcp001-header.bin (and C static) together.
const liam_fixture: *const [header_bytes]u8 = hvtcp001_header.bytes;

comptime {
    if (liam_fixture.len != header_bytes)
        @compileError("hvtcp001-header.bin must be exactly 116 bytes");
}

fn writeBe16(buf: []u8, at: usize, v: u16) void {
    std.mem.writeInt(u16, buf[at..][0..2], v, .big);
}
fn writeBe32(buf: []u8, at: usize, v: u32) void {
    std.mem.writeInt(u32, buf[at..][0..4], v, .big);
}

test "envelope constants match generated CHECKPOINT_HEADER" {
    try testing.expectEqual(@as(usize, 116), header_bytes);
    try testing.expectEqualStrings("HVTCP001", magic);
    try testing.expectEqual(@as(u16, 1), version);
    try testing.expectEqual(@as(u32, 0), flags_v1);
}

// F4 positive control: local off table equals generated.checkpoint.offset.
// A deliberate interior mismatch (e.g. off.through_seq = 17 while generated
// stays 16) fails the comptime block above — this runtime test re-states the
// full table so a silent no-op comptime guard cannot hide.
test "envelope offsets match generated CHECKPOINT_HEADER.offsets" {
    try testing.expectEqual(generated.checkpoint.offset.magic, off.magic);
    try testing.expectEqual(generated.checkpoint.offset.version, off.version);
    try testing.expectEqual(generated.checkpoint.offset.header_bytes, off.header_bytes);
    try testing.expectEqual(generated.checkpoint.offset.flags, off.flags);
    try testing.expectEqual(generated.checkpoint.offset.through_seq, off.through_seq);
    try testing.expectEqual(generated.checkpoint.offset.created_mono_nanos, off.created_mono_nanos);
    try testing.expectEqual(generated.checkpoint.offset.columns, off.columns);
    try testing.expectEqual(generated.checkpoint.offset.rows, off.rows);
    try testing.expectEqual(generated.checkpoint.offset.cell_width_px, off.cell_width_px);
    try testing.expectEqual(generated.checkpoint.offset.cell_height_px, off.cell_height_px);
    try testing.expectEqual(generated.checkpoint.offset.engine_build_id, off.engine_build_id);
    try testing.expectEqual(generated.checkpoint.offset.payload_length, off.payload_length);
    try testing.expectEqual(generated.checkpoint.offset.payload_sha256, off.payload_sha256);
    try testing.expectEqual(@as(usize, 16), off.through_seq);
    try testing.expectEqual(@as(usize, 84), off.payload_sha256);
}

test "liam fixture positive control: decode succeeds with exact field values" {
    // Canary: if decode is dead code or fixture is wrong, this fails first.
    const h = try decodeHeader(liam_fixture);
    try testing.expectEqual(@as(u64, 42), h.through_seq);
    try testing.expectEqual(@as(u64, 7), h.created_mono_nanos);
    try testing.expectEqual(@as(u32, 80), h.columns);
    try testing.expectEqual(@as(u32, 24), h.rows);
    try testing.expectEqual(@as(u32, 0x00090000), h.cell_width_px_16_16);
    try testing.expectEqual(@as(u32, 0x00120000), h.cell_height_px_16_16);
    try testing.expectEqual(@as(u32, 3), h.payload_length);
    try testing.expectEqual(@as(u8, 0), h.engine_build_id[0]);
    try testing.expectEqual(@as(u8, 31), h.engine_build_id[31]);
    const expected_sha = [_]u8{
        0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
        0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
        0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
        0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
    };
    try testing.expectEqualSlices(u8, &expected_sha, &h.payload_sha256);
}

test "encodeHeader round-trips to liam fixture" {
    const h = try decodeHeader(liam_fixture);
    var out: [header_bytes]u8 = undefined;
    encodeHeader(h, &out);
    try testing.expectEqualSlices(u8, liam_fixture, &out);
}

test "wrong magic rejects (positive control: good fixture still decodes)" {
    // Positive control first — production decode path is alive.
    _ = try decodeHeader(liam_fixture);

    var bad = liam_fixture.*;
    bad[0] = 'X';
    try testing.expectError(error.WrongMagic, decodeHeader(&bad));
}

test "wrong headerBytes rejects (positive control alive)" {
    _ = try decodeHeader(liam_fixture);
    var bad = liam_fixture.*;
    // headerBytes at offset 10; set to 115
    writeBe16(&bad, 10, 115);
    try testing.expectError(error.WrongHeaderBytes, decodeHeader(&bad));
}

test "wrong version rejects" {
    _ = try decodeHeader(liam_fixture);
    var bad = liam_fixture.*;
    writeBe16(&bad, 8, 2);
    try testing.expectError(error.WrongVersion, decodeHeader(&bad));
}

test "wrong flags rejects" {
    _ = try decodeHeader(liam_fixture);
    var bad = liam_fixture.*;
    writeBe32(&bad, 12, 1);
    try testing.expectError(error.WrongFlags, decodeHeader(&bad));
}

test "assembleEnvelope + parseEnvelope with abc payload (liam sha)" {
    var engine_id: [32]u8 = undefined;
    for (&engine_id, 0..) |*b, i| b.* = @intCast(i);

    const payload = "abc";
    const file = try assembleEnvelope(testing.allocator, .{
        .through_seq = 42,
        .created_mono_nanos = 7,
        .columns = 80,
        .rows = 24,
        .cell_width_px_16_16 = 0x00090000,
        .cell_height_px_16_16 = 0x00120000,
        .engine_build_id = &engine_id,
    }, payload);
    defer testing.allocator.free(file);

    try testing.expectEqual(@as(usize, header_bytes + 3), file.len);
    try testing.expectEqualSlices(u8, liam_fixture, file[0..header_bytes]);
    try testing.expectEqualStrings("abc", file[header_bytes..]);

    const h = try parseEnvelope(file);
    try testing.expectEqual(@as(u64, 42), h.through_seq);
    try testing.expectEqual(@as(u32, 3), h.payload_length);
}

test "parseEnvelope rejects truncated and corrupt payload (positive control)" {
    var engine_id: [32]u8 = undefined;
    @memset(&engine_id, 1);
    const file = try assembleEnvelope(testing.allocator, .{
        .through_seq = 1,
        .created_mono_nanos = 1,
        .columns = 80,
        .rows = 24,
        .cell_width_px_16_16 = 0,
        .cell_height_px_16_16 = 0,
        .engine_build_id = &engine_id,
    }, "ok");
    defer testing.allocator.free(file);

    // Positive control: good file parses.
    _ = try parseEnvelope(file);

    // Truncated
    try testing.expectError(error.Truncated, parseEnvelope(file[0 .. header_bytes - 1]));
    try testing.expectError(error.PayloadLengthMismatch, parseEnvelope(file[0 .. file.len - 1]));

    // Corrupt one opaque byte → sha mismatch
    var corrupt = try testing.allocator.dupe(u8, file);
    defer testing.allocator.free(corrupt);
    corrupt[header_bytes] ^= 0xff;
    try testing.expectError(error.PayloadSha256Mismatch, parseEnvelope(corrupt));
}

// ── Export-double VT engine for unit tests (A2 / pre-TG2) ───────────────────

/// Deterministic double: state = concatenation of written bytes; opaque export
/// is magic "MOCKCP01" + state; import replaces state; digest = SHA-256(state).
/// PTY effects: when input contains BEL (0x07), emits a single 0x07 as "effect"
/// stand-in (WRITE_PTY path is engine-owned; we record effect bytes).
const MockEngine = struct {
    allocator: std.mem.Allocator,
    state: std.ArrayList(u8) = .{},
    effect_log: std.ArrayList(u8) = .{},
    /// When true, export returns error (incomplete TG2 / export failure).
    fail_export: bool = false,
    /// When true, export returns empty payload (A2 incomplete).
    empty_export: bool = false,
    /// When true, export returns payload that won't round-trip digest.
    incomplete_export: bool = false,
    /// When true, write returns error (F1 fallible VT write).
    fail_write: bool = false,

    fn create(allocator: std.mem.Allocator) !*MockEngine {
        const self = try allocator.create(MockEngine);
        self.* = .{ .allocator = allocator };
        return self;
    }

    fn destroy(self: *MockEngine) void {
        self.state.deinit(self.allocator);
        self.effect_log.deinit(self.allocator);
        self.allocator.destroy(self);
    }

    fn engine(self: *MockEngine) VtEngine {
        return .{
            .context = self,
            .deinitFn = deinitCb,
            .writeFn = writeCb,
            .exportFn = exportCb,
            .importFn = importCb,
            .digestFn = digestCb,
            .effectsFn = effectsCb,
        };
    }

    fn deinitCb(ctx: *anyopaque) void {
        const self: *MockEngine = @ptrCast(@alignCast(ctx));
        self.destroy();
    }

    fn writeCb(ctx: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *MockEngine = @ptrCast(@alignCast(ctx));
        if (self.fail_write) return error.OutOfMemory;
        try self.state.appendSlice(self.allocator, bytes);
        // Record a stand-in PTY effect for BEL — proves effect stream is tracked.
        for (bytes) |b| {
            if (b == 0x07) try self.effect_log.append(self.allocator, 0x07);
        }
    }

    fn exportCb(ctx: *anyopaque, allocator: std.mem.Allocator) anyerror![]u8 {
        const self: *MockEngine = @ptrCast(@alignCast(ctx));
        if (self.fail_export) return error.CheckpointUnavailable;
        if (self.empty_export) return try allocator.alloc(u8, 0);
        if (self.incomplete_export) {
            // Deliberately incomplete: omit state so import digest ≠ live.
            // Still structurally valid so import succeeds but digests diverge.
            var out: std.ArrayList(u8) = .{};
            errdefer out.deinit(allocator);
            try out.appendSlice(allocator, "MOCKCP01");
            var sha: [32]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(&.{}, &sha, .{});
            try out.appendSlice(allocator, &sha);
            return try out.toOwnedSlice(allocator);
        }
        // Layout: "MOCKCP01" + state + sha256(state). Corrupt-any-byte fails import.
        var out: std.ArrayList(u8) = .{};
        errdefer out.deinit(allocator);
        try out.appendSlice(allocator, "MOCKCP01");
        try out.appendSlice(allocator, self.state.items);
        var sha: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(self.state.items, &sha, .{});
        try out.appendSlice(allocator, &sha);
        return try out.toOwnedSlice(allocator);
    }

    fn importCb(ctx: *anyopaque, payload: []const u8) anyerror!void {
        const self: *MockEngine = @ptrCast(@alignCast(ctx));
        // Validate mock payload. On failure leave destination UNCHANGED (§23).
        if (payload.len < 8 + 32 or !std.mem.eql(u8, payload[0..8], "MOCKCP01")) {
            return error.InvalidCheckpoint;
        }
        const body = payload[8 .. payload.len - 32];
        const got_sha = payload[payload.len - 32 ..];
        var expect_sha: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(body, &expect_sha, .{});
        if (!std.mem.eql(u8, got_sha, &expect_sha)) return error.InvalidCheckpoint;
        self.state.clearRetainingCapacity();
        try self.state.appendSlice(self.allocator, body);
    }

    fn digestCb(ctx: *anyopaque) [32]u8 {
        const self: *MockEngine = @ptrCast(@alignCast(ctx));
        var out: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(self.state.items, &out, .{});
        return out;
    }

    fn effectsCb(ctx: *anyopaque) []const u8 {
        const self: *MockEngine = @ptrCast(@alignCast(ctx));
        return self.effect_log.items;
    }
};

const MockFactory = struct {
    allocator: std.mem.Allocator,

    fn factory(self: *MockFactory) VtEngineFactory {
        return .{ .context = self, .createFn = createCb };
    }

    fn createCb(ctx: *anyopaque, allocator: std.mem.Allocator, columns: u32, rows: u32) anyerror!VtEngine {
        _ = columns;
        _ = rows;
        const self: *MockFactory = @ptrCast(@alignCast(ctx));
        _ = self;
        const eng = try MockEngine.create(allocator);
        return eng.engine();
    }
};

const MockClock = struct {
    nanos: u64 = 0,
    fn clock(self: *MockClock) Clock {
        return .{ .context = self, .nowFn = nowCb };
    }
    fn nowCb(ctx: *anyopaque) u64 {
        const self: *MockClock = @ptrCast(@alignCast(ctx));
        return self.nanos;
    }
};

fn testBuildId() [32]u8 {
    var id: [32]u8 = undefined;
    for (&id, 0..) |*b, i| b.* = @intCast(i);
    return id;
}

const TestState = struct {
    ts: TerminalState,
    factory: *MockFactory,
    clock: *MockClock,
    engine_ptr: *MockEngine,

    fn deinit(self: *TestState) void {
        self.ts.deinit();
        testing.allocator.destroy(self.factory);
        testing.allocator.destroy(self.clock);
    }
};

fn makeState() !TestState {
    const allocator = testing.allocator;
    const factory = try allocator.create(MockFactory);
    factory.* = .{ .allocator = allocator };
    const clock = try allocator.create(MockClock);
    clock.* = .{};
    const eng = try MockEngine.create(allocator);
    const id = testBuildId();
    const ts = TerminalState.init(
        allocator,
        eng.engine(),
        factory.factory(),
        clock.clock(),
        &id,
        .{ .columns = 80, .rows = 24 },
    );
    return .{ .ts = ts, .factory = factory, .clock = clock, .engine_ptr = eng };
}

test "feedOutput advances exclusive outputSeq and journals bytes" {
    var s = try makeState();
    defer s.deinit();

    try s.ts.feedOutput("hello");
    try testing.expectEqual(@as(u64, 5), s.ts.outputSeq());
    try testing.expectEqualStrings("hello", s.ts.journal.bytes.items);
    try testing.expectEqualStrings("hello", s.engine_ptr.state.items);
    // Invariant: journal.endSeq() == output_seq (§20 exclusive high-water).
    try testing.expectEqual(s.ts.outputSeq(), s.ts.journal.endSeq());
}

test "F1: engine.write failure preserves end_seq==output_seq (no silent diverge)" {
    var s = try makeState();
    defer s.deinit();

    try s.ts.feedOutput("ok");
    try testing.expectEqual(@as(u64, 2), s.ts.outputSeq());
    try testing.expectEqual(s.ts.outputSeq(), s.ts.journal.endSeq());
    try testing.expect(s.ts.reconnect_available);

    // Positive control: success path still works (production path not dead).
    try s.ts.feedOutput("more");
    try testing.expectEqual(@as(u64, 6), s.ts.outputSeq());
    try testing.expectEqual(s.ts.outputSeq(), s.ts.journal.endSeq());

    s.engine_ptr.fail_write = true;
    try testing.expectError(error.Internal, s.ts.feedOutput("FAIL"));

    // Journal must NOT have accepted the failed chunk; output_seq must not advance.
    try testing.expectEqual(@as(u64, 6), s.ts.outputSeq());
    try testing.expectEqual(s.ts.outputSeq(), s.ts.journal.endSeq());
    try testing.expectEqualStrings("okmore", s.ts.journal.bytes.items);
    try testing.expectEqualStrings("okmore", s.engine_ptr.state.items);
    // Reconnect must not claim a clean restore after a write/journal desync risk.
    try testing.expectEqual(false, s.ts.reconnect_available);
}

test "tryCheckpoint verifies import+digest then retains; journal evicts throughSeq" {
    var s = try makeState();
    defer s.deinit();

    try s.ts.feedOutput("screen-a");
    try s.ts.tryCheckpoint();

    try testing.expectEqual(@as(u64, 8), s.ts.checkpointSeq());
    try testing.expect(s.ts.checkpointAvailable());
    try testing.expectEqual(@as(u64, 8), s.ts.journal.start_seq);
    try testing.expectEqual(@as(usize, 0), s.ts.journal.retainedBytes());

    const cp = s.ts.checkpoints.newest().?;
    try testing.expectEqual(@as(u64, 8), cp.header.through_seq);
    // Envelope magic
    try testing.expectEqualStrings(magic, cp.file[0..8]);
}

test "incomplete export yields CHECKPOINT_UNAVAILABLE (A2); no silent mostly-restored" {
    var s = try makeState();
    defer s.deinit();

    try s.ts.feedOutput("partial");
    s.engine_ptr.incomplete_export = true;

    // Positive control: with complete export, checkpoint would succeed.
    // Prove the success path is not dead by briefly flipping the flag.
    s.engine_ptr.incomplete_export = false;
    try s.ts.tryCheckpoint();
    try testing.expect(s.ts.checkpointAvailable());
    const seq_after_good = s.ts.checkpointSeq();

    try s.ts.feedOutput("more");
    s.engine_ptr.incomplete_export = true;
    try testing.expectError(error.CheckpointUnavailable, s.ts.tryCheckpoint());
    // Store still holds the previous verified checkpoint on disk/slots, but
    // restoreInto requires reconnect_available (now false) and only serves
    // newest() — the previous slot is retained for dual-retain durability /
    // host-composition fallback (§18), not wired as an automatic restore
    // fallback in this module (F7). Newest throughSeq does not advance.
    try testing.expectEqual(seq_after_good, s.ts.checkpointSeq());
    try testing.expectEqual(false, s.ts.reconnect_available);
    try testing.expect(s.ts.checkpoints.newest() != null);
}

test "empty / failed export → CHECKPOINT_UNAVAILABLE (positive control alive)" {
    var s = try makeState();
    defer s.deinit();
    try s.ts.feedOutput("x");

    // Positive control: good path works.
    try s.ts.tryCheckpoint();
    try testing.expect(s.ts.checkpointAvailable());

    try s.ts.feedOutput("y");
    s.engine_ptr.empty_export = true;
    try testing.expectError(error.CheckpointUnavailable, s.ts.tryCheckpoint());

    s.engine_ptr.empty_export = false;
    s.engine_ptr.fail_export = true;
    s.ts.reconnect_available = true; // reset for this branch
    try testing.expectError(error.CheckpointUnavailable, s.ts.tryCheckpoint());
}

test "corrupt one opaque byte → import fails / destination unchanged" {
    var s = try makeState();
    defer s.deinit();
    try s.ts.feedOutput("stable-state");
    try s.ts.tryCheckpoint();

    const cp = s.ts.checkpoints.newest().?;
    var corrupt = try testing.allocator.dupe(u8, cp.opaquePayload());
    defer testing.allocator.free(corrupt);
    // Flip a byte inside the mock body (past MOCKCP01 magic).
    try testing.expect(corrupt.len > 8);
    corrupt[8] ^= 0xff;

    // Fresh terminal with a sentinel so we can prove "unchanged on failure".
    var fresh = try MockEngine.create(testing.allocator);
    // Don't use engine() deinit which destroys — manage manually.
    defer fresh.destroy();
    try fresh.state.appendSlice(testing.allocator, "SENTINEL");
    const before = try testing.allocator.dupe(u8, fresh.state.items);
    defer testing.allocator.free(before);

    const eng = fresh.engine();
    // Manual: importOpaque should fail and leave state as SENTINEL.
    // Note: eng.deinit would destroy fresh; we only call import.
    try testing.expectError(error.InvalidCheckpoint, eng.importOpaque(corrupt));
    try testing.expectEqualStrings(before, fresh.state.items);

    // Positive control: good payload imports and changes state.
    try eng.importOpaque(cp.opaquePayload());
    try testing.expectEqualStrings("stable-state", fresh.state.items);
}

test "restoreInto replays journal after throughSeq; digest matches uninterrupted" {
    var s = try makeState();
    defer s.deinit();

    try s.ts.feedOutput("AAA");
    try s.ts.tryCheckpoint();
    try s.ts.feedOutput("BBB");

    // Uninterrupted digest on live engine.
    const live_digest = s.ts.engine.digest();

    // Restore into fresh.
    var fresh = try MockEngine.create(testing.allocator);
    defer {
        // restoreInto does not take ownership; destroy manually.
        // TerminalState.restoreInto uses dest without deinit.
        fresh.destroy();
    }
    const dest = fresh.engine();
    const high = try s.ts.restoreInto(dest);
    try testing.expectEqual(@as(u64, 6), high);
    try testing.expectEqualStrings("AAABBB", fresh.state.items);
    try testing.expectEqualSlices(u8, &live_digest, &dest.digest());
}

test "never evict journal bytes not covered by a verified checkpoint" {
    var s = try makeState();
    defer s.deinit();

    try s.ts.feedOutput("keep-me");
    // No checkpoint yet — start_seq stays 0; full journal retained.
    try testing.expectEqual(@as(u64, 0), s.ts.journal.start_seq);
    try testing.expectEqualStrings("keep-me", s.ts.journal.bytes.items);

    // Force an incomplete checkpoint; journal must NOT advance start_seq.
    s.engine_ptr.fail_export = true;
    try testing.expectError(error.CheckpointUnavailable, s.ts.tryCheckpoint());
    try testing.expectEqual(@as(u64, 0), s.ts.journal.start_seq);
    try testing.expectEqualStrings("keep-me", s.ts.journal.bytes.items);
}

test "dual retain: newest and previous valid; third drops oldest" {
    var s = try makeState();
    defer s.deinit();

    try s.ts.feedOutput("one");
    try s.ts.tryCheckpoint();
    const first_seq = s.ts.checkpointSeq();

    try s.ts.feedOutput("two");
    try s.ts.tryCheckpoint();
    const second_seq = s.ts.checkpointSeq();

    try s.ts.feedOutput("three");
    try s.ts.tryCheckpoint();
    const third_seq = s.ts.checkpointSeq();

    try testing.expect(s.ts.checkpoints.newest().?.header.through_seq == third_seq);
    try testing.expect(s.ts.checkpoints.previous().?.header.through_seq == second_seq);
    try testing.expect(first_seq < second_seq);
    try testing.expect(second_seq < third_seq);
}

test "checkpoint interval triggers after 2 MiB new output" {
    var s = try makeState();
    defer s.deinit();

    // Feed just under the interval without explicit checkpoint.
    const chunk_size: usize = 64 * 1024;
    var filled: u64 = 0;
    var buf: [chunk_size]u8 = undefined;
    @memset(&buf, 'x');
    while (filled + chunk_size < checkpoint_output_interval_bytes) {
        try s.ts.feedOutput(&buf);
        filled += chunk_size;
    }
    // Should not have auto-checkpointed yet (still under 2 MiB).
    try testing.expectEqual(@as(u64, 0), s.ts.checkpointSeq());

    // Cross the threshold.
    try s.ts.feedOutput(&buf);
    try testing.expect(s.ts.checkpointSeq() > 0);
    try testing.expect(s.ts.checkpointAvailable());
}

// F3: This is PLUMBING-ONLY. MockEngine state is plain byte concatenation and
// digest=SHA256(state), so restored==uninterrupted holds for ANY split —
// independent of VT parsing. It proves envelope/journal/restore round-trips
// bytes through the seam. It is NOT TG2 and MUST NOT be read as sequence-split
// corpus evidence. The real adversarial CSI/OSC/DCS/UTF-8/grapheme/Kitty/
// synchronized-output/alternate-screen split corpus is gated on TG2 host
// composition against libghostty-vt (A2).
test "plumbing only: byte-split feed/checkpoint/restore round-trips opaque state (NOT TG2 corpus)" {
    const sequences = [_][]const u8{
        "\x1b[31m", // CSI SGR
        "\x1b[?1049h", // alternate screen
        "\x1b]2;title\x07", // OSC title + BEL (effect)
        "\x1bP1$r\x1b\\", // DCS
        "\xc3\xa9", // UTF-8 é
        "\xf0\x9f\x98\x80", // UTF-8 emoji (grapheme)
        "\x1b_Ga=T,f=100\x1b\\", // Kitty graphics-ish
        "\x1b[?2026h", // synchronized output
        "\x1b[?1049l", // leave alternate
        "plain",
    };

    // Uninterrupted run.
    var unint = try MockEngine.create(testing.allocator);
    defer unint.destroy();
    for (sequences) |seq| {
        try MockEngine.writeCb(unint, seq);
    }
    const unint_digest = MockEngine.digestCb(unint);

    // Split at every boundary: feed byte-by-byte with checkpoint before/after
    // each sequence, restore into fresh, compare.
    var s = try makeState();
    defer s.deinit();

    for (sequences) |seq| {
        // Checkpoint before split (may be empty state first time — force after ≥1 byte).
        if (s.ts.outputSeq() > 0) {
            s.ts.tryCheckpoint() catch {};
        }
        // Feed one byte at a time (adversarial split).
        for (seq) |b| {
            const one = [_]u8{b};
            try s.ts.feedOutput(&one);
        }
        try s.ts.tryCheckpoint();
    }

    // Restore path must actually RUN import into a fresh terminal.
    var restored = try MockEngine.create(testing.allocator);
    defer restored.destroy();
    const dest = restored.engine();
    _ = try s.ts.restoreInto(dest);

    try testing.expectEqualSlices(u8, &unint_digest, &dest.digest());
    try testing.expectEqualStrings(unint.state.items, restored.state.items);

    // Subsequent effect stream: after restore high-water, new output must produce
    // the same *new* effects as the uninterrupted engine from the same state.
    unint.effect_log.clearRetainingCapacity();
    restored.effect_log.clearRetainingCapacity();
    const more = "\x07post";
    try MockEngine.writeCb(unint, more);
    try dest.write(more);
    try testing.expectEqualSlices(u8, unint.effect_log.items, dest.effects());
    try testing.expectEqualSlices(u8, &MockEngine.digestCb(unint), &dest.digest());
}

test "persistCheckpoints atomic write + re-parse envelope" {
    var s = try makeState();
    defer s.deinit();
    try s.ts.feedOutput("disk");
    try s.ts.tryCheckpoint();

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const previous_umask = std.c.umask(0o022);
    defer _ = std.c.umask(previous_umask);

    try s.ts.persistCheckpoints(tmp.dir);
    try s.ts.persistJournal(tmp.dir);

    const checkpoint_stat = try std.posix.fstatat(tmp.dir.fd, "checkpoint-0.bin", std.posix.AT.SYMLINK_NOFOLLOW);
    try testing.expectEqual(@as(std.c.mode_t, 0o600), checkpoint_stat.mode & 0o777);
    const journal_stat = try std.posix.fstatat(tmp.dir.fd, "journal.bin", std.posix.AT.SYMLINK_NOFOLLOW);
    try testing.expectEqual(@as(std.c.mode_t, 0o600), journal_stat.mode & 0o777);

    const file = try tmp.dir.readFileAlloc(testing.allocator, "checkpoint-0.bin", checkpoint_max_bytes + header_bytes);
    defer testing.allocator.free(file);
    const h = try parseEnvelope(file);
    try testing.expectEqual(s.ts.checkpointSeq(), h.through_seq);

    // Positive control: wrong magic on disk would fail parse.
    var bad = try testing.allocator.dupe(u8, file);
    defer testing.allocator.free(bad);
    bad[0] = 'Z';
    try testing.expectError(error.WrongMagic, parseEnvelope(bad));
}

test "persistJournal does not follow a symlink at the temporary path" {
    var s = try makeState();
    defer s.deinit();
    try s.ts.feedOutput("secret");

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    {
        var sentinel = try tmp.dir.createFile("sentinel", .{ .mode = 0o600 });
        defer sentinel.close();
        try sentinel.writeAll("unchanged");
    }
    try tmp.dir.symLink("sentinel", "journal.bin.tmp", .{});

    try testing.expectError(error.IoFailed, s.ts.persistJournal(tmp.dir));
    const contents = try tmp.dir.readFileAlloc(testing.allocator, "sentinel", 32);
    defer testing.allocator.free(contents);
    try testing.expectEqualStrings("unchanged", contents);
}

test "restore refuses when reconnect_available is false (no mostly-restored)" {
    var s = try makeState();
    defer s.deinit();
    try s.ts.feedOutput("a");
    try s.ts.tryCheckpoint();

    // Positive control: restore works while available.
    var ok_eng = try MockEngine.create(testing.allocator);
    defer ok_eng.destroy();
    _ = try s.ts.restoreInto(ok_eng.engine());

    s.ts.reconnect_available = false;
    var bad_eng = try MockEngine.create(testing.allocator);
    defer bad_eng.destroy();
    try testing.expectError(error.CheckpointUnavailable, s.ts.restoreInto(bad_eng.engine()));
}

test "engineBuildId is embedded from caller, not recomputed" {
    var s = try makeState();
    defer s.deinit();
    try s.ts.feedOutput("id");
    try s.ts.tryCheckpoint();
    const cp = s.ts.checkpoints.newest().?;
    try testing.expectEqualSlices(u8, &testBuildId(), &cp.header.engine_build_id);
}

test "limits match §18 / schema" {
    try testing.expectEqual(@as(usize, 64 * 1024 * 1024), journal_max_bytes);
    try testing.expectEqual(@as(usize, 64 * 1024 * 1024), checkpoint_max_bytes);
    try testing.expectEqual(@as(usize, 2), retained_checkpoints);
    try testing.expectEqual(@as(usize, 64 * 1024), stream_chunk_max_bytes);
    try testing.expectEqual(@as(u64, 2 * 1024 * 1024), checkpoint_output_interval_bytes);
    try testing.expectEqual(@as(u64, 30 * std.time.ns_per_s), checkpoint_interval_ns);
}
