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
const builtin = @import("builtin");
const generated = @import("session_protocol_generated");
const hvtcp001_header = @import("hvtcp001_header");
const checkpoint_format = @import("checkpoint_format");

pub const checkpoint_max_bytes = checkpoint_format.checkpoint_max_bytes;
pub const checkpoint_contiguous_max_bytes = checkpoint_format.checkpoint_contiguous_max_bytes;
pub const checkpoint_stream_chunk_bytes = checkpoint_format.checkpoint_stream_chunk_bytes;
pub const legacy_engine_build_id = checkpoint_format.legacy_engine_build_id;
pub const acceptsEngineBuildId = checkpoint_format.acceptsEngineBuildId;
pub const header_bytes = checkpoint_format.header_bytes;
pub const magic = checkpoint_format.magic;
pub const version = checkpoint_format.version;
pub const flags_v1 = checkpoint_format.flags_v1;
pub const engine_build_id_bytes = checkpoint_format.engine_build_id_bytes;
pub const payload_sha256_bytes = checkpoint_format.payload_sha256_bytes;
const off = checkpoint_format.off;
pub const CheckpointHeader = checkpoint_format.CheckpointHeader;
pub const EnvelopeError = checkpoint_format.EnvelopeError;
pub const Error = checkpoint_format.Error;
pub const encodeHeader = checkpoint_format.encodeHeader;
pub const decodeHeader = checkpoint_format.decodeHeader;
pub const CheckpointFields = checkpoint_format.CheckpointFields;
pub const assembleEnvelope = checkpoint_format.assembleEnvelope;
pub const parseEnvelope = checkpoint_format.parseEnvelope;
pub const verifyPayload = checkpoint_format.verifyPayload;

// ── Limits (§18 / TERMINAL_LIMITS) ──────────────────────────────────────────

/// Replay journal capacity per generation (§18).
pub const journal_max_bytes: usize = 64 * 1024 * 1024;
/// Dual retain: newest valid + previous valid (§18).
pub const retained_checkpoints: usize = 2;
/// Stream chunk bound for OUTPUT / SNAPSHOT_BYTES (§18).
pub const stream_chunk_max_bytes: usize = 64 * 1024;
/// Checkpoint after this much new output since last verified checkpoint (§23).
pub const checkpoint_output_interval_bytes: u64 = 2 * 1024 * 1024;
/// Checkpoint after this many nanoseconds of mono time since last verified (§23).
pub const checkpoint_interval_ns: u64 = 30 * std.time.ns_per_s;
/// Journal persistence batching: journal.bin rewrites at most once per this
/// interval while output streams (§18 durability is unchanged at checkpoints,
/// termination, and forced persists — only the streaming path is batched).
pub const journal_persist_interval_ns: u64 = 250 * std.time.ns_per_ms;

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
    /// Bounded producer used for checkpoints above the legacy contiguous cap.
    /// Null keeps old engine doubles/source compatibility and falls back to
    /// exportFn, still writing the result in bounded chunks.
    exportStreamFn: ?*const fn (context: *anyopaque, sink: OpaqueStreamSink) anyerror!usize = null,
    /// Fresh engine with the same live callbacks/effect sink. Resize uses this
    /// to prepare a candidate without mutating the attached terminal.
    cloneFn: ?*const fn (context: *anyopaque, allocator: std.mem.Allocator) anyerror!VtEngine = null,
    importFn: *const fn (context: *anyopaque, payload: []const u8) anyerror!void,
    digestFn: *const fn (context: *anyopaque) [32]u8,
    /// Snapshot of PTY-bound effect bytes collected since create/import (for TG2 stream compare).
    effectsFn: *const fn (context: *anyopaque) []const u8,
    /// Resize the shadow terminal grid; cell px are whole pixels per cell.
    resizeFn: *const fn (
        context: *anyopaque,
        columns: u32,
        rows: u32,
        cell_width_px: u32,
        cell_height_px: u32,
    ) anyerror!void,

    pub fn deinit(self: VtEngine) void {
        self.deinitFn(self.context);
    }

    pub fn write(self: VtEngine, bytes: []const u8) anyerror!void {
        return self.writeFn(self.context, bytes);
    }

    pub fn exportOpaque(self: VtEngine, allocator: std.mem.Allocator) anyerror![]u8 {
        return self.exportFn(self.context, allocator);
    }

    pub fn exportOpaqueStream(
        self: VtEngine,
        allocator: std.mem.Allocator,
        sink: OpaqueStreamSink,
    ) anyerror!usize {
        if (self.exportStreamFn) |export_stream| {
            return export_stream(self.context, sink);
        }
        const payload = try self.exportOpaque(allocator);
        defer allocator.free(payload);
        var offset: usize = 0;
        while (offset < payload.len) {
            const take = @min(checkpoint_stream_chunk_bytes, payload.len - offset);
            try sink.write(payload[offset..][0..take]);
            offset += take;
        }
        return payload.len;
    }

    pub fn importOpaque(self: VtEngine, payload: []const u8) anyerror!void {
        return self.importFn(self.context, payload);
    }

    pub fn clone(self: VtEngine, allocator: std.mem.Allocator) anyerror!VtEngine {
        const clone_fn = self.cloneFn orelse return error.CheckpointUnavailable;
        return clone_fn(self.context, allocator);
    }

    pub fn digest(self: VtEngine) [32]u8 {
        return self.digestFn(self.context);
    }

    pub fn effects(self: VtEngine) []const u8 {
        return self.effectsFn(self.context);
    }

    pub fn resize(
        self: VtEngine,
        columns: u32,
        rows: u32,
        cell_width_px: u32,
        cell_height_px: u32,
    ) anyerror!void {
        return self.resizeFn(self.context, columns, rows, cell_width_px, cell_height_px);
    }
};

