const std = @import("std");
const builtin = @import("builtin");
const terminal = @import("terminal/main.zig");
const pagepkg = @import("terminal/page.zig");
const point = @import("terminal/point.zig");
const hyperlink = @import("terminal/hyperlink.zig");
const build_options = @import("terminal_options");

const sizepkg = @import("terminal/size.zig");

const Allocator = std.mem.Allocator;
const Terminal = terminal.Terminal;
const Stream = terminal.TerminalStream;
const Handler = @import("terminal/stream_terminal.zig").Handler;
const Screen = terminal.Screen;
const ScreenSet = terminal.ScreenSet;
const PageList = terminal.PageList;
const Page = pagepkg.Page;
const Selection = terminal.Selection;
const GlyphEntry = terminal.apc.glyph.Glossary.Entry;
const GlyphOutline = @import("font/opentype/glyf.zig").Glyf.Outline;

pub const max_payload_bytes = 64 * 1024 * 1024;
const magic = "HVGCP001";
const version: u16 = 1;

const identity_sources = [_][]const u8{
    "73534c4680a809398b396c94ac7f12fcccb7963d",
    builtin.zig_version_string,
    "zig-aarch64-macos-0.15.2:3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b",
    "zig-x86_64-macos-0.15.2:375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f",
    @embedFile("hive_checkpoint.zig"),
    @embedFile("terminal/c/terminal.zig"),
    @embedFile("apprt/embedded.zig"),
    @embedFile("Surface.zig"),
    @embedFile("termio/backend.zig"),
    @embedFile("lib_vt.zig"),
    @embedFile("terminal/stream_terminal.zig"),
};

const Sha256 = std.crypto.hash.sha2.Sha256;

fn hashInt(hash: *Sha256, value: u64) void {
    var bytes: [8]u8 = undefined;
    std.mem.writeInt(u64, &bytes, value, .little);
    hash.update(&bytes);
}

fn hashText(hash: *Sha256, value: []const u8) void {
    hash.update(value);
    hash.update(&.{0});
}

fn hashTypeLayout(hash: *Sha256, comptime T: type) void {
    const info = @typeInfo(T);
    hashText(hash, @tagName(std.meta.activeTag(info)));
    hashInt(hash, @sizeOf(T));
    hashInt(hash, @alignOf(T));
    hashInt(hash, @bitSizeOf(T));
    switch (info) {
        .int => |v| hashText(hash, @tagName(v.signedness)),
        .@"enum" => |v| {
            hashTypeLayout(hash, v.tag_type);
            inline for (v.fields) |field| {
                hashText(hash, field.name);
                hashInt(hash, field.value);
            }
        },
        .@"struct" => |v| {
            hashText(hash, @tagName(v.layout));
            inline for (v.fields) |field| {
                hashText(hash, field.name);
                if (!field.is_comptime) hashInt(hash, @bitOffsetOf(T, field.name));
                hashTypeLayout(hash, field.type);
            }
        },
        .@"union" => |v| {
            hashText(hash, @tagName(v.layout));
            if (v.tag_type) |tag| hashTypeLayout(hash, tag);
            inline for (v.fields) |field| {
                hashText(hash, field.name);
                hashTypeLayout(hash, field.type);
            }
        },
        .array => |v| {
            hashInt(hash, v.len);
            hashTypeLayout(hash, v.child);
        },
        .optional => |v| hashTypeLayout(hash, v.child),
        .pointer => |v| {
            hashText(hash, @tagName(v.size));
            hashInt(hash, v.alignment);
        },
        else => {},
    }
}

/// Single source of truth for the wire (fingerprint completeness B): the
/// fingerprint hashes exactly this list, and the write/read funnel enforces
/// membership at compile time — serializing a type that is not fingerprinted
/// is a build error, so the two can never drift apart.
const fingerprinted_types = .{
    c_char, c_int,
    u8,     u16,
    u21,    u32,
    u64,    usize,
    bool,   ?u21,

    @TypeOf(@as(Handler, undefined).apc_handler.max_bytes), @TypeOf(@as(Handler, undefined).apc_handler.enabled),
    @TypeOf(@as(Handler, undefined).default_cursor),        @TypeOf(@as(Handler, undefined).default_cursor_style),
    @TypeOf(@as(Handler, undefined).default_cursor_blink),  @TypeOf(@as(Terminal, undefined).status_display),
    @TypeOf(@as(Terminal, undefined).rows),                 @TypeOf(@as(Terminal, undefined).cols),
    Terminal.ScrollingRegion,                               Terminal.Colors,
    @TypeOf(@as(Terminal, undefined).modes),                @TypeOf(@as(Terminal, undefined).mouse_shape),
    @TypeOf(@as(Terminal, undefined).flags),                ScreenSet.Key,
    @TypeOf(@as(PageList, undefined).cols),                 @TypeOf(@as(PageList, undefined).rows),
    Page,                                                   Page.Layout,
    pagepkg.Row,                                            pagepkg.Cell,
    ?Screen.SavedCursor,                                    Screen.CharsetState,
    @TypeOf(@as(Screen, undefined).protected_mode),         @TypeOf(@as(Screen, undefined).kitty_keyboard),
    Screen.SemanticPrompt,                                  CursorWire,
    point.Coordinate,                                       terminal.Style,
    hyperlink.PageEntry,                                    Screen.CursorStyle,
    StyleSet,                                               HyperlinkSet,
    terminal.Style.Color,

    terminal.kitty.graphics.Image,                                         @TypeOf(@as(terminal.kitty.graphics.ImageStorage, undefined).image_limits),
    @TypeOf(@as(terminal.kitty.graphics.LoadingImage, undefined).display), @TypeOf(@as(terminal.kitty.graphics.LoadingImage, undefined).quiet),
    terminal.kitty.graphics.ImageStorage.PlacementKey,                     terminal.kitty.graphics.ImageStorage.Placement,
    @TypeOf(@as(GlyphEntry, undefined).design),                            @TypeOf(@as(GlyphEntry, undefined).width),
    @TypeOf(@as(GlyphEntry, undefined).constraint),                        GlyphOutline.Point,
};

fn isFingerprinted(comptime T: type) bool {
    comptime {
        for (fingerprinted_types) |F| if (F == T) return true;
        return false;
    }
}

fn assertFingerprinted(comptime T: type) void {
    if (comptime !isFingerprinted(T))
        @compileError("serialized type is not fingerprinted: " ++ @typeName(T));
}

fn hashLayoutCommon(hash: *Sha256, page_size: usize) void {
    hashText(hash, "hive-checkpoint-layout-v1");
    // Architecture binding (fingerprint completeness A): checkpoints embed
    // raw page memory whose page-rounded layout is architecture-specific,
    // and cross-architecture separation must not rest solely on the
    // page-size input below.
    hashText(hash, @tagName(builtin.target.cpu.arch));
    hashText(hash, @tagName(builtin.target.cpu.arch.endian()));
    hashText(hash, @tagName(builtin.target.abi));
    hashText(hash, @tagName(builtin.target.cCharSignedness()));
    hashInt(hash, builtin.target.ptrBitWidth());
    hashInt(hash, page_size);

    // Only options that affect checkpoint bytes or replay belong here.
    inline for (.{
        build_options.c_abi,
        build_options.kitty_graphics,
        build_options.tmux_control_mode,
        build_options.slow_runtime_safety,
    }) |value| hashInt(hash, @intFromBool(value));

    inline for (fingerprinted_types) |T| hashTypeLayout(hash, T);
}

fn hashCheckpointLayout(hash: *Sha256) void {
    hashLayoutCommon(hash, std.heap.page_size_min);
    hashPlainValue(hash, Page.layout(.{ .cols = 80, .rows = 24 }));
}

/// Backlog-A proof surface: the layout fingerprint with every page-size
/// derived input held constant (page-size input pinned, concrete page
/// layout excluded). The qualification harness dumps this on both native
/// slices and requires inequality — architecture separation must survive
/// with page size held equal.
pub fn archProofFingerprint() [32]u8 {
    var hash = Sha256.init(.{});
    hashLayoutCommon(&hash, 4096);
    var out: [32]u8 = undefined;
    hash.final(&out);
    return out;
}

var build_id: [32]u8 = undefined;
var build_id_hex: [65]u8 = undefined;
var build_id_once = std.once(initBuildId);

// Universal slices share an ID only when their serialized layouts are equal.
fn initBuildId() void {
    var hash = Sha256.init(.{});
    for (identity_sources) |source| {
        hash.update(source);
        hash.update(&.{0});
    }
    hashCheckpointLayout(&hash);
    hash.final(&build_id);
    build_id_hex[0..64].* = std.fmt.bytesToHex(build_id, .lower);
    build_id_hex[64] = 0;
}

pub fn buildId() *const [32]u8 {
    build_id_once.call();
    return &build_id;
}

pub fn buildIdHex() [*:0]const u8 {
    build_id_once.call();
    return @ptrCast(&build_id_hex);
}

pub const Error = Allocator.Error || error{
    InvalidCheckpoint,
    CheckpointTooLarge,
};

/// The structural wire codec. Every value reaches the wire as live data
/// only: integers as little-endian byte-aligned values, enums as their
/// backing integer, packed structs as exactly their backing-integer bytes,
/// auto structs field-by-field in declaration order, optionals as a presence
/// byte plus payload, and tagged unions as the tag plus the active payload
/// only. In-memory padding and inactive union payload bytes therefore never
/// reach the wire — the class of defect behind non-deterministic, leaking
/// checkpoint bytes. Pointer-bearing and untagged types are compile errors,
/// forcing an explicit per-field decision at the call site.
fn ByteAlignedInt(comptime T: type) type {
    return std.math.ByteAlignedInt(T);
}

fn emitValue(w: *Writer, value: anytype) Error!void {
    const T = @TypeOf(value);
    switch (@typeInfo(T)) {
        .int => {
            const Wide = ByteAlignedInt(T);
            var bytes: [@divExact(@bitSizeOf(Wide), 8)]u8 = undefined;
            std.mem.writeInt(Wide, &bytes, value, .little);
            try w.write(&bytes);
        },
        .bool => try w.write(&.{@intFromBool(value)}),
        .float => try emitValue(
            w,
            @as(std.meta.Int(.unsigned, @bitSizeOf(T)), @bitCast(value)),
        ),
        .@"enum" => |info| try emitValue(w, @as(info.tag_type, @intFromEnum(value))),
        .@"struct" => |info| switch (info.layout) {
            .@"packed" => try emitValue(w, @as(info.backing_integer.?, @bitCast(value))),
            else => inline for (info.fields) |field| {
                if (!field.is_comptime) try emitValue(w, @field(value, field.name));
            },
        },
        .optional => {
            try emitValue(w, value != null);
            if (value) |unwrapped| try emitValue(w, unwrapped);
        },
        .@"union" => |info| {
            if (info.tag_type == null)
                @compileError("untagged union is not serializable: " ++ @typeName(T));
            try emitValue(w, std.meta.activeTag(value));
            switch (value) {
                inline else => |payload| try emitValue(w, payload),
            }
        },
        .array => for (value) |item| try emitValue(w, item),
        .void => {},
        else => @compileError("type is not serializable: " ++ @typeName(T)),
    }
}

fn readValue(r: *Reader, comptime T: type) Error!T {
    switch (@typeInfo(T)) {
        .int => {
            const Wide = ByteAlignedInt(T);
            const wide_bytes = @divExact(@bitSizeOf(Wide), 8);
            const raw = std.mem.readInt(
                Wide,
                (try r.take(wide_bytes))[0..wide_bytes],
                .little,
            );
            return std.math.cast(T, raw) orelse error.InvalidCheckpoint;
        },
        .bool => return switch ((try r.take(1))[0]) {
            0 => false,
            1 => true,
            else => error.InvalidCheckpoint,
        },
        .float => return @bitCast(
            try readValue(r, std.meta.Int(.unsigned, @bitSizeOf(T))),
        ),
        .@"enum" => |info| {
            const raw = try readValue(r, info.tag_type);
            return std.meta.intToEnum(T, raw) catch error.InvalidCheckpoint;
        },
        .@"struct" => |info| switch (info.layout) {
            .@"packed" => return @bitCast(try readValue(r, info.backing_integer.?)),
            else => {
                var result: T = undefined;
                inline for (info.fields) |field| {
                    if (!field.is_comptime) {
                        @field(result, field.name) = try readValue(r, field.type);
                    }
                }
                return result;
            },
        },
        .optional => |info| {
            if (!try readValue(r, bool)) return null;
            return try readValue(r, info.child);
        },
        .@"union" => |info| {
            const Tag = info.tag_type orelse
                @compileError("untagged union is not deserializable: " ++ @typeName(T));
            const tag = try readValue(r, Tag);
            switch (tag) {
                inline else => |active| {
                    const Payload = @FieldType(T, @tagName(active));
                    return @unionInit(T, @tagName(active), try readValue(r, Payload));
                },
            }
        },
        .array => |info| {
            var result: T = undefined;
            for (&result) |*item| item.* = try readValue(r, info.child);
            return result;
        },
        .void => return {},
        else => @compileError("type is not deserializable: " ++ @typeName(T)),
    }
}

