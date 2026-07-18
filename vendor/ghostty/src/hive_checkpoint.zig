const std = @import("std");
const builtin = @import("builtin");
const terminal = @import("terminal/main.zig");
const pagepkg = @import("terminal/page.zig");
const point = @import("terminal/point.zig");
const hyperlink = @import("terminal/hyperlink.zig");
const build_options = @import("terminal_options");

const Allocator = std.mem.Allocator;
const Terminal = terminal.Terminal;
const Stream = terminal.TerminalStream;
const Handler = @import("terminal/stream_terminal.zig").Handler;
const Screen = terminal.Screen;
const ScreenSet = terminal.ScreenSet;
const PageList = terminal.PageList;
const Page = pagepkg.Page;
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

fn hashCheckpointLayout(hash: *Sha256) void {
    hashText(hash, "hive-checkpoint-layout-v1");
    hashText(hash, @tagName(builtin.target.cpu.arch.endian()));
    hashText(hash, @tagName(builtin.target.abi));
    hashText(hash, @tagName(builtin.target.cCharSignedness()));
    hashInt(hash, builtin.target.ptrBitWidth());
    hashInt(hash, std.heap.page_size_min);

    // Only options that affect checkpoint bytes or replay belong here.
    inline for (.{
        build_options.c_abi,
        build_options.kitty_graphics,
        build_options.tmux_control_mode,
        build_options.slow_runtime_safety,
    }) |value| hashInt(hash, @intFromBool(value));

    inline for (.{
        c_char, c_int,
        u8,     u16,
        u21,    u32,
        u64,    usize,
        bool,   ?u21,
    }) |T| hashTypeLayout(hash, T);
    inline for (.{
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
        point.Coordinate,
    }) |T| hashTypeLayout(hash, T);
    inline for (.{
        terminal.kitty.graphics.Image,                                         @TypeOf(@as(terminal.kitty.graphics.ImageStorage, undefined).image_limits),
        @TypeOf(@as(terminal.kitty.graphics.LoadingImage, undefined).display), @TypeOf(@as(terminal.kitty.graphics.LoadingImage, undefined).quiet),
        terminal.kitty.graphics.ImageStorage.PlacementKey,                     terminal.kitty.graphics.ImageStorage.Placement,
        @TypeOf(@as(GlyphEntry, undefined).design),                            @TypeOf(@as(GlyphEntry, undefined).width),
        @TypeOf(@as(GlyphEntry, undefined).constraint),                        GlyphOutline.Point,
    }) |T| hashTypeLayout(hash, T);

    const page_layout = canonicalBytes(Page.layout(.{ .cols = 80, .rows = 24 }));
    hash.update(&page_layout);
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

fn canonicalBytes(value: anytype) [@sizeOf(@TypeOf(value))]u8 {
    const T = @TypeOf(value);
    var result: [@sizeOf(T)]u8 align(@alignOf(T)) = @splat(0);
    switch (@typeInfo(T)) {
        .array => {
            for (value, 0..) |item, i| {
                const item_bytes = canonicalBytes(item);
                @memcpy(
                    result[i * item_bytes.len ..][0..item_bytes.len],
                    &item_bytes,
                );
            }
        },
        .@"struct" => |info| switch (info.layout) {
            .@"packed" => @as(*T, @ptrCast(&result)).* = value,
            else => inline for (info.fields) |field| {
                const field_bytes = canonicalBytes(@field(value, field.name));
                @memcpy(
                    result[@offsetOf(T, field.name)..][0..field_bytes.len],
                    &field_bytes,
                );
            },
        },
        else => @as(*T, @ptrCast(&result)).* = value,
    }
    return result;
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
        const bytes = canonicalBytes(value);
        try self.write(&bytes);
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
        var result: T = undefined;
        @memcpy(std.mem.asBytes(&result), try self.take(@sizeOf(T)));
        return result;
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

pub fn restoreStream(
    t: *Terminal,
    state: HandlerState,
    pending: []const u8,
    effects: Handler.Effects,
) Error!Stream {
    var handler: Handler = .init(t);
    handler.apc_handler.max_bytes = state.max_bytes;
    handler.apc_handler.enabled = state.enabled;
    handler.default_cursor = state.default_cursor;
    handler.default_cursor_style = state.default_cursor_style;
    handler.default_cursor_blink = state.default_cursor_blink;

    var result: Stream = .initAlloc(t.gpa(), handler);
    errdefer result.deinit();
    for (pending) |byte| result.next(byte);
    result.handler.effects = effects;
    return result;
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

        var metadata = canonicalBytes(page.*);
        @memset(
            metadata[@offsetOf(Page, "memory")..][0..@sizeOf([]u8)],
            0,
        );
        try w.write(&metadata);
        try w.slice(page.memory);
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

    var pool = try PageList.MemoryPool.init(alloc, std.heap.page_allocator, count);
    errdefer pool.deinit();
    var list: PageList.List = .{};
    errdefer {
        var it = list.first;
        while (it) |node| : (it = node.next) {
            pool.pages.arena.child_allocator.free(node.page().memory);
        }
    }

    var page_size: usize = 0;
    for (0..count) |_| {
        const serial = try r.plain(u64);
        var metadata = try r.plain(Page);
        const memory = try r.take(try r.plain(u32));
        if (memory.len == 0 or memory.len % std.heap.page_size_min != 0)
            return error.InvalidCheckpoint;
        const owned = try pool.pages.arena.child_allocator.alignedAlloc(
            u8,
            .fromByteUnits(std.heap.page_size_min),
            memory.len,
        );
        errdefer pool.pages.arena.child_allocator.free(owned);
        @memcpy(owned, memory);
        metadata.memory = owned;
        const layout = Page.layout(metadata.capacity);
        if (layout.total_size != memory.len or
            metadata.size.rows > metadata.capacity.rows or
            metadata.size.cols > metadata.capacity.cols)
            return error.InvalidCheckpoint;

        const node = try pool.nodes.create();
        node.* = .{
            .data = .{ .resident = metadata },
            .serial = serial,
            .owned = .heap,
        };
        list.append(node);
        page_size += memory.len;
    }

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

const CursorWire = struct {
    x: @TypeOf(@as(Screen.Cursor, undefined).x),
    y: @TypeOf(@as(Screen.Cursor, undefined).y),
    cursor_style: Screen.CursorStyle,
    pending_wrap: bool,
    protected: bool,
    style: terminal.Style,
    style_id: @TypeOf(@as(Screen.Cursor, undefined).style_id),
    hyperlink_id: hyperlink.Id,
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
        .style_id = screen.cursor.style_id,
        .hyperlink_id = screen.cursor.hyperlink_id,
        .hyperlink_implicit_id = screen.cursor.hyperlink_implicit_id,
        .semantic_content = screen.cursor.semantic_content,
        .semantic_content_clear_eol = screen.cursor.semantic_content_clear_eol,
        .pin = pin.screen,
    });
    try writeHyperlink(w, screen.cursor.hyperlink);
    try writeImages(w, screen);
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
            .style_id = cursor.style_id,
            .hyperlink_id = cursor.hyperlink_id,
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
    screen.cursor.hyperlink = try readHyperlink(r, alloc);
    try readImages(r, alloc, screen);
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
        var image = entry.value_ptr.*;
        image.data = "";
        try w.plain(image);
        try w.slice(entry.value_ptr.data);
    }

    try w.plain(storage.loading != null);
    if (storage.loading) |loading| {
        var image = loading.image;
        image.data = "";
        try w.plain(image);
        try w.slice(loading.image.data);
        try w.slice(loading.data.items);
        try w.plain(loading.display);
        try w.plain(loading.quiet);
    }

    try w.plain(@as(u32, @intCast(storage.placements.count())));
    var placement_it = storage.placements.iterator();
    while (placement_it.next()) |entry| {
        try w.plain(entry.key_ptr.*);
        var placement = entry.value_ptr.*;
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
        placement.location = .virtual;
        try w.plain(placement);
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
        var image = try r.plain(terminal.kitty.graphics.Image);
        image.data = try r.slice(alloc);
        errdefer image.deinit(alloc);
        try storage.images.put(alloc, key, image);
        storage.total_bytes += image.data.len;
    }

    if (try r.plain(bool)) {
        const loading = try alloc.create(terminal.kitty.graphics.LoadingImage);
        errdefer alloc.destroy(loading);
        var image = try r.plain(terminal.kitty.graphics.Image);
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
        var placement = try r.plain(terminal.kitty.graphics.ImageStorage.Placement);
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
        const contours = try alloc.alloc(u16, contour_count);
        errdefer alloc.free(contours);
        @memcpy(std.mem.sliceAsBytes(contours), try r.take(contours.len * @sizeOf(u16)));
        const point_count = try r.plain(u32);
        const points = try alloc.alloc(GlyphOutline.Point, point_count);
        errdefer alloc.free(points);
        @memcpy(std.mem.sliceAsBytes(points), try r.take(points.len * @sizeOf(@TypeOf(points[0]))));
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
    var restored = try restoreStream(&snapshot.terminal, snapshot.handler, snapshot.pending, .readonly);
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
    var restored = try restoreStream(
        &snapshot.terminal,
        snapshot.handler,
        snapshot.pending,
        .readonly,
    );
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
    try w.plain(screen.no_scrollback);
    try w.plain(screen.saved_cursor != null);
    if (screen.saved_cursor) |saved| try w.plain(saved);
    try w.plain(screen.charset);
    try w.plain(screen.protected_mode);
    try w.plain(screen.kitty_keyboard);
    try w.plain(screen.semantic_prompt);
    try w.plain(screen.pages.page_serial);
    try w.plain(screen.pages.page_serial_epoch);
    try w.plain(screen.pages.explicit_max_size);
    try w.plain(screen.pages.min_max_size);
    try w.plain(screen.pages.total_rows);
    try w.plain(screen.cursor.pending_wrap);
    try w.plain(screen.cursor.semantic_content);
    try w.plain(screen.cursor.semantic_content_clear_eol);
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
    try w.plain(t.status_display);
    try w.plain(t.rows);
    try w.plain(t.cols);
    try w.plain(t.width_px);
    try w.plain(t.height_px);
    try w.plain(t.scrolling_region);
    try w.slice(t.getPwd() orelse "");
    try w.slice(t.getTitle() orelse "");
    try w.plain(t.colors);
    try w.plain(t.previous_char != null);
    if (t.previous_char) |cp| try w.plain(cp);
    try w.plain(t.modes);
    try w.plain(t.mouse_shape);
    try w.plain(t.flags.shell_redraws_prompt);
    try w.plain(t.flags.modify_other_keys_2);
    try w.plain(t.flags.mouse_event);
    try w.plain(t.flags.mouse_format);
    try w.plain(t.flags.mouse_shift_capture);
    try w.plain(t.flags.password_input);
    for (0..t.cols) |col| try w.plain(t.tabstops.get(col));
    try writeGlyphs(&w, t);
    try w.plain(t.screens.active_key);
    try w.plain(t.screens.generations.get(.primary).?);
    try w.plain(t.screens.generations.get(.alternate).?);
    try semanticScreen(&w, t.screens.get(.primary).?);
    const alternate = t.screens.get(.alternate);
    try w.plain(alternate != null);
    if (alternate) |screen| try semanticScreen(&w, screen);
    try w.plain(stream.handler.apc_handler.max_bytes);
    try w.plain(stream.handler.apc_handler.enabled);
    try w.plain(stream.handler.default_cursor);
    try w.plain(stream.handler.default_cursor_style);
    try w.plain(stream.handler.default_cursor_blink);
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
    var restored_stream = try restoreStream(
        &snapshot.terminal,
        snapshot.handler,
        snapshot.pending,
        .readonly,
    );
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
            var restored_stream = try restoreStream(
                &snapshot.terminal,
                snapshot.handler,
                snapshot.pending,
                test_effects,
            );
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