pub const OpaqueStreamSink = struct {
    context: *anyopaque,
    writeFn: *const fn (context: *anyopaque, bytes: []const u8) anyerror!void,

    pub fn write(self: OpaqueStreamSink, bytes: []const u8) anyerror!void {
        return self.writeFn(self.context, bytes);
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

/// Write HVTCP001 directly to a caller-owned spool. A zero header is reserved,
/// the opaque payload is hashed while the engine streams it, then the complete
/// header is patched at offset zero and the file is synced. HVTCP001's payload
/// SHA-256 detects a torn/out-of-order patch after recovery; the inner
/// HVGCP001 payload has no body digest and relies on this outer integrity
/// layer. A failed export never leaves a header that could be mistaken for a
/// complete checkpoint.
pub fn writeEnvelopeStream(
    allocator: std.mem.Allocator,
    engine: VtEngine,
    file: *std.fs.File,
    fields: CheckpointFields,
) Error!CheckpointHeader {
    const FileSink = struct {
        file: *std.fs.File,
        sha: std.crypto.hash.sha2.Sha256 = .init(.{}),
        length: usize = 0,

        fn write(context: *anyopaque, bytes: []const u8) anyerror!void {
            const self: *@This() = @ptrCast(@alignCast(context));
            if (bytes.len == 0 or bytes.len > checkpoint_stream_chunk_bytes)
                return error.Internal;
            if (bytes.len > checkpoint_max_bytes -| self.length)
                return error.PayloadTooLarge;
            self.file.writeAll(bytes) catch return error.IoFailed;
            self.sha.update(bytes);
            self.length += bytes.len;
        }
    };

    file.setEndPos(0) catch return error.IoFailed;
    file.seekTo(0) catch return error.IoFailed;
    const empty_header = [_]u8{0} ** header_bytes;
    file.writeAll(&empty_header) catch return error.IoFailed;

    var sink: FileSink = .{ .file = file };
    const reported_length = engine.exportOpaqueStream(
        allocator,
        .{ .context = &sink, .writeFn = FileSink.write },
    ) catch |err| return switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.PayloadTooLarge => error.PayloadTooLarge,
        error.IoFailed => error.IoFailed,
        else => error.CheckpointUnavailable,
    };
    if (reported_length == 0 or reported_length != sink.length)
        return error.CheckpointUnavailable;
    if (sink.length > std.math.maxInt(u32)) return error.PayloadTooLarge;

    var payload_sha256: [payload_sha256_bytes]u8 = undefined;
    sink.sha.final(&payload_sha256);
    const header: CheckpointHeader = .{
        .through_seq = fields.through_seq,
        .created_mono_nanos = fields.created_mono_nanos,
        .columns = fields.columns,
        .rows = fields.rows,
        .cell_width_px_16_16 = fields.cell_width_px_16_16,
        .cell_height_px_16_16 = fields.cell_height_px_16_16,
        .engine_build_id = fields.engine_build_id.*,
        .payload_length = @intCast(sink.length),
        .payload_sha256 = payload_sha256,
    };
    var header_buffer: [header_bytes]u8 = undefined;
    encodeHeader(header, &header_buffer);
    file.seekTo(0) catch return error.IoFailed;
    file.writeAll(&header_buffer) catch return error.IoFailed;
    file.sync() catch return error.IoFailed;
    return header;
}

fn createAnonymousSpool(dir: std.fs.Dir) Error!std.fs.File {
    var name_buffer: [64]u8 = undefined;
    var attempts: usize = 0;
    while (attempts < 16) : (attempts += 1) {
        const name = std.fmt.bufPrint(&name_buffer, ".checkpoint-spool-{x:0>16}", .{
            std.crypto.random.int(u64),
        }) catch return error.Internal;
        const fd = std.posix.openat(dir.fd, name, .{
            .ACCMODE = .RDWR,
            .CREAT = true,
            .EXCL = true,
            .NOFOLLOW = true,
            .CLOEXEC = true,
        }, 0o600) catch |err| switch (err) {
            error.PathAlreadyExists => continue,
            else => return error.IoFailed,
        };
        const file: std.fs.File = .{ .handle = fd };
        file.chmod(0o600) catch {
            file.close();
            dir.deleteFile(name) catch {};
            return error.IoFailed;
        };
        dir.deleteFile(name) catch {
            file.close();
            return error.IoFailed;
        };
        return file;
    }
    return error.IoFailed;
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
    /// Anonymous spool containing header + opaque payload. Owned.
    file: std.fs.File,
    header: CheckpointHeader,

    pub fn deinit(self: *StoredCheckpoint) void {
        self.file.close();
        self.* = undefined;
    }

    pub fn totalBytes(self: *const StoredCheckpoint) usize {
        return header_bytes + @as(usize, self.header.payload_length);
    }

    pub fn readAt(self: *const StoredCheckpoint, buffer: []u8, offset: usize) Error!usize {
        if (offset >= self.totalBytes()) return 0;
        const bounded = buffer[0..@min(buffer.len, self.totalBytes() - offset)];
        const read = self.file.preadAll(bounded, offset) catch return error.IoFailed;
        if (read != bounded.len) return error.IoFailed;
        return read;
    }

    /// Legacy contiguous consumer adapter. Checkpoint creation and retention
    /// never use this; callers that still require one import slice pay for it
    /// only at consumption time.
    pub fn readOpaqueAlloc(
        self: *const StoredCheckpoint,
        allocator: std.mem.Allocator,
    ) Error![]u8 {
        const payload = try allocator.alloc(u8, self.header.payload_length);
        errdefer allocator.free(payload);
        const read = self.file.preadAll(payload, header_bytes) catch return error.IoFailed;
        if (read != payload.len) return error.IoFailed;
        return payload;
    }

    pub fn verify(self: *const StoredCheckpoint) Error!CheckpointHeader {
        var header_bytes_buffer: [header_bytes]u8 = undefined;
        if (try self.readAt(&header_bytes_buffer, 0) != header_bytes)
            return error.Truncated;
        const parsed = try decodeHeader(&header_bytes_buffer);
        if (parsed.payload_length > checkpoint_max_bytes) return error.PayloadTooLarge;
        if (header_bytes + @as(usize, parsed.payload_length) != self.totalBytes())
            return error.PayloadLengthMismatch;

        var sha = std.crypto.hash.sha2.Sha256.init(.{});
        var buffer: [checkpoint_stream_chunk_bytes]u8 = undefined;
        var offset: usize = header_bytes;
        while (offset < self.totalBytes()) {
            const read = try self.readAt(&buffer, offset);
            if (read == 0) return error.Truncated;
            sha.update(buffer[0..read]);
            offset += read;
        }
        var digest: [payload_sha256_bytes]u8 = undefined;
        sha.final(&digest);
        if (!std.mem.eql(u8, &digest, &parsed.payload_sha256))
            return error.PayloadSha256Mismatch;
        return parsed;
    }

    pub const Mapping = struct {
        bytes: []align(std.heap.page_size_min) u8,

        pub fn deinit(self: *Mapping) void {
            std.posix.munmap(self.bytes);
            self.* = undefined;
        }

        pub fn opaquePayload(self: *const Mapping, header: CheckpointHeader) []const u8 {
            return self.bytes[header_bytes..][0..header.payload_length];
        }
    };

    pub fn map(self: *const StoredCheckpoint) Error!Mapping {
        const bytes = std.posix.mmap(
            null,
            self.totalBytes(),
            std.posix.PROT.READ,
            .{ .TYPE = .PRIVATE },
            self.file.handle,
            0,
        ) catch |err| return switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            else => error.IoFailed,
        };
        return .{ .bytes = bytes };
    }
};