/// Emit every field of an auto-layout struct except the comptime-named
/// skip list. Skipped fields are the caller's responsibility on both sides
/// (pointer-bearing fields whose payloads travel separately).
fn emitStructExcept(
    w: *Writer,
    value: anytype,
    comptime skip: []const []const u8,
) Error!void {
    const T = @TypeOf(value);
    assertFingerprinted(T);
    inline for (@typeInfo(T).@"struct".fields) |field| {
        comptime var skipped = false;
        inline for (skip) |name| {
            if (comptime std.mem.eql(u8, field.name, name)) skipped = true;
        }
        if (!skipped and !field.is_comptime) {
            try emitValue(w, @field(value, field.name));
        }
    }
}

/// Read every field of an auto-layout struct except the comptime-named skip
/// list, which are left undefined for the caller to fill.
fn readStructExcept(
    r: *Reader,
    comptime T: type,
    comptime skip: []const []const u8,
) Error!T {
    assertFingerprinted(T);
    var result: T = undefined;
    inline for (@typeInfo(T).@"struct".fields) |field| {
        comptime var skipped = false;
        inline for (skip) |name| {
            if (comptime std.mem.eql(u8, field.name, name)) skipped = true;
        }
        if (!skipped and !field.is_comptime) {
            @field(result, field.name) = try readValue(r, field.type);
        }
    }
    return result;
}

/// Hash a plain data value (ints, bools, enums, and structs/arrays of them)
/// into the layout fingerprint. Used for the concrete page layout constants.
fn hashPlainValue(hash: *Sha256, value: anytype) void {
    const T = @TypeOf(value);
    switch (@typeInfo(T)) {
        .int => hashInt(hash, @intCast(value)),
        .bool => hashInt(hash, @intFromBool(value)),
        .@"enum" => hashInt(hash, @intFromEnum(value)),
        .@"struct" => |info| inline for (info.fields) |field| {
            if (!field.is_comptime) hashPlainValue(hash, @field(value, field.name));
        },
        .array => for (value) |item| hashPlainValue(hash, item),
        .void => {},
        else => @compileError("type is not layout-hashable: " ++ @typeName(T)),
    }
}

const Writer = struct {
    alloc: Allocator,
    bytes: std.ArrayList(u8) = .empty,

    fn deinit(self: *Writer) void {
        self.bytes.deinit(self.alloc);
    }

    fn write(self: *Writer, bytes: []const u8) Error!void {
        if (bytes.len > max_payload_bytes -| self.bytes.items.len)
            return error.CheckpointTooLarge;
        try self.bytes.appendSlice(self.alloc, bytes);
    }

    fn plain(self: *Writer, value: anytype) Error!void {
        assertFingerprinted(@TypeOf(value));
        try emitValue(self, value);
    }

    fn slice(self: *Writer, bytes: []const u8) Error!void {
        if (bytes.len > std.math.maxInt(u32)) return error.CheckpointTooLarge;
        try self.plain(@as(u32, @intCast(bytes.len)));
        try self.write(bytes);
    }

    fn finish(self: *Writer) Error![]u8 {
        return try self.bytes.toOwnedSlice(self.alloc);
    }
};

const Reader = struct {
    bytes: []const u8,
    offset: usize = 0,

    fn take(self: *Reader, len: usize) Error![]const u8 {
        if (len > self.bytes.len -| self.offset) return error.InvalidCheckpoint;
        defer self.offset += len;
        return self.bytes[self.offset..][0..len];
    }

    fn plain(self: *Reader, comptime T: type) Error!T {
        assertFingerprinted(T);
        return readValue(self, T);
    }

    fn slice(self: *Reader, alloc: Allocator) Error![]u8 {
        const len = try self.plain(u32);
        return try alloc.dupe(u8, try self.take(len));
    }

    fn done(self: Reader) bool {
        return self.offset == self.bytes.len;
    }
};

pub const HandlerState = struct {
    max_bytes: @TypeOf(@as(Handler, undefined).apc_handler.max_bytes),
    enabled: @TypeOf(@as(Handler, undefined).apc_handler.enabled),
    default_cursor: bool,
    default_cursor_style: Screen.CursorStyle,
    default_cursor_blink: bool,
};

pub const Snapshot = struct {
    terminal: Terminal,
    handler: HandlerState,
    pending: []u8,

    pub fn deinit(self: *Snapshot, alloc: Allocator) void {
        self.terminal.deinit(alloc);
        alloc.free(self.pending);
        self.* = undefined;
    }
};

pub const ManualWrite = struct {
    context: ?*anyopaque,
    callback: *const fn (?*anyopaque, [*]const u8, usize) callconv(.c) void,

    pub fn queue(
        self: ManualWrite,
        alloc: Allocator,
        data: []const u8,
        linefeed: bool,
    ) Allocator.Error!void {
        if (!linefeed or std.mem.indexOfScalar(u8, data, '\r') == null) {
            self.callback(self.context, data.ptr, data.len);
            return;
        }
        const cr_count = std.mem.count(u8, data, "\r");
        const encoded = try alloc.alloc(u8, data.len + cr_count);
        defer alloc.free(encoded);
        var out: usize = 0;
        for (data) |byte| {
            encoded[out] = byte;
            out += 1;
            if (byte == '\r') {
                encoded[out] = '\n';
                out += 1;
            }
        }
        self.callback(self.context, encoded.ptr, encoded.len);
    }
};

pub const OutputRangeLedger = struct {
    through_seq: u64 = 0,
    ranges: std.ArrayList(Range) = .empty,

    /// Bounded replay-dedup window. Accepted chunks are monotone in
    /// stream_seq (commit only follows a classify .accept, which requires
    /// stream_seq == through_seq), so evicting the oldest range only
    /// narrows the dedup window: a replay of an evicted range classifies
    /// .invalid (rejected) instead of .duplicate — it can never be
    /// re-accepted, so eviction fails closed. Unbounded growth would be a
    /// memory DoS: every accepted chunk would otherwise pin a 48-byte
    /// Range for the lifetime of the surface.
    pub const max_ranges: usize = 1024;

    const Range = struct {
        start: u64,
        end: u64,
        digest: [32]u8,
    };

    pub const Decision = enum { accept, duplicate, invalid };

    pub fn deinit(self: *OutputRangeLedger, alloc: Allocator) void {
        self.ranges.deinit(alloc);
    }

    pub fn reset(self: *OutputRangeLedger, through_seq: u64) void {
        self.ranges.clearRetainingCapacity();
        self.through_seq = through_seq;
    }

    pub fn classify(
        self: *const OutputRangeLedger,
        bytes: []const u8,
        stream_seq: u64,
    ) Decision {
        if (bytes.len == 0) return .invalid;
        const end = std.math.add(u64, stream_seq, @as(u64, @intCast(bytes.len))) catch
            return .invalid;
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
        if (stream_seq < self.through_seq) {
            for (self.ranges.items) |range| {
                if (range.start != stream_seq or range.end != end) continue;
                return if (std.mem.eql(u8, &range.digest, &digest))
                    .duplicate
                else
                    .invalid;
            }
            return .invalid;
        }
        if (stream_seq != self.through_seq) return .invalid;
        return .accept;
    }

    pub fn commit(
        self: *OutputRangeLedger,
        alloc: Allocator,
        bytes: []const u8,
        stream_seq: u64,
    ) Allocator.Error!void {
        const end = stream_seq + @as(u64, @intCast(bytes.len));
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
        // Bounded dedup window (see max_ranges): evict-oldest. An evicted
        // range replays as .invalid, never as a re-accept.
        if (self.ranges.items.len >= max_ranges)
            _ = self.ranges.orderedRemove(0);
        try self.ranges.append(alloc, .{
            .start = stream_seq,
            .end = end,
            .digest = digest,
        });
        self.through_seq = end;
    }
};

pub fn feed(
    stream: *Stream,
    pending: *std.ArrayList(u8),
    alloc: Allocator,
    valid: *bool,
    bytes: []const u8,
) void {
    for (bytes) |byte| {
        if (valid.*) pending.append(alloc, byte) catch {
            valid.* = false;
            pending.clearRetainingCapacity();
        };
        stream.next(byte);
        if (stream.parser.state == .ground and
            stream.utf8decoder.state == 0 and
            stream.handler.apc_handler.state == .inactive and
            stream.handler.dcs_handler.state == .inactive)
        {
            pending.clearRetainingCapacity();
        }
    }
}

/// Initialize the restored stream directly in its FINAL storage (`out`)
/// and replay the pending tail there. Replaying a partial OSC engages the
/// parser's capture, whose writer pointer and fixed backing both reference
/// the stream's own storage — a stream that has replayed pending bytes must
/// NEVER be moved afterwards (use-after-move: the capture would dangle and
/// a later OSC continuation writes through the stale pointer). A pristine
/// stream has no captures engaged, which is why the single init move below
/// is sound.
///
/// Infallible, so callers may sequence this after a point of no return.
/// initAlloc cannot fail. Replay CAN engage allocating parser state (the
/// OSC 52/66 capture writer, the APC glyph/kitty parsers, the DCS xtgettcap
/// buffer), but every one of those allocation sites already degrades
/// instead of propagating: the OSC capture allocates all-or-nothing and on
/// failure falls back to its fixed buffer, overflowing into the invalid
/// state (osc.zig Capture.allocating/captureTrailing/next), the APC and
/// DCS handlers catch and ignore (apc.zig feed/end, dcs.zig hook/put), and
/// terminal actions route through vtFallible, which logs and continues
/// (stream_terminal.zig vt). Allocation failure during replay therefore
/// cannot panic; the positive-control test below ("restored replay
/// survives allocation failure") pins that contract under a failing
/// allocator.
pub fn restoreStream(
    out: *Stream,
    t: *Terminal,
    state: HandlerState,
    pending: []const u8,
    effects: Handler.Effects,
) void {
    var handler: Handler = .init(t);
    handler.apc_handler.max_bytes = state.max_bytes;
    handler.apc_handler.enabled = state.enabled;
    handler.default_cursor = state.default_cursor;
    handler.default_cursor_style = state.default_cursor_style;
    handler.default_cursor_blink = state.default_cursor_blink;

    out.* = .initAlloc(t.gpa(), handler);
    for (pending) |byte| out.next(byte);
    out.handler.effects = effects;
}

pub fn encode(
    alloc: Allocator,
    t: *const Terminal,
    stream: *const Stream,
    pending: []const u8,
) Error![]u8 {
    var w: Writer = .{ .alloc = alloc };
    errdefer w.deinit();

    try w.write(magic);
    try w.plain(version);
    try w.write(buildId());
    try writeTerminal(&w, t);
    try w.plain(stream.handler.apc_handler.max_bytes);
    try w.plain(stream.handler.apc_handler.enabled);
    try w.plain(stream.handler.default_cursor);
    try w.plain(stream.handler.default_cursor_style);
    try w.plain(stream.handler.default_cursor_blink);
    try w.slice(pending);
    return try w.finish();
}

pub fn decode(alloc: Allocator, payload: []const u8) Error!Snapshot {
    if (payload.len > max_payload_bytes) return error.CheckpointTooLarge;
    var r: Reader = .{ .bytes = payload };
    if (!std.mem.eql(u8, try r.take(magic.len), magic))
        return error.InvalidCheckpoint;
    if (try r.plain(u16) != version) return error.InvalidCheckpoint;
    if (!std.mem.eql(u8, try r.take(buildId().len), buildId()))
        return error.InvalidCheckpoint;

    var decoded_terminal = try readTerminal(&r, alloc);
    errdefer decoded_terminal.deinit(alloc);
    const handler: HandlerState = .{
        .max_bytes = try r.plain(@TypeOf(@as(Handler, undefined).apc_handler.max_bytes)),
        .enabled = try r.plain(@TypeOf(@as(Handler, undefined).apc_handler.enabled)),
        .default_cursor = try r.plain(bool),
        .default_cursor_style = try r.plain(Screen.CursorStyle),
        .default_cursor_blink = try r.plain(bool),
    };
    const pending = try r.slice(alloc);
    errdefer alloc.free(pending);
    if (!r.done()) return error.InvalidCheckpoint;
    return .{
        .terminal = decoded_terminal,
        .handler = handler,
        .pending = pending,
    };
}

fn writeTerminal(w: *Writer, t: *const Terminal) Error!void {
    try w.plain(t.status_display);
    try w.plain(t.rows);
    try w.plain(t.cols);
    try w.plain(t.width_px);
    try w.plain(t.height_px);
    try w.plain(t.scrolling_region);
    try w.slice(t.getPwd() orelse "");
    try w.slice(t.getTitle() orelse "");
    try w.plain(t.colors);
    try w.plain(t.previous_char);
    try w.plain(t.modes);
    try w.plain(t.mouse_shape);

    var flags = t.flags;
    flags.focused = true;
    flags.selection_scroll = false;
    flags.search_viewport_dirty = false;
    flags.dirty = .{};
    try w.plain(flags);

    for (0..t.cols) |col| try w.plain(t.tabstops.get(col));
    try writeGlyphs(w, t);

    try w.plain(t.screens.active_key);
    try w.plain(t.screens.generations.get(.primary).?);
    try w.plain(t.screens.generations.get(.alternate).?);
    try writeScreen(w, t.screens.get(.primary).?);
    const alternate = t.screens.get(.alternate);
    try w.plain(alternate != null);
    if (alternate) |screen| try writeScreen(w, screen);
}

