const std = @import("std");
const input_arbiter = @import("input_arbiter");
const pty_host = @import("pty_host");
const terminal_state = @import("terminal_state");

const c = @cImport({
    @cInclude("stdlib.h");
});

const bridge_c = @cImport({
    @cInclude("hive_ghostty_bridge.h");
});

pub const c_api = @cImport({
    @cInclude("ghostty/vt.h");
});
const ghostty_c = c_api;

/// Hive's canonical non-image terminal-state budget.
pub const canonical_scrollback_bytes: usize = 48 * 1024 * 1024;

/// Contract A5: bridge/C-owned exports never escape to TerminalState. The
/// adapter copies into the exact Zig allocator that TerminalState later frees.
pub const BridgeExport = struct {
    context: *anyopaque,
    exportFn: *const fn (*anyopaque, *?[*]u8, *usize) anyerror!void,
    freeFn: *const fn (*anyopaque, [*]u8, usize) void,

    pub fn copyInto(
        self: BridgeExport,
        allocator: std.mem.Allocator,
    ) ![]u8 {
        var bridge_bytes: ?[*]u8 = null;
        var bridge_len: usize = 0;
        try self.exportFn(self.context, &bridge_bytes, &bridge_len);
        if (bridge_len == 0) return allocator.alloc(u8, 0);
        const source = bridge_bytes orelse return error.InvalidBridgeExport;
        defer self.freeFn(self.context, source, bridge_len);
        return allocator.dupe(u8, source[0..bridge_len]);
    }
};

const BridgeBytes = struct {
    pointer: [*]u8,
    length: usize,
};