/// Newest at index 0, previous at index 1. Both must be import-verified.
pub const CheckpointStore = struct {
    slots: [retained_checkpoints]?StoredCheckpoint = .{ null, null },

    pub fn init() CheckpointStore {
        return .{};
    }

    pub fn deinit(self: *CheckpointStore) void {
        for (&self.slots) |*slot| {
            if (slot.*) |*cp| cp.deinit();
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

    /// Push a newly verified checkpoint as newest; demote previous newest and
    /// drop oldest. Takes ownership of the spool file.
    pub fn pushVerified(self: *CheckpointStore, checkpoint: StoredCheckpoint) void {
        if (self.slots[1]) |*old| old.deinit();
        self.slots[1] = self.slots[0];
        self.slots[0] = checkpoint;
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
    /// Borrowed secure directory in which checkpoint spools are created and
    /// immediately unlinked. It must outlive this state.
    checkpoint_spool_dir: std.fs.Dir,
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
    /// Journal bytes/seq changed since the last persistJournal (§18 batching).
    journal_dirty: bool = false,
    /// Mono nanos of the last persistJournal (or create).
    last_journal_persist_mono: u64 = 0,
    /// When true, reconnect must surface CHECKPOINT_UNAVAILABLE (no silent approx).
    reconnect_available: bool = true,
    /// Exclusive journal offset a live attached viewer has already been sent
    /// (§20 sent_seq); `null` when no viewer is attached. See setViewerFloor.
    viewer_floor_seq: ?u64 = null,
    closed: bool = false,

    pub fn init(
        allocator: std.mem.Allocator,
        engine: VtEngine,
        factory: VtEngineFactory,
        clock: Clock,
        engine_build_id: *const [32]u8,
        geometry: Geometry,
        checkpoint_spool_dir: std.fs.Dir,
    ) TerminalState {
        const now = clock.now();
        var state: TerminalState = .{
            .allocator = allocator,
            .engine = engine,
            .factory = factory,
            .clock = clock,
            .checkpoint_spool_dir = checkpoint_spool_dir,
            .engine_build_id = engine_build_id.*,
            .geometry = geometry,
            .journal = Journal.init(allocator),
            .checkpoints = CheckpointStore.init(),
            .last_checkpoint_mono = now,
            .last_journal_persist_mono = now,
        };
        // Sync the engine's pixel geometry once so XTWINOPS size reports and
        // future checkpoint envelopes agree with `geometry` from the start.
        // Non-fatal: the grid size is already correct from engine create; only
        // cell px would stay unknown (reported as 0) if this fails.
        state.engine.resize(
            geometry.columns,
            geometry.rows,
            geometry.cell_width_px_16_16 >> 16,
            geometry.cell_height_px_16_16 >> 16,
        ) catch {};
        return state;
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

    pub fn retainedOutputStart(self: *const TerminalState) u64 {
        return self.journal.start_seq;
    }

    /// Publish the live attached viewer's delivered high-water, or `null` when
    /// no viewer is attached. A checkpoint fires from inside feedOutput and
    /// evicts the journal it just covered; without this floor that eviction can
    /// pass bytes an attached viewer has not been sent, and its next push reads
    /// an evicted range and the host detaches a healthy pane (#91).
    /// The journal-pressure path in feedChunk deliberately ignores the floor: a
    /// viewer a whole journal behind is dropped rather than growing retention
    /// without bound.
    pub fn setViewerFloor(self: *TerminalState, seq: ?u64) void {
        self.viewer_floor_seq = seq;
    }

    pub fn outputClosed(self: *const TerminalState) bool {
        return self.closed;
    }

    pub fn retainedCheckpointCount(self: *const TerminalState) u32 {
        var count: u32 = 0;
        for (self.checkpoints.slots) |slot| if (slot != null) {
            count += 1;
        };
        return count;
    }

    pub fn newestCheckpoint(self: *const TerminalState) ?*const StoredCheckpoint {
        if (!self.reconnect_available) return null;
        return self.checkpoints.newest();
    }

    /// §23 geometry: the shadow VT follows every applied window resize so the
    /// next verified checkpoint carries the live geometry — envelope fields
    /// AND opaque payload agree, so restoreInto renders at the real size
    /// instead of the create-time 80x24.
    pub const PreparedResize = struct {
        base: StoredCheckpoint,
        resized: StoredCheckpoint,
        previous_geometry: Geometry,
        geometry: Geometry,
        owned: bool = true,

        pub fn deinit(self: *PreparedResize) void {
            if (!self.owned) return;
            self.base.deinit();
            self.resized.deinit();
            self.* = undefined;
        }
    };

    /// Prepare and verify a resized clone without mutating either live
    /// representation. The host imports this verified state into the live VT,
    /// applies the PTY resize, and rolls the VT back if that second step fails.
    pub fn prepareResize(self: *TerminalState, geometry: Geometry) Error!PreparedResize {
        if (self.closed) return error.Closed;
        if (geometry.columns == 0 or geometry.rows == 0 or
            geometry.columns > std.math.maxInt(u16) or
            geometry.rows > std.math.maxInt(u16)) return error.Internal;

        // First capture the unmodified terminal. If any later preflight step
        // fails, this verified checkpoint keeps the existing live geometry
        // reattachable and the live engine is never resized.
        var base = self.buildVerifiedCheckpoint(self.engine, self.geometry) catch |err| {
            self.noteCheckpointFailure();
            return err;
        };
        var base_owned = true;
        defer if (base_owned) base.deinit();

        var candidate = self.engine.clone(self.allocator) catch {
            self.retainCheckpoint(base);
            base_owned = false;
            return error.CheckpointUnavailable;
        };
        defer candidate.deinit();

        var base_mapping = base.map() catch |err| {
            self.retainCheckpoint(base);
            base_owned = false;
            return err;
        };
        defer base_mapping.deinit();
        candidate.importOpaque(base_mapping.opaquePayload(base.header)) catch {
            self.retainCheckpoint(base);
            base_owned = false;
            return error.CheckpointUnavailable;
        };
        candidate.resize(
            geometry.columns,
            geometry.rows,
            geometry.cell_width_px_16_16 >> 16,
            geometry.cell_height_px_16_16 >> 16,
        ) catch {
            self.retainCheckpoint(base);
            base_owned = false;
            return error.Internal;
        };

        const resized = self.buildVerifiedCheckpoint(candidate, geometry) catch |err| {
            self.retainCheckpoint(base);
            base_owned = false;
            return err;
        };
        base_owned = false;
        return .{
            .base = base,
            .resized = resized,
            .previous_geometry = self.geometry,
            .geometry = geometry,
        };
    }

    /// Apply the already-export-verified state to the live renderer. The
    /// import contract leaves the destination unchanged on failure, so the
    /// host can still decline the PTY resize.
    pub fn applyPreparedResize(self: *TerminalState, prepared: *PreparedResize) Error!void {
        std.debug.assert(prepared.owned);
        var mapping = try prepared.resized.map();
        defer mapping.deinit();
        self.engine.importOpaque(mapping.opaquePayload(prepared.resized.header)) catch
            return error.CheckpointUnavailable;
        self.engine.resize(
            prepared.geometry.columns,
            prepared.geometry.rows,
            prepared.geometry.cell_width_px_16_16 >> 16,
            prepared.geometry.cell_height_px_16_16 >> 16,
        ) catch {
            self.rollbackPreparedResize(prepared) catch {
                self.reconnect_available = false;
            };
            return error.Internal;
        };
        self.geometry = prepared.geometry;
    }

    pub fn rollbackPreparedResize(
        self: *TerminalState,
        prepared: *PreparedResize,
    ) Error!void {
        std.debug.assert(prepared.owned);
        var mapping = try prepared.base.map();
        defer mapping.deinit();
        self.engine.importOpaque(mapping.opaquePayload(prepared.base.header)) catch
            return error.CheckpointUnavailable;
        self.engine.resize(
            prepared.previous_geometry.columns,
            prepared.previous_geometry.rows,
            prepared.previous_geometry.cell_width_px_16_16 >> 16,
            prepared.previous_geometry.cell_height_px_16_16 >> 16,
        ) catch return error.Internal;
        self.geometry = prepared.previous_geometry;
    }

    /// Retain the verified before/after checkpoints after both live
    /// representations have committed.
    pub fn finalizePreparedResize(self: *TerminalState, prepared: *PreparedResize) void {
        std.debug.assert(prepared.owned);
        self.checkpoints.pushVerified(prepared.base);
        const resized_header = prepared.resized.header;
        self.checkpoints.pushVerified(prepared.resized);
        // Resize must establish a restorable geometry, but it is not a journal
        // pressure event. Keep the replay window intact for attached viewers.
        self.finishCheckpoint(resized_header, false);
        prepared.owned = false;
    }

    pub fn resize(self: *TerminalState, geometry: Geometry) Error!void {
        var prepared = try self.prepareResize(geometry);
        defer prepared.deinit();
        try self.applyPreparedResize(&prepared);
        self.finalizePreparedResize(&prepared);
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
                    self.journal_dirty = true;
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
        self.journal_dirty = true;
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

    /// Create a verified checkpoint through an anonymous spool, import it into
    /// a FRESH terminal, compare semantic digests, then retain the spool.
    pub fn tryCheckpoint(self: *TerminalState) Error!void {
        if (self.closed) return error.Closed;
        const checkpoint = self.buildVerifiedCheckpoint(self.engine, self.geometry) catch |err| {
            self.noteCheckpointFailure();
            return err;
        };
        const header = checkpoint.header;
        self.checkpoints.pushVerified(checkpoint);
        self.finishCheckpoint(header, true);
    }

    fn noteCheckpointFailure(self: *TerminalState) void {
        // A failed refresh does not invalidate a checkpoint whose replay tail
        // is still retained. The journal-pressure path separately marks the
        // state unavailable if it must discard uncovered bytes.
        if (self.checkpoints.newest() == null) self.reconnect_available = false;
    }

    fn buildVerifiedCheckpoint(
        self: *TerminalState,
        engine: VtEngine,
        geometry: Geometry,
    ) Error!StoredCheckpoint {
        var file = try createAnonymousSpool(self.checkpoint_spool_dir);
        var file_owned = true;
        errdefer if (file_owned) file.close();
        const header = try writeEnvelopeStream(self.allocator, engine, &file, .{
            .through_seq = self.output_seq,
            .created_mono_nanos = self.clock.now(),
            .columns = geometry.columns,
            .rows = geometry.rows,
            .cell_width_px_16_16 = geometry.cell_width_px_16_16,
            .cell_height_px_16_16 = geometry.cell_height_px_16_16,
            .engine_build_id = &self.engine_build_id,
        });
        var checkpoint: StoredCheckpoint = .{ .file = file, .header = header };
        file_owned = false;
        errdefer checkpoint.deinit();

        const parsed = checkpoint.verify() catch return error.CheckpointUnavailable;
        if (!std.meta.eql(parsed, header)) return error.CheckpointUnavailable;

        const live_digest = engine.digest();
        var fresh = self.factory.create(
            self.allocator,
            geometry.columns,
            geometry.rows,
        ) catch return error.CheckpointUnavailable;
        defer fresh.deinit();
        var mapping = try checkpoint.map();
        defer mapping.deinit();
        fresh.importOpaque(mapping.opaquePayload(header)) catch
            return error.CheckpointUnavailable;
        const restored_digest = fresh.digest();
        if (!std.mem.eql(u8, &live_digest, &restored_digest))
            return error.CheckpointUnavailable;
        return checkpoint;
    }

    fn retainCheckpoint(self: *TerminalState, checkpoint: StoredCheckpoint) void {
        const header = checkpoint.header;
        self.checkpoints.pushVerified(checkpoint);
        self.finishCheckpoint(header, false);
    }

    fn finishCheckpoint(
        self: *TerminalState,
        header: CheckpointHeader,
        evict_covered_journal: bool,
    ) void {
        self.checkpoint_seq = header.through_seq;
        self.bytes_since_checkpoint = 0;
        self.last_checkpoint_mono = header.created_mono_nanos;
        self.reconnect_available = true;
        if (evict_covered_journal) {
            const evict_through = if (self.viewer_floor_seq) |floor|
                @min(header.through_seq, floor)
            else
                header.through_seq;
            self.journal.evictThrough(evict_through) catch unreachable;
            self.journal_dirty = true;
        }
    }

    /// Restore path for attach: import newest verified checkpoint into `dest`,
    /// then replay journal bytes beginning exactly at throughSeq. Returns the
    /// high-water after restore (output_seq). Incomplete / missing checkpoint
    /// yields CHECKPOINT_UNAVAILABLE — never approximates.
    pub fn restoreInto(self: *const TerminalState, dest: VtEngine) Error!u64 {
        if (!self.reconnect_available) return error.CheckpointUnavailable;
        const cp = self.checkpoints.newest() orelse return error.CheckpointUnavailable;

        if (!acceptsEngineBuildId(&cp.header.engine_build_id, &self.engine_build_id)) {
            return error.EngineMismatch;
        }

        // Re-verify envelope integrity before import. StoredCheckpoint.verify
        // checks length + payload SHA-256 without assembling a contiguous
        // file image; do not leak raw EnvelopeError (there is no wire code for
        // a SHA/length mismatch).
        const header = cp.verify() catch return error.CheckpointUnavailable;
        var mapping = try cp.map();
        defer mapping.deinit();
        const payload = mapping.opaquePayload(header);

        dest.importOpaque(payload) catch return error.CheckpointUnavailable;

        // Replay journal from throughSeq exclusively.
        const tail = try self.journal.sliceFrom(header.through_seq);
        if (tail.len > 0) {
            dest.write(tail) catch return error.Internal;
        }
        return self.output_seq;
    }

    /// Disk-style write of newest checkpoint to `dir` as checkpoint-0.bin (and
    /// previous as checkpoint-1.bin). Atomic: unique randomized .tmp, fsync,
    /// rename.
    pub fn persistCheckpoints(self: *const TerminalState, dir: std.fs.Dir) Error!void {
        if (self.checkpoints.newest()) |cp| {
            try writeAtomicCheckpoint(dir, "checkpoint-0.bin", cp);
        }
        if (self.checkpoints.previous()) |cp| {
            try writeAtomicCheckpoint(dir, "checkpoint-1.bin", cp);
        }
    }

    /// Persist journal.bin atomically with mode 0600 on the file itself.
    pub fn persistJournal(self: *TerminalState, dir: std.fs.Dir) Error!void {
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
        self.journal_dirty = false;
        self.last_journal_persist_mono = self.clock.now();
    }

    /// Batched streaming persist (§18): rewrites journal.bin at most once per
    /// journal_persist_interval_ns so chatty output does not fsync-storm the
    /// whole journal per batch. No-op while clean or inside the window.
    /// Checkpoint/terminate/read-paths that need durability must call
    /// persistJournal directly — batching never delays those.
    pub fn persistJournalIfDue(self: *TerminalState, dir: std.fs.Dir) Error!void {
        if (!self.journal_dirty) return;
        const now = self.clock.now();
        if (now -% self.last_journal_persist_mono < journal_persist_interval_ns) return;
        try self.persistJournal(dir);
    }
};

fn writeAtomic(dir: std.fs.Dir, name: []const u8, bytes: []const u8) Error!void {
    // journal.bin carries raw PTY output (potential secrets). Fail closed
    // unless the target directory is owned by this uid and not group/other-
    // writable: in a shared dir a hostile writer could pre-plant or race the
    // temp path. Same uid+mode doctrine as broker.openOwnedDirectory (F2/§23).
    const stat = std.posix.fstat(dir.fd) catch return error.IoFailed;
    if (stat.uid != std.posix.getuid() or stat.mode & std.posix.S.IFMT != std.posix.S.IFDIR or
        stat.mode & 0o022 != 0) return error.IoFailed;

    // Unique randomized temp name per call (was the fixed "{name}.tmp"): a
    // same-dir writer cannot predict and pre-plant the temp path to win the
    // rename race. O_NOFOLLOW + 0600 below are retained regardless.
    var tmp_buf: [64]u8 = undefined;
    const tmp_name = std.fmt.bufPrint(&tmp_buf, "{s}.{x:0>16}.tmp", .{
        name,
        std.crypto.random.int(u64),
    }) catch return error.Internal;

    try writeAtomicTmp(dir, name, tmp_name, bytes);
}

fn writeAtomicCheckpoint(
    dir: std.fs.Dir,
    name: []const u8,
    checkpoint: *const StoredCheckpoint,
) Error!void {
    const stat = std.posix.fstat(dir.fd) catch return error.IoFailed;
    if (stat.uid != std.posix.getuid() or stat.mode & std.posix.S.IFMT != std.posix.S.IFDIR or
        stat.mode & 0o022 != 0) return error.IoFailed;

    var tmp_buf: [64]u8 = undefined;
    const tmp_name = std.fmt.bufPrint(&tmp_buf, "{s}.{x:0>16}.tmp", .{
        name,
        std.crypto.random.int(u64),
    }) catch return error.Internal;
    const fd = std.posix.openat(dir.fd, tmp_name, .{
        .ACCMODE = .WRONLY,
        .CREAT = true,
        .TRUNC = true,
        .NOFOLLOW = true,
        .CLOEXEC = true,
    }, 0o600) catch return error.IoFailed;
    const file: std.fs.File = .{ .handle = fd };
    defer file.close();
    errdefer dir.deleteFile(tmp_name) catch {};
    file.chmod(0o600) catch return error.IoFailed;

    var buffer: [checkpoint_stream_chunk_bytes]u8 = undefined;
    var offset: usize = 0;
    while (offset < checkpoint.totalBytes()) {
        const read = try checkpoint.readAt(&buffer, offset);
        if (read == 0) return error.IoFailed;
        file.writeAll(buffer[0..read]) catch return error.IoFailed;
        offset += read;
    }
    file.sync() catch return error.IoFailed;
    dir.rename(tmp_name, name) catch return error.IoFailed;
    const dir_file: std.fs.File = .{ .handle = dir.fd };
    dir_file.sync() catch return error.IoFailed;
}

/// Core of writeAtomic with an explicit temp name, so tests can exercise
/// O_NOFOLLOW against a pre-planted symlink at a known temp path.
fn writeAtomicTmp(dir: std.fs.Dir, name: []const u8, tmp_name: []const u8, bytes: []const u8) Error!void {
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
    /// Test-only streamed payload size; bypasses the mock checkpoint body.
    stream_padding_bytes: usize = 0,
    /// When true, write returns error (F1 fallible VT write).
    fail_write: bool = false,
    /// When true, resize returns error without changing the engine geometry.
    fail_resize: bool = false,
    /// Last applied resize (init-time geometry sync counts as a resize).
    columns: u32 = 0,
    rows: u32 = 0,
    cell_width_px: u32 = 0,
    cell_height_px: u32 = 0,
    resize_calls: usize = 0,

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
            .exportStreamFn = exportStreamCb,
            .cloneFn = cloneCb,
            .importFn = importCb,
            .digestFn = digestCb,
            .effectsFn = effectsCb,
            .resizeFn = resizeCb,
        };
    }

    fn resizeCb(
        ctx: *anyopaque,
        columns: u32,
        rows: u32,
        cell_width_px: u32,
        cell_height_px: u32,
    ) anyerror!void {
        const self: *MockEngine = @ptrCast(@alignCast(ctx));
        if (self.fail_resize) return error.ResizeFailed;
        self.columns = columns;
        self.rows = rows;
        self.cell_width_px = cell_width_px;
        self.cell_height_px = cell_height_px;
        self.resize_calls += 1;
    }

    fn cloneCb(ctx: *anyopaque, allocator: std.mem.Allocator) anyerror!VtEngine {
        _ = ctx;
        return (try MockEngine.create(allocator)).engine();
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

    fn exportStreamCb(ctx: *anyopaque, sink: OpaqueStreamSink) anyerror!usize {
        const self: *MockEngine = @ptrCast(@alignCast(ctx));
        if (self.fail_export) return error.CheckpointUnavailable;
        if (self.empty_export) return 0;
        if (self.stream_padding_bytes > 0) {
            const zeroes = [_]u8{0} ** checkpoint_stream_chunk_bytes;
            var remaining = self.stream_padding_bytes;
            while (remaining > 0) {
                const take = @min(remaining, zeroes.len);
                try sink.write(zeroes[0..take]);
                remaining -= take;
            }
            return self.stream_padding_bytes;
        }
        try sink.write("MOCKCP01");
        var sha: [32]u8 = undefined;
        if (self.incomplete_export) {
            std.crypto.hash.sha2.Sha256.hash(&.{}, &sha, .{});
            try sink.write(&sha);
            return 8 + sha.len;
        }
        var offset: usize = 0;
        while (offset < self.state.items.len) {
            const take = @min(checkpoint_stream_chunk_bytes, self.state.items.len - offset);
            try sink.write(self.state.items[offset..][0..take]);
            offset += take;
        }
        std.crypto.hash.sha2.Sha256.hash(self.state.items, &sha, .{});
        try sink.write(&sha);
        return 8 + self.state.items.len + sha.len;
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
    tmp: std.testing.TmpDir,

    fn deinit(self: *TestState) void {
        self.ts.deinit();
        self.tmp.cleanup();
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
    var tmp = testing.tmpDir(.{});
    errdefer tmp.cleanup();
    const ts = TerminalState.init(
        allocator,
        eng.engine(),
        factory.factory(),
        clock.clock(),
        &id,
        .{ .columns = 80, .rows = 24 },
        tmp.dir,
    );
    return .{ .ts = ts, .factory = factory, .clock = clock, .engine_ptr = eng, .tmp = tmp };
}

test "failed resize rollback disables reconnect instead of claiming recovery" {
    var s = try makeState();
    defer s.deinit();
    try s.ts.feedOutput("stable");
    try s.ts.tryCheckpoint();
    try testing.expect(s.ts.checkpointAvailable());

    var prepared = try s.ts.prepareResize(.{ .columns = 120, .rows = 40 });
    defer prepared.deinit();
    s.engine_ptr.fail_resize = true;
    try testing.expectError(error.Internal, s.ts.applyPreparedResize(&prepared));

    try testing.expect(!s.ts.reconnect_available);
    try testing.expectEqual(@as(u32, 80), s.ts.geometry.columns);
    try testing.expectEqual(@as(u32, 24), s.ts.geometry.rows);
    try testing.expectEqual(@as(u32, 1), s.ts.retainedCheckpointCount());
    var destination = try MockEngine.create(testing.allocator);
    defer destination.destroy();
    try testing.expectError(error.CheckpointUnavailable, s.ts.restoreInto(destination.engine()));
}

test "streamed HVTCP001 producer crosses legacy cap with bounded writes and SHA-256" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var file = try tmp.dir.createFile("streamed-checkpoint.bin", .{ .read = true });
    defer file.close();

    const engine_ptr = try MockEngine.create(testing.allocator);
    const engine = engine_ptr.engine();
    defer engine.deinit();
    engine_ptr.stream_padding_bytes = checkpoint_contiguous_max_bytes + 1;
    const engine_id = testBuildId();
    const header = try writeEnvelopeStream(testing.allocator, engine, &file, .{
        .through_seq = 41,
        .created_mono_nanos = 73,
        .columns = 500,
        .rows = 500,
        .cell_width_px_16_16 = 8 << 16,
        .cell_height_px_16_16 = 16 << 16,
        .engine_build_id = &engine_id,
    });

    try testing.expectEqual(
        @as(u32, @intCast(checkpoint_contiguous_max_bytes + 1)),
        header.payload_length,
    );
    const stat = try file.stat();
    try testing.expectEqual(header_bytes + engine_ptr.stream_padding_bytes, stat.size);

    var expected_hash = std.crypto.hash.sha2.Sha256.init(.{});
    const zeroes = [_]u8{0} ** checkpoint_stream_chunk_bytes;
    var remaining = engine_ptr.stream_padding_bytes;
    while (remaining > 0) {
        const take = @min(remaining, zeroes.len);
        expected_hash.update(zeroes[0..take]);
        remaining -= take;
    }
    var expected_sha: [payload_sha256_bytes]u8 = undefined;
    expected_hash.final(&expected_sha);
    try testing.expectEqualSlices(u8, &expected_sha, &header.payload_sha256);

    file.seekTo(0) catch return error.IoFailed;
    var header_buffer: [header_bytes]u8 = undefined;
    try testing.expectEqual(header_buffer.len, try file.readAll(&header_buffer));
    const decoded = try decodeHeader(&header_buffer);
    try testing.expectEqualDeep(header, decoded);

    engine_ptr.fail_export = true;
    try testing.expectError(
        error.CheckpointUnavailable,
        writeEnvelopeStream(testing.allocator, engine, &file, .{
            .through_seq = 42,
            .created_mono_nanos = 74,
            .columns = 500,
            .rows = 500,
            .cell_width_px_16_16 = 8 << 16,
            .cell_height_px_16_16 = 16 << 16,
            .engine_build_id = &engine_id,
        }),
    );
    try testing.expectEqual(@as(u64, header_bytes), (try file.stat()).size);
    file.seekTo(0) catch return error.IoFailed;
    try testing.expectEqual(header_buffer.len, try file.readAll(&header_buffer));
    try testing.expectEqualSlices(u8, &([_]u8{0} ** header_bytes), &header_buffer);
}

test "restore engine compatibility accepts only current and immediate legacy IDs" {
    const current = testBuildId();
    try testing.expect(acceptsEngineBuildId(&current, &current));
    switch (builtin.target.cpu.arch) {
        .aarch64, .x86_64 => try testing.expect(acceptsEngineBuildId(
            &legacy_engine_build_id,
            &current,
        )),
        else => {},
    }
    var unrelated = legacy_engine_build_id;
    unrelated[0] ^= 0xff;
    try testing.expect(!acceptsEngineBuildId(&unrelated, &current));
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
    var checkpoint_magic: [8]u8 = undefined;
    try testing.expectEqual(@as(usize, 8), try cp.readAt(&checkpoint_magic, 0));
    try testing.expectEqualStrings(magic, &checkpoint_magic);
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
    // The previous verified checkpoint plus its retained replay tail remains a
    // valid reattach path. A failed refresh must not silently disable it.
    try testing.expectEqual(seq_after_good, s.ts.checkpointSeq());
    try testing.expect(s.ts.reconnect_available);
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
    const payload = try cp.readOpaqueAlloc(testing.allocator);
    defer testing.allocator.free(payload);
    var corrupt = try testing.allocator.dupe(u8, payload);
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
    try eng.importOpaque(payload);
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

// #91: the checkpoint fires from INSIDE feedOutput, i.e. before the host loop
// pumps the attached viewer. Evicting the covered prefix therefore raced ahead
// of the viewer's sent_seq on the 30s cadence, its next push read an evicted
// range, and the host detached a healthy pane.
test "an interval checkpoint never evicts past a live viewer floor" {
    var s = try makeState();
    defer s.deinit();

    // A viewer is attached and has been sent everything journaled so far.
    try s.ts.feedOutput("delivered");
    s.ts.setViewerFloor(s.ts.outputSeq());

    // The interval elapses, so the next feed checkpoints and evicts inside
    // feedOutput while "undelivered" has not reached the viewer.
    s.clock.nanos += checkpoint_interval_ns;
    try s.ts.feedOutput("undelivered");
    try testing.expect(s.ts.checkpointSeq() > 0);

    // The viewer's next push starts at the floor and must still be servable.
    try testing.expectEqual(@as(u64, 9), s.ts.journal.start_seq);
    try testing.expectEqualStrings("undelivered", try s.ts.journal.sliceFrom(9));

    // Positive control: with no attached viewer the same sequence DOES evict
    // the whole covered prefix, so the assertions above are not vacuous.
    s.ts.setViewerFloor(null);
    s.clock.nanos += checkpoint_interval_ns;
    try s.ts.feedOutput("tail");
    try testing.expectEqual(s.ts.outputSeq(), s.ts.journal.start_seq);
    try testing.expectError(error.CheckpointUnavailable, s.ts.journal.sliceFrom(9));
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
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    {
        var sentinel = try tmp.dir.createFile("sentinel", .{ .mode = 0o600 });
        defer sentinel.close();
        try sentinel.writeAll("unchanged");
    }
    try tmp.dir.symLink("sentinel", "journal.bin.tmp", .{});

    // Positive control: the same core write with no symlink at the temp path
    // succeeds, so the rejection below is the O_NOFOLLOW check, not a dead path.
    try writeAtomicTmp(tmp.dir, "control.bin", "control.bin.tmp", "ok");

    try testing.expectError(error.IoFailed, writeAtomicTmp(tmp.dir, "journal.bin", "journal.bin.tmp", "secret"));
    const contents = try tmp.dir.readFileAlloc(testing.allocator, "sentinel", 32);
    defer testing.allocator.free(contents);
    try testing.expectEqualStrings("unchanged", contents);
}

test "writeAtomic fails closed on a group/other-writable target directory" {
    var s = try makeState();
    defer s.deinit();
    try s.ts.feedOutput("secret");

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.makeDir("shared");
    var shared = try tmp.dir.openDir("shared", .{});
    defer shared.close();
    try shared.chmod(0o777);

    // Shared-dir doctrine: refuse even though the dir is owned by this uid —
    // group/other write bits let a hostile writer race the temp path.
    try testing.expectError(error.IoFailed, s.ts.persistJournal(shared));

    // Positive control: tightening to owner-only unblocks the same persist.
    try shared.chmod(0o700);
    try s.ts.persistJournal(shared);
    const journal_stat = try std.posix.fstatat(shared.fd, "journal.bin", std.posix.AT.SYMLINK_NOFOLLOW);
    try testing.expectEqual(@as(std.c.mode_t, 0o600), journal_stat.mode & 0o777);
}

test "persistJournal uses unique randomized temp names (legacy fixed name inert)" {
    var s = try makeState();
    defer s.deinit();
    try s.ts.feedOutput("secret");

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    // Pre-plant the legacy predictable temp name: a same-dir writer's file must
    // neither be consumed, truncated, nor block the persist.
    {
        var planted = try tmp.dir.createFile("journal.bin.tmp", .{ .mode = 0o600 });
        defer planted.close();
        try planted.writeAll("planted");
    }

    // Two persists back-to-back: randomized names cannot collide with the
    // planted file or with each other.
    try s.ts.persistJournal(tmp.dir);
    try s.ts.persistJournal(tmp.dir);

    const planted = try tmp.dir.readFileAlloc(testing.allocator, "journal.bin.tmp", 32);
    defer testing.allocator.free(planted);
    try testing.expectEqualStrings("planted", planted);

    const journal = try tmp.dir.readFileAlloc(testing.allocator, "journal.bin", 64 * 1024);
    defer testing.allocator.free(journal);
    try testing.expectEqualStrings("secret", journal[16..]);

    // No randomized temp file survives the rename.
    var listing = try tmp.dir.openDir(".", .{ .iterate = true });
    defer listing.close();
    var it = listing.iterate();
    while (try it.next()) |entry| {
        if (std.mem.endsWith(u8, entry.name, ".tmp")) {
            try testing.expectEqualStrings("journal.bin.tmp", entry.name);
        }
    }
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
    try testing.expectEqual(@as(usize, 512 * 1024 * 1024), checkpoint_max_bytes);
    try testing.expectEqual(@as(usize, 64 * 1024 * 1024), checkpoint_contiguous_max_bytes);
    try testing.expectEqual(@as(usize, 2), retained_checkpoints);
    try testing.expectEqual(@as(usize, 64 * 1024), stream_chunk_max_bytes);
    try testing.expectEqual(@as(u64, 2 * 1024 * 1024), checkpoint_output_interval_bytes);
    try testing.expectEqual(@as(u64, 30 * std.time.ns_per_s), checkpoint_interval_ns);
}