fn readTerminal(r: *Reader, alloc: Allocator) Error!Terminal {
    const status_display = try r.plain(@TypeOf(@as(Terminal, undefined).status_display));
    const rows = try r.plain(@TypeOf(@as(Terminal, undefined).rows));
    const cols = try r.plain(@TypeOf(@as(Terminal, undefined).cols));
    if (rows == 0 or cols == 0) return error.InvalidCheckpoint;

    var t: Terminal = try .init(alloc, .{ .cols = cols, .rows = rows });
    errdefer t.deinit(alloc);
    t.status_display = status_display;
    t.width_px = try r.plain(u32);
    t.height_px = try r.plain(u32);
    t.scrolling_region = try r.plain(Terminal.ScrollingRegion);

    const pwd = try r.slice(alloc);
    defer alloc.free(pwd);
    const title = try r.slice(alloc);
    defer alloc.free(title);
    try t.setPwd(pwd);
    try t.setTitle(title);
    t.colors = try r.plain(Terminal.Colors);
    t.previous_char = try r.plain(?u21);
    t.modes = try r.plain(@TypeOf(t.modes));
    t.mouse_shape = try r.plain(@TypeOf(t.mouse_shape));
    t.flags = try r.plain(@TypeOf(t.flags));

    for (0..cols) |col| {
        const set = try r.plain(bool);
        if (set != t.tabstops.get(col)) {
            if (set) t.tabstops.set(col) else t.tabstops.unset(col);
        }
    }
    try readGlyphs(r, alloc, &t);

    const active_key = try r.plain(ScreenSet.Key);
    const primary_generation = try r.plain(usize);
    const alternate_generation = try r.plain(usize);
    const primary = try readScreen(r, alloc);
    errdefer {
        primary.deinit();
        alloc.destroy(primary);
    }
    const has_alternate = try r.plain(bool);
    const alternate = if (has_alternate) try readScreen(r, alloc) else null;
    errdefer if (alternate) |screen| {
        screen.deinit();
        alloc.destroy(screen);
    };

    var all: @TypeOf(t.screens.all) = .init(.{});
    all.put(.primary, primary);
    if (alternate) |screen| all.put(.alternate, screen);
    const active = all.get(active_key) orelse return error.InvalidCheckpoint;
    var generations: @TypeOf(t.screens.generations) = .initFull(0);
    generations.put(.primary, primary_generation);
    generations.put(.alternate, alternate_generation);
    t.screens.deinit(alloc);
    t.screens = .{
        .active_key = active_key,
        .active = active,
        .all = all,
        .generations = generations,
    };
    return t;
}

const StyleSet = @TypeOf(@as(Page, undefined).styles);
const HyperlinkSet = @TypeOf(@as(Page, undefined).hyperlink_set);
const SetRefCountInt = sizepkg.CellCountInt;

/// Build the canonical twin of a live page: a freshly zeroed same-capacity
/// page into which only the live rows are structurally cloned. Live page
/// memory carries dead bytes — freed cells/styles/graphemes/strings and
/// recycled regions — whose content is build- and history-dependent and may
/// predate the checkpoint; nothing dead may reach the wire. A same-capacity
/// clone cannot exceed any set or allocator capacity, so failures here are
/// allocation failures.
fn canonicalPage(page: *const Page) Error!Page {
    var canon = Page.init(page.capacity) catch return error.OutOfMemory;
    errdefer canon.deinit();
    canon.cloneFrom(page, 0, page.size.rows) catch return error.OutOfMemory;
    canon.size = page.size;
    return canon;
}

/// Emit one ref-counted set as a structural side table: count, then per id
/// in ascending (== canonical insertion) order the refcount and the value.
/// Canonical pages build their sets exclusively through cloneFrom insertion,
/// so ids are contiguous from 1 and every id is live.
fn writeSetTable(w: *Writer, set: anytype, memory: []u8) Error!void {
    const live: u32 = @intCast(set.next_id - 1);
    try w.plain(live);
    var id: u32 = 1;
    while (id <= live) : (id += 1) {
        try w.plain(set.refCount(memory, @intCast(id)));
        try w.plain(set.get(memory, @intCast(id)).*);
    }
}

/// Rebuild a scrubbed set region from its side table. addWithId recomputes
/// the table/probe state deterministically from the canonical value hashes,
/// in the same ascending-id order the exporter used, so a valid table
/// reproduces the exporter's set struct exactly (validated by the caller).
fn readSetTable(
    r: *Reader,
    comptime T: type,
    set: anytype,
    memory: []u8,
    ctx: anytype,
    string_bounds: ?struct { start: usize, end: usize },
) Error!void {
    const live = try r.plain(u32);
    // Ids 1..live must fit the layout (id 0 is reserved); anything larger
    // trips asserts inside the set instead of returning an error.
    if (live >= set.layout.cap) return error.InvalidCheckpoint;
    var id: u32 = 1;
    while (id <= live) : (id += 1) {
        const ref = try r.plain(SetRefCountInt);
        if (ref == 0) return error.InvalidCheckpoint;
        const value = try r.plain(T);
        // Hyperlink entries are hashed through their string storage, so
        // their offsets must be bounded before the set dereferences them.
        if (comptime T == hyperlink.PageEntry) {
            const bounds = string_bounds.?;
            if (!hyperlinkSliceInBounds(value.uri, bounds.start, bounds.end))
                return error.InvalidCheckpoint;
            switch (value.id) {
                .explicit => |slice| if (!hyperlinkSliceInBounds(
                    slice,
                    bounds.start,
                    bounds.end,
                )) return error.InvalidCheckpoint,
                .implicit => {},
            }
        }
        const assigned = set.addWithIdContext(memory, value, @intCast(id), ctx) catch
            return error.InvalidCheckpoint;
        if (assigned) |actual| if (actual != id) return error.InvalidCheckpoint;
        if (ref > 1) set.useMultiple(memory, @intCast(id), ref - 1);
    }
}

/// Fields of Page whose value is a pure function of the capacity-derived
/// layout. Everything else is either live state validated separately or the
/// scrubbed sets rebuilt from side tables. An unknown field name fails the
/// comparison closed (treated as derived), so an upstream Page change that
/// adds live state breaks decoding loudly rather than silently.
fn validateDerivedMetadata(metadata: *const Page, derived: *const Page) bool {
    inline for (@typeInfo(Page).@"struct".fields) |field| {
        const skip = comptime for ([_][]const u8{
            "memory",
            "size",
            "dirty",
            "pause_integrity_checks",
            "styles",
            "hyperlink_set",
        }) |name| {
            if (std.mem.eql(u8, field.name, name)) break true;
        } else false;
        if (!skip) {
            if (!std.meta.eql(
                @field(metadata.*, field.name),
                @field(derived.*, field.name),
            )) return false;
        }
    }
    return true;
}

fn hyperlinkSliceInBounds(
    slice: anytype,
    start: usize,
    end: usize,
) bool {
    const offset: usize = slice.offset.offset;
    const slice_end = std.math.add(usize, offset, slice.len) catch return false;
    return offset >= start and slice_end <= end;
}

fn writePageList(w: *Writer, pages: *const PageList) Error!void {
    try w.plain(pages.page_serial);
    try w.plain(pages.page_serial_epoch);
    try w.plain(pages.explicit_max_size);
    try w.plain(pages.min_max_size);
    try w.plain(pages.cols);
    try w.plain(pages.rows);
    try w.plain(pages.total_rows);

    var count: u32 = 0;
    var count_it = pages.pages.first;
    while (count_it) |node| : (count_it = node.next) count += 1;
    try w.plain(count);

    var it = pages.pages.first;
    while (it) |node| : (it = node.next) {
        var preserved = try node.pagePreservingState(w.alloc);
        defer preserved.deinit();
        const page = preserved.page();
        try w.plain(node.serial);

        var canon = try canonicalPage(page);
        defer canon.deinit();
        // The hyperlink set's context holds transient page pointers used
        // only while hashing/comparing; it is never wire state and is
        // re-supplied per call on import.
        try emitStructExcept(w, canon, &.{ "memory", "hyperlink_set" });
        try emitStructExcept(w, canon.hyperlink_set, &.{"context"});

        // Raw page bytes, with the union-bearing set regions zeroed on the
        // wire: stored set items contain in-memory union padding that Zig
        // cannot canonicalize in place, so those regions travel as
        // structural side tables instead.
        const l = Page.layout(canon.capacity);
        if (canon.memory.len > std.math.maxInt(u32)) return error.CheckpointTooLarge;
        try w.plain(@as(u32, @intCast(canon.memory.len)));
        const base = w.bytes.items.len;
        try w.write(canon.memory);
        const wire_page = w.bytes.items[base..][0..canon.memory.len];
        @memset(wire_page[l.styles_start..][0..l.styles_layout.total_size], 0);
        @memset(
            wire_page[l.hyperlink_set_start..][0..l.hyperlink_set_layout.total_size],
            0,
        );
        // The grapheme and hyperlink-map hash tables / bitmap allocators store
        // interior offsets whose ALIGNMENT is asserted on deref; a corrupt
        // stored offset would reach Offset.ptr's unreachable in ReleaseFast
        // (illegal behavior on corrupt input, a CH violation). Scrub these
        // regions on the wire and rebuild their cell associations from range-
        // validated side tables on import — no raw region byte is ever
        // dereferenced during decode. (string_alloc stays raw: it is u8, so it
        // never misaligns, and its only readers already bounds-check offsets.)
        @memset(wire_page[l.grapheme_alloc_start..][0..l.grapheme_alloc_layout.total_size], 0);
        @memset(wire_page[l.grapheme_map_start..][0..l.grapheme_map_layout.total_size], 0);
        @memset(wire_page[l.hyperlink_map_start..][0..l.hyperlink_map_layout.total_size], 0);

        try writeSetTable(w, &canon.styles, canon.memory);
        try writeSetTable(w, &canon.hyperlink_set, canon.memory);
        try writeGraphemeTable(w, &canon);
        try writeHyperlinkMapTable(w, &canon);
    }
}

/// Emit a side table of (cell linear index, codepoints) for every cell that
/// carries grapheme continuation data. Safe: `page` is our canonical clone.
fn writeGraphemeTable(w: *Writer, page: *const Page) Error!void {
    const cols: usize = page.size.cols;
    const rows = page.rows.ptr(page.memory)[0..page.size.rows];
    var count: u32 = 0;
    for (rows) |*row| {
        const cells = row.cells.ptr(page.memory)[0..cols];
        for (cells) |*cell| if (cell.hasGrapheme()) {
            count += 1;
        };
    }
    try w.plain(count);
    for (rows, 0..) |*row, y| {
        const cells = row.cells.ptr(page.memory)[0..cols];
        for (cells, 0..) |*cell, x| if (cell.hasGrapheme()) {
            const cps = page.lookupGrapheme(cell) orelse return error.InvalidCheckpoint;
            try w.plain(@as(u32, @intCast(y * cols + x)));
            try w.plain(@as(u32, @intCast(cps.len)));
            for (cps) |cp| try w.plain(cp);
        };
    }
}

/// Emit a side table of (cell linear index, hyperlink id) for every cell
/// associated with a hyperlink.
fn writeHyperlinkMapTable(w: *Writer, page: *const Page) Error!void {
    const cols: usize = page.size.cols;
    const rows = page.rows.ptr(page.memory)[0..page.size.rows];
    var count: u32 = 0;
    for (rows) |*row| {
        const cells = row.cells.ptr(page.memory)[0..cols];
        for (cells) |*cell| if (cell.hyperlink) {
            count += 1;
        };
    }
    try w.plain(count);
    for (rows, 0..) |*row, y| {
        const cells = row.cells.ptr(page.memory)[0..cols];
        for (cells, 0..) |*cell, x| if (cell.hyperlink) {
            const id = page.lookupHyperlink(cell) orelse return error.InvalidCheckpoint;
            try w.plain(@as(u32, @intCast(y * cols + x)));
            try w.plain(id);
        };
    }
}

/// Resolve a serialized (linear cell index) to its row/cell pointers,
/// rejecting an out-of-range index.
fn cellAt(page: *Page, owned: []u8, index: u32) Error!struct { row: *pagepkg.Row, cell: *pagepkg.Cell } {
    const cols: usize = page.size.cols;
    const total = cols * @as(usize, page.size.rows);
    if (index >= total) return error.InvalidCheckpoint;
    const row = &page.rows.ptr(owned)[index / cols];
    const cell = &row.cells.ptr(owned)[index % cols];
    return .{ .row = row, .cell = cell };
}

fn readGraphemeTable(r: *Reader, page: *Page, owned: []u8) Error!void {
    const count = try r.plain(u32);
    for (0..count) |_| {
        const loc = try cellAt(page, owned, try r.plain(u32));
        const cp_count = try r.plain(u32);
        if (cp_count == 0) return error.InvalidCheckpoint;
        // Take the alloc-new branch on the first codepoint: a scrubbed map
        // has no entry for this cell, so appendGrapheme must not try to
        // append to an existing (absent) slice.
        loc.cell.content_tag = .codepoint;
        for (0..cp_count) |_| {
            const cp = try r.plain(u21);
            page.appendGrapheme(loc.row, loc.cell, cp) catch
                return error.InvalidCheckpoint;
        }
    }
}