/// Production libghostty-vt adapter. TerminalState owns the returned VtEngine
/// and is the sole caller of its deinit callback.
pub const RealVtEngine = struct {
    allocator: std.mem.Allocator,
    terminal: ghostty_c.GhosttyTerminal,
    effect_sink: ?terminal_state.PtyEffectSink,
    effects: std.ArrayList(u8) = .{},
    effect_failed: bool = false,
    digest_value: [32]u8 = @splat(0),
    /// PTY output has landed since `digest_value` was measured. The digest is a
    /// full checkpoint export, so measuring it per write made sustained output
    /// cost O(terminal state) per chunk; only `digestCb` actually reads it.
    digest_dirty: bool = false,
    /// Checkpoint exports performed by this engine, so the "not once per
    /// written chunk" bound above is assertable rather than merely intended.
    bridge_exports: usize = 0,
    last_bridge_address: usize = 0,
    last_copy_address: usize = 0,
    /// Live grid + cell pixel geometry, updated by resize; drives XTWINOPS
    /// size reports (CSI 14/16/18 t).
    columns: u32,
    rows: u32,
    cell_width_px: u32 = 0,
    cell_height_px: u32 = 0,
    /// XTVERSION reply text ("ghostty <version>"), built once at create.
    xtversion_buf: [80]u8 = undefined,
    xtversion_len: usize = 0,

    pub fn create(
        allocator: std.mem.Allocator,
        columns: u32,
        rows: u32,
        effect_sink: ?terminal_state.PtyEffectSink,
    ) !*RealVtEngine {
        if (columns == 0 or columns > std.math.maxInt(u16) or
            rows == 0 or rows > std.math.maxInt(u16))
            return error.InvalidGeometry;
        const self = try allocator.create(RealVtEngine);
        errdefer allocator.destroy(self);
        var terminal: ghostty_c.GhosttyTerminal = null;
        const options = terminalOptions(columns, rows);
        if (ghostty_c.ghostty_terminal_new(null, &terminal, options) != ghostty_c.GHOSTTY_SUCCESS)
            return error.EngineCreateFailed;
        errdefer ghostty_c.ghostty_terminal_free(terminal);
        self.* = .{
            .allocator = allocator,
            .terminal = terminal,
            .effect_sink = effect_sink,
            .columns = columns,
            .rows = rows,
        };
        // XTVERSION identifies as the pinned Ghostty engine build (claude's
        // detection requires the reply to start with "ghostty"); the default
        // "libghostty" string fails that check.
        const fallback = "ghostty libghostty-vt";
        var version: ghostty_c.GhosttyString = .{ .ptr = null, .len = 0 };
        if (ghostty_c.ghostty_build_info(
            ghostty_c.GHOSTTY_BUILD_INFO_VERSION_STRING,
            @ptrCast(&version),
        ) == ghostty_c.GHOSTTY_SUCCESS and version.ptr != null and version.len > 0) {
            const text = std.fmt.bufPrint(
                &self.xtversion_buf,
                "ghostty {s}",
                .{version.ptr[0..version.len]},
            ) catch blk: {
                @memcpy(self.xtversion_buf[0..fallback.len], fallback);
                break :blk fallback;
            };
            self.xtversion_len = text.len;
        } else {
            @memcpy(self.xtversion_buf[0..fallback.len], fallback);
            self.xtversion_len = fallback.len;
        }
        if (ghostty_c.ghostty_terminal_set(
            terminal,
            ghostty_c.GHOSTTY_TERMINAL_OPT_USERDATA,
            self,
        ) != ghostty_c.GHOSTTY_SUCCESS) return error.EngineCreateFailed;
        if (ghostty_c.ghostty_terminal_set(
            terminal,
            ghostty_c.GHOSTTY_TERMINAL_OPT_WRITE_PTY,
            @ptrCast(&writePtyCallback),
        ) != ghostty_c.GHOSTTY_SUCCESS) return error.EngineCreateFailed;
        // Startup probes (claude et al.): answer DA / XTVERSION / XTWINOPS the
        // way ghostty-the-app does, or the client stalls waiting on replies.
        if (ghostty_c.ghostty_terminal_set(
            terminal,
            ghostty_c.GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES,
            @ptrCast(&deviceAttributesCallback),
        ) != ghostty_c.GHOSTTY_SUCCESS) return error.EngineCreateFailed;
        if (ghostty_c.ghostty_terminal_set(
            terminal,
            ghostty_c.GHOSTTY_TERMINAL_OPT_XTVERSION,
            @ptrCast(&xtversionCallback),
        ) != ghostty_c.GHOSTTY_SUCCESS) return error.EngineCreateFailed;
        if (ghostty_c.ghostty_terminal_set(
            terminal,
            ghostty_c.GHOSTTY_TERMINAL_OPT_SIZE,
            @ptrCast(&sizeCallback),
        ) != ghostty_c.GHOSTTY_SUCCESS) return error.EngineCreateFailed;
        var image_limit: u64 = 16 * 1024 * 1024;
        if (ghostty_c.ghostty_terminal_set(
            terminal,
            ghostty_c.GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT,
            &image_limit,
        ) != ghostty_c.GHOSTTY_SUCCESS) return error.EngineCreateFailed;
        var disabled = false;
        for ([_]ghostty_c.GhosttyTerminalOption{
            ghostty_c.GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_FILE,
            ghostty_c.GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_TEMP_FILE,
            ghostty_c.GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_SHARED_MEM,
        }) |option| {
            if (ghostty_c.ghostty_terminal_set(terminal, option, &disabled) !=
                ghostty_c.GHOSTTY_SUCCESS) return error.EngineCreateFailed;
        }
        try self.updateDigest();
        return self;
    }

    pub fn terminalOptions(columns: u32, rows: u32) ghostty_c.GhosttyTerminalOptions {
        return .{
            .cols = @intCast(columns),
            .rows = @intCast(rows),
            .max_scrollback = canonical_scrollback_bytes,
        };
    }

    pub fn engine(self: *RealVtEngine) terminal_state.VtEngine {
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

    pub fn factory() terminal_state.VtEngineFactory {
        return .{ .context = @ptrCast(&real_factory_context), .createFn = factoryCreate };
    }

    pub fn engineBuildId() ![32]u8 {
        const value = std.mem.span(bridge_c.hive_ghostty_engine_build_id_v1());
        if (value.len != 64) return error.InvalidEngineBuildId;
        var result: [32]u8 = undefined;
        _ = try std.fmt.hexToBytes(&result, value);
        return result;
    }

    fn deinitCb(context: *anyopaque) void {
        const self: *RealVtEngine = @ptrCast(@alignCast(context));
        ghostty_c.ghostty_terminal_free(self.terminal);
        self.effects.deinit(self.allocator);
        const allocator = self.allocator;
        self.* = undefined;
        allocator.destroy(self);
    }

    fn writeCb(context: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *RealVtEngine = @ptrCast(@alignCast(context));
        self.effect_failed = false;
        ghostty_c.ghostty_terminal_vt_write(self.terminal, bytes.ptr, bytes.len);
        if (self.effect_failed) return error.PtyEffectFailed;
        self.digest_dirty = true;
    }

    fn exportCb(
        context: *anyopaque,
        allocator: std.mem.Allocator,
    ) anyerror![]u8 {
        const self: *RealVtEngine = @ptrCast(@alignCast(context));
        const bridge_bytes = try self.exportBridge();
        defer c.free(bridge_bytes.pointer);
        const copy = try allocator.dupe(u8, bridge_bytes.pointer[0..bridge_bytes.length]);
        self.last_bridge_address = @intFromPtr(bridge_bytes.pointer);
        self.last_copy_address = @intFromPtr(copy.ptr);
        return copy;
    }

    fn exportStreamCb(
        context: *anyopaque,
        sink: terminal_state.OpaqueStreamSink,
    ) anyerror!usize {
        const self: *RealVtEngine = @ptrCast(@alignCast(context));
        const Stream = struct {
            sink: terminal_state.OpaqueStreamSink,
            sha: std.crypto.hash.sha2.Sha256 = .init(.{}),
            callback_error: ?anyerror = null,

            fn write(
                userdata: ?*anyopaque,
                bytes: [*c]const u8,
                length: usize,
            ) callconv(.c) bridge_c.ghostty_result_e {
                const state: *@This() = @ptrCast(@alignCast(userdata orelse
                    return bridge_c.GHOSTTY_INVALID_VALUE));
                if (length == 0 or bytes == null) return bridge_c.GHOSTTY_INVALID_VALUE;
                const chunk = bytes[0..length];
                state.sink.write(chunk) catch |err| {
                    state.callback_error = err;
                    return bridge_c.GHOSTTY_INVALID_VALUE;
                };
                state.sha.update(chunk);
                return bridge_c.GHOSTTY_SUCCESS;
            }
        };
        var stream: Stream = .{ .sink = sink };
        var length: usize = 0;
        self.bridge_exports += 1;
        const result = bridge_c.hive_ghostty_terminal_checkpoint_export_stream_v1(
            @ptrCast(self.terminal),
            &Stream.write,
            &stream,
            &length,
        );
        if (stream.callback_error) |err| return err;
        if (result != bridge_c.GHOSTTY_SUCCESS) return switch (result) {
            bridge_c.GHOSTTY_OUT_OF_MEMORY => error.OutOfMemory,
            bridge_c.GHOSTTY_OUT_OF_SPACE => error.PayloadTooLarge,
            else => error.CheckpointExportFailed,
        };
        if (length == 0) return error.CheckpointExportFailed;
        stream.sha.final(&self.digest_value);
        self.digest_dirty = false;
        return length;
    }

    fn cloneCb(context: *anyopaque, allocator: std.mem.Allocator) anyerror!terminal_state.VtEngine {
        const self: *RealVtEngine = @ptrCast(@alignCast(context));
        const clone = try RealVtEngine.create(
            allocator,
            self.columns,
            self.rows,
            self.effect_sink,
        );
        errdefer clone.engine().deinit();
        try clone.resize(
            self.columns,
            self.rows,
            self.cell_width_px,
            self.cell_height_px,
        );
        return clone.engine();
    }

    fn importCb(context: *anyopaque, payload: []const u8) anyerror!void {
        const self: *RealVtEngine = @ptrCast(@alignCast(context));
        if (bridge_c.hive_ghostty_terminal_checkpoint_import_v1(
            @ptrCast(self.terminal),
            payload.ptr,
            payload.len,
        ) != bridge_c.GHOSTTY_SUCCESS) return error.CheckpointImportFailed;
        self.digest_dirty = true;
    }

    fn digestCb(context: *anyopaque) [32]u8 {
        const self: *RealVtEngine = @ptrCast(@alignCast(context));
        if (!self.digest_dirty) return self.digest_value;
        self.updateDigest() catch {
            // §23 forbids claiming a clean restore from state that was never
            // verified, so an unmeasurable digest must never compare equal to
            // another engine's. The live and the fresh verify engine are alive
            // at the same moment, so their addresses cannot collide.
            self.digest_value = @splat(0);
            std.mem.writeInt(usize, self.digest_value[0..@sizeOf(usize)], @intFromPtr(self), .little);
            return self.digest_value;
        };
        self.digest_dirty = false;
        return self.digest_value;
    }

    fn effectsCb(context: *anyopaque) []const u8 {
        const self: *RealVtEngine = @ptrCast(@alignCast(context));
        return self.effects.items;
    }

    pub fn writePtyCallback(
        _: ghostty_c.GhosttyTerminal,
        userdata: ?*anyopaque,
        data: [*c]const u8,
        length: usize,
    ) callconv(.c) void {
        const self: *RealVtEngine = @ptrCast(@alignCast(userdata orelse return));
        if (length == 0) return;
        if (data == null) {
            self.effect_failed = true;
            return;
        }
        const bytes = data[0..length];
        if (self.effect_sink) |sink| {
            sink.write(bytes) catch {
                self.effect_failed = true;
            };
            return;
        }
        // Fresh verification engines retain effects for TG2 comparison. The
        // live engine delivers them directly to the bounded PTY queue instead
        // of retaining a second, session-lifetime copy. Retention stays under
        // the §18 journal ceiling; a null-sink engine that would grow past it
        // fails closed rather than pinning unbounded client-driven bytes.
        const retained = std.math.add(usize, self.effects.items.len, bytes.len) catch {
            self.effect_failed = true;
            return;
        };
        if (retained > terminal_state.journal_max_bytes) {
            self.effect_failed = true;
            return;
        }
        self.effects.appendSlice(self.allocator, bytes) catch {
            self.effect_failed = true;
        };
    }

    /// §23: keep the shadow VT grid/pixel geometry in lockstep with the host's
    /// applied window so checkpoints and XTWINOPS replies carry the real size.
    pub fn resize(
        self: *RealVtEngine,
        columns: u32,
        rows: u32,
        cell_width_px: u32,
        cell_height_px: u32,
    ) !void {
        if (columns == 0 or columns > std.math.maxInt(u16) or
            rows == 0 or rows > std.math.maxInt(u16))
            return error.InvalidGeometry;
        if (ghostty_c.ghostty_terminal_resize(
            self.terminal,
            @intCast(columns),
            @intCast(rows),
            cell_width_px,
            cell_height_px,
        ) != ghostty_c.GHOSTTY_SUCCESS) return error.EngineResizeFailed;
        self.columns = columns;
        self.rows = rows;
        self.cell_width_px = cell_width_px;
        self.cell_height_px = cell_height_px;
        self.digest_dirty = true;
    }

    fn resizeCb(
        context: *anyopaque,
        columns: u32,
        rows: u32,
        cell_width_px: u32,
        cell_height_px: u32,
    ) anyerror!void {
        const self: *RealVtEngine = @ptrCast(@alignCast(context));
        try self.resize(columns, rows, cell_width_px, cell_height_px);
    }

    /// DA1/DA2/DA3 answers mirror ghostty-the-app (apprt/embedded.zig
    /// deviceAttributes): VT220 level-2 conformance + ANSI color (no clipboard
    /// 52 — clipboard writes are denied), DA2 firmware 10, DA3 unit 0.
    fn deviceAttributesCallback(
        _: ghostty_c.GhosttyTerminal,
        userdata: ?*anyopaque,
        out_attrs: [*c]ghostty_c.GhosttyDeviceAttributes,
    ) callconv(.c) bool {
        _ = userdata;
        if (out_attrs == null) return false;
        out_attrs.* = std.mem.zeroes(ghostty_c.GhosttyDeviceAttributes);
        out_attrs.*.primary.conformance_level = 62;
        out_attrs.*.primary.features[0] = 22;
        out_attrs.*.primary.num_features = 1;
        out_attrs.*.secondary.device_type = 1;
        out_attrs.*.secondary.firmware_version = 10;
        return true;
    }

    fn xtversionCallback(
        _: ghostty_c.GhosttyTerminal,
        userdata: ?*anyopaque,
    ) callconv(.c) ghostty_c.GhosttyString {
        const self: *RealVtEngine = @ptrCast(@alignCast(userdata orelse return .{
            .ptr = null,
            .len = 0,
        }));
        return .{ .ptr = &self.xtversion_buf, .len = self.xtversion_len };
    }

    fn sizeCallback(
        _: ghostty_c.GhosttyTerminal,
        userdata: ?*anyopaque,
        out_size: [*c]ghostty_c.GhosttySizeReportSize,
    ) callconv(.c) bool {
        const self: *RealVtEngine = @ptrCast(@alignCast(userdata orelse return false));
        if (out_size == null) return false;
        out_size.* = .{
            .rows = @intCast(self.rows),
            .columns = @intCast(self.columns),
            .cell_width = self.cell_width_px,
            .cell_height = self.cell_height_px,
        };
        return true;
    }

    fn bridgeAllocate(
        _: ?*anyopaque,
        length: usize,
        alignment: usize,
    ) callconv(.c) ?*anyopaque {
        if (alignment > @alignOf(u128)) return null;
        return c.malloc(length);
    }

    fn exportBridge(self: *RealVtEngine) !BridgeBytes {
        var payload: ?[*]u8 = null;
        var length: usize = 0;
        self.bridge_exports += 1;
        if (bridge_c.hive_ghostty_terminal_checkpoint_export_v1(
            @ptrCast(self.terminal),
            &bridgeAllocate,
            null,
            &payload,
            &length,
        ) != bridge_c.GHOSTTY_SUCCESS) return error.CheckpointExportFailed;
        if (length == 0) return error.CheckpointExportFailed;
        return .{
            .pointer = payload orelse return error.CheckpointExportFailed,
            .length = length,
        };
    }

    fn updateDigest(self: *RealVtEngine) !void {
        const Discard = struct {
            fn write(_: *anyopaque, _: []const u8) anyerror!void {}
        };
        var discard: u8 = 0;
        _ = try exportStreamCb(self, .{ .context = &discard, .writeFn = Discard.write });
    }

    fn factoryCreate(
        _: *anyopaque,
        allocator: std.mem.Allocator,
        columns: u32,
        rows: u32,
    ) anyerror!terminal_state.VtEngine {
        const real_engine = try RealVtEngine.create(allocator, columns, rows, null);
        return real_engine.engine();
    }
};

var real_factory_context: u8 = 0;

/// Single writer used by both the arbiter and libghostty-vt PTY effects.
pub const PtyQueueSink = struct {
    pty: *pty_host.PtyHost,

    pub fn arbiterSink(self: *PtyQueueSink) input_arbiter.WriteSink {
        return .{ .context = self, .writeFn = writeCb, .closeFn = closeCb };
    }

    pub fn effectSink(self: *PtyQueueSink) terminal_state.PtyEffectSink {
        return .{ .context = self, .writeFn = writeCb };
    }

    fn writeCb(context: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *PtyQueueSink = @ptrCast(@alignCast(context));
        _ = try self.pty.writeAccept(bytes);
    }

    fn closeCb(context: *anyopaque) void {
        const self: *PtyQueueSink = @ptrCast(@alignCast(context));
        self.pty.closeMaster();
    }
};

/// Production automation/cancel encoder: safe paste uses the live terminal's
/// bracketed-paste mode, and submit/cancel are separate real Ghostty key events.
pub const RealInputEncoder = struct {
    allocator: std.mem.Allocator,
    vt: *RealVtEngine,
    key_encoder: ghostty_c.GhosttyKeyEncoder,
    key_event: ghostty_c.GhosttyKeyEvent,

    pub fn create(
        allocator: std.mem.Allocator,
        vt: *RealVtEngine,
    ) !*RealInputEncoder {
        const self = try allocator.create(RealInputEncoder);
        errdefer allocator.destroy(self);
        var key_encoder: ghostty_c.GhosttyKeyEncoder = null;
        if (ghostty_c.ghostty_key_encoder_new(null, &key_encoder) != ghostty_c.GHOSTTY_SUCCESS)
            return error.EncoderCreateFailed;
        errdefer ghostty_c.ghostty_key_encoder_free(key_encoder);
        var key_event: ghostty_c.GhosttyKeyEvent = null;
        if (ghostty_c.ghostty_key_event_new(null, &key_event) != ghostty_c.GHOSTTY_SUCCESS)
            return error.EncoderCreateFailed;
        self.* = .{
            .allocator = allocator,
            .vt = vt,
            .key_encoder = key_encoder,
            .key_event = key_event,
        };
        return self;
    }

    pub fn deinit(self: *RealInputEncoder) void {
        ghostty_c.ghostty_key_event_free(self.key_event);
        ghostty_c.ghostty_key_encoder_free(self.key_encoder);
        const allocator = self.allocator;
        self.* = undefined;
        allocator.destroy(self);
    }

    pub fn encoder(self: *RealInputEncoder) input_arbiter.Encoder {
        return .{ .context = self, .encodeFn = encodeCb };
    }

    pub fn cancelEncoder(self: *RealInputEncoder) input_arbiter.CancelEncoder {
        return .{ .context = self, .encodeFn = cancelCb };
    }

    fn encodeCb(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        body: []const u8,
        submit: input_arbiter.SubmitAction,
        out: *std.ArrayList(u8),
    ) anyerror!void {
        const self: *RealInputEncoder = @ptrCast(@alignCast(context));
        if (out.items.len != 0 or out.capacity == 0) return error.InvalidEncodeBuffer;
        var bracketed = false;
        if (ghostty_c.ghostty_terminal_mode_get(
            self.vt.terminal,
            ghostty_c.ghostty_mode_new(2004, false),
            &bracketed,
        ) != ghostty_c.GHOSTTY_SUCCESS) return error.EncodeFailed;
        const mutable = try allocator.dupe(u8, body);
        defer {
            std.crypto.secureZero(u8, mutable);
            allocator.free(mutable);
        }
        var written: usize = 0;
        if (ghostty_c.ghostty_paste_encode(
            mutable.ptr,
            mutable.len,
            bracketed,
            out.allocatedSlice().ptr,
            out.capacity,
            &written,
        ) != ghostty_c.GHOSTTY_SUCCESS) return error.EncodeFailed;
        // `written` arrives across the FFI boundary; never trust it past the
        // buffer that was handed over. Fail closed before slicing.
        if (written > out.capacity) return error.EncodeFailed;
        out.items = out.allocatedSlice()[0..written];
        switch (submit) {
            .none => {},
            .@"return" => try self.appendKey(out, ghostty_c.GHOSTTY_KEY_ENTER, 0),
            .control_enter => try self.appendKey(
                out,
                ghostty_c.GHOSTTY_KEY_ENTER,
                ghostty_c.GHOSTTY_MODS_CTRL,
            ),
        }
    }

    fn cancelCb(
        context: *anyopaque,
        _: std.mem.Allocator,
        out: *std.ArrayList(u8),
    ) anyerror!void {
        const self: *RealInputEncoder = @ptrCast(@alignCast(context));
        if (out.items.len != 0 or out.capacity == 0) return error.InvalidEncodeBuffer;
        try self.appendKey(out, ghostty_c.GHOSTTY_KEY_C, ghostty_c.GHOSTTY_MODS_CTRL);
    }

    fn appendKey(
        self: *RealInputEncoder,
        out: *std.ArrayList(u8),
        key: ghostty_c.GhosttyKey,
        mods: ghostty_c.GhosttyMods,
    ) !void {
        ghostty_c.ghostty_key_encoder_setopt_from_terminal(self.key_encoder, self.vt.terminal);
        ghostty_c.ghostty_key_event_set_action(self.key_event, ghostty_c.GHOSTTY_KEY_ACTION_PRESS);
        ghostty_c.ghostty_key_event_set_key(self.key_event, key);
        ghostty_c.ghostty_key_event_set_mods(self.key_event, mods);
        ghostty_c.ghostty_key_event_set_consumed_mods(self.key_event, 0);
        ghostty_c.ghostty_key_event_set_composing(self.key_event, false);
        const old_len = out.items.len;
        const allocation = out.allocatedSlice();
        var written: usize = 0;
        if (ghostty_c.ghostty_key_encoder_encode(
            self.key_encoder,
            self.key_event,
            allocation[old_len..].ptr,
            allocation.len - old_len,
            &written,
        ) != ghostty_c.GHOSTTY_SUCCESS) return error.EncodeFailed;
        // Same FFI distrust as encodeCb: clamp the reported byte count to the
        // remaining capacity before extending the slice.
        if (written > allocation.len - old_len) return error.EncodeFailed;
        out.items = allocation[0 .. old_len + written];
    }
};