fn readHyperlinkMapTable(r: *Reader, page: *Page, owned: []u8) Error!void {
    const count = try r.plain(u32);
    for (0..count) |_| {
        const loc = try cellAt(page, owned, try r.plain(u32));
        const id = try r.plain(hyperlink.Id);
        // The referenced entry must be a live rebuilt hyperlink id. Refcounts
        // are already carried by the hyperlink_set side table, so associate
        // the cell WITHOUT an extra use().
        if (id == 0 or id >= page.hyperlink_set.next_id)
            return error.InvalidCheckpoint;
        page.setHyperlink(loc.row, loc.cell, id) catch
            return error.InvalidCheckpoint;
    }
}

fn readPageList(r: *Reader, alloc: Allocator) Error!PageList {
    const page_serial = try r.plain(u64);
    const page_serial_epoch = try r.plain(u64);
    const explicit_max_size = try r.plain(usize);
    const min_max_size = try r.plain(usize);
    const cols = try r.plain(@TypeOf(@as(PageList, undefined).cols));
    const rows = try r.plain(@TypeOf(@as(PageList, undefined).rows));
    const total_rows = try r.plain(usize);
    const count = try r.plain(u32);
    if (cols == 0 or rows == 0 or count == 0) return error.InvalidCheckpoint;
    // The active viewport requires at least `rows` total rows, and every
    // page needs far more than one payload byte — bound the declared counts
    // before any allocation is sized from them.
    if (total_rows < rows) return error.InvalidCheckpoint;
    // Each serialized page carries at least one page_size_min-aligned memory
    // block (plus its serial, metadata, length prefix, and side tables), so
    // `count` pages require at least count * page_size_min remaining bytes.
    // Reject a count the remaining payload cannot possibly back BEFORE it
    // sizes any allocation: MemoryPool.init preheats count *
    // Page.layout(std_capacity) (~512 KiB each), so an unbounded count
    // within the 64 MiB byte cap would otherwise drive a multi-terabyte
    // preheat before a single page is validated.
    if (count > (r.bytes.len -| r.offset) / std.heap.page_size_min)
        return error.InvalidCheckpoint;

    // The preheat is a pure free-list optimization and both pools grow on
    // demand; page memory is allocated per-page below rather than drawn from
    // the preheated page buffers. Cap the up-front reservation so even a
    // structurally-valid large count cannot force a huge preheat — a valid
    // 64 MiB payload holds at most this many std-capacity pages.
    const max_preheat_pages = max_payload_bytes / Page.layout(pagepkg.std_capacity).total_size;
    var pool = try PageList.MemoryPool.init(
        alloc,
        std.heap.page_allocator,
        @min(count, max_preheat_pages),
    );
    errdefer pool.deinit();
    var list: PageList.List = .{};
    errdefer {
        var it = list.first;
        while (it) |node| : (it = node.next) {
            pool.pages.arena.child_allocator.free(node.page().memory);
        }
    }

    var page_size: usize = 0;
    var rows_total: usize = 0;
    for (0..count) |_| {
        const serial = try r.plain(u64);
        if (serial < page_serial_epoch) return error.InvalidCheckpoint;
        var metadata = try readStructExcept(r, Page, &.{ "memory", "hyperlink_set" });
        metadata.hyperlink_set = try readStructExcept(r, HyperlinkSet, &.{"context"});
        metadata.hyperlink_set.context = .{};
        const memory = try r.take(try r.plain(u32));
        if (memory.len == 0 or memory.len % std.heap.page_size_min != 0)
            return error.InvalidCheckpoint;
        if (metadata.size.rows == 0 or metadata.size.cols == 0 or
            metadata.size.rows > metadata.capacity.rows or
            metadata.size.cols > metadata.capacity.cols)
            return error.InvalidCheckpoint;
        const layout = Page.layout(metadata.capacity);
        if (layout.total_size != memory.len) return error.InvalidCheckpoint;

        // The scrubbed regions must arrive zeroed; anything else is a
        // non-canonical (corrupt or crafted) payload.
        inline for (.{
            .{ layout.styles_start, layout.styles_layout.total_size },
            .{ layout.hyperlink_set_start, layout.hyperlink_set_layout.total_size },
            .{ layout.grapheme_alloc_start, layout.grapheme_alloc_layout.total_size },
            .{ layout.grapheme_map_start, layout.grapheme_map_layout.total_size },
            .{ layout.hyperlink_map_start, layout.hyperlink_map_layout.total_size },
        }) |region| {
            if (!std.mem.allEqual(u8, memory[region[0]..][0..region[1]], 0))
                return error.InvalidCheckpoint;
        }

        // Every layout-derived metadata field must equal a freshly derived
        // twin before anything dereferences an offset: a crafted offset
        // otherwise walks outside the page mapping.
        const scratch = try alloc.alignedAlloc(
            u8,
            .fromByteUnits(std.heap.page_size_min),
            layout.total_size,
        );
        defer alloc.free(scratch);
        @memset(scratch, 0);
        const derived = Page.initBuf(.init(scratch), layout);
        if (!validateDerivedMetadata(&metadata, &derived))
            return error.InvalidCheckpoint;

        const owned = try pool.pages.arena.child_allocator.alignedAlloc(
            u8,
            .fromByteUnits(std.heap.page_size_min),
            memory.len,
        );
        errdefer pool.pages.arena.child_allocator.free(owned);
        @memcpy(owned, memory);
        metadata.memory = owned;

        // Rebuild the scrubbed sets from their side tables, then require the
        // rebuilt set state to equal the serialized metadata exactly — this
        // simultaneously validates the metadata counters and the tables.
        const expected_styles = metadata.styles;
        const expected_hyperlinks = metadata.hyperlink_set;
        const buf = sizepkg.OffsetBuf.init(owned);
        metadata.styles = .init(buf.add(layout.styles_start), layout.styles_layout, .{});
        try readSetTable(
            r,
            terminal.Style,
            &metadata.styles,
            owned,
            @as(StyleSet.Context, .{}),
            null,
        );
        if (!std.meta.eql(metadata.styles, expected_styles))
            return error.InvalidCheckpoint;
        metadata.hyperlink_set = .init(
            buf.add(layout.hyperlink_set_start),
            layout.hyperlink_set_layout,
            .{},
        );
        try readSetTable(
            r,
            hyperlink.PageEntry,
            &metadata.hyperlink_set,
            owned,
            @as(HyperlinkSet.Context, .{ .page = &metadata }),
            .{
                .start = layout.string_alloc_start,
                .end = layout.string_alloc_start +
                    layout.string_alloc_layout.total_size,
            },
        );
        metadata.hyperlink_set.context = .{};
        if (!std.meta.eql(metadata.hyperlink_set, expected_hyperlinks))
            return error.InvalidCheckpoint;

        // Re-initialize the scrubbed grapheme/hyperlink-map regions to empty
        // and rebuild their cell associations from the range-validated side
        // tables via public page APIs. No byte of these regions is ever
        // dereferenced from the wire, so corrupt input cannot reach an
        // interior-offset alignment assert.
        // Validate every row's cell-array offset before ANY cell deref (the
        // grapheme/hyperlink rebuild below indexes cells via cellAt): a
        // crafted row.cells offset would otherwise reach Offset.ptr's
        // alignment assert. rows.offset itself is already validated by
        // validateDerivedMetadata.
        {
            const cell_size = @sizeOf(pagepkg.Cell);
            const wire_rows = metadata.rows.ptr(owned)[0..metadata.size.rows];
            for (wire_rows, 0..) |*row, y| {
                const expected_cells = layout.cells_start +
                    y * @as(usize, metadata.capacity.cols) * cell_size;
                if (row.cells.offset != expected_cells)
                    return error.InvalidCheckpoint;
            }
        }

        metadata.grapheme_alloc = .init(
            buf.add(layout.grapheme_alloc_start),
            layout.grapheme_alloc_layout,
        );
        metadata.grapheme_map = .init(
            buf.add(layout.grapheme_map_start),
            layout.grapheme_map_layout,
        );
        metadata.hyperlink_map = .init(
            buf.add(layout.hyperlink_map_start),
            layout.hyperlink_map_layout,
        );
        metadata.pauseIntegrityChecks(true);
        try readGraphemeTable(r, &metadata, owned);
        try readHyperlinkMapTable(r, &metadata, owned);
        metadata.pauseIntegrityChecks(false);

        // Upstream's integrity walk asserts (crashes) on set-membership
        // violations instead of erroring, and raw row/cell bytes are
        // untrusted. Validate every raw-region reference first: row cell
        // offsets must match the canonical initBuf formula, cell style and
        // hyperlink ids must be live rebuilt ids, and grapheme slices must
        // stay inside their region.
        {
            const cell_size = @sizeOf(pagepkg.Cell);
            const gr_start = layout.grapheme_alloc_start;
            const gr_end = gr_start + layout.grapheme_alloc_layout.total_size;
            const wire_rows = metadata.rows.ptr(owned)[0..metadata.size.rows];
            for (wire_rows, 0..) |*row, y| {
                const expected_cells = layout.cells_start +
                    y * @as(usize, metadata.capacity.cols) * cell_size;
                if (row.cells.offset != expected_cells)
                    return error.InvalidCheckpoint;
                const cells = row.cells.ptr(owned)[0..metadata.size.cols];
                for (cells) |*cell| {
                    if (cell.style_id != 0 and
                        cell.style_id >= metadata.styles.next_id)
                        return error.InvalidCheckpoint;
                    if (cell.hyperlink) {
                        if (metadata.lookupHyperlink(cell)) |link_id| {
                            if (link_id == 0 or
                                link_id >= metadata.hyperlink_set.next_id)
                                return error.InvalidCheckpoint;
                        }
                    }
                    if (cell.hasGrapheme()) {
                        if (metadata.lookupGrapheme(cell)) |cps| {
                            const off = @intFromPtr(cps.ptr) -| @intFromPtr(owned.ptr);
                            const bytes = std.math.mul(
                                usize,
                                cps.len,
                                @sizeOf(u21),
                            ) catch return error.InvalidCheckpoint;
                            if (off < gr_start or
                                (std.math.add(usize, off, bytes) catch
                                    return error.InvalidCheckpoint) > gr_end)
                                return error.InvalidCheckpoint;
                        }
                    }
                }
            }
        }

        // Full cross-reference walk (styles, graphemes, hyperlinks,
        // spacers): corrupt interior state is an invalid checkpoint, never
        // illegal behavior.
        metadata.verifyIntegrity(alloc) catch return error.InvalidCheckpoint;

        const node = try pool.nodes.create();
        node.* = .{
            .data = .{ .resident = metadata },
            .serial = serial,
            .owned = .heap,
        };
        list.append(node);
        page_size += memory.len;
        rows_total += metadata.size.rows;
    }
    if (rows_total != total_rows) return error.InvalidCheckpoint;

    const viewport_pin = try pool.pins.create();
    viewport_pin.* = .{ .node = list.first.? };
    var tracked: @TypeOf(@as(PageList, undefined).tracked_pins) = .{};
    errdefer tracked.deinit(pool.alloc);
    try tracked.putNoClobber(pool.alloc, viewport_pin, {});

    return .{
        .pool = pool,
        .pages = list,
        .page_serial = page_serial,
        .page_serial_epoch = page_serial_epoch,
        .page_size = page_size,
        .explicit_max_size = explicit_max_size,
        .min_max_size = min_max_size,
        .total_rows = total_rows,
        .tracked_pins = tracked,
        .viewport = .{ .active = {} },
        .viewport_pin = viewport_pin,
        .viewport_pin_row_offset = null,
        .cols = cols,
        .rows = rows,
    };
}

// The cursor's own style/hyperlink set references are NOT on the wire:
// canonical pages renumber set ids, so restore rederives them from the
// serialized values exactly as a live terminal would (manualStyleUpdate /
// startHyperlink).
const CursorWire = struct {
    x: @TypeOf(@as(Screen.Cursor, undefined).x),
    y: @TypeOf(@as(Screen.Cursor, undefined).y),
    cursor_style: Screen.CursorStyle,
    pending_wrap: bool,
    protected: bool,
    style: terminal.Style,
    hyperlink_implicit_id: @TypeOf(@as(Screen.Cursor, undefined).hyperlink_implicit_id),
    semantic_content: pagepkg.Cell.SemanticContent,
    semantic_content_clear_eol: bool,
    pin: point.Coordinate,
};

fn writeScreen(w: *Writer, screen: *const Screen) Error!void {
    try w.plain(screen.no_scrollback);
    try w.plain(screen.saved_cursor);
    try w.plain(screen.charset);
    try w.plain(screen.protected_mode);
    try w.plain(screen.kitty_keyboard);
    try w.plain(screen.semantic_prompt);
    try writePageList(w, &screen.pages);

    const pin = screen.pages.pointFromPin(.screen, screen.cursor.page_pin.*) orelse
        return error.InvalidCheckpoint;
    try w.plain(CursorWire{
        .x = screen.cursor.x,
        .y = screen.cursor.y,
        .cursor_style = screen.cursor.cursor_style,
        .pending_wrap = screen.cursor.pending_wrap,
        .protected = screen.cursor.protected,
        .style = screen.cursor.style,
        .hyperlink_implicit_id = screen.cursor.hyperlink_implicit_id,
        .semantic_content = screen.cursor.semantic_content,
        .semantic_content_clear_eol = screen.cursor.semantic_content_clear_eol,
        .pin = pin.screen,
    });
    try writeHyperlink(w, screen.cursor.hyperlink);
    try writeImages(w, screen);

    if (screen.selection) |sel| {
        const sel_start = screen.pages.pointFromPin(.screen, sel.start()) orelse
            return error.InvalidCheckpoint;
        const sel_end = screen.pages.pointFromPin(.screen, sel.end()) orelse
            return error.InvalidCheckpoint;
        try w.plain(true);
        try w.plain(sel_start.screen);
        try w.plain(sel_end.screen);
        try w.plain(sel.rectangle);
    } else try w.plain(false);
}

fn readScreen(r: *Reader, alloc: Allocator) Error!*Screen {
    const no_scrollback = try r.plain(bool);
    const saved_cursor = try r.plain(?Screen.SavedCursor);
    const charset = try r.plain(Screen.CharsetState);
    const protected_mode = try r.plain(@TypeOf(@as(Screen, undefined).protected_mode));
    const kitty_keyboard = try r.plain(@TypeOf(@as(Screen, undefined).kitty_keyboard));
    const semantic_prompt = try r.plain(Screen.SemanticPrompt);
    var pages = try readPageList(r, alloc);
    var pages_owned = true;
    errdefer if (pages_owned) pages.deinit();
    const cursor = try r.plain(CursorWire);
    const cursor_pin = pages.pin(.{ .screen = cursor.pin }) orelse
        return error.InvalidCheckpoint;
    // Screen.assertIntegrity (reached via manualStyleUpdate/select below)
    // asserts the cursor is in bounds and its x/y match the active-relative
    // pin coordinate; validate those here so corrupt cursor state rejects
    // rather than reaching an assert.
    if (cursor.x >= pages.cols or cursor.y >= pages.rows)
        return error.InvalidCheckpoint;
    const cursor_active = pages.pointFromPin(.active, cursor_pin) orelse
        return error.InvalidCheckpoint;
    if (cursor_active.active.x != cursor.x or cursor_active.active.y != cursor.y)
        return error.InvalidCheckpoint;
    const tracked = try pages.trackPin(cursor_pin);
    // Once the struct move transfers PageList ownership to screen and
    // pages_owned clears, screen.deinit() owns this pin; the guard prevents
    // reverse-order errdefer from touching the freed pool.
    errdefer if (pages_owned) pages.untrackPin(tracked);
    const rac = tracked.rowAndCell();

    const screen = try alloc.create(Screen);
    errdefer alloc.destroy(screen);
    screen.* = .{
        .alloc = alloc,
        .pages = pages,
        .no_scrollback = no_scrollback,
        .cursor = .{
            .x = cursor.x,
            .y = cursor.y,
            .cursor_style = cursor.cursor_style,
            .pending_wrap = cursor.pending_wrap,
            .protected = cursor.protected,
            .style = cursor.style,
            .style_id = 0,
            .hyperlink_id = 0,
            .hyperlink_implicit_id = cursor.hyperlink_implicit_id,
            .semantic_content = cursor.semantic_content,
            .semantic_content_clear_eol = cursor.semantic_content_clear_eol,
            .page_pin = tracked,
            .page_row = rac.row,
            .page_cell = rac.cell,
        },
        .saved_cursor = saved_cursor,
        .charset = charset,
        .protected_mode = protected_mode,
        .kitty_keyboard = kitty_keyboard,
        .semantic_prompt = semantic_prompt,
    };
    pages_owned = false;
    errdefer screen.deinit();

    // Rederive the cursor's set references against the restored page,
    // exactly as a live terminal would: the canonical page only carries
    // cell-held references, so the cursor's own style/hyperlink refs are
    // re-added here (deduplicating against cell-held entries).
    screen.manualStyleUpdate() catch return error.OutOfMemory;
    if (try readHyperlink(r, alloc)) |link| {
        defer {
            link.deinit(alloc);
            alloc.destroy(link);
        }
        switch (link.id) {
            .implicit => |implicit_id| screen.cursor.hyperlink_implicit_id = implicit_id,
            .explicit => {},
        }
        screen.startHyperlink(link.uri, switch (link.id) {
            .explicit => |id| id,
            .implicit => null,
        }) catch return error.OutOfMemory;
    }
    screen.cursor.hyperlink_implicit_id = cursor.hyperlink_implicit_id;

    try readImages(r, alloc, screen);

    if (try r.plain(bool)) {
        const sel_start = try r.plain(point.Coordinate);
        const sel_end = try r.plain(point.Coordinate);
        const rectangle = try r.plain(bool);
        const start_pin = screen.pages.pin(.{ .screen = sel_start }) orelse
            return error.InvalidCheckpoint;
        const end_pin = screen.pages.pin(.{ .screen = sel_end }) orelse
            return error.InvalidCheckpoint;
        try screen.select(Selection.init(start_pin, end_pin, rectangle));
    }
    return screen;
}

fn writeHyperlink(w: *Writer, link: ?*const hyperlink.Hyperlink) Error!void {
    try w.plain(link != null);
    if (link) |value| {
        switch (value.id) {
            .implicit => |id| {
                try w.plain(@as(u8, 0));
                try w.plain(id);
            },
            .explicit => |id| {
                try w.plain(@as(u8, 1));
                try w.slice(id);
            },
        }
        try w.slice(value.uri);
    }
}

fn readHyperlink(r: *Reader, alloc: Allocator) Error!?*hyperlink.Hyperlink {
    if (!try r.plain(bool)) return null;
    const result = try alloc.create(hyperlink.Hyperlink);
    errdefer alloc.destroy(result);
    const id: hyperlink.Hyperlink.Id = switch (try r.plain(u8)) {
        0 => .{ .implicit = try r.plain(@TypeOf(@as(Screen.Cursor, undefined).hyperlink_implicit_id)) },
        1 => .{ .explicit = try r.slice(alloc) },
        else => return error.InvalidCheckpoint,
    };
    errdefer switch (id) {
        .implicit => {},
        .explicit => |bytes| alloc.free(bytes),
    };
    result.* = .{ .id = id, .uri = try r.slice(alloc) };
    return result;
}

fn writeImages(w: *Writer, screen: *const Screen) Error!void {
    if (comptime !build_options.kitty_graphics) return;
    const storage = &screen.kitty_images;
    try w.plain(storage.generation);
    try w.plain(storage.next_image_id);
    try w.plain(storage.next_internal_placement_id);
    try w.plain(storage.image_limits);
    try w.plain(storage.total_limit);

    try w.plain(@as(u32, @intCast(storage.images.count())));
    var image_it = storage.images.iterator();
    while (image_it.next()) |entry| {
        try w.plain(entry.key_ptr.*);
        try emitStructExcept(w, entry.value_ptr.*, &.{"data"});
        try w.slice(entry.value_ptr.data);
    }

    try w.plain(storage.loading != null);
    if (storage.loading) |loading| {
        try emitStructExcept(w, loading.image, &.{"data"});
        try w.slice(loading.image.data);
        try w.slice(loading.data.items);
        try w.plain(loading.display);
        try w.plain(loading.quiet);
    }

    try w.plain(@as(u32, @intCast(storage.placements.count())));
    var placement_it = storage.placements.iterator();
    while (placement_it.next()) |entry| {
        try w.plain(entry.key_ptr.*);
        const placement = entry.value_ptr.*;
        switch (placement.location) {
            .virtual => {
                try w.plain(@as(u8, 0));
            },
            .pin => |pin| {
                try w.plain(@as(u8, 1));
                const pt = screen.pages.pointFromPin(.screen, pin.*) orelse
                    return error.InvalidCheckpoint;
                try w.plain(pt.screen);
            },
        }
        try emitStructExcept(w, placement, &.{"location"});
    }
}

fn readImages(r: *Reader, alloc: Allocator, screen: *Screen) Error!void {
    if (comptime !build_options.kitty_graphics) return;
    var storage = &screen.kitty_images;
    storage.generation = try r.plain(u64);
    storage.next_image_id = try r.plain(u32);
    storage.next_internal_placement_id = try r.plain(u32);
    storage.image_limits = try r.plain(@TypeOf(storage.image_limits));
    storage.total_limit = try r.plain(usize);

    const image_count = try r.plain(u32);
    for (0..image_count) |_| {
        const key = try r.plain(u32);
        var image = try readStructExcept(r, terminal.kitty.graphics.Image, &.{"data"});
        image.data = try r.slice(alloc);
        errdefer image.deinit(alloc);
        try storage.images.put(alloc, key, image);
        storage.total_bytes += image.data.len;
    }

    if (try r.plain(bool)) {
        const loading = try alloc.create(terminal.kitty.graphics.LoadingImage);
        errdefer alloc.destroy(loading);
        var image = try readStructExcept(r, terminal.kitty.graphics.Image, &.{"data"});
        image.data = try r.slice(alloc);
        errdefer image.deinit(alloc);
        const data = try r.slice(alloc);
        errdefer alloc.free(data);
        loading.* = .{
            .image = image,
            .data = .{ .items = data, .capacity = data.len },
            .display = try r.plain(@TypeOf(loading.display)),
            .quiet = try r.plain(@TypeOf(loading.quiet)),
        };
        storage.loading = loading;
    }

    const placement_count = try r.plain(u32);
    for (0..placement_count) |_| {
        const key = try r.plain(terminal.kitty.graphics.ImageStorage.PlacementKey);
        const location_tag = try r.plain(u8);
        var placement = try readStructExcept(
            r,
            terminal.kitty.graphics.ImageStorage.Placement,
            &.{"location"},
        );
        placement.location = switch (location_tag) {
            0 => .virtual,
            1 => pin: {
                const coord = try r.plain(point.Coordinate);
                const pin_value = screen.pages.pin(.{ .screen = coord }) orelse
                    return error.InvalidCheckpoint;
                break :pin .{ .pin = try screen.pages.trackPin(pin_value) };
            },
            else => return error.InvalidCheckpoint,
        };
        errdefer placement.deinit(screen);
        try storage.placements.put(alloc, key, placement);
    }
    storage.dirty = true;
}

fn writeGlyphs(w: *Writer, t: *const Terminal) Error!void {
    const glossary = &t.glyph_glossary;
    try w.plain(@as(u32, @intCast(glossary.entries.count())));
    for (glossary.entries.keys(), glossary.entries.values()) |cp, entry| {
        try w.plain(cp);
        try w.plain(entry.design);
        try w.plain(entry.width);
        try w.plain(entry.constraint);
        switch (entry.glyph) {
            .glyf => |outline| {
                try w.plain(@as(u32, @intCast(outline.contours.len)));
                try w.write(std.mem.sliceAsBytes(outline.contours));
                try w.plain(@as(u32, @intCast(outline.points.len)));
                try w.write(std.mem.sliceAsBytes(outline.points));
            },
        }
    }
}

fn readGlyphs(r: *Reader, alloc: Allocator, t: *Terminal) Error!void {
    const count = try r.plain(u32);
    for (0..count) |_| {
        const cp = try r.plain(u21);
        const design = try r.plain(@TypeOf(@as(GlyphEntry, undefined).design));
        const width = try r.plain(@TypeOf(@as(GlyphEntry, undefined).width));
        const constraint = try r.plain(@TypeOf(@as(GlyphEntry, undefined).constraint));
        const contour_count = try r.plain(u32);
        const contour_bytes = try r.take(
            std.math.mul(usize, contour_count, @sizeOf(u16)) catch
                return error.InvalidCheckpoint,
        );
        const contours = try alloc.alloc(u16, contour_count);
        errdefer alloc.free(contours);
        @memcpy(std.mem.sliceAsBytes(contours), contour_bytes);
        const point_count = try r.plain(u32);
        const point_bytes = try r.take(
            std.math.mul(usize, point_count, @sizeOf(GlyphOutline.Point)) catch
                return error.InvalidCheckpoint,
        );
        const points = try alloc.alloc(GlyphOutline.Point, point_count);
        errdefer alloc.free(points);
        @memcpy(std.mem.sliceAsBytes(points), point_bytes);
        // Ownership: register takes ownership of contours/points ONLY on
        // success. Its OutOfNamespace return precedes any storage, and its
        // only fallible allocation (entries.getOrPut) precedes inserting
        // the entry; once the entry is stored the function cannot fail
        // (Glossary.zig register). The errdefers above therefore free
        // exactly the failures and never double-free a stored entry.
        t.glyph_glossary.register(alloc, cp, .{
            .glyph = .{ .glyf = .{ .contours = contours, .points = points } },
            .design = design,
            .width = width,
            .constraint = constraint,
        }) catch |err| switch (err) {
            error.OutOfNamespace => return error.InvalidCheckpoint,
            else => |e| return e,
        };
    }
}

test "checkpoint layout fingerprint covers enum backing tags and field offsets" {
    const Narrow = enum(u8) { a = 0, b = 1 };
    const Wide = enum(c_int) { a = 0, b = 1 };
    const Renumbered = enum(u8) { a = 0, b = 2 };
    const Ordered = extern struct { a: u8, b: u32 };
    const Reordered = extern struct { b: u32, a: u8 };
    const LayoutDigest = struct {
        fn of(comptime T: type) [32]u8 {
            var hash = Sha256.init(.{});
            hashTypeLayout(&hash, T);
            var result: [32]u8 = undefined;
            hash.final(&result);
            return result;
        }
    };

    try std.testing.expect(!std.mem.eql(u8, &LayoutDigest.of(Narrow), &LayoutDigest.of(Wide)));
    try std.testing.expect(!std.mem.eql(u8, &LayoutDigest.of(Narrow), &LayoutDigest.of(Renumbered)));
    try std.testing.expect(!std.mem.eql(u8, &LayoutDigest.of(Ordered), &LayoutDigest.of(Reordered)));
}

test "stored style union slack cannot reach the wire (B1.0 defect class)" {
    // The inherited defect: SGR 31 stores a Style whose Color union carries
    // undefined payload slack, and raw page-memory export shipped those
    // bytes (fixtures case-00-split-005..012, offset 386207, value unstable
    // across builds). The structural codec must emit exactly the tag and
    // active payload — nothing else — for a style value read back from live
    // page memory, where the slack is real runtime garbage.
    const alloc = std.testing.allocator;
    var t: Terminal = try .init(alloc, .{ .cols = 20, .rows = 5 });
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice("\x1b[31mred");

    const screen = t.screens.active;
    const page = screen.cursor.page_pin.node.page();
    const style_id = screen.cursor.style_id;
    try std.testing.expect(style_id != 0);
    const stored = page.styles.get(page.memory, style_id).*;

    var w: Writer = .{ .alloc = alloc };
    defer w.deinit();
    try w.plain(stored);
    // Style = fg(tag=palette:1, payload 1) · bg(tag=none:0) ·
    // underline(tag=none:0) · flags(u16=0)
    try std.testing.expectEqualSlices(
        u8,
        &.{ 1, 1, 0, 0, 0, 0 },
        w.bytes.items,
    );
}

test "checkpoint canonical export renumbers style id holes and round trips" {
    const alloc = std.testing.allocator;
    var t: Terminal = try .init(alloc, .{ .cols = 20, .rows = 5, .max_scrollback = 1 << 20 });
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    var pending: std.ArrayList(u8) = .empty;
    defer pending.deinit(alloc);
    var valid = true;
    // Style A gets a cell, the cell is overwritten plain (A dies, id hole),
    // then style B is applied and left active on the cursor.
    feed(&stream, &pending, alloc, &valid, "\x1b[31mA\x1b[0m\rZ\x1b[32mB\x1b[38;2;1;2;3m");
    try std.testing.expect(valid);

    const payload = try encode(alloc, &t, &stream, pending.items);
    defer alloc.free(payload);
    var snapshot = try decode(alloc, payload);
    defer snapshot.deinit(alloc);
    var restored: Stream = undefined;
    restoreStream(&restored, &snapshot.terminal, snapshot.handler, snapshot.pending, .readonly);
    defer restored.deinit();

    // The restored cursor style must be the live truecolor style even
    // though ids renumbered, and a re-encode must be byte-identical.
    try std.testing.expectEqual(
        terminal.Style.Color{ .rgb = .{ .r = 1, .g = 2, .b = 3 } },
        snapshot.terminal.screens.active.cursor.style.fg_color,
    );
    const round_trip = try encode(alloc, &snapshot.terminal, &restored, snapshot.pending);
    defer alloc.free(round_trip);
    try std.testing.expectEqualSlices(u8, payload, round_trip);
}

test "checkpoint captures and restores selection" {
    const alloc = std.testing.allocator;
    var t: Terminal = try .init(alloc, .{ .cols = 20, .rows = 5, .max_scrollback = 1 << 20 });
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice("select me\r\nsecond line");

    const screen = t.screens.active;
    const start_pin = screen.pages.pin(.{ .screen = .{ .x = 1, .y = 0 } }).?;
    const end_pin = screen.pages.pin(.{ .screen = .{ .x = 3, .y = 1 } }).?;
    try screen.select(Selection.init(start_pin, end_pin, false));

    const payload = try encode(alloc, &t, &stream, "");
    defer alloc.free(payload);
    var snapshot = try decode(alloc, payload);
    defer snapshot.deinit(alloc);

    const restored_screen = snapshot.terminal.screens.active;
    const sel = restored_screen.selection orelse return error.TestUnexpectedResult;
    const sel_start = restored_screen.pages.pointFromPin(.screen, sel.start()).?;
    const sel_end = restored_screen.pages.pointFromPin(.screen, sel.end()).?;
    try std.testing.expectEqual(point.Coordinate{ .x = 1, .y = 0 }, sel_start.screen);
    try std.testing.expectEqual(point.Coordinate{ .x = 3, .y = 1 }, sel_end.screen);
    try std.testing.expect(!sel.rectangle);

    // A selection-free checkpoint restores selection-free.
    screen.clearSelection();
    const bare = try encode(alloc, &t, &stream, "");
    defer alloc.free(bare);
    var bare_snapshot = try decode(alloc, bare);
    defer bare_snapshot.deinit(alloc);
    try std.testing.expect(bare_snapshot.terminal.screens.active.selection == null);
}

test "checkpoint decode rejects out-of-range enum, bool, and union tags" {
    const alloc = std.testing.allocator;
    var w: Writer = .{ .alloc = alloc };
    defer w.deinit();
    try w.plain(terminal.Style.Color{ .palette = 7 });
    w.bytes.items[0] = 9; // no such Color tag
    var r: Reader = .{ .bytes = w.bytes.items };
    try std.testing.expectError(
        error.InvalidCheckpoint,
        r.plain(terminal.Style.Color),
    );

    var rb: Reader = .{ .bytes = &.{2} };
    try std.testing.expectError(error.InvalidCheckpoint, rb.plain(bool));

    var re: Reader = .{ .bytes = &.{255} };
    try std.testing.expectError(error.InvalidCheckpoint, re.plain(Screen.CursorStyle));
}

test "checkpoint import survives deterministic byte flip fuzz" {
    const alloc = std.testing.allocator;
    var t: Terminal = try .init(alloc, .{ .cols = 20, .rows = 5, .max_scrollback = 1 << 20 });
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice(
        "fuzz target\x1b[31mstyled\x1b[0m e\xcc\x81" ++
            "\x1b]8;id=f;https://example.test/\x1b\\link\x1b]8;;\x1b\\" ++
            "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\",
    );
    const payload = try encode(alloc, &t, &stream, "");
    defer alloc.free(payload);

    // Flip a fixed stride of positions plus the entire structured head.
    // Oracle: never crash, never leak, either clean success or the single
    // invalid-checkpoint error.
    var mutated = try alloc.dupe(u8, payload);
    defer alloc.free(mutated);
    var index: usize = 0;
    while (index < payload.len) : (index += if (index < 2048) 7 else 251) {
        for ([_]u8{ 0x01, 0xFF }) |mask| {
            mutated[index] = payload[index] ^ mask;
            defer mutated[index] = payload[index];
            var debug: std.heap.DebugAllocator(.{}) = .init;
            const fuzz_alloc = debug.allocator();
            if (decode(fuzz_alloc, mutated)) |value| {
                var snapshot = value;
                snapshot.deinit(fuzz_alloc);
            } else |err| switch (err) {
                error.InvalidCheckpoint,
                error.CheckpointTooLarge,
                error.OutOfMemory,
                => {},
            }
            if (debug.deinit() != .ok) {
                std.debug.print("fuzz leak at byte {d}\n", .{index});
                return error.TestUnexpectedResult;
            }
        }
    }

    // Count/offset-bomb sweep under a BOUNDED arena: single bit flips rarely
    // produce a large count or offset that still passes the size checks, so
    // inject an explicit large u32 at strided aligned offsets. This exercises
    // the page-count preheat bound AND the scrubbed grapheme/hyperlink-map
    // regions (a large u32 in a grapheme_map offset formerly reached
    // Offset.ptr's alignment assert). Every decode allocation is payload- or
    // capacity-bounded, so a 128 MiB arena sits far above any legitimate
    // small-payload decode; the arena both keeps the fuzz well under the
    // memory watchdog and turns any unbounded allocation into a deterministic
    // OutOfMemory (a bounded reject) rather than a runaway. Oracle: no crash,
    // accepted error or clean success.
    const arena_buf = try alloc.alloc(u8, 128 * 1024 * 1024);
    defer alloc.free(arena_buf);
    var offset: usize = 0;
    while (offset + 4 <= payload.len) : (offset += 16) {
        for ([_]u32{ 0x0000_4000, 0x00FF_FFFF, 0xFFFF_FFFF }) |value| {
            std.mem.writeInt(u32, mutated[offset..][0..4], value, .little);
            defer @memcpy(mutated[offset..][0..4], payload[offset..][0..4]);
            var fba = std.heap.FixedBufferAllocator.init(arena_buf);
            const fuzz_alloc = fba.allocator();
            if (decode(fuzz_alloc, mutated)) |dec| {
                var snapshot = dec;
                snapshot.deinit(fuzz_alloc);
            } else |err| switch (err) {
                error.InvalidCheckpoint,
                error.CheckpointTooLarge,
                error.OutOfMemory,
                => {},
            }
        }
    }
}

test "checkpoint decode rejects corruption in scrubbed grapheme regions" {
    // Deterministic corruption-(A) regression: over a payload whose page
    // carries a combining grapheme + a hyperlink (populating grapheme_map/
    // grapheme_alloc/hyperlink_map), every single-byte flip must either
    // round-trip or reject with InvalidCheckpoint — never a deref assert,
    // never a leak — and a meaningful fraction must reject.
    const alloc = std.testing.allocator;
    var t: Terminal = try .init(alloc, .{ .cols = 20, .rows = 5, .max_scrollback = 1 << 20 });
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice("e\xcc\x81\x1b]8;id=r;https://example.test/\x1b\\link\x1b]8;;\x1b\\");
    const payload = try encode(alloc, &t, &stream, "");
    defer alloc.free(payload);
    {
        var ok = try decode(alloc, payload);
        ok.deinit(alloc);
    }

    var mutated = try alloc.dupe(u8, payload);
    defer alloc.free(mutated);
    var rejections: usize = 0;
    for (0..payload.len) |i| {
        mutated[i] = payload[i] ^ 0xFF;
        defer mutated[i] = payload[i];
        var debug: std.heap.DebugAllocator(.{}) = .init;
        const a = debug.allocator();
        if (decode(a, mutated)) |dec| {
            var snap = dec;
            snap.deinit(a);
        } else |err| switch (err) {
            error.InvalidCheckpoint => rejections += 1,
            error.CheckpointTooLarge, error.OutOfMemory => {},
        }
        try std.testing.expectEqual(std.heap.Check.ok, debug.deinit());
    }
    try std.testing.expect(rejections > 0);
}

test "arch proof fingerprint dump for cross-slice qualification" {
    // Backlog A: with the page-size input held equal and the concrete page
    // layout excluded, the two architecture fingerprints must still differ.
    // Each native slice dumps its value here; the qualification script
    // compares them.
    const fp = archProofFingerprint();
    const path = std.process.getEnvVarOwned(
        std.testing.allocator,
        "HIVE_CHECKPOINT_ARCH_PROOF_PATH",
    ) catch return;
    defer std.testing.allocator.free(path);
    const file = try std.fs.createFileAbsolute(path, .{});
    defer file.close();
    const hex = std.fmt.bytesToHex(fp, .lower);
    try file.writeAll(&hex);
}

// Force stack reuse between restore and continuation, standing in for the
// async tick that made the production use-after-move deterministic.
fn clobberStack() void {
    var noise: [4096]u8 = undefined;
    for (&noise, 0..) |*byte, i| byte.* = @truncate(i *% 31);
    std.mem.doNotOptimizeAway(&noise);
}

test "readPageList rejects a page-count bomb before any preheat" {
    // Regression: readPageList validated count only against remaining
    // payload SIZE (count <= remaining bytes), then MemoryPool.init
    // preheated count * Page.layout(std_capacity) (~512 KiB each) BEFORE any
    // page was validated. A crafted count within the 64 MiB byte cap drove a
    // multi-terabyte preheat. The fix rejects an impossible count up front.
    //
    // A failing allocator that errors on its FIRST allocation proves the
    // reject happens with ZERO allocations: the error must be
    // InvalidCheckpoint, never OutOfMemory. Without the fix, execution
    // reaches MemoryPool.init and the first allocation fails -> OutOfMemory,
    // so this test is RED on the pre-fix code.
    const alloc = std.testing.allocator;
    var w: Writer = .{ .alloc = alloc };
    defer w.deinit();
    // A PageList header (writePageList order) with a large count and just
    // enough trailing bytes that count <= remaining bytes (defeating the old
    // size-only check) but count * page_size_min far exceeds remaining.
    const bomb_count: u32 = 300_000;
    try w.plain(@as(u64, 1)); // page_serial
    try w.plain(@as(u64, 0)); // page_serial_epoch
    try w.plain(@as(usize, 0)); // explicit_max_size
    try w.plain(@as(usize, 0)); // min_max_size
    try w.plain(@as(@TypeOf(@as(PageList, undefined).cols), 80));
    try w.plain(@as(@TypeOf(@as(PageList, undefined).rows), 24));
    try w.plain(@as(usize, 24)); // total_rows
    try w.plain(bomb_count);
    try w.bytes.appendNTimes(alloc, 0, bomb_count); // count <= remaining bytes

    var failing = std.testing.FailingAllocator.init(alloc, .{ .fail_index = 0 });
    var r: Reader = .{ .bytes = w.bytes.items };
    try std.testing.expectError(
        error.InvalidCheckpoint,
        readPageList(&r, failing.allocator()),
    );
    try std.testing.expectEqual(@as(usize, 0), failing.allocations);
}

test "restored partial-OSC capture is self-consistent in final storage" {
    // Regression: restoreStream used to replay the pending tail into a
    // local Stream and return it BY VALUE. A partial OSC engages the
    // parser's capture, whose writer points into the stream's own storage;
    // the move left it dangling and the OSC continuation wrote through the
    // stale pointer (EXC_BAD_ACCESS under the async tick). Restore now
    // initializes and replays in place; this test pins the invariant
    // directly via pointer identity, then completes the OSC end-to-end.
    const alloc = std.testing.allocator;
    var t: Terminal = try .init(alloc, .{ .cols = 20, .rows = 5, .max_scrollback = 1 << 20 });
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    var pending: std.ArrayList(u8) = .empty;
    defer pending.deinit(alloc);
    var valid = true;
    feed(&stream, &pending, alloc, &valid, "before\x1b]2;par");
    try std.testing.expect(valid);
    try std.testing.expect(pending.items.len > 0);

    const payload = try encode(alloc, &t, &stream, pending.items);
    defer alloc.free(payload);
    var snapshot = try decode(alloc, payload);
    defer snapshot.deinit(alloc);

    // Final storage on the heap: any stale pointer into a helper frame or
    // a moved-from local cannot alias it.
    const restored = try alloc.create(Stream);
    defer alloc.destroy(restored);
    restoreStream(restored, &snapshot.terminal, snapshot.handler, snapshot.pending, .readonly);
    defer restored.deinit();

    // The engaged capture's writer must point into THIS stream's own
    // storage. With the old by-value restore this pointer identity fails
    // deterministically (it references the moved-from frame).
    {
        const capture = &restored.parser.osc_parser.capture;
        try std.testing.expect(capture.* != null);
        const engaged = &capture.*.?;
        switch (engaged.backing) {
            .fixed => |*fixed_writer| try std.testing.expect(engaged.writer == fixed_writer),
            .allocating => |*allocating| try std.testing.expect(engaged.writer == &allocating.writer),
        }
    }

    clobberStack();

    // The continuation must complete the title through the capture with no
    // crash and no corruption.
    var restored_pending: std.ArrayList(u8) = .{
        .items = snapshot.pending,
        .capacity = snapshot.pending.len,
    };
    snapshot.pending = &.{};
    defer restored_pending.deinit(alloc);
    var restored_valid = true;
    feed(restored, &restored_pending, alloc, &restored_valid, "tial title\x07");
    try std.testing.expect(restored_valid);
    try std.testing.expectEqualStrings(
        "partial title",
        snapshot.terminal.getTitle() orelse "",
    );
}

test "checkpoint partial utf8 and alternate screen round trip" {
    const alloc = std.testing.allocator;
    var t: Terminal = try .init(alloc, .{ .cols = 20, .rows = 5, .max_scrollback = 1 << 20 });
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    var pending: std.ArrayList(u8) = .empty;
    defer pending.deinit(alloc);

    var valid = true;
    feed(&stream, &pending, alloc, &valid, "primary\r\n\x1b[?1049halternate \xf0\x9f");
    const payload = try encode(alloc, &t, &stream, pending.items);
    defer alloc.free(payload);
    var snapshot = try decode(alloc, payload);
    defer snapshot.deinit(alloc);
    var restored: Stream = undefined;
    restoreStream(&restored, &snapshot.terminal, snapshot.handler, snapshot.pending, .readonly);
    defer restored.deinit();
    restored.nextSlice("\x98\x84");
    stream.nextSlice("\x98\x84");

    try std.testing.expectEqual(t.screens.active_key, snapshot.terminal.screens.active_key);
    try std.testing.expectEqual(t.screens.active.cursor.x, snapshot.terminal.screens.active.cursor.x);
    try std.testing.expectEqual(t.screens.active.cursor.y, snapshot.terminal.screens.active.cursor.y);
}

test "shared import and restore decoder rejects every truncated prefix" {
    const alloc = std.testing.allocator;
    var t: Terminal = try .init(alloc, .{ .cols = 20, .rows = 5, .max_scrollback = 1 << 20 });
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice(
        "deep state\x1b]8;id=truncated;https://example.test/\x1b\\link" ++
            "\x1b]8;;\x1b\\\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\",
    );
    const payload = try encode(alloc, &t, &stream, "");
    defer alloc.free(payload);

    // This sweep catches the other decode-path leaks; it does not observe
    // B1's allocator-invisible use-after-write class (the guard proves B1).
    for (0..payload.len) |length| {
        var debug: std.heap.DebugAllocator(.{}) = .init;
        const prefix_alloc = debug.allocator();
        if (decode(prefix_alloc, payload[0..length])) |value| {
            var snapshot = value;
            snapshot.deinit(prefix_alloc);
            return error.TestUnexpectedResult;
        } else |err| try std.testing.expectEqual(error.InvalidCheckpoint, err);
        if (debug.deinit() != .ok) {
            std.debug.print("checkpoint leak at prefix {d}/{d}\n", .{ length, payload.len });
            return error.TestUnexpectedResult;
        }
    }
}

test "checkpoint payload is deterministic and canonically round trips" {
    const alloc = std.testing.allocator;
    var t: Terminal = try .init(alloc, .{ .cols = 20, .rows = 5, .max_scrollback = 1 << 20 });
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice("deterministic\r\n\x1b]2;stable\x07\x1b[31mred\x1b[0m");

    const first = try encode(alloc, &t, &stream, "");
    defer alloc.free(first);
    // Equal encodes in one process do not prove cross-run stability because
    // both may reuse the same heap addresses; the decode/restore round trip
    // below is the actual raw-pointer leak guard.
    const second = try encode(alloc, &t, &stream, "");
    defer alloc.free(second);
    try std.testing.expectEqualSlices(u8, first, second);

    var snapshot = try decode(alloc, first);
    defer snapshot.deinit(alloc);
    var restored: Stream = undefined;
    restoreStream(&restored, &snapshot.terminal, snapshot.handler, snapshot.pending, .readonly);
    defer restored.deinit();
    const round_trip = try encode(
        alloc,
        &snapshot.terminal,
        &restored,
        snapshot.pending,
    );
    defer alloc.free(round_trip);
    try std.testing.expectEqualSlices(u8, first, round_trip);
}

threadlocal var test_effect_log: ?*std.ArrayList(u8) = null;

fn testLog(bytes: []const u8) void {
    const log = test_effect_log orelse return;
    log.appendSlice(std.testing.allocator, bytes) catch @panic("test effect log allocation failed");
}

fn testWritePty(_: *Handler, bytes: [:0]const u8) void {
    testLog("write:");
    testLog(bytes);
    testLog("\n");
}

fn testBell(_: *Handler) void {
    testLog("bell\n");
}

fn testTitle(handler: *Handler) void {
    testLog("title:");
    testLog(handler.terminal.getTitle() orelse "");
    testLog("\n");
}

fn testPwd(handler: *Handler) void {
    testLog("pwd:");
    testLog(handler.terminal.getPwd() orelse "");
    testLog("\n");
}

const test_effects: Handler.Effects = .{
    .bell = &testBell,
    .clipboard_write = null,
    .color_scheme = null,
    .device_attributes = null,
    .enquiry = null,
    .size = null,
    .title_changed = &testTitle,
    .pwd_changed = &testPwd,
    .write_pty = &testWritePty,
    .xtversion = null,
};

fn expectSameCheckpoint(
    alloc: Allocator,
    a: *const Terminal,
    a_stream: *const Stream,
    a_pending: []const u8,
    b: *const Terminal,
    b_stream: *const Stream,
    b_pending: []const u8,
) !void {
    const a_digest = try semanticState(alloc, a, a_stream, a_pending);
    defer alloc.free(a_digest);
    const b_digest = try semanticState(alloc, b, b_stream, b_pending);
    defer alloc.free(b_digest);
    try std.testing.expectEqualSlices(u8, a_digest, b_digest);
}

fn semanticScreen(w: *Writer, screen: *const Screen) !void {
    try emitValue(w, screen.no_scrollback);
    try emitValue(w, screen.saved_cursor != null);
    if (screen.saved_cursor) |saved| try emitValue(w, saved);
    try emitValue(w, screen.charset);
    try emitValue(w, screen.protected_mode);
    try emitValue(w, screen.kitty_keyboard);
    try emitValue(w, screen.semantic_prompt);
    try emitValue(w, screen.pages.page_serial);
    try emitValue(w, screen.pages.page_serial_epoch);
    try emitValue(w, screen.pages.explicit_max_size);
    try emitValue(w, screen.pages.min_max_size);
    try emitValue(w, screen.pages.total_rows);
    try emitValue(w, screen.cursor.pending_wrap);
    try emitValue(w, screen.cursor.semantic_content);
    try emitValue(w, screen.cursor.semantic_content_clear_eol);
    try writeHyperlink(w, screen.cursor.hyperlink);
    try writeImages(w, screen);

    var formatted: std.Io.Writer.Allocating = .init(w.alloc);
    defer formatted.deinit();
    var formatter: terminal.formatter.ScreenFormatter = .init(screen, .vt);
    formatter.extra = .all;
    try formatter.format(&formatted.writer);
    try w.slice(formatted.writer.buffered());
}

fn semanticState(
    alloc: Allocator,
    t: *const Terminal,
    stream: *const Stream,
    pending: []const u8,
) ![]u8 {
    var w: Writer = .{ .alloc = alloc };
    errdefer w.deinit();
    try emitValue(&w, t.status_display);
    try emitValue(&w, t.rows);
    try emitValue(&w, t.cols);
    try emitValue(&w, t.width_px);
    try emitValue(&w, t.height_px);
    try emitValue(&w, t.scrolling_region);
    try w.slice(t.getPwd() orelse "");
    try w.slice(t.getTitle() orelse "");
    try emitValue(&w, t.colors);
    try emitValue(&w, t.previous_char != null);
    if (t.previous_char) |cp| try emitValue(&w, cp);
    try emitValue(&w, t.modes);
    try emitValue(&w, t.mouse_shape);
    try emitValue(&w, t.flags.shell_redraws_prompt);
    try emitValue(&w, t.flags.modify_other_keys_2);
    try emitValue(&w, t.flags.mouse_event);
    try emitValue(&w, t.flags.mouse_format);
    try emitValue(&w, t.flags.mouse_shift_capture);
    try emitValue(&w, t.flags.password_input);
    for (0..t.cols) |col| try emitValue(&w, t.tabstops.get(col));
    try writeGlyphs(&w, t);
    try emitValue(&w, t.screens.active_key);
    try emitValue(&w, t.screens.generations.get(.primary).?);
    try emitValue(&w, t.screens.generations.get(.alternate).?);
    try semanticScreen(&w, t.screens.get(.primary).?);
    const alternate = t.screens.get(.alternate);
    try emitValue(&w, alternate != null);
    if (alternate) |screen| try semanticScreen(&w, screen);
    try emitValue(&w, stream.handler.apc_handler.max_bytes);
    try emitValue(&w, stream.handler.apc_handler.enabled);
    try emitValue(&w, stream.handler.default_cursor);
    try emitValue(&w, stream.handler.default_cursor_style);
    try emitValue(&w, stream.handler.default_cursor_blink);
    try w.slice(pending);
    return try w.finish();
}

test "checkpoint restores complete non-viewer terminal state" {
    const alloc = std.testing.allocator;
    var source: Terminal = try .init(alloc, .{
        .cols = 20,
        .rows = 5,
        .max_scrollback = 1 << 20,
    });
    defer source.deinit(alloc);
    var source_stream = source.vtStream();
    defer source_stream.deinit();
    var source_pending: std.ArrayList(u8) = .empty;
    defer source_pending.deinit(alloc);
    var source_valid = true;
    for (0..12) |_| feed(
        &source_stream,
        &source_pending,
        alloc,
        &source_valid,
        "scrollback line\r\n",
    );
    feed(
        &source_stream,
        &source_pending,
        alloc,
        &source_valid,
        "\x1b]2;complete title\x07" ++
            "\x1b]7;file://host/complete/pwd\x07" ++
            "\x1b]4;42;rgb:12/34/56\x1b\\" ++
            "\x1b[3g\x1b[5G\x1bH\x1b[2;4r" ++
            "\x1b[?1h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?2026h" ++
            "\x1b(0q\x1b(B" ++
            "\x1b[1\"qprotected\x1b[0\"q" ++
            "\x1b]8;id=complete;https://example.test/\x1b\\link\x1b]8;;\x1b\\" ++
            "\x1b7\x1b[1;1H\x1b[1mbold e\xcc\x81\x1b[0m" ++
            "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\" ++
            "\x1b[?1049halt screen\x1b7\x1b[3;3H",
    );
    try std.testing.expect(source_valid);

    const payload = try encode(alloc, &source, &source_stream, source_pending.items);
    defer alloc.free(payload);
    var snapshot = try decode(alloc, payload);
    defer snapshot.deinit(alloc);
    var restored_stream: Stream = undefined;
    restoreStream(&restored_stream, &snapshot.terminal, snapshot.handler, snapshot.pending, .readonly);
    defer restored_stream.deinit();
    try expectSameCheckpoint(
        alloc,
        &source,
        &source_stream,
        source_pending.items,
        &snapshot.terminal,
        &restored_stream,
        snapshot.pending,
    );

    var restored_pending: std.ArrayList(u8) = .{
        .items = snapshot.pending,
        .capacity = snapshot.pending.len,
    };
    snapshot.pending = &.{};
    defer restored_pending.deinit(alloc);
    var restored_valid = true;
    feed(
        &source_stream,
        &source_pending,
        alloc,
        &source_valid,
        "\x1b[?2026l\x1b[?1049lafter",
    );
    feed(
        &restored_stream,
        &restored_pending,
        alloc,
        &restored_valid,
        "\x1b[?2026l\x1b[?1049lafter",
    );
    try std.testing.expect(source_valid);
    try std.testing.expect(restored_valid);
    try expectSameCheckpoint(
        alloc,
        &source,
        &source_stream,
        source_pending.items,
        &snapshot.terminal,
        &restored_stream,
        restored_pending.items,
    );
}

test "checkpoint corpus every byte split preserves state and subsequent effects" {
    const alloc = std.testing.allocator;
    const corpus = [_][]const u8{
        "\x1b[31mred\x1b[0m",
        "\x1b]2;checkpoint title\x07",
        "\x1bP$qm\x1b\\",
        "A\xf0\x9f\x98\x84Z",
        "e\xcc\x81x",
        "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\",
        "\x1b[?2026hsynchronized\x1b[?2026l",
        "primary\x1b[?1049halternate\x1b[?1049lprimary-again",
        "12345678901234567890",
    };
    const subsequent = "\x07\x1b]2;after\x07\x1b]7;file://host/tmp\x07\x1b[6n!";

    for (corpus) |bytes| {
        for (0..bytes.len + 1) |split| {
            var uninterrupted: Terminal = try .init(alloc, .{
                .cols = 20,
                .rows = 5,
                .max_scrollback = 1 << 20,
            });
            defer uninterrupted.deinit(alloc);
            var uninterrupted_stream = uninterrupted.vtStream();
            defer uninterrupted_stream.deinit();
            uninterrupted_stream.handler.effects = test_effects;
            var uninterrupted_pending: std.ArrayList(u8) = .empty;
            defer uninterrupted_pending.deinit(alloc);
            var uninterrupted_valid = true;
            var uninterrupted_log: std.ArrayList(u8) = .empty;
            defer uninterrupted_log.deinit(alloc);
            test_effect_log = &uninterrupted_log;
            feed(
                &uninterrupted_stream,
                &uninterrupted_pending,
                alloc,
                &uninterrupted_valid,
                bytes[0..split],
            );
            uninterrupted_log.clearRetainingCapacity();
            feed(
                &uninterrupted_stream,
                &uninterrupted_pending,
                alloc,
                &uninterrupted_valid,
                bytes[split..],
            );
            feed(
                &uninterrupted_stream,
                &uninterrupted_pending,
                alloc,
                &uninterrupted_valid,
                subsequent,
            );

            var source: Terminal = try .init(alloc, .{
                .cols = 20,
                .rows = 5,
                .max_scrollback = 1 << 20,
            });
            defer source.deinit(alloc);
            var source_stream = source.vtStream();
            defer source_stream.deinit();
            source_stream.handler.effects = test_effects;
            var source_pending: std.ArrayList(u8) = .empty;
            defer source_pending.deinit(alloc);
            var source_valid = true;
            var restored_log: std.ArrayList(u8) = .empty;
            defer restored_log.deinit(alloc);
            test_effect_log = &restored_log;
            feed(
                &source_stream,
                &source_pending,
                alloc,
                &source_valid,
                bytes[0..split],
            );
            const payload = try encode(alloc, &source, &source_stream, source_pending.items);
            defer alloc.free(payload);
            var snapshot = try decode(alloc, payload);
            defer snapshot.deinit(alloc);
            var restored_stream: Stream = undefined;
            restoreStream(&restored_stream, &snapshot.terminal, snapshot.handler, snapshot.pending, test_effects);
            defer restored_stream.deinit();
            var restored_pending: std.ArrayList(u8) = .{
                .items = snapshot.pending,
                .capacity = snapshot.pending.len,
            };
            snapshot.pending = &.{};
            defer restored_pending.deinit(alloc);
            var restored_valid = true;
            restored_log.clearRetainingCapacity();
            feed(
                &restored_stream,
                &restored_pending,
                alloc,
                &restored_valid,
                bytes[split..],
            );
            feed(
                &restored_stream,
                &restored_pending,
                alloc,
                &restored_valid,
                subsequent,
            );

            try std.testing.expect(uninterrupted_valid);
            try std.testing.expect(restored_valid);
            try std.testing.expectEqualSlices(u8, uninterrupted_log.items, restored_log.items);
            try expectSameCheckpoint(
                alloc,
                &uninterrupted,
                &uninterrupted_stream,
                uninterrupted_pending.items,
                &snapshot.terminal,
                &restored_stream,
                restored_pending.items,
            );
        }
    }
    test_effect_log = null;
}

test "rendering stream suppresses query replies" {
    const alloc = std.testing.allocator;
    var t: Terminal = try .init(alloc, .{ .cols = 20, .rows = 5 });
    defer t.deinit(alloc);
    var rendering = t.vtStream();
    defer rendering.deinit();
    rendering.handler.effects = .readonly;
    var pending: std.ArrayList(u8) = .empty;
    defer pending.deinit(alloc);
    var valid = true;
    var replies: std.ArrayList(u8) = .empty;
    defer replies.deinit(alloc);
    test_effect_log = &replies;
    feed(
        &rendering,
        &pending,
        alloc,
        &valid,
        "\x05\x1b[c\x1b[>c\x1b[=c\x1b[5n\x1b[6n\x1b[?25$p" ++
            "\x1b[14t\x1b[16t\x1b[18t\x1b[>0q\x1b[?996n",
    );
    test_effect_log = null;
    try std.testing.expect(valid);
    try std.testing.expectEqual(@as(usize, 0), replies.items.len);
}

test "manual output ledger enforces ordering duplicates and conflicts" {
    const alloc = std.testing.allocator;
    var ledger: OutputRangeLedger = .{};
    defer ledger.deinit(alloc);
    try std.testing.expectEqual(.accept, ledger.classify("abc", 0));
    try ledger.commit(alloc, "abc", 0);
    try std.testing.expectEqual(.duplicate, ledger.classify("abc", 0));
    try std.testing.expectEqual(.invalid, ledger.classify("abd", 0));
    try std.testing.expectEqual(.invalid, ledger.classify("gap", 4));
    try std.testing.expectEqual(.accept, ledger.classify("next", 3));
    try ledger.commit(alloc, "next", 3);
    ledger.reset(99);
    try std.testing.expectEqual(.invalid, ledger.classify("old", 0));
    try std.testing.expectEqual(.accept, ledger.classify("new", 99));
}

test "manual output ledger bounds the replay dedup window" {
    // Positive control for OutputRangeLedger.max_ranges: unbounded growth
    // was a memory DoS (48 bytes per accepted chunk, pruned only on
    // restore). The window is capped with evict-oldest; an evicted range
    // must replay as .invalid (fail-closed), never as a re-accept.
    const alloc = std.testing.allocator;
    var ledger: OutputRangeLedger = .{};
    defer ledger.deinit(alloc);

    // Single-byte chunks: chunk i occupies exactly [i, i + 1).
    var seq: u64 = 0;
    while (seq < OutputRangeLedger.max_ranges + 1) : (seq += 1) {
        try std.testing.expectEqual(.accept, ledger.classify("x", seq));
        try ledger.commit(alloc, "x", seq);
    }
    try std.testing.expectEqual(OutputRangeLedger.max_ranges, ledger.ranges.items.len);

    // The evicted oldest chunk no longer dedupes; the newest still does.
    try std.testing.expectEqual(.invalid, ledger.classify("x", 0));
    try std.testing.expectEqual(.duplicate, ledger.classify("x", seq - 1));
}

test "glyph decode rejects out-of-namespace codepoint freeing exactly once" {
    // Positive control for the readGlyphs ownership contract: register
    // fails OutOfNamespace for a non-private-use codepoint BEFORE taking
    // ownership of contours/points, so the errdefers free them exactly
    // once — testing.allocator reports any double free or leak here.
    const alloc = std.testing.allocator;
    var w: Writer = .{ .alloc = alloc };
    defer w.deinit();
    try w.plain(@as(u32, 1)); // glyph count
    try w.plain(@as(u21, 'A')); // not private use: OutOfNamespace
    try w.plain(std.mem.zeroes(@TypeOf(@as(GlyphEntry, undefined).design)));
    try w.plain(@as(@TypeOf(@as(GlyphEntry, undefined).width), .narrow));
    try w.plain(@as(@TypeOf(@as(GlyphEntry, undefined).constraint), .{}));
    try w.plain(@as(u32, 1)); // contour count
    const contour: u16 = 0;
    try w.write(std.mem.asBytes(&contour));
    try w.plain(@as(u32, 1)); // point count
    const glyph_point = std.mem.zeroes(GlyphOutline.Point);
    try w.write(std.mem.asBytes(&glyph_point));

    var t: Terminal = try .init(alloc, .{ .cols = 20, .rows = 5 });
    defer t.deinit(alloc);
    var r: Reader = .{ .bytes = w.bytes.items };
    try std.testing.expectError(error.InvalidCheckpoint, readGlyphs(&r, alloc, &t));
    try std.testing.expect(!t.glyph_glossary.contains('A'));
}

test "restored replay survives allocation failure" {
    // Positive control for restoreStream's point-of-no-return contract:
    // callers replay AFTER the old terminal/stream are destroyed, so the
    // replay must never panic. Replaying a pending tail engages allocating
    // parser state (the OSC 52 capture writer, the APC glyph parser); run
    // the replay with an allocator failing at each index in turn and pin
    // that every allocation site degrades instead of panicking.
    const alloc = std.testing.allocator;
    const cases = [_][]const u8{
        "before\x1b]52;c;", // partial OSC 52: allocating capture
        "before\x1b_25a1;r;cp=e0a0;AAAA", // partial glyph APC
    };
    for (cases) |bytes| {
        var t: Terminal = try .init(alloc, .{ .cols = 20, .rows = 5, .max_scrollback = 1 << 20 });
        defer t.deinit(alloc);
        var stream = t.vtStream();
        defer stream.deinit();
        var pending: std.ArrayList(u8) = .empty;
        defer pending.deinit(alloc);
        var valid = true;
        feed(&stream, &pending, alloc, &valid, bytes);
        try std.testing.expect(valid);
        try std.testing.expect(pending.items.len > 0);

        const payload = try encode(alloc, &t, &stream, pending.items);
        defer alloc.free(payload);

        var fail_index: usize = 0;
        while (fail_index < 16) : (fail_index += 1) {
            var failing = std.testing.FailingAllocator.init(alloc, .{ .fail_index = fail_index });
            var snapshot = try decode(alloc, payload);
            // The replay allocates through the terminal's gpa; decode used
            // the real allocator, so only replay-time allocations fail.
            snapshot.terminal.screens.active.alloc = failing.allocator();
            var restored: Stream = undefined;
            restoreStream(&restored, &snapshot.terminal, snapshot.handler, snapshot.pending, .readonly);
            snapshot.terminal.screens.active.alloc = alloc;
            restored.deinit();
            snapshot.deinit(alloc);
        }
    }
}

test "manual bridge forwards encoded key text IME and mouse bytes in order" {
    const Capture = struct {
        bytes: std.ArrayList(u8) = .empty,

        fn write(
            context: ?*anyopaque,
            bytes: [*]const u8,
            length: usize,
        ) callconv(.c) void {
            const self: *@This() = @ptrCast(@alignCast(context orelse return));
            self.bytes.appendSlice(std.testing.allocator, bytes[0..length]) catch
                @panic("test capture allocation failed");
        }
    };

    const alloc = std.testing.allocator;
    var capture: Capture = .{};
    defer capture.bytes.deinit(alloc);
    const manual: ManualWrite = .{ .context = &capture, .callback = &Capture.write };
    const encoded = [_][]const u8{
        "\x1b[A", // key
        "text", // committed text
        "\xe4\xb8\x96", // IME commit
        "\x1b[<0;2;3M", // mouse
    };
    for (encoded) |bytes| try manual.queue(alloc, bytes, false);
    try std.testing.expectEqualStrings(
        "\x1b[Atext\xe4\xb8\x96\x1b[<0;2;3M",
        capture.bytes.items,
    );

    capture.bytes.clearRetainingCapacity();
    try manual.queue(alloc, "\r", true);
    try std.testing.expectEqualStrings("\r\n", capture.bytes.items);
}
