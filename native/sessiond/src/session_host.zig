//! WP4 Track Omega: one HOST process owns one provider generation.
//!
//! This module composes the landed PTY, process-inspection, input-arbiter, and
//! terminal-state leaves. Broker registry/admission authority remains in
//! broker.zig; this module implements only the host process and its launcher.

const std = @import("std");
const boot_envelope = @import("boot_envelope");
const broker = @import("broker");
const generated = @import("session_protocol_generated");
const input_arbiter = @import("input_arbiter");
const process_inspector = @import("process_inspector");
const protocol = @import("protocol");
const pty_host = @import("pty_host");
const neutral_host = @import("neutral_host");
const neutral_control_plane = @import("neutral_control_plane");
const terminal_state = @import("terminal_state");

const c = @cImport({
    @cInclude("fcntl.h");
    @cInclude("signal.h");
    @cInclude("sys/socket.h");
    @cInclude("sys/stat.h");
    @cInclude("sys/time.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
    @cInclude("stdlib.h");
});

const bridge_c = @cImport({
    @cInclude("hive_ghostty_bridge.h");
});

const ghostty_c = @cImport({
    @cInclude("ghostty/vt.h");
});

test {
    std.testing.refAllDecls(@This());
}

pub const inherited_control_fd = boot_envelope.inherited_control_fd;
pub const BootMessage = boot_envelope.Message;
pub const writeBootMessage = boot_envelope.write;
pub const readBootMessage = boot_envelope.read;

/// Host-owned visibility clock. Renewal and expiry use only the injected
/// monotonic value; broker liveness is intentionally irrelevant.
pub const VisibilityLease = struct {
    workspace_session_id: []const u8,
    open_terminal_revision: u64,
    expires_mono_ns: u64,
    state: enum { attaching, visible, reconnecting, expired } = .attaching,

    pub fn initial(
        workspace_session_id: []const u8,
        revision: u64,
        now_ns: u64,
    ) !VisibilityLease {
        if (revision == 0) return error.InvalidVisibilityRevision;
        return .{
            .workspace_session_id = workspace_session_id,
            .open_terminal_revision = revision,
            .expires_mono_ns = try expiryFrom(now_ns),
        };
    }

    pub fn renew(
        self: *VisibilityLease,
        workspace_session_id: []const u8,
        revision: u64,
        now_ns: u64,
    ) !void {
        if (self.expired(now_ns)) return error.VisibilityExpired;
        if (!std.mem.eql(u8, self.workspace_session_id, workspace_session_id))
            return error.VisibilityForbidden;
        if (revision < self.open_terminal_revision)
            return error.StaleVisibilityRevision;
        self.open_terminal_revision = revision;
        self.expires_mono_ns = try expiryFrom(now_ns);
        self.state = .visible;
    }

    pub fn expired(self: *VisibilityLease, now_ns: u64) bool {
        if (self.state == .expired) return true;
        if (now_ns < self.expires_mono_ns) return false;
        self.state = .expired;
        return true;
    }

    fn expiryFrom(now_ns: u64) !u64 {
        return std.math.add(
            u64,
            now_ns,
            generated.limits.visibility_expiry_ms * std.time.ns_per_ms,
        );
    }
};

/// Contract A3: §20 checkpointSeq is readable only when replay bytes exist.
pub fn checkpointWireSeq(state: *const terminal_state.TerminalState) u64 {
    if (!state.checkpointAvailable()) return 0;
    return state.checkpointSeq();
}

pub fn requireEngineBuildId(value: ?[]const u8) !void {
    const expected = try broker.engineBuildIdHex();
    if (value == null or !std.mem.eql(u8, value.?, &expected))
        return error.EngineMismatch;
}

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
        const options: ghostty_c.GhosttyTerminalOptions = .{
            .cols = @intCast(columns),
            .rows = @intCast(rows),
            .max_scrollback = 50_000,
        };
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

    pub fn engine(self: *RealVtEngine) terminal_state.VtEngine {
        return .{
            .context = self,
            .deinitFn = deinitCb,
            .writeFn = writeCb,
            .exportFn = exportCb,
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
        try self.updateDigest();
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

    fn importCb(context: *anyopaque, payload: []const u8) anyerror!void {
        const self: *RealVtEngine = @ptrCast(@alignCast(context));
        if (bridge_c.hive_ghostty_terminal_checkpoint_import_v1(
            @ptrCast(self.terminal),
            payload.ptr,
            payload.len,
        ) != bridge_c.GHOSTTY_SUCCESS) return error.CheckpointImportFailed;
        try self.updateDigest();
    }

    fn digestCb(context: *anyopaque) [32]u8 {
        const self: *RealVtEngine = @ptrCast(@alignCast(context));
        return self.digest_value;
    }

    fn effectsCb(context: *anyopaque) []const u8 {
        const self: *RealVtEngine = @ptrCast(@alignCast(context));
        return self.effects.items;
    }

    fn writePtyCallback(
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
        try self.updateDigest();
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
        const bridge_bytes = try self.exportBridge();
        defer c.free(bridge_bytes.pointer);
        std.crypto.hash.sha2.Sha256.hash(
            bridge_bytes.pointer[0..bridge_bytes.length],
            &self.digest_value,
            .{},
        );
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

pub const FinalState = enum { terminated, survivors, unknown };

pub const FinalSurvivor = struct {
    pid: i32,
    startToken: []const u8,
    reason: []const u8,
};

pub const FinalError = struct {
    phase: []const u8,
    code: []const u8,
};

pub const FinalEvidence = struct {
    schemaVersion: u8 = 1,
    state: []const u8,
    exitCode: ?u8,
    exitSignal: ?i32,
    /// True iff PtyHost's own waitpid reaped this host-owned child; false does not imply the host is still alive—the inspector may have reaped it first.
    waitObserved: bool,
    outputSeq: []const u8,
    checkpointSeq: []const u8,
    survivors: []const FinalSurvivor,
    errors: []const FinalError,
    failureCode: ?[]const u8,
};

/// `final.json` is immutable exit evidence: exclusive create, file fsync, then
/// directory fsync. Existing evidence is never replaced.
pub fn writeFinalExclusive(
    allocator: std.mem.Allocator,
    directory: std.fs.Dir,
    evidence: FinalEvidence,
) !void {
    const json = try std.json.Stringify.valueAlloc(allocator, evidence, .{});
    defer allocator.free(json);
    var file = try directory.createFile("final.json", .{
        .mode = 0o600,
        .exclusive = true,
    });
    errdefer directory.deleteFile("final.json") catch {};
    defer file.close();
    try file.chmod(0o600);
    try file.writeAll(json);
    try file.sync();
    try std.posix.fsync(directory.fd);
}

const WireSubject = struct {
    kind: []const u8,
    agentId: ?[]const u8 = null,
};

const WireLocator = struct {
    schemaVersion: u8,
    instanceId: []const u8,
    subject: WireSubject,
    generation: u64,
    sessionId: []const u8,
    hostKind: []const u8,
    engineBuildId: ?[]const u8,
};

const WireProcessRoot = struct {
    pid: i32,
    startToken: []const u8,
    processGroupId: i32,
};

const WireGeometry = struct {
    columns: u32,
    rows: u32,
    widthPx: u32,
    heightPx: u32,
    cellWidthPx: f64,
    cellHeightPx: f64,
};

const WireVisibility = struct {
    state: []const u8,
    workspaceSessionId: []const u8,
    openTerminalRevision: []const u8,
    expiresAt: []const u8,
};

const WireHostProjection = struct {
    locator: WireLocator,
    hostPid: i32,
    hostStartToken: []const u8,
    processRoot: WireProcessRoot,
    expectedExecutable: []const u8,
    executableBuildHash: []const u8,
    engineBuildId: []const u8,
    protocol: struct { major: u8, minor: u8 },
    geometry: WireGeometry,
    state: []const u8,
    outputSeq: []const u8,
    checkpointSeq: []const u8,
    visibility: WireVisibility,
};

const WireHostRegisterRequest = struct {
    schemaVersion: u8,
    record: WireHostProjection,
};

pub const HostRegistration = struct {
    record: broker.HostRecord,
    expires_at: []const u8,
    created_at: []const u8,
    checkpoint_available: bool,
    executable_verified: bool,
    complete: bool,
};

fn locatorValue(allocator: std.mem.Allocator, locator: broker.Locator) !std.json.Value {
    var subject = std.json.ObjectMap.init(allocator);
    try subject.put("kind", .{ .string = @tagName(locator.subject) });
    switch (locator.subject) {
        .root => {},
        .agent => |agent_id| try subject.put("agentId", .{ .string = agent_id }),
    }
    var value = std.json.ObjectMap.init(allocator);
    try value.put("schemaVersion", .{ .integer = 1 });
    try value.put("instanceId", .{ .string = locator.instance_id });
    try value.put("subject", .{ .object = subject });
    try value.put("generation", .{ .integer = @intCast(locator.generation) });
    try value.put("sessionId", .{ .string = locator.session_id });
    try value.put("hostKind", .{ .string = @tagName(locator.host_kind) });
    try value.put("engineBuildId", if (locator.engine_build_id) |engine|
        .{ .string = engine }
    else
        .null);
    return .{ .object = value };
}

fn processRootValue(allocator: std.mem.Allocator, root: broker.ProcessRoot) !std.json.Value {
    var value = std.json.ObjectMap.init(allocator);
    try value.put("pid", .{ .integer = root.pid });
    try value.put("startToken", .{ .string = root.start_token });
    try value.put("processGroupId", .{ .integer = root.process_group_id });
    return .{ .object = value };
}

fn geometryValue(allocator: std.mem.Allocator, geometry: broker.Geometry) !std.json.Value {
    var value = std.json.ObjectMap.init(allocator);
    try value.put("columns", .{ .integer = geometry.columns });
    try value.put("rows", .{ .integer = geometry.rows });
    try value.put("widthPx", .{ .integer = geometry.width_px });
    try value.put("heightPx", .{ .integer = geometry.height_px });
    try value.put("cellWidthPx", .{ .float = geometry.cell_width_px });
    try value.put("cellHeightPx", .{ .float = geometry.cell_height_px });
    return .{ .object = value };
}

fn visibilityValue(
    allocator: std.mem.Allocator,
    visibility: broker.Visibility,
    expires_at: []const u8,
) !std.json.Value {
    var revision_storage: [32]u8 = undefined;
    const revision = try std.fmt.bufPrint(&revision_storage, "{d}", .{
        visibility.open_terminal_revision,
    });
    var value = std.json.ObjectMap.init(allocator);
    try value.put("state", .{ .string = @tagName(visibility.state) });
    try value.put("workspaceSessionId", .{ .string = visibility.workspace_session_id });
    try value.put("openTerminalRevision", .{ .string = try allocator.dupe(u8, revision) });
    try value.put("expiresAt", .{ .string = expires_at });
    return .{ .object = value };
}

fn protocolValue(allocator: std.mem.Allocator, major: u8, minor: u8) !std.json.Value {
    var value = std.json.ObjectMap.init(allocator);
    try value.put("major", .{ .integer = major });
    try value.put("minor", .{ .integer = minor });
    return .{ .object = value };
}

fn projectionValue(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
) !std.json.Value {
    const record = registration.record;
    var output_storage: [32]u8 = undefined;
    var checkpoint_storage: [32]u8 = undefined;
    const output = try std.fmt.bufPrint(&output_storage, "{d}", .{record.output_seq});
    const checkpoint = try std.fmt.bufPrint(&checkpoint_storage, "{d}", .{record.checkpoint_seq});
    var value = std.json.ObjectMap.init(allocator);
    try value.put("locator", try locatorValue(allocator, record.locator));
    try value.put("hostPid", .{ .integer = record.host_pid });
    try value.put("hostStartToken", .{ .string = record.host_start_token });
    try value.put("processRoot", try processRootValue(allocator, record.process_root));
    try value.put("expectedExecutable", .{ .string = record.expected_executable });
    try value.put("executableBuildHash", .{ .string = record.executable_build_hash });
    try value.put("engineBuildId", .{ .string = record.engine_build_id });
    try value.put("protocol", try protocolValue(allocator, record.protocol_major, record.protocol_minor));
    try value.put("geometry", try geometryValue(allocator, record.geometry));
    try value.put("state", .{ .string = @tagName(record.state) });
    try value.put("visibility", try visibilityValue(allocator, record.visibility, registration.expires_at));
    try value.put("outputSeq", .{ .string = try allocator.dupe(u8, output) });
    try value.put("checkpointSeq", .{ .string = try allocator.dupe(u8, checkpoint) });
    return .{ .object = value };
}

pub fn encodeHostRegister(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    var root = std.json.ObjectMap.init(arena.allocator());
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("record", try projectionValue(arena.allocator(), registration));
    const json = try std.json.Stringify.valueAlloc(allocator, std.json.Value{ .object = root }, .{});
    errdefer allocator.free(json);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.host_register_payload,
        json,
    )) return error.InvalidHostRegister;
    return json;
}

pub fn encodeRecordJson(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const projection = try projectionValue(arena.allocator(), registration);
    var root = projection.object;
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("socketRelativePath", .{ .string = "host.sock" });
    try root.put("createdAt", .{ .string = registration.created_at });
    const json = try std.json.Stringify.valueAlloc(allocator, std.json.Value{ .object = root }, .{});
    errdefer allocator.free(json);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.host_record_v1,
        json,
    )) return error.InvalidHostRecord;
    return json;
}

pub fn encodeCreatedPayload(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const record = registration.record;
    var output_storage: [32]u8 = undefined;
    var checkpoint_storage: [32]u8 = undefined;
    const output = try std.fmt.bufPrint(&output_storage, "{d}", .{record.output_seq});
    const checkpoint = try std.fmt.bufPrint(&checkpoint_storage, "{d}", .{record.checkpoint_seq});

    var input = std.json.ObjectMap.init(a);
    try input.put("state", .{ .string = "FREE" });
    try input.put("ownerViewerId", .null);
    try input.put("claimId", .null);
    const resources = std.json.ObjectMap.init(a);
    const survivors = std.json.Array.init(a);
    const diagnostics = std.json.Array.init(a);
    var inspection = std.json.ObjectMap.init(a);
    try inspection.put("schemaVersion", .{ .integer = 1 });
    try inspection.put("locator", try locatorValue(a, record.locator));
    try inspection.put("presence", .{ .string = "present" });
    try inspection.put("complete", .{ .bool = registration.complete });
    try inspection.put("hostPid", .{ .integer = record.host_pid });
    try inspection.put("hostStartToken", .{ .string = record.host_start_token });
    try inspection.put("providerRoot", try processRootValue(a, record.process_root));
    try inspection.put("expectedExecutable", .{ .string = record.expected_executable });
    try inspection.put("executableVerified", .{ .bool = registration.executable_verified });
    try inspection.put("outputSeq", .{ .string = try a.dupe(u8, output) });
    try inspection.put("checkpointSeq", .{ .string = try a.dupe(u8, checkpoint) });
    try inspection.put("checkpointAvailable", .{ .bool = registration.checkpoint_available });
    try inspection.put("input", .{ .object = input });
    try inspection.put("viewerCount", .{ .integer = 0 });
    try inspection.put("geometry", try geometryValue(a, record.geometry));
    try inspection.put("resources", .{ .object = resources });
    try inspection.put("visibility", try visibilityValue(a, record.visibility, registration.expires_at));
    try inspection.put("exit", .null);
    try inspection.put("survivors", .{ .array = survivors });
    try inspection.put("evidenceAt", .{ .string = registration.created_at });
    try inspection.put("diagnosticIds", .{ .array = diagnostics });

    var root = std.json.ObjectMap.init(a);
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("locator", try locatorValue(a, record.locator));
    try root.put("inspection", .{ .object = inspection });
    try root.put("created", .{ .bool = true });
    const json = try std.json.Stringify.valueAlloc(allocator, std.json.Value{ .object = root }, .{});
    errdefer allocator.free(json);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.created_payload,
        json,
    )) return error.InvalidCreatedPayload;
    return json;
}

const WireHello = struct {
    schemaVersion: u8,
    buildId: []const u8,
    instanceId: []const u8,
    protocol: struct { major: u8, minMinor: u8, maxMinor: u8 },
    clientRole: []const u8,
    grantToken: ?[]const u8 = null,
};

const WireWelcome = struct {
    schemaVersion: u8,
    protocol: struct { major: u8, minor: u8 },
    instanceId: []const u8,
    endpointRole: []const u8,
    buildId: []const u8,
    engineBuildId: ?[]const u8,
};

fn responseHeader(request: protocol.Header, type_code: u16, payload_len: usize) protocol.Header {
    return .{
        .minor = request.minor,
        .type_code = type_code,
        .flags = generated.frame_flag.response | generated.frame_flag.final,
        .payload_length = @intCast(payload_len),
        .request_id = request.request_id,
        .stream_seq = 0,
    };
}

fn readRequiredFrame(allocator: std.mem.Allocator, stream: std.net.Stream) !protocol.Frame {
    const file: std.fs.File = .{ .handle = stream.handle };
    return switch (try protocol.readFrame(allocator, file.deprecatedReader())) {
        .frame => |frame| frame,
        else => error.InvalidRegistrationFrame,
    };
}

fn writeHostWelcome(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    request: protocol.Header,
    registration: HostRegistration,
    build_id: []const u8,
    server_epoch: u64,
) !void {
    var connection_storage: [32]u8 = undefined;
    var epoch_storage: [32]u8 = undefined;
    const connection = try std.fmt.bufPrint(&connection_storage, "{d}", .{
        std.crypto.random.int(u64),
    });
    const epoch = try std.fmt.bufPrint(&epoch_storage, "{d}", .{server_epoch});
    const payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .protocol = .{ .major = generated.protocol_major, .minor = generated.protocol_minor },
        .instanceId = registration.record.locator.instance_id,
        .endpointRole = "host",
        .buildId = build_id,
        .engineBuildId = registration.record.engine_build_id,
        .connectionId = connection,
        .serverEpoch = epoch,
        .limits = .{
            .controlFrameMaxBytes = generated.limits.control_json_bytes,
            .maxInputTransactionBytes = generated.limits.input_transaction_bytes,
            .streamChunkMaxBytes = generated.limits.stream_chunk_bytes,
            .automatedMessageMaxBytes = generated.limits.automated_message_bytes,
            .viewerQueueMaxBytes = generated.limits.viewer_queue_bytes,
        },
    }, .{});
    defer allocator.free(payload);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.welcome_payload,
        payload,
    )) return error.InvalidWelcome;
    try protocol.writeFrame(
        stream,
        responseHeader(request, generated.frame_type.welcome, payload.len),
        payload,
    );
}

fn writeHostFailure(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    request: protocol.Header,
    code_value: protocol.WireError,
) !void {
    var code_storage: [64]u8 = undefined;
    const tag = @tagName(code_value);
    const code = std.ascii.upperString(code_storage[0..tag.len], tag);
    const payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .code = code,
        .message = tag,
        .diagnosticId = @as(?[]const u8, null),
    }, .{});
    defer allocator.free(payload);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.error_payload,
        payload,
    )) return error.InvalidErrorPayload;
    const header: protocol.Header = .{
        .minor = if (protocol.minorSupported(request.minor))
            request.minor
        else
            generated.protocol_max_minor,
        .type_code = generated.frame_type.@"error",
        .flags = generated.frame_flag.response |
            generated.frame_flag.final |
            generated.frame_flag.error_flag,
        .payload_length = @intCast(payload.len),
        .request_id = request.request_id,
        .stream_seq = 0,
    };
    try protocol.writeFrame(stream, header, payload);
}

/// Host side of the inherited-fd milestone: boot bytes first, then a generated
/// HELLO/WELCOME and HOST_REGISTER/accepted exchange.
pub fn serveInheritedRegistration(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    registration: HostRegistration,
    host_build_id: []const u8,
    server_epoch: u64,
) !BootMessage {
    const file: std.fs.File = .{ .handle = stream.handle };
    var boot = try readBootMessage(allocator, file.deprecatedReader());
    errdefer boot.deinit(allocator);
    const broker_build_id = try serveRegistrationAfterBoot(
        allocator,
        stream,
        registration,
        host_build_id,
        server_epoch,
    );
    allocator.free(broker_build_id);
    return boot;
}

/// Completes registration after the host role has consumed the private boot
/// envelope and created the PTY/socket evidence named by HOST_REGISTER.
pub fn serveRegistrationAfterBoot(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    registration: HostRegistration,
    host_build_id: []const u8,
    server_epoch: u64,
) ![]u8 {
    var hello_frame = try readRequiredFrame(allocator, stream);
    defer hello_frame.deinit(allocator);
    if (hello_frame.header.type_code != generated.frame_type.hello or
        hello_frame.header.flags != 0 or
        !protocol.validateControlPayload(
            allocator,
            generated.wire_schema.hello_payload,
            hello_frame.payload,
        )) return error.InvalidHostHello;
    var hello = try std.json.parseFromSlice(WireHello, allocator, hello_frame.payload, .{
        .ignore_unknown_fields = true,
    });
    defer hello.deinit();
    if (hello.value.schemaVersion != 1 or
        hello.value.protocol.major != generated.protocol_major or
        hello.value.protocol.minMinor > generated.protocol_minor or
        hello.value.protocol.maxMinor < generated.protocol_minor or
        !std.mem.eql(u8, hello.value.clientRole, "broker") or
        !std.mem.eql(u8, hello.value.instanceId, registration.record.locator.instance_id))
        return error.InvalidHostHello;
    try writeHostWelcome(
        allocator,
        stream,
        hello_frame.header,
        registration,
        host_build_id,
        server_epoch,
    );

    const register = try encodeHostRegister(allocator, registration);
    defer allocator.free(register);
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.host_register,
        .flags = 0,
        .payload_length = @intCast(register.len),
        .request_id = 2,
        .stream_seq = 0,
    }, register);
    var accepted_frame = try readRequiredFrame(allocator, stream);
    defer accepted_frame.deinit(allocator);
    if (accepted_frame.header.type_code != generated.frame_type.host_register or
        accepted_frame.header.request_id != 2 or
        accepted_frame.header.flags != (generated.frame_flag.response | generated.frame_flag.final) or
        !protocol.validateControlPayload(
            allocator,
            generated.wire_schema.host_register_payload,
            accepted_frame.payload,
        )) return error.HostRegistrationRefused;
    const Accepted = struct { schemaVersion: u8, accepted: bool };
    var accepted = try std.json.parseFromSlice(Accepted, allocator, accepted_frame.payload, .{});
    defer accepted.deinit();
    if (accepted.value.schemaVersion != 1 or !accepted.value.accepted)
        return error.HostRegistrationRefused;
    return allocator.dupe(u8, hello.value.buildId);
}

pub const ParsedRegistration = struct {
    arena: std.heap.ArenaAllocator,
    registration: HostRegistration,
    record_json: []u8,
    created_payload: []u8,

    pub fn deinit(self: *ParsedRegistration, allocator: std.mem.Allocator) void {
        allocator.free(self.record_json);
        allocator.free(self.created_payload);
        self.arena.deinit();
        self.* = undefined;
    }
};

fn parseLocator(arena: std.mem.Allocator, wire: WireLocator) !broker.Locator {
    const subject: @FieldType(broker.Locator, "subject") = if (std.mem.eql(u8, wire.subject.kind, "root")) blk: {
        if (wire.subject.agentId != null) return error.InvalidHostRegister;
        break :blk .root;
    } else if (std.mem.eql(u8, wire.subject.kind, "agent"))
        .{ .agent = try arena.dupe(u8, wire.subject.agentId orelse return error.InvalidHostRegister) }
    else
        return error.InvalidHostRegister;
    return .{
        .instance_id = try arena.dupe(u8, wire.instanceId),
        .session_id = try arena.dupe(u8, wire.sessionId),
        .generation = wire.generation,
        .subject = subject,
        .host_kind = std.meta.stringToEnum(@FieldType(broker.Locator, "host_kind"), wire.hostKind) orelse
            return error.InvalidHostRegister,
        .engine_build_id = if (wire.engineBuildId) |engine| try arena.dupe(u8, engine) else null,
    };
}

fn parseRegistration(
    allocator: std.mem.Allocator,
    payload: []const u8,
) !ParsedRegistration {
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.host_register_payload,
        payload,
    )) return error.InvalidHostRegister;
    var parsed = try std.json.parseFromSlice(WireHostRegisterRequest, allocator, payload, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    if (parsed.value.schemaVersion != 1) return error.InvalidHostRegister;

    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const a = arena.allocator();
    const wire = parsed.value.record;
    // HostLaunchReadback uses this field as a validated remaining duration.
    // The broker replaces it with its own absolute monotonic deadline only
    // after Registry admission.
    const lease_remaining_ns = try validatedHostLeaseRemaining(wire.visibility.expiresAt);
    var registration: HostRegistration = .{
        .record = .{
            .locator = try parseLocator(a, wire.locator),
            .host_pid = wire.hostPid,
            .host_start_token = try a.dupe(u8, wire.hostStartToken),
            .process_root = .{
                .pid = wire.processRoot.pid,
                .start_token = try a.dupe(u8, wire.processRoot.startToken),
                .process_group_id = wire.processRoot.processGroupId,
            },
            .expected_executable = try a.dupe(u8, wire.expectedExecutable),
            .executable_build_hash = try a.dupe(u8, wire.executableBuildHash),
            .engine_build_id = try a.dupe(u8, wire.engineBuildId),
            .protocol_major = wire.protocol.major,
            .protocol_minor = wire.protocol.minor,
            .geometry = .{
                .columns = @intCast(wire.geometry.columns),
                .rows = @intCast(wire.geometry.rows),
                .width_px = wire.geometry.widthPx,
                .height_px = wire.geometry.heightPx,
                .cell_width_px = wire.geometry.cellWidthPx,
                .cell_height_px = wire.geometry.cellHeightPx,
            },
            .state = std.meta.stringToEnum(@FieldType(broker.HostRecord, "state"), wire.state) orelse
                return error.InvalidHostRegister,
            .visibility = .{
                .state = std.meta.stringToEnum(@FieldType(broker.Visibility, "state"), wire.visibility.state) orelse
                    return error.InvalidHostRegister,
                .workspace_session_id = try a.dupe(u8, wire.visibility.workspaceSessionId),
                .open_terminal_revision = try std.fmt.parseInt(
                    u64,
                    wire.visibility.openTerminalRevision,
                    10,
                ),
                .expires_mono_ns = lease_remaining_ns,
            },
            .output_seq = try std.fmt.parseInt(u64, wire.outputSeq, 10),
            .checkpoint_seq = try std.fmt.parseInt(u64, wire.checkpointSeq, 10),
        },
        .expires_at = try a.dupe(u8, wire.visibility.expiresAt),
        .created_at = try a.dupe(u8, wire.visibility.expiresAt),
        .checkpoint_available = false,
        .executable_verified = false,
        .complete = false,
    };
    var created_storage: [32]u8 = undefined;
    const created_at = try broker.wallDeadline(&created_storage, 0);
    registration.created_at = try a.dupe(u8, created_at);
    const record_json = try encodeRecordJson(allocator, registration);
    errdefer allocator.free(record_json);
    const created_payload = try encodeCreatedPayload(allocator, registration);
    return .{
        .arena = arena,
        .registration = registration,
        .record_json = record_json,
        .created_payload = created_payload,
    };
}

/// Launcher-side registration exchange. The host independently enforces its
/// own 15-second monotonic deadline.
const PendingRegistrationReadback = struct {
    parsed: ParsedRegistration,
    request_header: protocol.Header,
};

fn beginInheritedRegistration(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    spec_json: []const u8,
    initial_input: []const u8,
    adoption_secret: [32]u8,
    broker_build_id: []const u8,
    instance_id: []const u8,
) !PendingRegistrationReadback {
    try writeBootMessage(stream, spec_json, initial_input, adoption_secret);
    const hello = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .buildId = broker_build_id,
        .instanceId = instance_id,
        .protocol = .{
            .major = generated.protocol_major,
            .minMinor = generated.protocol_minor,
            .maxMinor = generated.protocol_minor,
        },
        .clientRole = "broker",
    }, .{});
    defer allocator.free(hello);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.hello_payload,
        hello,
    )) return error.InvalidBrokerHello;
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.hello,
        .flags = 0,
        .payload_length = @intCast(hello.len),
        .request_id = 1,
        .stream_seq = 0,
    }, hello);

    var welcome_frame = try readRequiredFrame(allocator, stream);
    defer welcome_frame.deinit(allocator);
    if (welcome_frame.header.type_code != generated.frame_type.welcome or
        welcome_frame.header.request_id != 1 or
        welcome_frame.header.flags != (generated.frame_flag.response | generated.frame_flag.final) or
        !protocol.validateControlPayload(
            allocator,
            generated.wire_schema.welcome_payload,
            welcome_frame.payload,
        )) return error.InvalidWelcome;
    var welcome = try std.json.parseFromSlice(WireWelcome, allocator, welcome_frame.payload, .{
        .ignore_unknown_fields = true,
    });
    defer welcome.deinit();
    if (welcome.value.schemaVersion != 1 or
        welcome.value.protocol.major != generated.protocol_major or
        welcome.value.protocol.minor != generated.protocol_minor or
        !std.mem.eql(u8, welcome.value.instanceId, instance_id) or
        !std.mem.eql(u8, welcome.value.endpointRole, "host"))
        return error.InvalidWelcome;

    var register_frame = try readRequiredFrame(allocator, stream);
    defer register_frame.deinit(allocator);
    if (register_frame.header.type_code != generated.frame_type.host_register or
        register_frame.header.flags != 0)
        return error.InvalidHostRegister;
    var result = try parseRegistration(allocator, register_frame.payload);
    errdefer result.deinit(allocator);
    if (!std.mem.eql(u8, result.registration.record.locator.instance_id, instance_id) or
        !std.mem.eql(u8, result.registration.record.executable_build_hash, welcome.value.buildId) or
        welcome.value.engineBuildId == null or
        !std.mem.eql(u8, result.registration.record.engine_build_id, welcome.value.engineBuildId.?))
        return error.InvalidHostRegister;

    return .{
        .parsed = result,
        .request_header = register_frame.header,
    };
}

fn acceptPendingRegistration(
    stream: std.net.Stream,
    request_header: protocol.Header,
) !void {
    const accepted = "{\"schemaVersion\":1,\"accepted\":true}";
    try protocol.writeFrame(
        stream,
        responseHeader(request_header, generated.frame_type.host_register, accepted.len),
        accepted,
    );
}

/// Compatibility helper for unit seams that admit immediately. The production
/// launcher retains the pending readback until broker Registry admission.
pub fn completeInheritedRegistration(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    spec_json: []const u8,
    initial_input: []const u8,
    adoption_secret: [32]u8,
    broker_build_id: []const u8,
    instance_id: []const u8,
) !ParsedRegistration {
    var pending = try beginInheritedRegistration(
        allocator,
        stream,
        spec_json,
        initial_input,
        adoption_secret,
        broker_build_id,
        instance_id,
    );
    errdefer pending.parsed.deinit(allocator);
    try acceptPendingRegistration(stream, pending.request_header);
    return pending.parsed;
}

const SpawnedHost = struct {
    pid: i32,
    stream: std.net.Stream,
};

fn closeHostInheritedDescriptors(descriptor_limit: c_int) void {
    var fd: c_int = inherited_control_fd + 1;
    while (fd < descriptor_limit) : (fd += 1) _ = c.close(fd);
}

/// The host child must never inherit the broker's dynamic-linker knobs: any
/// DYLD_* variable in the broker's environment would inject libraries into
/// the privileged host process at exec. Everything else passes through
/// unchanged so launch behavior matches the pre-scrub baseline. The result
/// borrows the live environ entries; only the array itself is owned.
fn scrubbedHostEnvironment(allocator: std.mem.Allocator) ![]?[*:0]const u8 {
    var kept: usize = 0;
    var index: usize = 0;
    while (std.c.environ[index]) |entry| : (index += 1) {
        if (!std.mem.startsWith(u8, std.mem.span(entry), "DYLD_")) kept += 1;
    }
    const scrubbed = try allocator.alloc(?[*:0]const u8, kept + 1);
    errdefer allocator.free(scrubbed);
    var out: usize = 0;
    index = 0;
    while (std.c.environ[index]) |entry| : (index += 1) {
        const text = std.mem.span(entry);
        if (std.mem.startsWith(u8, text, "DYLD_")) continue;
        scrubbed[out] = entry;
        out += 1;
    }
    scrubbed[out] = null;
    return scrubbed;
}

fn spawnHostProcess(allocator: std.mem.Allocator, executable: []const u8) !SpawnedHost {
    if (!std.fs.path.isAbsolute(executable)) return error.InvalidHostExecutable;
    const executable_z = try allocator.dupeZ(u8, executable);
    defer allocator.free(executable_z);
    const role_z = try allocator.dupeZ(u8, "host");
    defer allocator.free(role_z);
    const descriptor_limit = c.getdtablesize();
    if (descriptor_limit <= inherited_control_fd) return error.InvalidDescriptorLimit;
    const environment = try scrubbedHostEnvironment(allocator);
    defer allocator.free(environment);

    var sockets: [2]c_int = .{ -1, -1 };
    if (c.socketpair(c.AF_UNIX, c.SOCK_STREAM, 0, &sockets) != 0)
        return error.SocketPairFailed;
    errdefer {
        if (sockets[0] >= 0) _ = c.close(sockets[0]);
        if (sockets[1] >= 0) _ = c.close(sockets[1]);
    }

    const pid = c.fork();
    if (pid < 0) return error.HostForkFailed;
    if (pid == 0) {
        _ = c.close(sockets[0]);
        if (sockets[1] != inherited_control_fd) {
            if (c.dup2(sockets[1], inherited_control_fd) < 0) c._exit(126);
            _ = c.close(sockets[1]);
        }
        const descriptor_flags = c.fcntl(inherited_control_fd, c.F_GETFD);
        if (descriptor_flags < 0 or
            c.fcntl(inherited_control_fd, c.F_SETFD, descriptor_flags & ~c.FD_CLOEXEC) < 0)
            c._exit(126);
        // The host inherits exactly stdio plus fd 3. Retaining the broker's
        // listener or lock descriptors would prevent clean crash recovery.
        closeHostInheritedDescriptors(descriptor_limit);
        const argv = [_:null]?[*:0]const u8{ executable_z.ptr, role_z.ptr };
        _ = c.execve(executable_z.ptr, @ptrCast(&argv), @ptrCast(environment.ptr));
        c._exit(127);
    }

    _ = c.close(sockets[1]);
    sockets[1] = -1;
    return .{
        .pid = @intCast(pid),
        .stream = .{ .handle = sockets[0] },
    };
}

fn killAndWait(pid: i32) void {
    if (pid <= 0) return;
    _ = c.kill(pid, c.SIGKILL);
    var status: c_int = 0;
    while (true) {
        const waited = c.waitpid(pid, &status, 0);
        if (waited == pid) return;
        if (waited >= 0) continue;
        switch (std.posix.errno(waited)) {
            .INTR => continue,
            .CHILD => return,
            else => return,
        }
    }
}

fn waitForChildExit(pid: i32, timeout_ns: u64) bool {
    var timer = std.time.Timer.start() catch return false;
    while (true) {
        var status: c_int = 0;
        const waited = c.waitpid(pid, &status, c.WNOHANG);
        if (waited == pid) return true;
        if (waited < 0) switch (std.posix.errno(waited)) {
            .INTR => continue,
            .CHILD => return true,
            else => return false,
        };
        if (timer.read() >= timeout_ns) return false;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

fn setControlTimeoutMs(fd: std.posix.fd_t, timeout_ms: u64) !void {
    if (timeout_ms == 0) return error.InvalidControlTimeout;
    const timeout: c.struct_timeval = .{
        .tv_sec = @intCast(timeout_ms / std.time.ms_per_s),
        .tv_usec = @intCast(
            (timeout_ms % std.time.ms_per_s) * std.time.us_per_ms,
        ),
    };
    if (c.setsockopt(fd, c.SOL_SOCKET, c.SO_RCVTIMEO, &timeout, @sizeOf(c.struct_timeval)) != 0 or
        c.setsockopt(fd, c.SOL_SOCKET, c.SO_SNDTIMEO, &timeout, @sizeOf(c.struct_timeval)) != 0)
        return error.ControlTimeoutUnavailable;
}

fn setControlTimeout(fd: std.posix.fd_t) !void {
    return setControlTimeoutMs(fd, generated.limits.control_rpc_timeout_ms);
}

/// Absolute monotonic bound on one accepted connection's cumulative service
/// time. SO_RCVTIMEO bounds each individual syscall, but a peer dribbling one
/// byte per syscall window would otherwise hold the single-threaded host loop
/// — and starve the broker's VISIBILITY_RENEW until the §21 lease self-
/// terminates the session. The budget is the same lease-bound window the
/// accept path grants a single syscall; exhausting it drops the connection
/// (fail closed) so the loop always regains control within a bounded time.
const ConnectionDeadline = struct {
    timer: *std.time.Timer,
    start_ns: u64,
    budget_ns: u64,

    fn init(timer: *std.time.Timer, lease: VisibilityLease, now_ns: u64) !ConnectionDeadline {
        const timeout_ms = try leaseBoundControlTimeoutMs(lease, now_ns);
        return .{
            .timer = timer,
            .start_ns = timer.read(),
            .budget_ns = try std.math.mul(u64, timeout_ms, std.time.ns_per_ms),
        };
    }

    fn elapsedNs(self: *const ConnectionDeadline) u64 {
        const now = self.timer.read();
        if (now <= self.start_ns) return 0;
        return now - self.start_ns;
    }

    fn remainingMs(self: *const ConnectionDeadline) !u64 {
        const elapsed = self.elapsedNs();
        if (elapsed >= self.budget_ns) return error.ConnectionDeadlineExceeded;
        return std.math.divCeil(u64, self.budget_ns - elapsed, std.time.ns_per_ms) catch
            return error.ConnectionDeadlineExceeded;
    }

    /// Re-arms the per-syscall socket timeout at the remaining budget so the
    /// next blocking read/write cannot outlive the absolute deadline.
    fn rearm(self: *const ConnectionDeadline, handle: std.posix.fd_t) !void {
        try setControlTimeoutMs(handle, try self.remainingMs());
    }

    fn check(self: *const ConnectionDeadline) !void {
        _ = try self.remainingMs();
    }
};

/// One bounded frame read: the socket timeout is re-armed at the deadline's
/// remaining budget before the blocking read, and the deadline is verified
/// after it, so no sequence of dribbled syscalls outlives the budget.
fn readConnectionFrame(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    deadline: *const ConnectionDeadline,
) !protocol.Frame {
    try deadline.rearm(stream.handle);
    const frame = try readRequiredFrame(allocator, stream);
    try deadline.check();
    return frame;
}

/// Applies the lease-bound control timeout to one accepted host connection.
/// Returns false on any per-connection setup failure (lease-timeout race,
/// setsockopt on a reset/invalid socket) so the caller drops that connection
/// and keeps serving; it never surfaces a fatal error that would tear down
/// the whole host on a single bad connection.
fn acceptedConnectionReady(lease: VisibilityLease, handle: std.posix.fd_t, now_ns: u64) bool {
    const timeout_ms = leaseBoundControlTimeoutMs(lease, now_ns) catch return false;
    setControlTimeoutMs(handle, timeout_ms) catch return false;
    return true;
}

test "accepted-connection setup drops a bad socket without a fatal error" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    var timer = try std.time.Timer.start();
    const now = timer.read();
    const lease = try VisibilityLease.initial("ws-fixture", 1, now);

    // A valid, un-expired lease + a real socket: the control timeout applies
    // and the connection is ready to serve.
    const good = try std.posix.socket(std.posix.AF.UNIX, std.posix.SOCK.STREAM, 0);
    try std.testing.expect(acceptedConnectionReady(lease, good, now));

    // The same fd, now closed, makes setsockopt fail (EBADF). The setup must
    // report NOT ready (drop this one connection) rather than surfacing a
    // fatal error that the host loop would let tear the whole host down.
    std.posix.close(good);
    try std.testing.expect(!acceptedConnectionReady(lease, good, now));
}

fn leaseBoundControlTimeoutMs(lease: VisibilityLease, now_ns: u64) !u64 {
    if (now_ns >= lease.expires_mono_ns) return error.VisibilityExpired;
    const remaining_ms = try std.math.divCeil(
        u64,
        lease.expires_mono_ns - now_ns,
        std.time.ns_per_ms,
    );
    return @min(remaining_ms, generated.limits.control_rpc_timeout_ms);
}

fn socketEvidenceAt(directory: std.fs.Dir, name: []const u8) !broker.SocketEvidence {
    const stat = try std.posix.fstatat(directory.fd, name, std.posix.AT.SYMLINK_NOFOLLOW);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFSOCK or
        stat.mode & 0o777 != 0o600)
        return error.SocketSubstitution;
    return .{
        .device = @intCast(stat.dev),
        .inode = @intCast(stat.ino),
        .owner_uid = @intCast(stat.uid),
        .mode = @intCast(stat.mode & 0o777),
    };
}

fn requireOwnedDirectory(directory: std.fs.Dir, mode: ?u16) !void {
    const stat = try std.posix.fstat(directory.fd);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFDIR)
        return error.DirectorySubstitution;
    if (mode) |expected| if (stat.mode & 0o777 != expected)
        return error.DirectorySubstitution;
}

fn readAndVerifyAdoptionSecret(
    directory: std.fs.Dir,
    expected: [32]u8,
) !void {
    const fd = try std.posix.openat(directory.fd, "adopt.cap", .{
        .NOFOLLOW = true,
        .CLOEXEC = true,
    }, 0);
    const file: std.fs.File = .{ .handle = fd };
    defer file.close();
    const stat = try std.posix.fstat(fd);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFREG or
        stat.mode & 0o777 != 0o600)
        return error.SecretSubstitution;
    var actual: [32]u8 = undefined;
    defer std.crypto.secureZero(u8, &actual);
    if (try file.readAll(&actual) != actual.len) return error.InvalidAdoptionSecret;
    var extra: [1]u8 = undefined;
    if (try file.read(&extra) != 0) return error.InvalidAdoptionSecret;
    if (!std.crypto.timing_safe.eql([32]u8, actual, expected))
        return error.SecretSubstitution;
}

pub const HostRuntime = struct {
    allocator: std.mem.Allocator,
    canonical_home: []u8,
    directory: std.fs.Dir,
    socket_path: []u8,
    server: std.net.Server,
    socket_evidence: broker.SocketEvidence,

    pub fn open(
        allocator: std.mem.Allocator,
        hive_home: []const u8,
        session_id: []const u8,
        adoption_secret: [32]u8,
    ) !HostRuntime {
        if (!protocol.validSessionId(session_id)) return error.InvalidSessionId;
        const canonical_home = try std.fs.cwd().realpathAlloc(allocator, hive_home);
        errdefer allocator.free(canonical_home);
        var home = try std.fs.cwd().openDir(canonical_home, .{ .no_follow = true });
        defer home.close();
        var runtime = try home.openDir("runtime", .{ .no_follow = true });
        defer runtime.close();
        // The broker owns `$HIVE_HOME/runtime`; the private authority boundary
        // begins at runtime/sessiond, which is mode 0700.
        try requireOwnedDirectory(runtime, null);
        var sessiond = try runtime.openDir("sessiond", .{ .no_follow = true });
        defer sessiond.close();
        try requireOwnedDirectory(sessiond, 0o700);
        var hosts = try sessiond.openDir("hosts", .{ .no_follow = true });
        defer hosts.close();
        try requireOwnedDirectory(hosts, 0o700);
        var directory = try hosts.openDir(session_id, .{ .no_follow = true, .iterate = true });
        errdefer directory.close();
        try requireOwnedDirectory(directory, 0o700);
        try readAndVerifyAdoptionSecret(directory, adoption_secret);
        _ = std.posix.fstatat(
            directory.fd,
            "host.sock",
            std.posix.AT.SYMLINK_NOFOLLOW,
        ) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return error.SocketSubstitution,
        };

        const socket_path = try std.fs.path.join(allocator, &.{
            canonical_home,
            "runtime/sessiond/hosts",
            session_id,
            "host.sock",
        });
        errdefer allocator.free(socket_path);
        const address = try std.net.Address.initUnix(socket_path);
        // host.sock's 0600 mode is fixed atomically at bind() through a
        // saved/restored umask: 0177 masks exactly group/other (and the
        // owner-execute bit) off the 0777 bind base. A post-bind path chmod
        // both follows symlinks and leaves the socket briefly permissive, so
        // no path-based chmod remains — socketEvidenceAt below is the fstat
        // proof of the mode the socket was born with.
        const saved_umask = c.umask(0o177);
        const listen_result = address.listen(.{});
        _ = c.umask(saved_umask);
        var server = try listen_result;
        errdefer server.deinit();
        const evidence = try socketEvidenceAt(directory, "host.sock");
        const flags = c.fcntl(server.stream.handle, c.F_GETFL);
        if (flags < 0 or c.fcntl(server.stream.handle, c.F_SETFL, flags | c.O_NONBLOCK) < 0)
            return error.SocketNonBlockingFailed;
        return .{
            .allocator = allocator,
            .canonical_home = canonical_home,
            .directory = directory,
            .socket_path = socket_path,
            .server = server,
            .socket_evidence = evidence,
        };
    }

    pub fn deinit(self: *HostRuntime) void {
        self.server.deinit();
        if (socketEvidenceAt(self.directory, "host.sock")) |current| {
            if (std.meta.eql(current, self.socket_evidence))
                self.directory.deleteFile("host.sock") catch {};
        } else |_| {}
        self.directory.close();
        self.allocator.free(self.socket_path);
        self.allocator.free(self.canonical_home);
        self.* = undefined;
    }

    pub fn accept(self: *HostRuntime) !?std.net.Stream {
        if (!std.meta.eql(
            self.socket_evidence,
            try socketEvidenceAt(self.directory, "host.sock"),
        )) return error.SocketSubstitution;
        const connection = self.server.accept() catch |err| switch (err) {
            error.WouldBlock => return null,
            else => return err,
        };
        errdefer connection.stream.close();
        // The listener is nonblocking so the PTY/lease loop can make
        // progress. Darwin propagates that state to accepted descriptors;
        // broker RPCs use the generated SO_RCVTIMEO bound and must block
        // while a complete frame arrives.
        const flags = c.fcntl(connection.stream.handle, c.F_GETFL);
        if (flags < 0 or
            c.fcntl(connection.stream.handle, c.F_SETFL, flags & ~@as(c_int, c.O_NONBLOCK)) < 0)
            return error.SocketBlockingFailed;
        if (!std.meta.eql(
            self.socket_evidence,
            try socketEvidenceAt(self.directory, "host.sock"),
        )) return error.SocketSubstitution;
        return connection.stream;
    }
};

fn executableBuildHash(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const file = try std.fs.openFileAbsolute(path, .{});
    defer file.close();
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var storage: [16 * 1024]u8 = undefined;
    while (true) {
        const count = try file.read(&storage);
        if (count == 0) break;
        hasher.update(storage[0..count]);
    }
    const digest = hasher.finalResult();
    const hex = std.fmt.bytesToHex(digest, .lower);
    return allocator.dupe(u8, &hex);
}

const LaunchClient = struct {
    allocator: std.mem.Allocator,
    parsed: ParsedRegistration,
    wire: broker.WireHostClient,
    host_pid: i32,
    /// Retained so finalize can prove THIS broker owns the freshly admitted
    /// host (the host fails closed for privileged RPCs until HOST_ADOPT).
    /// Zeroed on every teardown path.
    adoption_secret: [32]u8,
    pending_id: ?broker.PendingRegistration,
    pending_stream: ?std.net.Stream,
    pending_header: protocol.Header,

    fn deinit(self: *LaunchClient) void {
        if (self.pending_stream) |stream| {
            stream.close();
            killAndWait(self.host_pid);
        }
        // Closing broker control must not kill a successfully registered host.
        // The host's independent visibility lease owns broker-crash cleanup.
        self.wire.deinit();
        self.parsed.deinit(self.allocator);
        std.crypto.secureZero(u8, &self.adoption_secret);
        self.* = undefined;
    }

    fn control(self: *LaunchClient) broker.HostControl {
        return self.wire.control();
    }
};

/// Production WP3 HostLauncher injection. It forks and execs the exact
/// executable argument in `host` role and transfers all sensitive boot state
/// only through fd 3. The launcher owns returned HostControl contexts.
pub const ProductionHostLauncher = struct {
    allocator: std.mem.Allocator,
    canonical_home: []u8,
    next_pending_id: broker.PendingRegistration = 1,
    clients: std.ArrayList(*LaunchClient) = .{},

    pub fn init(
        allocator: std.mem.Allocator,
        hive_home: []const u8,
    ) !ProductionHostLauncher {
        return .{
            .allocator = allocator,
            .canonical_home = try std.fs.cwd().realpathAlloc(allocator, hive_home),
        };
    }

    pub fn deinit(self: *ProductionHostLauncher) void {
        for (self.clients.items) |client| {
            client.deinit();
            self.allocator.destroy(client);
        }
        self.clients.deinit(self.allocator);
        self.allocator.free(self.canonical_home);
        self.* = undefined;
    }

    pub fn launcher(self: *ProductionHostLauncher) broker.HostLauncher {
        return .{
            .context = self,
            .launch_fn = launchCallback,
            .finalize_fn = finalizeCallback,
        };
    }

    fn launchCallback(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        executable: []const u8,
        spec_json: []const u8,
        initial_input: []const u8,
        adoption_secret: [32]u8,
        broker_now_ns: u64,
    ) ?broker.HostLaunchReadback {
        // This value is intentionally non-authoritative in the host process's
        // independent monotonic clock domain.
        _ = broker_now_ns;
        const self: *ProductionHostLauncher = @ptrCast(@alignCast(context));
        return self.launchOne(
            allocator,
            executable,
            spec_json,
            initial_input,
            adoption_secret,
        ) catch |err| {
            std.log.err("production host launch failed: {s}; broker will report verification_unknown", .{
                @errorName(err),
            });
            return null;
        };
    }

    fn launchOne(
        self: *ProductionHostLauncher,
        allocator: std.mem.Allocator,
        executable: []const u8,
        spec_json: []const u8,
        initial_input: []const u8,
        adoption_secret: [32]u8,
    ) !broker.HostLaunchReadback {
        if (!protocol.validateControlPayload(
            allocator,
            generated.wire_schema.create_begin_payload,
            spec_json,
        )) return error.InvalidCreateSpec;
        const SpecProjection = struct { locator: WireLocator };
        var spec = try std.json.parseFromSlice(SpecProjection, allocator, spec_json, .{
            .ignore_unknown_fields = true,
        });
        defer spec.deinit();
        const instance_id = spec.value.locator.instanceId;
        const build_id = try executableBuildHash(allocator, executable);
        defer allocator.free(build_id);

        var child = try spawnHostProcess(allocator, executable);
        var child_owned = true;
        errdefer if (child_owned) killAndWait(child.pid);
        var stream_owned = true;
        errdefer if (stream_owned) child.stream.close();
        try setControlTimeout(child.stream.handle);
        var pending = try beginInheritedRegistration(
            allocator,
            child.stream,
            spec_json,
            initial_input,
            adoption_secret,
            build_id,
            instance_id,
        );
        var parsed_owned = true;
        errdefer if (parsed_owned) pending.parsed.deinit(allocator);
        if (pending.parsed.registration.record.host_pid != child.pid or
            !std.mem.eql(u8, pending.parsed.registration.record.locator.session_id, spec.value.locator.sessionId))
            return error.HostIdentityMismatch;
        const observed = try broker.inspectProcess(child.pid);
        var token_storage: [64]u8 = undefined;
        const token = try broker.formatStartToken(observed.start_token, &token_storage);
        if (!std.mem.eql(u8, token, pending.parsed.registration.record.host_start_token) or
            !std.mem.eql(u8, observed.executablePath(), executable))
            return error.HostIdentityMismatch;

        const host_directory_path = try std.fs.path.join(allocator, &.{
            self.canonical_home,
            "runtime/sessiond/hosts",
            spec.value.locator.sessionId,
        });
        defer allocator.free(host_directory_path);
        var host_directory = try std.fs.openDirAbsolute(host_directory_path, .{
            .no_follow = true,
        });
        defer host_directory.close();
        try requireOwnedDirectory(host_directory, 0o700);
        const socket_evidence = try socketEvidenceAt(host_directory, "host.sock");
        const socket_path = try std.fs.path.join(allocator, &.{
            host_directory_path,
            "host.sock",
        });
        defer allocator.free(socket_path);
        var wire = try broker.WireHostClient.init(
            allocator,
            host_directory,
            socket_path,
            socket_evidence,
            pending.parsed.registration.record,
            build_id,
        );
        errdefer wire.deinit();
        try wire.enableNeutralControl(self.canonical_home);
        const created_payload = try allocator.dupe(u8, pending.parsed.created_payload);
        errdefer allocator.free(created_payload);

        const pending_id = self.next_pending_id;
        self.next_pending_id = std.math.add(
            broker.PendingRegistration,
            pending_id,
            1,
        ) catch return error.PendingRegistrationExhausted;

        const client = try self.allocator.create(LaunchClient);
        errdefer self.allocator.destroy(client);
        client.* = .{
            .allocator = allocator,
            .parsed = pending.parsed,
            .wire = wire,
            .host_pid = child.pid,
            .adoption_secret = adoption_secret,
            .pending_id = pending_id,
            .pending_stream = child.stream,
            .pending_header = pending.request_header,
        };
        try self.clients.append(self.allocator, client);
        parsed_owned = false;
        child_owned = false;
        stream_owned = false;
        return .{
            .record = client.parsed.registration.record,
            .record_json = client.parsed.record_json,
            .created_payload = created_payload,
            .host = client.control(),
            .pending = pending_id,
        };
    }

    fn finalizeCallback(
        context: *anyopaque,
        pending: broker.PendingRegistration,
        decision: broker.HostLaunchDecision,
    ) bool {
        const self: *ProductionHostLauncher = @ptrCast(@alignCast(context));
        return self.finalizeOne(pending, decision) catch false;
    }

    fn finalizeOne(
        self: *ProductionHostLauncher,
        pending: broker.PendingRegistration,
        decision: broker.HostLaunchDecision,
    ) !bool {
        var index: usize = 0;
        while (index < self.clients.items.len) : (index += 1) {
            if (self.clients.items[index].pending_id == pending) break;
        }
        if (index == self.clients.items.len) return false;
        const client = self.clients.items[index];
        const stream = client.pending_stream orelse return false;
        client.pending_id = null;
        client.pending_stream = null;

        switch (decision) {
            .admitted => {
                acceptPendingRegistration(stream, client.pending_header) catch {
                    stream.close();
                    killAndWait(client.host_pid);
                    _ = self.clients.orderedRemove(index);
                    client.deinit();
                    self.allocator.destroy(client);
                    return false;
                };
                stream.close();
                // Admission is final, so the host now serves host.sock — but
                // it fails closed for terminate/grant_register/
                // visibility_renew until HOST_ADOPT proves the 32-byte secret.
                // Adopt immediately so the legit fresh-launch flow keeps
                // working; a host that refuses adoption is not the host this
                // broker launched and must not stay registered. The readback
                // is discarded, so its now_ns input is irrelevant (0).
                if (client.control().adopt(
                    client.parsed.registration.record.locator,
                    client.adoption_secret,
                    0,
                ) == null) {
                    killAndWait(client.host_pid);
                    _ = self.clients.orderedRemove(index);
                    client.deinit();
                    self.allocator.destroy(client);
                    return false;
                }
                return true;
            },
            .rejected => |code| {
                const wrote_rejection = blk: {
                    writeHostFailure(
                        client.allocator,
                        stream,
                        client.pending_header,
                        code,
                    ) catch break :blk false;
                    break :blk true;
                };
                stream.close();
                const exited_cleanly = waitForChildExit(
                    client.host_pid,
                    generated.limits.control_rpc_timeout_ms * std.time.ns_per_ms,
                );
                if (!exited_cleanly) killAndWait(client.host_pid);
                _ = self.clients.orderedRemove(index);
                client.deinit();
                self.allocator.destroy(client);
                return wrote_rejection and exited_cleanly;
            },
        }
    }
};

fn sameLocator(left: broker.Locator, right: broker.Locator) bool {
    if (left.generation != right.generation or
        !std.mem.eql(u8, left.instance_id, right.instance_id) or
        !std.mem.eql(u8, left.session_id, right.session_id) or
        left.host_kind != right.host_kind or
        std.meta.activeTag(left.subject) != std.meta.activeTag(right.subject))
        return false;
    switch (left.subject) {
        .root => {},
        .agent => |agent_id| if (!std.mem.eql(u8, agent_id, right.subject.agent)) return false,
    }
    if (left.engine_build_id == null or right.engine_build_id == null)
        return left.engine_build_id == null and right.engine_build_id == null;
    return std.mem.eql(u8, left.engine_build_id.?, right.engine_build_id.?);
}

const WireHostAdoptChallenge = struct {
    schemaVersion: u8,
    adoptionSecretHex: []const u8,
    expectedLocator: WireLocator,
    brokerBuildId: []const u8,
    protocol: struct { major: u8, minor: u8 },
    operation: []const u8,
};

const WireGrantRegistration = struct {
    schemaVersion: u8,
    grantTokenSha256: []const u8,
    viewerId: []const u8,
    operations: []const []const u8,
    expiresAt: []const u8,
    geometry: WireGeometry,
};

const WireHostAttach = struct {
    schemaVersion: u8,
    locator: WireLocator,
    token: []const u8,
    geometry: WireGeometry,
    afterSeq: []const u8,
};

const WireVisibilityRenew = struct {
    schemaVersion: u8,
    locator: WireLocator,
    workspaceSessionId: []const u8,
    workspacePid: i32,
    workspaceStartToken: []const u8,
    openTerminalRevision: []const u8,
};

const WireOrphanDiscard = struct {
    schemaVersion: u8,
    locator: WireLocator,
};

const WireTerminalSessionRef = struct {
    key: []const u8,
    incarnation: []const u8,
};

const WireTerminate = struct {
    schemaVersion: u8,
    session: WireTerminalSessionRef,
    mode: []const u8,
    target: []const u8,
    deadline: []const u8,
    idempotencyKey: []const u8,
};

const WireClaimAcquire = struct {
    schemaVersion: u8,
    session: WireTerminalSessionRef,
    writer: []const u8,
    kind: []const u8,
    leaseMilliseconds: u64,
    idempotencyKey: []const u8,
};

/// CLAIM_RELEASE has a frame type but no frozen payload schema yet — host
/// accepts this minimal shape (token + submit|cancel). Encoded release bytes
/// for submit are optional; cancel uses empty encoding (arbiter accepts).
const WireClaimRelease = struct {
    schemaVersion: u8,
    session: WireTerminalSessionRef,
    claimToken: []const u8,
    kind: []const u8,
};

const WireInputOperation = struct {
    kind: []const u8,
    encoding: ?[]const u8 = null,
    bytes: ?[]const u8 = null,
};

const WireInputSubmit = struct {
    schemaVersion: u8,
    session: WireTerminalSessionRef,
    claimToken: []const u8,
    transactionId: []const u8,
    idempotencyKey: []const u8,
    operation: WireInputOperation,
};

const WireTerminalWindow = struct {
    columns: u32,
    rows: u32,
    widthPixels: u32,
    heightPixels: u32,
};

const WireResize = struct {
    schemaVersion: u8,
    session: WireTerminalSessionRef,
    window: WireTerminalWindow,
    revision: []const u8,
    idempotencyKey: []const u8,
};

const GrantOperations = packed struct {
    view: bool = false,
    human_input: bool = false,
    resize: bool = false,
};

const GrantEntry = struct {
    hash: [32]u8,
    viewer_id: []u8,
    operations: GrantOperations,
    geometry: broker.Geometry,
    expires_mono_ns: u64,

    fn deinit(self: *GrantEntry, allocator: std.mem.Allocator) void {
        allocator.free(self.viewer_id);
        std.crypto.secureZero(u8, &self.hash);
        self.* = undefined;
    }
};

pub const ViewerAuthorization = struct {
    viewer_id: []u8,
    operations: GrantOperations,
    geometry: broker.Geometry,
    after_seq: u64,

    pub fn deinit(self: *ViewerAuthorization, allocator: std.mem.Allocator) void {
        allocator.free(self.viewer_id);
        self.* = undefined;
    }
};

fn sameGeometry(left: broker.Geometry, right: WireGeometry) bool {
    return left.columns == right.columns and
        left.rows == right.rows and
        left.width_px == right.widthPx and
        left.height_px == right.heightPx and
        left.cell_width_px == right.cellWidthPx and
        left.cell_height_px == right.cellHeightPx;
}

pub const TerminationBinding = struct {
    pty: *pty_host.PtyHost,
    directory: std.fs.Dir,
    arbiter: ?*input_arbiter.InputArbiter = null,
    /// Optional provider-adapter bytes. No current SessionSpec supplies them;
    /// absence intentionally degrades to TERM-first rather than fabrication.
    graceful_action: ?[]const u8 = null,
};

const ProviderTermination = struct {
    tree: process_inspector.TerminationResult,
    exit: pty_host.ExitEvidence,
    arbiter_error: ?[]const u8 = null,
    graceful_action_error: ?[]const u8 = null,

    fn deinit(self: *ProviderTermination, allocator: std.mem.Allocator) void {
        self.tree.deinit(allocator);
        self.* = undefined;
    }
};

/// Routes root-child waits through PtyHost so tree termination cannot consume
/// the wait status without recording it in the terminal-host exit evidence.
const ProviderTerminationPlatform = struct {
    delegate: process_inspector.Platform,
    pty: *pty_host.PtyHost,
    root_pid: i32,
    root_exit: ?pty_host.ExitEvidence = null,

    fn platform(self: *ProviderTerminationPlatform) process_inspector.Platform {
        return .{
            .context = self,
            .monoNowFn = monoNow,
            .sleepFn = sleep,
            .killFn = kill,
            .observeFn = observe,
            .waitNoHangFn = waitNoHang,
            .listChildrenFn = listChildren,
        };
    }

    fn monoNow(context: *anyopaque) u64 {
        const self: *ProviderTerminationPlatform = @ptrCast(@alignCast(context));
        return self.delegate.monoNow();
    }

    fn sleep(context: *anyopaque, ns: u64) void {
        const self: *ProviderTerminationPlatform = @ptrCast(@alignCast(context));
        self.delegate.sleep(ns);
    }

    fn kill(context: *anyopaque, pid: i32, signal: i32) bool {
        const self: *ProviderTerminationPlatform = @ptrCast(@alignCast(context));
        return self.delegate.kill(pid, signal);
    }

    fn observe(context: *anyopaque, pid: i32) process_inspector.ObserveResult {
        const self: *ProviderTerminationPlatform = @ptrCast(@alignCast(context));
        return self.delegate.observe(pid);
    }

    fn waitNoHang(context: *anyopaque, pid: i32) bool {
        const self: *ProviderTerminationPlatform = @ptrCast(@alignCast(context));
        if (pid != self.root_pid) return self.delegate.waitNoHang(pid);
        if (self.root_exit) |exit| {
            if (exit.reaped) return true;
        }
        const exit = self.pty.waitExit(false) catch {
            self.root_exit = .{
                .authority = .unavailable,
                .state = .unknown,
                .reaped = false,
            };
            return false;
        };
        self.root_exit = exit;
        return exit.reaped;
    }

    fn listChildren(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        pid: i32,
    ) anyerror![]i32 {
        const self: *ProviderTerminationPlatform = @ptrCast(@alignCast(context));
        return self.delegate.listChildren(allocator, pid);
    }

    fn finishExit(self: *ProviderTerminationPlatform, hang: bool) pty_host.ExitEvidence {
        if (self.root_exit) |exit| {
            if (exit.reaped) return exit;
        }
        const exit = self.pty.waitExit(hang) catch return .{
            .authority = .unavailable,
            .state = .unknown,
            .reaped = false,
        };
        self.root_exit = exit;
        return exit;
    }
};

fn deliverGracefulAction(binding: TerminationBinding) !void {
    const bytes = binding.graceful_action orelse return;
    if (bytes.len == 0) return;
    _ = try binding.pty.writeAccept(bytes);
    while (true) {
        const count = try binding.pty.writeDrain();
        if (count == 0) return;
    }
}

fn parseStartToken(value: []const u8) !process_inspector.StartToken {
    const colon = std.mem.indexOfScalar(u8, value, ':') orelse
        return error.InvalidStartToken;
    if (colon == 0 or colon + 1 >= value.len or
        std.mem.indexOfScalarPos(u8, value, colon + 1, ':') != null)
        return error.InvalidStartToken;
    return .{
        .seconds = try std.fmt.parseInt(u64, value[0..colon], 10),
        .microseconds = try std.fmt.parseInt(u64, value[colon + 1 ..], 10),
    };
}

fn terminateProvider(
    allocator: std.mem.Allocator,
    binding: TerminationBinding,
    root: broker.ProcessRoot,
    mode: process_inspector.TerminationMode,
    visibility_expired: bool,
) !ProviderTermination {
    var arbiter_error: ?[]const u8 = null;
    if (binding.arbiter) |arbiter| {
        if (visibility_expired)
            arbiter.onVisibilityLeaseExpired() catch |err| {
                arbiter_error = @errorName(err);
            }
        else
            arbiter.terminate() catch |err| {
                arbiter_error = @errorName(err);
            };
    }
    var graceful_action_error: ?[]const u8 = null;
    if (mode == .graceful and binding.graceful_action != null) {
        deliverGracefulAction(binding) catch |err| {
            graceful_action_error = @errorName(err);
        };
    }
    var real_platform = process_inspector.RealPlatform.init();
    var termination_platform: ProviderTerminationPlatform = .{
        .delegate = real_platform.platform(),
        .pty = binding.pty,
        .root_pid = root.pid,
    };
    var tree = try process_inspector.terminateTree(
        termination_platform.platform(),
        allocator,
        root.pid,
        try parseStartToken(root.start_token),
        mode,
    );
    errdefer tree.deinit(allocator);
    binding.pty.closeMaster();
    const exit = termination_platform.finishExit(tree.state == .terminated);
    return .{
        .tree = tree,
        .exit = exit,
        .arbiter_error = arbiter_error,
        .graceful_action_error = graceful_action_error,
    };
}

fn leapYearsThrough(year: u64) u64 {
    return year / 4 - year / 100 + year / 400;
}

fn wallTimestampMillis(value: []const u8) !u64 {
    if (value.len != 24 or value[4] != '-' or value[7] != '-' or value[10] != 'T' or
        value[13] != ':' or value[16] != ':' or value[19] != '.' or value[23] != 'Z')
        return error.InvalidTimestamp;
    const year = try std.fmt.parseInt(u64, value[0..4], 10);
    const month = try std.fmt.parseInt(u8, value[5..7], 10);
    const day = try std.fmt.parseInt(u8, value[8..10], 10);
    const hour = try std.fmt.parseInt(u8, value[11..13], 10);
    const minute = try std.fmt.parseInt(u8, value[14..16], 10);
    const second = try std.fmt.parseInt(u8, value[17..19], 10);
    const millisecond = try std.fmt.parseInt(u16, value[20..23], 10);
    if (year < 1970 or month == 0 or month > 12 or day == 0 or hour > 23 or
        minute > 59 or second > 59)
        return error.InvalidTimestamp;
    const leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0);
    const month_days = [_]u8{ 31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    if (day > month_days[month - 1]) return error.InvalidTimestamp;
    var days = (year - 1970) * 365 + leapYearsThrough(year - 1) - leapYearsThrough(1969);
    for (month_days[0 .. month - 1]) |count| days += count;
    days += day - 1;
    const seconds = try std.math.add(
        u64,
        try std.math.mul(u64, days, std.time.s_per_day),
        @as(u64, hour) * std.time.s_per_hour + @as(u64, minute) * std.time.s_per_min + second,
    );
    return std.math.add(
        u64,
        try std.math.mul(u64, seconds, std.time.ms_per_s),
        millisecond,
    );
}

fn wallExpiryToMonotonic(value: []const u8, now_ns: u64, maximum_ms: u64) !u64 {
    const deadline_ms = try wallTimestampMillis(value);
    const wall_now = std.time.milliTimestamp();
    if (wall_now < 0 or deadline_ms <= @as(u64, @intCast(wall_now)))
        return error.Expired;
    const remaining_ms = deadline_ms - @as(u64, @intCast(wall_now));
    if (remaining_ms > maximum_ms) return error.InvalidTimestamp;
    return std.math.add(
        u64,
        now_ns,
        try std.math.mul(u64, remaining_ms, std.time.ns_per_ms),
    );
}

fn validatedHostLeaseRemaining(expires_at: []const u8) !u64 {
    return wallExpiryToMonotonic(
        expires_at,
        0,
        generated.limits.visibility_expiry_ms,
    );
}

const ActiveInputClaim = struct {
    token: []u8,
    writer: []u8,
    kind: []u8,
    idempotency_key: []u8,
    owner_viewer_id: []u8,
    lease_expires_at: []u8,
    expires_mono_ns: u64,
    next_sequence: u64,

    fn deinit(self: *ActiveInputClaim, allocator: std.mem.Allocator) void {
        allocator.free(self.token);
        allocator.free(self.writer);
        allocator.free(self.kind);
        allocator.free(self.idempotency_key);
        allocator.free(self.owner_viewer_id);
        allocator.free(self.lease_expires_at);
        self.* = undefined;
    }
};

const InputOperationKind = enum { bytes, canonical_eof, hangup };

/// Replay ledgers are bounded FIFOs, sized like the file's other
/// generated-limits-style caps: past the cap the oldest entry evicts before
/// the new one reserves, so unique client-chosen idempotency keys can never
/// grow the host without limit. Eviction only forfeits dedup of ancient keys
/// — a replayed recent key still hits, a re-submitted ancient key simply
/// re-derives its outcome under a fresh ledger entry.
const max_replay_entries: usize = 256;

const InputReplay = struct {
    idempotency_key: []u8,
    claim_token: []u8,
    transaction_id: []u8,
    operation_kind: InputOperationKind,
    operation_digest: [32]u8,
    receipt: ?InputReceiptData = null,

    fn deinit(self: *InputReplay, allocator: std.mem.Allocator) void {
        allocator.free(self.idempotency_key);
        allocator.free(self.claim_token);
        allocator.free(self.transaction_id);
        self.* = undefined;
    }

    fn matches(
        self: *const InputReplay,
        request: WireInputSubmit,
        kind: InputOperationKind,
        digest: [32]u8,
    ) bool {
        return std.mem.eql(u8, self.claim_token, request.claimToken) and
            std.mem.eql(u8, self.transaction_id, request.transactionId) and
            self.operation_kind == kind and
            std.crypto.timing_safe.eql([32]u8, self.operation_digest, digest);
    }
};

const ResizeReplay = struct {
    idempotency_key: []u8,
    revision: u64,
    window: WireTerminalWindow,
    result: ?StoredResizeResult = null,

    fn deinit(self: *ResizeReplay, allocator: std.mem.Allocator) void {
        allocator.free(self.idempotency_key);
        self.* = undefined;
    }

    fn matches(self: *const ResizeReplay, revision: u64, window: WireTerminalWindow) bool {
        return self.revision == revision and
            self.window.columns == window.columns and self.window.rows == window.rows and
            self.window.widthPixels == window.widthPixels and
            self.window.heightPixels == window.heightPixels;
    }
};

const StoredResizeResult = union(enum) {
    applied: pty_host.ResizeReceipt,
    stale: u64,
    unknown: []const u8,
};

const InputReceiptData = struct {
    transaction_id: []const u8,
    stage: []const u8,
    byte_range: ?input_arbiter.ByteRange,
    ordered_at: ?u64,
    available_credit_bytes: usize,
    completeness: []const u8,
    diagnostic: ?[]const u8,
};

const ClaimResponse = union(enum) {
    granted: *const ActiveInputClaim,
    denied: struct { owner: ?*const ActiveInputClaim, diagnostic: []const u8 },
    unknown: []const u8,
};

pub const HostCore = struct {
    allocator: std.mem.Allocator,
    registration: HostRegistration,
    adoption_secret: [32]u8,
    host_executable: []const u8,
    broker_build_id: []const u8,
    lease: VisibilityLease,
    grants: std.ArrayList(GrantEntry) = .{},
    active_claim: ?ActiveInputClaim = null,
    /// Last human claim orphaned by an unclean viewer drop (#40). Retained only
    /// so inspection can still name the input owner of record while the arbiter
    /// holds HUMAN_ORPHANED — never consulted for authorization. Cleared on the
    /// next grant or clean release.
    orphaned_claim: ?ActiveInputClaim = null,
    input_replays: std.ArrayList(InputReplay) = .{},
    resize_replays: std.ArrayList(ResizeReplay) = .{},
    termination: ?TerminationBinding = null,
    adopted: bool = false,
    terminated: bool = false,

    pub fn init(
        allocator: std.mem.Allocator,
        registration: HostRegistration,
        adoption_secret: [32]u8,
        host_executable: []const u8,
        broker_build_id: []const u8,
        now_ns: u64,
    ) !HostCore {
        return .{
            .allocator = allocator,
            .registration = registration,
            .adoption_secret = adoption_secret,
            .host_executable = host_executable,
            .broker_build_id = broker_build_id,
            .lease = try VisibilityLease.initial(
                registration.record.visibility.workspace_session_id,
                registration.record.visibility.open_terminal_revision,
                now_ns,
            ),
        };
    }

    pub fn deinit(self: *HostCore) void {
        for (self.grants.items) |*grant| grant.deinit(self.allocator);
        self.grants.deinit(self.allocator);
        if (self.active_claim) |*claim| claim.deinit(self.allocator);
        if (self.orphaned_claim) |*claim| claim.deinit(self.allocator);
        for (self.input_replays.items) |*replay| replay.deinit(self.allocator);
        self.input_replays.deinit(self.allocator);
        for (self.resize_replays.items) |*replay| replay.deinit(self.allocator);
        self.resize_replays.deinit(self.allocator);
        std.crypto.secureZero(u8, &self.adoption_secret);
        self.* = undefined;
    }

    pub fn bindTermination(self: *HostCore, binding: TerminationBinding) void {
        self.termination = binding;
    }

    fn terminalSessionMatches(self: *const HostCore, session: WireTerminalSessionRef) bool {
        var generation_storage: [32]u8 = undefined;
        const generation = std.fmt.bufPrint(
            &generation_storage,
            "{d}",
            .{self.registration.record.locator.generation},
        ) catch return false;
        return std.mem.eql(u8, session.key, self.registration.record.locator.session_id) and
            std.mem.eql(u8, session.incarnation, generation);
    }

    fn inputClaimValue(
        allocator: std.mem.Allocator,
        claim: *const ActiveInputClaim,
    ) !std.json.Value {
        var value = std.json.ObjectMap.init(allocator);
        try value.put("token", .{ .string = claim.token });
        try value.put("writer", .{ .string = claim.writer });
        try value.put("kind", .{ .string = claim.kind });
        try value.put("leaseExpiresAt", .{ .string = claim.lease_expires_at });
        return .{ .object = value };
    }

    fn encodeClaimResult(self: *HostCore, response: ClaimResponse) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var result = std.json.ObjectMap.init(a);
        switch (response) {
            .granted => |claim| {
                try result.put("state", .{ .string = "granted" });
                try result.put("claim", try inputClaimValue(a, claim));
            },
            .denied => |denied| {
                try result.put("state", .{ .string = "denied" });
                try result.put("owner", if (denied.owner) |owner|
                    try inputClaimValue(a, owner)
                else
                    .null);
                try result.put("diagnostic", .{ .string = denied.diagnostic });
            },
            .unknown => |diagnostic| {
                try result.put("state", .{ .string = "unknown" });
                try result.put("diagnostic", .{ .string = diagnostic });
            },
        }
        var root = std.json.ObjectMap.init(a);
        try root.put("schemaVersion", .{ .integer = 1 });
        try root.put("result", .{ .object = result });
        const payload = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .object = root },
            .{},
        );
        errdefer self.allocator.free(payload);
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.claim_result_payload,
            payload,
        )) return error.InvalidClaimResult;
        return payload;
    }

    pub fn claimInput(
        self: *HostCore,
        payload: []const u8,
        viewer_id: []const u8,
        now_ns: u64,
    ) ![]u8 {
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.claim_acquire_payload,
            payload,
        )) return error.InvalidClaimAcquire;
        var parsed = try std.json.parseFromSlice(WireClaimAcquire, self.allocator, payload, .{});
        defer parsed.deinit();
        const request = parsed.value;
        if (request.schemaVersion != 1 or !self.terminalSessionMatches(request.session))
            return error.GenerationMismatch;
        if (self.active_claim) |*claim| {
            if (std.mem.eql(u8, claim.idempotency_key, request.idempotencyKey) and
                std.mem.eql(u8, claim.writer, request.writer) and
                std.mem.eql(u8, claim.kind, request.kind) and
                std.mem.eql(u8, claim.owner_viewer_id, viewer_id))
                return self.encodeClaimResult(.{ .granted = claim });
            if (claim.expires_mono_ns > now_ns) {
                return self.encodeClaimResult(.{ .denied = .{
                    .owner = claim,
                    .diagnostic = "input already claimed",
                } });
            }
            // Expired host claim with no clean release — drop it so a returning
            // viewer can re-enter through free/orphaned arbiter paths (#40).
            self.onViewerDetached(claim.owner_viewer_id);
        }
        const binding = self.termination orelse
            return self.encodeClaimResult(.{ .unknown = "input binding unavailable" });
        const arbiter = binding.arbiter orelse
            return self.encodeClaimResult(.{ .unknown = "input arbiter unavailable" });
        if (self.lease.expired(now_ns))
            return self.encodeClaimResult(.{ .unknown = "visibility lease expired" });
        const remaining_ms = (self.lease.expires_mono_ns - now_ns) / std.time.ns_per_ms;
        const duration_ms = @min(request.leaseMilliseconds, remaining_ms);
        if (duration_ms == 0)
            return self.encodeClaimResult(.{ .unknown = "claim lease unavailable" });

        var random_token: [32]u8 = undefined;
        std.crypto.random.bytes(&random_token);
        defer std.crypto.secureZero(u8, &random_token);
        const token_hex = std.fmt.bytesToHex(random_token, .lower);
        var claim: ActiveInputClaim = .{
            .token = try std.fmt.allocPrint(self.allocator, "claim_{s}", .{token_hex}),
            .writer = undefined,
            .kind = undefined,
            .idempotency_key = undefined,
            .owner_viewer_id = undefined,
            .lease_expires_at = undefined,
            .expires_mono_ns = try std.math.add(
                u64,
                now_ns,
                try std.math.mul(u64, duration_ms, std.time.ns_per_ms),
            ),
            .next_sequence = 0,
        };
        var initialized_fields: usize = 1;
        errdefer {
            if (initialized_fields >= 1) self.allocator.free(claim.token);
            if (initialized_fields >= 2) self.allocator.free(claim.writer);
            if (initialized_fields >= 3) self.allocator.free(claim.kind);
            if (initialized_fields >= 4) self.allocator.free(claim.idempotency_key);
            if (initialized_fields >= 5) self.allocator.free(claim.owner_viewer_id);
            if (initialized_fields >= 6) self.allocator.free(claim.lease_expires_at);
        }
        claim.writer = try self.allocator.dupe(u8, request.writer);
        initialized_fields = 2;
        claim.kind = try self.allocator.dupe(u8, request.kind);
        initialized_fields = 3;
        claim.idempotency_key = try self.allocator.dupe(u8, request.idempotencyKey);
        initialized_fields = 4;
        claim.owner_viewer_id = try self.allocator.dupe(u8, viewer_id);
        initialized_fields = 5;
        var expiry_storage: [24]u8 = undefined;
        const expiry = try broker.wallDeadline(&expiry_storage, duration_ms);
        claim.lease_expires_at = try self.allocator.dupe(u8, expiry);
        initialized_fields = 6;

        // Returning human after unclean drop: arbiter is HUMAN_ORPHANED until
        // operatorResume (never-steal still blocks concurrent HUMAN_OWNED).
        // Automation must not reclaim an orphaned human lease (#40 invariant).
        // Kind enforcement is by-construction inside operatorResume(kind=…);
        // the early host compare is a diagnostic shortcut only.
        if (arbiter.currentState() == .human_orphaned) {
            if (!std.mem.eql(u8, request.kind, "human")) {
                claim.deinit(self.allocator);
                initialized_fields = 0;
                return self.encodeClaimResult(.{ .denied = .{
                    .owner = null,
                    .diagnostic = "HumanOrphaned",
                } });
            }
            const resumed = arbiter.operatorResume(viewer_id, claim.token, request.kind) catch |err| {
                claim.deinit(self.allocator);
                initialized_fields = 0;
                return switch (err) {
                    error.HumanOwned, error.HumanOrphaned, error.InputBusy, error.NotReady => self.encodeClaimResult(.{ .denied = .{
                        .owner = null,
                        .diagnostic = @errorName(err),
                    } }),
                    else => self.encodeClaimResult(.{ .unknown = @errorName(err) }),
                };
            };
            claim.next_sequence = resumed.next_sequence;
            self.clearOrphanedClaim();
            self.active_claim = claim;
            initialized_fields = 0;
            return self.encodeClaimResult(.{ .granted = &self.active_claim.? });
        }

        const granted = arbiter.claimAcquire(viewer_id, claim.token) catch |err| {
            claim.deinit(self.allocator);
            initialized_fields = 0;
            return switch (err) {
                error.HumanOwned, error.HumanOrphaned, error.InputBusy => self.encodeClaimResult(.{ .denied = .{
                    .owner = null,
                    .diagnostic = @errorName(err),
                } }),
                else => self.encodeClaimResult(.{ .unknown = @errorName(err) }),
            };
        };
        claim.next_sequence = granted.next_sequence;
        self.clearOrphanedClaim();
        self.active_claim = claim;
        initialized_fields = 0;
        return self.encodeClaimResult(.{ .granted = &self.active_claim.? });
    }

    /// Unclean viewer drop: orphan the arbiter claim (lease current) and clear
    /// the host `active_claim` so a returning human can re-enter (#40). The
    /// dropped claim moves to `orphaned_claim` so inspection still reports the
    /// input owner of record while HUMAN_ORPHANED holds; if the arbiter did
    /// not orphan (expired lease → Closed), the claim is dropped for real.
    pub fn onViewerDetached(self: *HostCore, viewer_id: []const u8) void {
        const claim = if (self.active_claim) |*active| active else return;
        if (!std.mem.eql(u8, claim.owner_viewer_id, viewer_id)) return;
        var orphaned = false;
        if (self.termination) |binding| {
            if (binding.arbiter) |arbiter| {
                arbiter.viewerDisconnect() catch {};
                orphaned = arbiter.currentState() == .human_orphaned;
            }
        }
        if (orphaned) {
            if (self.orphaned_claim) |*stale| stale.deinit(self.allocator);
            self.orphaned_claim = self.active_claim;
        } else {
            claim.deinit(self.allocator);
        }
        self.active_claim = null;
    }

    /// Ownership resolved (grant or clean release): the retained orphan no
    /// longer names the input owner of record.
    fn clearOrphanedClaim(self: *HostCore) void {
        if (self.orphaned_claim) |*claim| claim.deinit(self.allocator);
        self.orphaned_claim = null;
    }

    /// Clean CLAIM_RELEASE → FREE + clear host claim (no orphan).
    pub fn releaseInput(
        self: *HostCore,
        payload: []const u8,
        viewer_id: []const u8,
        now_ns: u64,
    ) ![]u8 {
        _ = now_ns;
        var parsed = try std.json.parseFromSlice(WireClaimRelease, self.allocator, payload, .{
            .ignore_unknown_fields = true,
        });
        defer parsed.deinit();
        const request = parsed.value;
        if (request.schemaVersion != 1 or !self.terminalSessionMatches(request.session))
            return error.GenerationMismatch;
        const claim = if (self.active_claim) |*active| active else return error.InvalidClaimAcquire;
        if (!std.mem.eql(u8, claim.token, request.claimToken) or
            !std.mem.eql(u8, claim.owner_viewer_id, viewer_id))
            return error.InvalidClaimAcquire;
        const kind: input_arbiter.ReleaseKind = if (std.mem.eql(u8, request.kind, "submit"))
            .submit
        else if (std.mem.eql(u8, request.kind, "cancel"))
            .cancel
        else
            return error.InvalidClaimAcquire;
        const binding = self.termination orelse return error.InvalidClaimAcquire;
        const arbiter = binding.arbiter orelse return error.InvalidClaimAcquire;
        _ = arbiter.claimRelease(viewer_id, claim.token, kind, "") catch |err| return switch (err) {
            error.HumanOrphaned, error.HumanOwned, error.NotReady, error.InputBusy => error.InvalidClaimAcquire,
            else => error.OutOfMemory,
        };
        claim.deinit(self.allocator);
        self.active_claim = null;
        self.clearOrphanedClaim();
        return self.encodeInputApplied(.{
            .transaction_id = "claim-release",
            .stage = "accepted",
            .byte_range = null,
            .ordered_at = null,
            .available_credit_bytes = 0,
            .completeness = "complete",
            .diagnostic = null,
        });
    }

    fn encodeInputApplied(self: *HostCore, receipt: InputReceiptData) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var receipt_value = std.json.ObjectMap.init(a);
        try receipt_value.put("transactionId", .{ .string = receipt.transaction_id });
        try receipt_value.put("stage", .{ .string = receipt.stage });
        if (receipt.byte_range) |range| {
            var byte_range = std.json.ObjectMap.init(a);
            try byte_range.put("start", .{ .string = try std.fmt.allocPrint(a, "{d}", .{range.start}) });
            try byte_range.put("endExclusive", .{ .string = try std.fmt.allocPrint(a, "{d}", .{range.end_exclusive}) });
            try receipt_value.put("byteRange", .{ .object = byte_range });
        } else try receipt_value.put("byteRange", .null);
        try receipt_value.put("orderedAt", if (receipt.ordered_at) |ordered|
            .{ .string = try std.fmt.allocPrint(a, "{d}", .{ordered}) }
        else
            .null);
        try receipt_value.put("availableCreditBytes", .{ .integer = @intCast(receipt.available_credit_bytes) });
        try receipt_value.put("consumedByProcess", .{ .string = "not-claimed" });
        try receipt_value.put("completeness", .{ .string = receipt.completeness });
        try receipt_value.put("diagnostic", if (receipt.diagnostic) |diagnostic|
            .{ .string = diagnostic }
        else
            .null);
        var root = std.json.ObjectMap.init(a);
        try root.put("schemaVersion", .{ .integer = 1 });
        try root.put("resultKind", .{ .string = "input" });
        try root.put("receipt", .{ .object = receipt_value });
        const payload = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .object = root },
            .{},
        );
        errdefer self.allocator.free(payload);
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.applied_payload,
            payload,
        )) return error.InvalidAppliedResult;
        return payload;
    }

    fn reserveInputReplay(
        self: *HostCore,
        request: WireInputSubmit,
        kind: InputOperationKind,
        digest: [32]u8,
    ) !*InputReplay {
        var replay: InputReplay = .{
            .idempotency_key = try self.allocator.dupe(u8, request.idempotencyKey),
            .claim_token = undefined,
            .transaction_id = undefined,
            .operation_kind = kind,
            .operation_digest = digest,
        };
        var initialized_fields: usize = 1;
        errdefer {
            if (initialized_fields >= 1) self.allocator.free(replay.idempotency_key);
            if (initialized_fields >= 2) self.allocator.free(replay.claim_token);
            if (initialized_fields >= 3) self.allocator.free(replay.transaction_id);
        }
        replay.claim_token = try self.allocator.dupe(u8, request.claimToken);
        initialized_fields = 2;
        replay.transaction_id = try self.allocator.dupe(u8, request.transactionId);
        initialized_fields = 3;
        while (self.input_replays.items.len >= max_replay_entries) {
            var evicted = self.input_replays.orderedRemove(0);
            evicted.deinit(self.allocator);
        }
        try self.input_replays.append(self.allocator, replay);
        initialized_fields = 0;
        return &self.input_replays.items[self.input_replays.items.len - 1];
    }

    fn rejectedInputReceipt(transaction_id: []const u8, diagnostic: []const u8) InputReceiptData {
        return .{
            .transaction_id = transaction_id,
            .stage = "rejected",
            .byte_range = null,
            .ordered_at = null,
            .available_credit_bytes = generated.limits.input_transaction_bytes,
            .completeness = "complete",
            .diagnostic = diagnostic,
        };
    }

    pub fn submitInput(
        self: *HostCore,
        payload: []const u8,
        viewer_id: []const u8,
        now_ns: u64,
    ) ![]u8 {
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.input_submit_payload,
            payload,
        )) return error.InvalidInputSubmit;
        var parsed = try std.json.parseFromSlice(WireInputSubmit, self.allocator, payload, .{});
        defer parsed.deinit();
        const request = parsed.value;
        if (request.schemaVersion != 1 or !self.terminalSessionMatches(request.session))
            return error.GenerationMismatch;

        var decoded: ?[]u8 = null;
        defer if (decoded) |bytes| {
            std.crypto.secureZero(u8, bytes);
            self.allocator.free(bytes);
        };
        const kind: InputOperationKind = if (std.mem.eql(u8, request.operation.kind, "bytes")) blk: {
            const encoded = request.operation.bytes orelse return error.InvalidInputSubmit;
            if (request.operation.encoding == null or
                !std.mem.eql(u8, request.operation.encoding.?, "base64"))
                return error.InvalidInputSubmit;
            const size = std.base64.standard.Decoder.calcSizeForSlice(encoded) catch
                return error.InvalidInputSubmit;
            if (size > generated.limits.input_transaction_bytes)
                return error.InputPayloadTooLarge;
            decoded = try self.allocator.alloc(u8, size);
            std.base64.standard.Decoder.decode(decoded.?, encoded) catch
                return error.InvalidInputSubmit;
            break :blk .bytes;
        } else if (std.mem.eql(u8, request.operation.kind, "canonical-end-of-file"))
            .canonical_eof
        else if (std.mem.eql(u8, request.operation.kind, "hangup"))
            .hangup
        else
            return error.InvalidInputSubmit;
        var digest_hasher = std.crypto.hash.sha2.Sha256.init(.{});
        digest_hasher.update(@tagName(kind));
        digest_hasher.update(&[_]u8{0});
        if (decoded) |bytes| digest_hasher.update(bytes);
        const operation_digest = digest_hasher.finalResult();

        for (self.input_replays.items) |*replay| {
            if (!std.mem.eql(u8, replay.idempotency_key, request.idempotencyKey)) continue;
            if (!replay.matches(request, kind, operation_digest))
                return self.encodeInputApplied(rejectedInputReceipt(
                    request.transactionId,
                    "idempotency key reused with different input",
                ));
            const receipt = replay.receipt orelse return error.InputReplayIncomplete;
            return self.encodeInputApplied(receipt);
        }
        const replay = try self.reserveInputReplay(request, kind, operation_digest);
        const binding = self.termination orelse {
            replay.receipt = .{
                .transaction_id = replay.transaction_id,
                .stage = "unknown",
                .byte_range = null,
                .ordered_at = null,
                .available_credit_bytes = 0,
                .completeness = "unknown",
                .diagnostic = "input binding unavailable",
            };
            return self.encodeInputApplied(replay.receipt.?);
        };
        const arbiter = binding.arbiter orelse {
            replay.receipt = .{
                .transaction_id = replay.transaction_id,
                .stage = "unknown",
                .byte_range = null,
                .ordered_at = null,
                .available_credit_bytes = 0,
                .completeness = "unknown",
                .diagnostic = "input arbiter unavailable",
            };
            return self.encodeInputApplied(replay.receipt.?);
        };
        const claim = if (self.active_claim) |*active| active else {
            replay.receipt = rejectedInputReceipt(replay.transaction_id, "input claim unavailable");
            return self.encodeInputApplied(replay.receipt.?);
        };
        if (claim.expires_mono_ns <= now_ns) {
            arbiter.viewerDisconnect() catch {};
            replay.receipt = rejectedInputReceipt(replay.transaction_id, "input claim expired");
            return self.encodeInputApplied(replay.receipt.?);
        }
        if (!std.mem.eql(u8, claim.token, request.claimToken) or
            !std.mem.eql(u8, claim.owner_viewer_id, viewer_id))
        {
            replay.receipt = rejectedInputReceipt(replay.transaction_id, "input claim fenced");
            return self.encodeInputApplied(replay.receipt.?);
        }

        if (kind == .hangup) {
            const ordered_at = binding.pty.hangup() catch |err| {
                replay.receipt = .{
                    .transaction_id = replay.transaction_id,
                    .stage = "unknown",
                    .byte_range = null,
                    .ordered_at = null,
                    .available_credit_bytes = 0,
                    .completeness = "unknown",
                    .diagnostic = @errorName(err),
                };
                return self.encodeInputApplied(replay.receipt.?);
            };
            arbiter.terminate() catch |err| {
                replay.receipt = .{
                    .transaction_id = replay.transaction_id,
                    .stage = "unknown",
                    .byte_range = null,
                    .ordered_at = ordered_at,
                    .available_credit_bytes = 0,
                    .completeness = "partial",
                    .diagnostic = @errorName(err),
                };
                return self.encodeInputApplied(replay.receipt.?);
            };
            replay.receipt = .{
                .transaction_id = replay.transaction_id,
                .stage = "accepted",
                .byte_range = null,
                .ordered_at = ordered_at,
                .available_credit_bytes = 0,
                .completeness = "complete",
                .diagnostic = null,
            };
            return self.encodeInputApplied(replay.receipt.?);
        }

        var eof_storage: [1]u8 = undefined;
        const input_bytes: []const u8 = if (kind == .bytes)
            decoded.?
        else blk: {
            eof_storage[0] = binding.pty.canonicalEofByte() catch |err| {
                replay.receipt = if (err == error.NotCanonical)
                    rejectedInputReceipt(replay.transaction_id, "terminal input mode is not canonical")
                else
                    .{
                        .transaction_id = replay.transaction_id,
                        .stage = "unknown",
                        .byte_range = null,
                        .ordered_at = null,
                        .available_credit_bytes = 0,
                        .completeness = "unknown",
                        .diagnostic = @errorName(err),
                    };
                return self.encodeInputApplied(replay.receipt.?);
            };
            break :blk &eof_storage;
        };
        var input_digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(input_bytes, &input_digest, .{});
        const accepted = arbiter.humanInput(
            viewer_id,
            claim.token,
            claim.next_sequence,
            input_digest,
            input_bytes,
        ) catch |err| {
            replay.receipt = if (err == error.Internal or err == error.SinkWriteFailed)
                .{
                    .transaction_id = replay.transaction_id,
                    .stage = "unknown",
                    .byte_range = null,
                    .ordered_at = null,
                    .available_credit_bytes = 0,
                    .completeness = "unknown",
                    .diagnostic = @errorName(err),
                }
            else
                rejectedInputReceipt(replay.transaction_id, @errorName(err));
            return self.encodeInputApplied(replay.receipt.?);
        };
        claim.next_sequence = std.math.add(u64, claim.next_sequence, 1) catch
            return error.InputSequenceOverflow;
        const ordered_at = binding.pty.operationSequence();
        binding.pty.writeDrainAll() catch |err| {
            // DrainStalled: the child stopped reading and the bounded drain
            // gave up, but the bytes are still queued and the host loop keeps
            // draining — receipt "queued"/"partial" (never "unknown", which
            // would permanently fence client input).
            replay.receipt = .{
                .transaction_id = replay.transaction_id,
                .stage = if (err == error.DrainStalled) "queued" else "unknown",
                .byte_range = accepted.byte_range,
                .ordered_at = ordered_at,
                .available_credit_bytes = @min(
                    generated.limits.input_transaction_bytes,
                    binding.pty.availableWriteCredit(),
                ),
                .completeness = "partial",
                .diagnostic = @errorName(err),
            };
            return self.encodeInputApplied(replay.receipt.?);
        };
        replay.receipt = .{
            .transaction_id = replay.transaction_id,
            .stage = "written-to-terminal",
            .byte_range = accepted.byte_range,
            .ordered_at = ordered_at,
            .available_credit_bytes = @min(
                generated.limits.input_transaction_bytes,
                binding.pty.availableWriteCredit(),
            ),
            .completeness = "complete",
            .diagnostic = null,
        };
        return self.encodeInputApplied(replay.receipt.?);
    }

    fn encodeResizeApplied(self: *HostCore, result: StoredResizeResult) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var result_value = std.json.ObjectMap.init(a);
        switch (result) {
            .applied => |receipt| {
                try result_value.put("state", .{ .string = "applied" });
                try result_value.put("revision", .{ .string = try std.fmt.allocPrint(a, "{d}", .{receipt.revision}) });
                var readback = std.json.ObjectMap.init(a);
                try readback.put("columns", .{ .integer = receipt.readback.columns });
                try readback.put("rows", .{ .integer = receipt.readback.rows });
                try readback.put("widthPixels", .{ .integer = receipt.readback.width_px });
                try readback.put("heightPixels", .{ .integer = receipt.readback.height_px });
                try result_value.put("readback", .{ .object = readback });
                try result_value.put("orderedAt", .{ .string = try std.fmt.allocPrint(a, "{d}", .{receipt.ordered_at}) });
                try result_value.put("foregroundProcessObservation", .{ .string = "not-claimed" });
            },
            .stale => |revision| {
                try result_value.put("state", .{ .string = "stale" });
                try result_value.put("currentRevision", .{ .string = try std.fmt.allocPrint(a, "{d}", .{revision}) });
            },
            .unknown => |diagnostic| {
                try result_value.put("state", .{ .string = "unknown" });
                try result_value.put("diagnostic", .{ .string = diagnostic });
            },
        }
        var root = std.json.ObjectMap.init(a);
        try root.put("schemaVersion", .{ .integer = 1 });
        try root.put("resultKind", .{ .string = "resize" });
        try root.put("result", .{ .object = result_value });
        const payload = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .object = root },
            .{},
        );
        errdefer self.allocator.free(payload);
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.applied_payload,
            payload,
        )) return error.InvalidAppliedResult;
        return payload;
    }

    fn reserveResizeReplay(
        self: *HostCore,
        request: WireResize,
        revision: u64,
    ) !*ResizeReplay {
        const replay: ResizeReplay = .{
            .idempotency_key = try self.allocator.dupe(u8, request.idempotencyKey),
            .revision = revision,
            .window = request.window,
        };
        errdefer self.allocator.free(replay.idempotency_key);
        while (self.resize_replays.items.len >= max_replay_entries) {
            var evicted = self.resize_replays.orderedRemove(0);
            evicted.deinit(self.allocator);
        }
        try self.resize_replays.append(self.allocator, replay);
        return &self.resize_replays.items[self.resize_replays.items.len - 1];
    }

    pub fn resizeTerminal(
        self: *HostCore,
        payload: []const u8,
        state: *terminal_state.TerminalState,
    ) ![]u8 {
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.resize_payload,
            payload,
        )) return error.InvalidResize;
        var parsed = try std.json.parseFromSlice(WireResize, self.allocator, payload, .{});
        defer parsed.deinit();
        const request = parsed.value;
        if (request.schemaVersion != 1 or !self.terminalSessionMatches(request.session))
            return error.GenerationMismatch;
        const revision = std.fmt.parseInt(u64, request.revision, 10) catch
            return error.InvalidResize;
        for (self.resize_replays.items) |*replay| {
            if (!std.mem.eql(u8, replay.idempotency_key, request.idempotencyKey)) continue;
            if (!replay.matches(revision, request.window)) return error.InvalidResizeReplay;
            return self.encodeResizeApplied(replay.result orelse return error.ResizeReplayIncomplete);
        }
        const replay = try self.reserveResizeReplay(request, revision);
        const binding = self.termination orelse {
            replay.result = .{ .unknown = "terminal binding unavailable" };
            return self.encodeResizeApplied(replay.result.?);
        };
        const geometry: pty_host.Geometry = .{
            .columns = request.window.columns,
            .rows = request.window.rows,
            .width_px = request.window.widthPixels,
            .height_px = request.window.heightPixels,
        };
        const receipt = binding.pty.resize(geometry, revision) catch |err| {
            replay.result = if (err == error.StaleResizeRevision)
                .{ .stale = binding.pty.resizeRevision() }
            else
                .{ .unknown = @errorName(err) };
            return self.encodeResizeApplied(replay.result.?);
        };
        self.registration.record.geometry.columns = @intCast(receipt.readback.columns);
        self.registration.record.geometry.rows = @intCast(receipt.readback.rows);
        self.registration.record.geometry.width_px = receipt.readback.width_px;
        self.registration.record.geometry.height_px = receipt.readback.height_px;
        // The shadow VT follows the applied window so future checkpoints carry
        // the real geometry (§23: a checkpoint restore renders at the live
        // size, not the create-time 80x24).
        state.resize(.{
            .columns = receipt.readback.columns,
            .rows = receipt.readback.rows,
            .cell_width_px_16_16 = cellFixed16_16(receipt.readback.width_px, receipt.readback.columns),
            .cell_height_px_16_16 = cellFixed16_16(receipt.readback.height_px, receipt.readback.rows),
        }) catch |err| {
            replay.result = .{ .unknown = @errorName(err) };
            return self.encodeResizeApplied(replay.result.?);
        };
        replay.result = .{ .applied = receipt };
        return self.encodeResizeApplied(replay.result.?);
    }

    pub fn adopt(
        self: *HostCore,
        payload: []const u8,
        hello_build_id: []const u8,
        now_ns: u64,
    ) ![]u8 {
        if (self.lease.expired(now_ns)) return error.VisibilityExpired;
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.host_adopt_payload,
            payload,
        )) return error.InvalidAdoption;
        var parsed = try std.json.parseFromSlice(WireHostAdoptChallenge, self.allocator, payload, .{
            .ignore_unknown_fields = true,
        });
        defer parsed.deinit();
        if (parsed.value.schemaVersion != 1 or
            !std.mem.eql(u8, parsed.value.operation, "adopt") or
            parsed.value.protocol.major != generated.protocol_major or
            parsed.value.protocol.minor != generated.protocol_minor or
            !std.mem.eql(u8, parsed.value.brokerBuildId, hello_build_id) or
            !std.mem.eql(u8, parsed.value.brokerBuildId, self.broker_build_id))
            return error.InvalidAdoption;
        const locator = try parseLocator(self.allocator, parsed.value.expectedLocator);
        defer {
            self.allocator.free(locator.instance_id);
            self.allocator.free(locator.session_id);
            switch (locator.subject) {
                .root => {},
                .agent => |agent_id| self.allocator.free(agent_id),
            }
            if (locator.engine_build_id) |engine| self.allocator.free(engine);
        }
        if (!sameLocator(locator, self.registration.record.locator))
            return error.InvalidAdoption;
        var secret: [32]u8 = undefined;
        _ = std.fmt.hexToBytes(&secret, parsed.value.adoptionSecretHex) catch
            return error.InvalidAdoption;
        defer std.crypto.secureZero(u8, &secret);
        if (!std.crypto.timing_safe.eql([32]u8, secret, self.adoption_secret))
            return error.InvalidAdoption;

        const response = try self.encodeAdoptionReadback(now_ns);
        self.adopted = true;
        return response;
    }

    fn encodeAdoptionReadback(self: *HostCore, now_ns: u64) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const record = self.registration.record;
        var expiry_storage: [24]u8 = undefined;
        const expires_at = try self.leaseWallDeadline(now_ns, &expiry_storage);
        var output_storage: [32]u8 = undefined;
        var checkpoint_storage: [32]u8 = undefined;
        const output = try std.fmt.bufPrint(&output_storage, "{d}", .{record.output_seq});
        const checkpoint = try std.fmt.bufPrint(&checkpoint_storage, "{d}", .{record.checkpoint_seq});
        var root = std.json.ObjectMap.init(a);
        try root.put("schemaVersion", .{ .integer = 1 });
        try root.put("locator", try locatorValue(a, record.locator));
        try root.put("hostPid", .{ .integer = record.host_pid });
        try root.put("hostStartToken", .{ .string = record.host_start_token });
        try root.put("executable", .{ .string = self.host_executable });
        try root.put("executableBuildHash", .{ .string = record.executable_build_hash });
        try root.put("engineBuildId", .{ .string = record.engine_build_id });
        try root.put("protocol", try protocolValue(a, record.protocol_major, record.protocol_minor));
        try root.put("processRoot", try processRootValue(a, record.process_root));
        try root.put("outputSeq", .{ .string = try a.dupe(u8, output) });
        // A3: registration.record.checkpoint_seq was populated through
        // checkpointWireSeq, never by an unchecked TerminalState read.
        try root.put("checkpointSeq", .{ .string = try a.dupe(u8, checkpoint) });
        try root.put("visibility", try visibilityValue(a, record.visibility, expires_at));
        const json = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .object = root },
            .{},
        );
        errdefer self.allocator.free(json);
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.host_adopt_payload,
            json,
        )) return error.InvalidAdoptionReadback;
        return json;
    }

    fn leaseWallDeadline(
        self: *HostCore,
        now_ns: u64,
        storage: *[24]u8,
    ) ![]const u8 {
        if (self.lease.expired(now_ns)) return error.VisibilityExpired;
        const remaining_ns = self.lease.expires_mono_ns - now_ns;
        const remaining_ms = std.math.divCeil(
            u64,
            remaining_ns,
            std.time.ns_per_ms,
        ) catch return error.InvalidTimestamp;
        return broker.wallDeadline(storage, remaining_ms);
    }

    fn removeExpiredGrants(self: *HostCore, now_ns: u64) void {
        var index: usize = 0;
        while (index < self.grants.items.len) {
            if (self.grants.items[index].expires_mono_ns > now_ns) {
                index += 1;
                continue;
            }
            var expired = self.grants.orderedRemove(index);
            expired.deinit(self.allocator);
        }
    }

    pub fn registerGrant(self: *HostCore, payload: []const u8, now_ns: u64) ![]u8 {
        if (self.lease.expired(now_ns)) return error.VisibilityExpired;
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.grant_register_payload,
            payload,
        )) return error.InvalidGrant;
        var parsed = try std.json.parseFromSlice(WireGrantRegistration, self.allocator, payload, .{
            .ignore_unknown_fields = true,
        });
        defer parsed.deinit();
        if (parsed.value.schemaVersion != 1 or
            !std.mem.startsWith(u8, parsed.value.grantTokenSha256, "sha256:"))
            return error.InvalidGrant;
        var hash: [32]u8 = undefined;
        _ = std.fmt.hexToBytes(&hash, parsed.value.grantTokenSha256["sha256:".len..]) catch
            return error.InvalidGrant;
        defer std.crypto.secureZero(u8, &hash);
        const expires_mono_ns = try wallExpiryToMonotonic(
            parsed.value.expiresAt,
            now_ns,
            generated.limits.attach_grant_timeout_ms,
        );
        self.removeExpiredGrants(now_ns);
        if (self.grants.items.len >= generated.limits.viewers_per_generation)
            return error.GrantCapacityExceeded;
        for (self.grants.items) |grant| {
            if (std.crypto.timing_safe.eql([32]u8, grant.hash, hash))
                return error.DuplicateGrant;
        }
        var operations: GrantOperations = .{};
        for (parsed.value.operations) |operation| {
            if (std.mem.eql(u8, operation, "view"))
                operations.view = true
            else if (std.mem.eql(u8, operation, "human-input"))
                operations.human_input = true
            else if (std.mem.eql(u8, operation, "resize"))
                operations.resize = true
            else
                return error.InvalidGrant;
        }
        const viewer_id = try self.allocator.dupe(u8, parsed.value.viewerId);
        errdefer self.allocator.free(viewer_id);
        try self.grants.append(self.allocator, .{
            .hash = hash,
            .viewer_id = viewer_id,
            .operations = operations,
            .geometry = .{
                .columns = @intCast(parsed.value.geometry.columns),
                .rows = @intCast(parsed.value.geometry.rows),
                .width_px = parsed.value.geometry.widthPx,
                .height_px = parsed.value.geometry.heightPx,
                .cell_width_px = parsed.value.geometry.cellWidthPx,
                .cell_height_px = parsed.value.geometry.cellHeightPx,
            },
            .expires_mono_ns = expires_mono_ns,
        });
        const response = try self.allocator.dupe(
            u8,
            "{\"schemaVersion\":1,\"registered\":true}",
        );
        errdefer self.allocator.free(response);
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.grant_register_payload,
            response,
        )) return error.InvalidGrantResponse;
        return response;
    }

    /// Validates and consumes one viewer capability. Streaming begins only
    /// after the caller has established the generated SNAPSHOT/OUTPUT wire
    /// contract; this method does not invent a HOST_ATTACH response shape.
    pub fn authorizeViewerAttach(
        self: *HostCore,
        payload: []const u8,
        hello_token: []const u8,
        now_ns: u64,
    ) !ViewerAuthorization {
        if (self.lease.expired(now_ns)) return error.VisibilityExpired;
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.host_attach_payload,
            payload,
        )) return error.InvalidHostAttach;
        var parsed = try std.json.parseFromSlice(WireHostAttach, self.allocator, payload, .{
            .ignore_unknown_fields = true,
        });
        defer parsed.deinit();
        if (parsed.value.schemaVersion != 1) return error.InvalidHostAttach;
        const locator = try parseLocator(self.allocator, parsed.value.locator);
        defer {
            self.allocator.free(locator.instance_id);
            self.allocator.free(locator.session_id);
            switch (locator.subject) {
                .root => {},
                .agent => |agent_id| self.allocator.free(agent_id),
            }
            if (locator.engine_build_id) |engine| self.allocator.free(engine);
        }
        if (!sameLocator(locator, self.registration.record.locator))
            return error.AttachLocatorMismatch;
        const after_seq = try std.fmt.parseInt(u64, parsed.value.afterSeq, 10);
        if (after_seq > self.registration.record.output_seq)
            return error.InvalidHostAttach;

        var hello_hash: [32]u8 = undefined;
        defer std.crypto.secureZero(u8, &hello_hash);
        std.crypto.hash.sha2.Sha256.hash(hello_token, &hello_hash, .{});
        var token_hash: [32]u8 = undefined;
        defer std.crypto.secureZero(u8, &token_hash);
        std.crypto.hash.sha2.Sha256.hash(parsed.value.token, &token_hash, .{});
        if (!std.crypto.timing_safe.eql([32]u8, hello_hash, token_hash))
            return error.InvalidViewerGrant;

        self.removeExpiredGrants(now_ns);
        var match_index: ?usize = null;
        for (self.grants.items, 0..) |grant, index| {
            if (std.crypto.timing_safe.eql([32]u8, grant.hash, token_hash))
                match_index = index;
        }
        const index = match_index orelse return error.InvalidViewerGrant;
        if (!self.grants.items[index].operations.view or
            !sameGeometry(self.grants.items[index].geometry, parsed.value.geometry))
            return error.InvalidViewerGrant;
        var grant = self.grants.orderedRemove(index);
        std.crypto.secureZero(u8, &grant.hash);
        const authorization: ViewerAuthorization = .{
            .viewer_id = grant.viewer_id,
            .operations = grant.operations,
            .geometry = grant.geometry,
            .after_seq = after_seq,
        };
        return authorization;
    }

    pub fn renewVisibility(self: *HostCore, payload: []const u8, now_ns: u64) ![]u8 {
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.visibility_renew_payload,
            payload,
        )) return error.InvalidVisibilityRenewal;
        var parsed = try std.json.parseFromSlice(WireVisibilityRenew, self.allocator, payload, .{
            .ignore_unknown_fields = true,
        });
        defer parsed.deinit();
        const locator = try parseLocator(self.allocator, parsed.value.locator);
        defer {
            self.allocator.free(locator.instance_id);
            self.allocator.free(locator.session_id);
            switch (locator.subject) {
                .root => {},
                .agent => |agent_id| self.allocator.free(agent_id),
            }
            if (locator.engine_build_id) |engine| self.allocator.free(engine);
        }
        if (!sameLocator(locator, self.registration.record.locator))
            return error.InvalidVisibilityRenewal;
        const workspace = switch (process_inspector.observeProcess(parsed.value.workspacePid)) {
            .present => |identity| identity,
            .absent, .unobservable => return error.InvalidWorkspaceIdentity,
        };
        var token_storage: [64]u8 = undefined;
        const token = try workspace.start_token.format(&token_storage);
        if (!std.mem.eql(u8, token, parsed.value.workspaceStartToken))
            return error.InvalidWorkspaceIdentity;
        const revision = try std.fmt.parseInt(u64, parsed.value.openTerminalRevision, 10);
        try self.lease.renew(
            parsed.value.workspaceSessionId,
            revision,
            now_ns,
        );
        self.registration.record.visibility.state = .visible;
        self.registration.record.visibility.open_terminal_revision = revision;
        self.registration.record.visibility.expires_mono_ns = self.lease.expires_mono_ns;
        // The grant-time clamp ties claim lifetime to the visibility lease
        // (claimInput), so a live renewal must extend both. Without this the
        // claim expires 10–15 s after acquire even while the pane stays
        // visible, and the next keystroke is rejected "input claim expired".
        if (self.active_claim) |*claim| {
            if (claim.expires_mono_ns < self.lease.expires_mono_ns) {
                claim.expires_mono_ns = self.lease.expires_mono_ns;
                const claim_remaining_ms = (self.lease.expires_mono_ns - now_ns) / std.time.ns_per_ms;
                var claim_expiry_storage: [24]u8 = undefined;
                const claim_expiry = try broker.wallDeadline(&claim_expiry_storage, claim_remaining_ms);
                const updated_expiry = try self.allocator.dupe(u8, claim_expiry);
                self.allocator.free(claim.lease_expires_at);
                claim.lease_expires_at = updated_expiry;
            }
        }
        var expiry_storage: [24]u8 = undefined;
        const expires_at = try self.leaseWallDeadline(now_ns, &expiry_storage);
        var revision_storage: [32]u8 = undefined;
        const revision_text = try std.fmt.bufPrint(&revision_storage, "{d}", .{revision});
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        var root = std.json.ObjectMap.init(arena.allocator());
        try root.put("schemaVersion", .{ .integer = 1 });
        try root.put("locator", try locatorValue(arena.allocator(), self.registration.record.locator));
        try root.put("state", .{ .string = "active" });
        try root.put("expiresAt", .{ .string = expires_at });
        try root.put("openTerminalRevision", .{ .string = try arena.allocator().dupe(u8, revision_text) });
        const response = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .object = root },
            .{},
        );
        errdefer self.allocator.free(response);
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.renewed_payload,
            response,
        )) return error.InvalidVisibilityResponse;
        return response;
    }

    fn encodeOrphanDiscarded(
        self: *HostCore,
        discarded: bool,
        prior_owner_viewer_id: ?[]const u8,
        prior_claim_id: ?[]const u8,
        diagnostic: []const u8,
    ) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var root = std.json.ObjectMap.init(a);
        try root.put("schemaVersion", .{ .integer = 1 });
        try root.put("discarded", .{ .bool = discarded });
        try root.put("priorOwnerViewerId", if (prior_owner_viewer_id) |value|
            .{ .string = value }
        else
            .null);
        try root.put("priorClaimId", if (prior_claim_id) |value|
            .{ .string = value }
        else
            .null);
        try root.put("diagnostic", .{ .string = diagnostic });
        const payload = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .object = root },
            .{},
        );
        errdefer self.allocator.free(payload);
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.orphan_discarded_payload,
            payload,
        )) return error.InvalidOrphanDiscardResponse;
        return payload;
    }

    /// §22 INPUT_ORPHAN_DISCARD: the operator exit from HUMAN_ORPHANED.
    ///
    /// The arbiter orphans a human claim when its viewer drops uncleanly, and
    /// #40 never-steal then denies every automation claim forever — with no
    /// automated way back (2026-07-21 messaging regression). This is that way
    /// back, and nothing more: it cancel-encodes the abandoned draft through
    /// `operatorDiscard` and returns the arbiter to FREE. It CANNOT resume a
    /// draft, and it refuses (never steals) whenever the arbiter is anything
    /// other than HUMAN_ORPHANED — a live human keeps input, as before. The
    /// refusal is a normal response carrying its reason, not a wire error, so
    /// the caller can record WHY on the message row it is trying to deliver.
    pub fn discardInputOrphan(self: *HostCore, payload: []const u8) ![]u8 {
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.orphan_discard_payload,
            payload,
        )) return error.InvalidOrphanDiscard;
        var parsed = try std.json.parseFromSlice(WireOrphanDiscard, self.allocator, payload, .{
            .ignore_unknown_fields = true,
        });
        defer parsed.deinit();
        if (parsed.value.schemaVersion != 1) return error.InvalidOrphanDiscard;
        const locator = try parseLocator(self.allocator, parsed.value.locator);
        defer {
            self.allocator.free(locator.instance_id);
            self.allocator.free(locator.session_id);
            switch (locator.subject) {
                .root => {},
                .agent => |agent_id| self.allocator.free(agent_id),
            }
            if (locator.engine_build_id) |engine| self.allocator.free(engine);
        }
        if (!sameLocator(locator, self.registration.record.locator))
            return error.InvalidOrphanDiscard;

        const binding = self.termination orelse
            return self.encodeOrphanDiscarded(false, null, null, "input arbiter not bound");
        const arbiter = binding.arbiter orelse
            return self.encodeOrphanDiscarded(false, null, null, "input arbiter not bound");
        const state = arbiter.currentState();
        if (state != .human_orphaned)
            return self.encodeOrphanDiscarded(false, null, null, @tagName(state));

        // The orphan's owner of record, retained by onViewerDetached. Read it
        // before the discard: clearOrphanedClaim frees these strings.
        const prior_owner: ?[]const u8 = if (self.orphaned_claim) |claim|
            claim.owner_viewer_id
        else
            null;
        const prior_claim: ?[]const u8 = if (self.orphaned_claim) |claim|
            claim.token
        else
            null;
        _ = arbiter.operatorDiscard() catch |err| {
            return self.encodeOrphanDiscarded(false, prior_owner, prior_claim, @errorName(err));
        };
        const response = try self.encodeOrphanDiscarded(
            true,
            prior_owner,
            prior_claim,
            "orphaned human claim discarded",
        );
        self.clearOrphanedClaim();
        return response;
    }

    pub fn terminate(self: *HostCore, payload: []const u8) ![]u8 {
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.terminate_payload,
            payload,
        )) return error.InvalidTermination;
        var parsed = try std.json.parseFromSlice(WireTerminate, self.allocator, payload, .{
            .ignore_unknown_fields = true,
        });
        defer parsed.deinit();
        if (parsed.value.schemaVersion != 1) return error.InvalidTermination;
        // Frozen A0 addresses the host by SessionRef; map generation→incarnation.
        var incarnation_storage: [32]u8 = undefined;
        const incarnation = try std.fmt.bufPrint(
            &incarnation_storage,
            "{d}",
            .{self.registration.record.locator.generation},
        );
        if (!std.mem.eql(u8, parsed.value.session.key, self.registration.record.locator.session_id) or
            !std.mem.eql(u8, parsed.value.session.incarnation, incarnation))
            return error.InvalidTermination;
        const mode = std.meta.stringToEnum(
            process_inspector.TerminationMode,
            parsed.value.mode,
        ) orelse return error.InvalidTermination;
        if (!std.mem.eql(u8, parsed.value.target, "process-tree") and
            !std.mem.eql(u8, parsed.value.target, "foreground-group") and
            !std.mem.eql(u8, parsed.value.target, "session-members"))
            return error.InvalidTermination;
        return self.terminateBound(mode, null);
    }

    /// Crash invariant enforcement. The caller invokes this from the host
    /// lifecycle clock even when no broker transport is connected.
    pub fn enforceVisibilityExpiry(self: *HostCore, now_ns: u64) !bool {
        if (self.terminated) return true;
        if (!self.lease.expired(now_ns)) return false;
        const response = try self.terminateBound(.graceful, "VISIBILITY_EXPIRED");
        self.allocator.free(response);
        return true;
    }

    fn terminateBound(
        self: *HostCore,
        mode: process_inspector.TerminationMode,
        failure_code: ?[]const u8,
    ) ![]u8 {
        if (self.terminated) return error.AlreadyTerminated;
        const binding = self.termination orelse return error.TerminationNotReady;
        var outcome = try terminateProvider(
            self.allocator,
            binding,
            self.registration.record.process_root,
            mode,
            failure_code != null,
        );
        defer outcome.deinit(self.allocator);

        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var survivors_json = std.json.Array.init(a);
        var survivors: std.ArrayList(FinalSurvivor) = .{};
        defer survivors.deinit(a);
        for (outcome.tree.members) |member| {
            if (member.fate == .terminated) continue;
            var token_storage: [64]u8 = undefined;
            const token = try member.identity.start_token.format(&token_storage);
            const owned_token = try a.dupe(u8, token);
            const reason = try a.dupe(u8, member.reason);
            var process = std.json.ObjectMap.init(a);
            try process.put("processId", .{ .integer = member.identity.pid });
            try process.put("startToken", .{ .string = owned_token });
            var survivor = std.json.ObjectMap.init(a);
            try survivor.put("process", .{ .object = process });
            try survivor.put("reason", .{ .string = reason });
            try survivors_json.append(.{ .object = survivor });
            try survivors.append(a, .{
                .pid = member.identity.pid,
                .startToken = owned_token,
                .reason = reason,
            });
        }
        var final_errors: std.ArrayList(FinalError) = .{};
        defer final_errors.deinit(a);
        var diagnostics = std.json.Array.init(a);
        const termination_errors = [_]struct { phase: []const u8, code: ?[]const u8 }{
            .{ .phase = "input-arbiter-close", .code = outcome.arbiter_error },
            .{ .phase = "provider-graceful-action", .code = outcome.graceful_action_error },
        };
        for (termination_errors) |termination_error| {
            const code = termination_error.code orelse continue;
            try diagnostics.append(.{ .string = try std.fmt.allocPrint(
                a,
                "{s}:{s}",
                .{ termination_error.phase, code },
            ) });
            try final_errors.append(a, .{
                .phase = termination_error.phase,
                .code = code,
            });
        }
        if (failure_code) |code| try diagnostics.append(.{ .string = code });

        var exit_value: std.json.Value = .null;
        var observed_storage: [24]u8 = undefined;
        const observed_at = try broker.wallDeadline(&observed_storage, 0);
        if (outcome.exit.reaped) {
            var exit = std.json.ObjectMap.init(a);
            try exit.put("code", if (outcome.exit.exit_code) |code|
                .{ .integer = code }
            else
                .null);
            try exit.put("signal", if (outcome.exit.term_signal) |signal|
                .{ .integer = signal }
            else
                .null);
            try exit.put("observedAt", .{ .string = try a.dupe(u8, observed_at) });
            exit_value = .{ .object = exit };
        }
        // waitpid is authoritative only when this host is the direct parent.
        var reap = std.json.ObjectMap.init(a);
        try reap.put("authority", .{ .string = if (outcome.exit.reaped)
            "direct-parent"
        else
            "unavailable" });
        try reap.put("reaped", .{ .bool = outcome.exit.reaped });
        try reap.put("status", exit_value);
        try reap.put("completeness", .{ .string = if (outcome.exit.reaped and
            outcome.tree.state == .terminated and
            survivors_json.items.len == 0)
            "complete"
        else if (outcome.exit.reaped)
            "partial"
        else
            "unknown" });

        const completeness: []const u8 = if (outcome.tree.state == .terminated and
            outcome.exit.reaped and
            survivors_json.items.len == 0 and
            diagnostics.items.len == 0)
            "complete"
        else if (outcome.tree.state == .survivors)
            "partial"
        else
            "unknown";

        var root = std.json.ObjectMap.init(a);
        try root.put("schemaVersion", .{ .integer = 1 });
        try root.put("state", .{ .string = @tagName(outcome.tree.state) });
        try root.put("exit", exit_value);
        try root.put("reap", .{ .object = reap });
        try root.put("survivors", .{ .array = survivors_json });
        try root.put("completeness", .{ .string = completeness });
        try root.put("diagnostics", .{ .array = diagnostics });
        const response = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .object = root },
            .{},
        );
        errdefer self.allocator.free(response);
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.terminated_payload,
            response,
        )) return error.InvalidTerminationResponse;

        var output_storage: [32]u8 = undefined;
        var checkpoint_storage: [32]u8 = undefined;
        const output_seq = try std.fmt.bufPrint(
            &output_storage,
            "{d}",
            .{self.registration.record.output_seq},
        );
        const checkpoint_seq = try std.fmt.bufPrint(
            &checkpoint_storage,
            "{d}",
            .{self.registration.record.checkpoint_seq},
        );
        try writeFinalExclusive(self.allocator, binding.directory, .{
            .state = @tagName(outcome.tree.state),
            .exitCode = outcome.exit.exit_code,
            .exitSignal = outcome.exit.term_signal,
            .waitObserved = outcome.exit.reaped,
            .outputSeq = output_seq,
            .checkpointSeq = checkpoint_seq,
            .survivors = survivors.items,
            .errors = final_errors.items,
            .failureCode = failure_code,
        });
        self.registration.record.state = .exited;
        self.terminated = true;
        return response;
    }

    fn finishNeutralReap(
        self: *HostCore,
        exit_code: ?i32,
        exit_signal: ?i32,
        final_state: []const u8,
        evidence_error: ?FinalError,
    ) !void {
        if (self.terminated) return;
        const binding = self.termination orelse return error.TerminationNotReady;
        var errors: [2]FinalError = undefined;
        var error_count: usize = 0;
        if (evidence_error) |value| {
            errors[0] = value;
            error_count = 1;
        }
        if (binding.arbiter) |arbiter| {
            arbiter.terminate() catch |err| {
                errors[error_count] = .{
                    .phase = "input-arbiter-close",
                    .code = @errorName(err),
                };
                error_count += 1;
            };
        }
        try binding.pty.recordExternalReap(self.registration.record.process_root.pid);
        binding.pty.closeMaster();

        var output_storage: [32]u8 = undefined;
        var checkpoint_storage: [32]u8 = undefined;
        const output_seq = try std.fmt.bufPrint(
            &output_storage,
            "{d}",
            .{self.registration.record.output_seq},
        );
        const checkpoint_seq = try std.fmt.bufPrint(
            &checkpoint_storage,
            "{d}",
            .{self.registration.record.checkpoint_seq},
        );
        try writeFinalExclusive(self.allocator, binding.directory, .{
            .state = final_state,
            .exitCode = if (exit_code) |code| std.math.cast(u8, code) else null,
            .exitSignal = exit_signal,
            .waitObserved = true,
            .outputSeq = output_seq,
            .checkpointSeq = checkpoint_seq,
            .survivors = &.{},
            .errors = errors[0..error_count],
            .failureCode = null,
        });
        self.registration.record.state = .exited;
        self.terminated = true;
    }

    fn reconcileNeutralOperationFailure(self: *HostCore, operation_error: anyerror) !void {
        if (self.terminated) return;
        const child_pid = self.registration.record.process_root.pid;
        var raw_status: c_int = 0;
        const waited = c.waitpid(child_pid, &raw_status, c.WNOHANG);
        var exit_code: ?i32 = null;
        var exit_signal: ?i32 = null;
        if (waited == child_pid) {
            const status_bits: u32 = @bitCast(raw_status);
            if (std.posix.W.IFEXITED(status_bits))
                exit_code = @intCast(std.posix.W.EXITSTATUS(status_bits));
            if (std.posix.W.IFSIGNALED(status_bits))
                exit_signal = @intCast(std.posix.W.TERMSIG(status_bits));
        } else if (waited == 0) {
            return;
        } else if (std.posix.errno(waited) != .CHILD) {
            return;
        }
        try self.finishNeutralReap(
            exit_code,
            exit_signal,
            "unknown",
            .{
                .phase = "neutral-control-operation",
                .code = @errorName(operation_error),
            },
        );
    }

    fn acceptNeutralInspection(self: *HostCore, payload: []const u8) !void {
        var parsed = try std.json.parseFromSlice(
            neutral_control_plane.WireInspectionPayload,
            self.allocator,
            payload,
            .{},
        );
        defer parsed.deinit();
        const inspection = parsed.value;
        if (inspection.schemaVersion != 1 or
            inspection.reap.authority != .@"direct-parent" or
            !inspection.reap.reaped or inspection.reap.status == null)
            return;
        try self.finishNeutralReap(
            inspection.reap.status.?.code,
            inspection.reap.status.?.signal,
            "unknown",
            .{
                .phase = "process-tree-inspection",
                .code = "descendant-completeness-unavailable-after-root-reap",
            },
        );
    }

    fn acceptNeutralTermination(self: *HostCore, payload: []const u8) !void {
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.terminated_payload,
            payload,
        )) return error.InvalidTerminationResponse;
        var parsed = try std.json.parseFromSlice(
            neutral_control_plane.WireTerminationPayload,
            self.allocator,
            payload,
            .{},
        );
        defer parsed.deinit();
        const result = parsed.value;
        if (result.schemaVersion != 1 or result.reap.authority != .@"direct-parent" or
            !result.reap.reaped or result.reap.status == null)
            return;
        const complete = result.state == .terminated and result.survivors.len == 0 and
            result.completeness == .complete and result.reap.completeness == .complete;
        try self.finishNeutralReap(
            result.reap.status.?.code,
            result.reap.status.?.signal,
            if (complete) "terminated" else "unknown",
            if (complete) null else .{
                .phase = "neutral-control-operation",
                .code = "incomplete-after-root-reap",
            },
        );
    }
};

const ExpectedPeerRole = enum { broker, viewer, either };

const AcceptedHello = struct {
    allocator: std.mem.Allocator,
    build_id: []u8,
    grant_token: ?[]u8,
    role: ExpectedPeerRole,

    fn deinit(self: *AcceptedHello) void {
        self.allocator.free(self.build_id);
        if (self.grant_token) |token| {
            std.crypto.secureZero(u8, token);
            self.allocator.free(token);
        }
        self.* = undefined;
    }
};

fn acceptHostHello(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    deadline: *const ConnectionDeadline,
    now_ns: u64,
    expected_role: ExpectedPeerRole,
) !?AcceptedHello {
    const peer = try broker.inspectPeer(stream.handle);
    if (peer.uid != std.posix.getuid() or
        peer.gid != @as(u32, @intCast(c.getgid())))
        return error.UnauthenticatedPeer;

    var hello_frame = try readConnectionFrame(allocator, stream, deadline);
    defer {
        std.crypto.secureZero(u8, hello_frame.payload);
        hello_frame.deinit(allocator);
    }
    if (hello_frame.header.type_code != generated.frame_type.hello or
        hello_frame.header.flags != 0 or
        !protocol.validateControlPayload(
            allocator,
            generated.wire_schema.hello_payload,
            hello_frame.payload,
        ))
    {
        try writeHostFailure(allocator, stream, hello_frame.header, .malformed_frame);
        return null;
    }
    var hello = try std.json.parseFromSlice(WireHello, allocator, hello_frame.payload, .{
        .ignore_unknown_fields = true,
    });
    defer hello.deinit();
    if (hello.value.protocol.major != generated.protocol_major or
        hello.value.protocol.minMinor > generated.protocol_minor or
        hello.value.protocol.maxMinor < generated.protocol_minor or
        (expected_role == .broker and
            !std.mem.eql(u8, hello.value.buildId, core.broker_build_id)))
    {
        try writeHostFailure(allocator, stream, hello_frame.header, .protocol_mismatch);
        return null;
    }
    if (!std.mem.eql(u8, hello.value.instanceId, core.registration.record.locator.instance_id)) {
        try writeHostFailure(allocator, stream, hello_frame.header, .instance_mismatch);
        return null;
    }
    const role: ExpectedPeerRole = if (std.mem.eql(u8, hello.value.clientRole, "broker"))
        .broker
    else if (std.mem.eql(u8, hello.value.clientRole, "viewer"))
        .viewer
    else {
        try writeHostFailure(allocator, stream, hello_frame.header, .forbidden);
        return null;
    };
    if ((expected_role != .either and role != expected_role) or
        (role == .viewer and hello.value.grantToken == null))
    {
        try writeHostFailure(allocator, stream, hello_frame.header, .forbidden);
        return null;
    }
    const build_id = try allocator.dupe(u8, hello.value.buildId);
    errdefer allocator.free(build_id);
    const grant_token = if (hello.value.grantToken) |token|
        try allocator.dupe(u8, token)
    else
        null;
    errdefer if (grant_token) |token| {
        std.crypto.secureZero(u8, token);
        allocator.free(token);
    };
    try writeHostWelcome(
        allocator,
        stream,
        hello_frame.header,
        core.registration,
        core.registration.record.executable_build_hash,
        now_ns,
    );
    return .{
        .allocator = allocator,
        .build_id = build_id,
        .grant_token = grant_token,
        .role = role,
    };
}

const AuthorizedViewer = struct {
    authorization: ViewerAuthorization,
    /// HOST_ATTACH request header fields for correlated snapshot frames and
    /// typed attach failures (§20).
    attach_minor: u8,
    attach_request_id: u64,
};

fn viewerAttachFailureCode(err: anyerror) protocol.WireError {
    return switch (err) {
        error.VisibilityExpired => .not_ready,
        error.InvalidHostAttach => .malformed_frame,
        // Exact-locator fence (§06/§20): a wrong or superseded generation is a
        // typed refusal before any grant/token evaluation.
        error.AttachLocatorMismatch => .generation_mismatch,
        error.InvalidViewerGrant => .unauthenticated,
        error.OutOfMemory => .resource_exhausted,
        else => .verification_unknown,
    };
}

fn authorizeViewerAfterHello(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    hello: *const AcceptedHello,
    deadline: *const ConnectionDeadline,
    now_ns: u64,
) !AuthorizedViewer {
    var request = try readConnectionFrame(allocator, stream, deadline);
    defer {
        std.crypto.secureZero(u8, request.payload);
        request.deinit(allocator);
    }
    if (request.header.flags != 0 or
        request.header.type_code != generated.frame_type.host_attach)
    {
        try writeHostFailure(allocator, stream, request.header, .malformed_frame);
        return error.InvalidHostAttach;
    }
    const authorization = core.authorizeViewerAttach(
        request.payload,
        hello.grant_token.?,
        now_ns,
    ) catch |err| {
        try writeHostFailure(allocator, stream, request.header, viewerAttachFailureCode(err));
        return err;
    };
    return .{
        .authorization = authorization,
        .attach_minor = request.header.minor,
        .attach_request_id = request.header.request_id,
    };
}

/// Authenticates the existing generated viewer HELLO and consumes the existing
/// generated HOST_ATTACH request. The caller retains the stream and begins the
/// snapshot/output sequence.
pub fn authorizeViewerConnection(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    now_ns: u64,
) !ViewerAuthorization {
    var timer = try std.time.Timer.start();
    const deadline = try ConnectionDeadline.init(&timer, core.lease, now_ns);
    var hello = (try acceptHostHello(allocator, stream, core, &deadline, now_ns, .viewer)) orelse
        return error.ViewerHandshakeRefused;
    defer hello.deinit();
    const authorized = try authorizeViewerAfterHello(allocator, stream, core, &hello, &deadline, now_ns);
    return authorized.authorization;
}

fn serveBrokerRequest(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    hello_build_id: []const u8,
    deadline: *const ConnectionDeadline,
    now_ns: u64,
) !void {
    var request = try readConnectionFrame(allocator, stream, deadline);
    defer request.deinit(allocator);
    if (request.header.flags != 0) {
        try writeHostFailure(allocator, stream, request.header, .malformed_frame);
        return;
    }
    // Same-uid + instanceId + buildId prove only that the peer is A local
    // process running the same executable; the 32-byte adoption secret is the
    // proof it is THE broker that owns this host. HOST_ADOPT is therefore the
    // only pre-adoption verb: terminate, grant_register, visibility_renew and
    // any future privileged RPC fail closed until adoption has set
    // core.adopted (write-once for the host's lifetime).
    if (request.header.type_code != generated.frame_type.host_adopt and !core.adopted) {
        try writeHostFailure(allocator, stream, request.header, .unauthenticated);
        return;
    }
    switch (request.header.type_code) {
        generated.frame_type.host_adopt => {
            const response = core.adopt(
                request.payload,
                hello_build_id,
                now_ns,
            ) catch |err| {
                try writeHostFailure(
                    allocator,
                    stream,
                    request.header,
                    if (err == error.VisibilityExpired) .not_ready else .unauthenticated,
                );
                return;
            };
            defer core.allocator.free(response);
            try protocol.writeFrame(
                stream,
                responseHeader(request.header, generated.frame_type.host_adopt, response.len),
                response,
            );
        },
        generated.frame_type.grant_register => {
            const response = core.registerGrant(request.payload, now_ns) catch |err| {
                try writeHostFailure(
                    allocator,
                    stream,
                    request.header,
                    switch (err) {
                        error.VisibilityExpired => .not_ready,
                        error.GrantCapacityExceeded => .capacity_exceeded,
                        else => .malformed_frame,
                    },
                );
                return;
            };
            defer core.allocator.free(response);
            try protocol.writeFrame(
                stream,
                responseHeader(request.header, generated.frame_type.grant_register, response.len),
                response,
            );
        },
        generated.frame_type.visibility_renew => {
            const response = core.renewVisibility(request.payload, now_ns) catch |err| {
                try writeHostFailure(
                    allocator,
                    stream,
                    request.header,
                    switch (err) {
                        error.InvalidWorkspaceIdentity => .unauthenticated,
                        error.VisibilityExpired => .not_ready,
                        error.VisibilityForbidden => .forbidden,
                        else => .malformed_frame,
                    },
                );
                return;
            };
            defer core.allocator.free(response);
            try protocol.writeFrame(
                stream,
                responseHeader(request.header, generated.frame_type.renewed, response.len),
                response,
            );
        },
        generated.frame_type.input_orphan_discard => {
            const response = core.discardInputOrphan(request.payload) catch {
                try writeHostFailure(allocator, stream, request.header, .malformed_frame);
                return;
            };
            defer core.allocator.free(response);
            try protocol.writeFrame(
                stream,
                responseHeader(request.header, generated.frame_type.orphan_discarded, response.len),
                response,
            );
        },
        generated.frame_type.terminate => {
            const response = core.terminate(request.payload) catch |err| {
                try writeHostFailure(
                    allocator,
                    stream,
                    request.header,
                    switch (err) {
                        error.TerminationNotReady => .not_ready,
                        error.AlreadyTerminated => .already_exists,
                        else => .verification_unknown,
                    },
                );
                return;
            };
            defer core.allocator.free(response);
            try protocol.writeFrame(
                stream,
                responseHeader(request.header, generated.frame_type.terminated, response.len),
                response,
            );
        },
        else => try writeHostFailure(allocator, stream, request.header, .unsupported_frame),
    }
}

/// Serves one authenticated broker RPC on an already-accepted host.sock
/// connection. Kernel identity is captured before HELLO; broker JSON claims
/// are used only as cross-checks. The broker opens one connection per RPC.
pub fn serveHostConnection(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    now_ns: u64,
) !void {
    var timer = try std.time.Timer.start();
    const deadline = try ConnectionDeadline.init(&timer, core.lease, now_ns);
    var hello = (try acceptHostHello(allocator, stream, core, &deadline, now_ns, .broker)) orelse return;
    defer hello.deinit();
    return serveBrokerRequest(allocator, stream, core, hello.build_id, &deadline, now_ns);
}

fn viewerFailureCode(err: anyerror) protocol.WireError {
    return switch (err) {
        error.GenerationMismatch => .generation_mismatch,
        error.InvalidClaimAcquire,
        error.InvalidInputSubmit,
        error.InvalidResize,
        error.InvalidResizeReplay,
        => .malformed_frame,
        error.InputPayloadTooLarge => .payload_too_large,
        error.OutOfMemory => .resource_exhausted,
        else => .verification_unknown,
    };
}

fn handleViewerFrame(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    state: *terminal_state.TerminalState,
    authorization: *const ViewerAuthorization,
    request: *const protocol.Frame,
    now_ns: u64,
) !void {
    const expected_flags: u16 = if (request.header.type_code == generated.frame_type.input_submit)
        generated.frame_flag.content_sensitive
    else
        0;
    if (request.header.flags != expected_flags) {
        try writeHostFailure(allocator, stream, request.header, .malformed_frame);
        return;
    }
    var response_type: u16 = undefined;
    const response = switch (request.header.type_code) {
        generated.frame_type.claim_acquire => blk: {
            if (!authorization.operations.human_input) {
                try writeHostFailure(allocator, stream, request.header, .forbidden);
                return;
            }
            response_type = generated.frame_type.claim_result;
            break :blk core.claimInput(
                request.payload,
                authorization.viewer_id,
                now_ns,
            ) catch |err| {
                try writeHostFailure(allocator, stream, request.header, viewerFailureCode(err));
                return;
            };
        },
        generated.frame_type.input_submit => blk: {
            if (!authorization.operations.human_input) {
                try writeHostFailure(allocator, stream, request.header, .forbidden);
                return;
            }
            response_type = generated.frame_type.applied;
            break :blk core.submitInput(
                request.payload,
                authorization.viewer_id,
                now_ns,
            ) catch |err| {
                try writeHostFailure(allocator, stream, request.header, viewerFailureCode(err));
                return;
            };
        },
        generated.frame_type.resize => blk: {
            if (!authorization.operations.resize) {
                try writeHostFailure(allocator, stream, request.header, .forbidden);
                return;
            }
            response_type = generated.frame_type.applied;
            break :blk core.resizeTerminal(request.payload, state) catch |err| {
                try writeHostFailure(allocator, stream, request.header, viewerFailureCode(err));
                return;
            };
        },
        generated.frame_type.claim_release => blk: {
            if (!authorization.operations.human_input) {
                try writeHostFailure(allocator, stream, request.header, .forbidden);
                return;
            }
            response_type = generated.frame_type.applied;
            break :blk core.releaseInput(
                request.payload,
                authorization.viewer_id,
                now_ns,
            ) catch |err| {
                try writeHostFailure(allocator, stream, request.header, viewerFailureCode(err));
                return;
            };
        },
        else => {
            try writeHostFailure(allocator, stream, request.header, .unsupported_frame);
            return;
        },
    };
    defer core.allocator.free(response);
    try protocol.writeFrame(
        stream,
        responseHeader(request.header, response_type, response.len),
        response,
    );
}

/// One live attached viewer stream owned by the host loop (§20/§26). A later
/// successful attach for the same exact generation supersedes it.
const AttachedViewer = struct {
    stream: std.net.Stream,
    authorization: ViewerAuthorization,
    /// Exclusive journal byte offset already written to this viewer.
    sent_seq: u64,
    /// Exclusive contiguous OUTPUT high-water the viewer acknowledged (§20 APPLIED).
    acked_seq: u64,

    fn close(self: *AttachedViewer, allocator: std.mem.Allocator) void {
        self.stream.close();
        self.authorization.deinit(allocator);
        self.* = undefined;
    }
};

/// Push retained journal bytes from `seq.*` to the journal end as ordered
/// unsolicited OUTPUT frames (stream_seq = absolute first-byte offset),
/// chunked at the negotiated stream bound. Advances `seq.*`.
fn pushRetainedOutput(
    stream: std.net.Stream,
    state: *terminal_state.TerminalState,
    seq: *u64,
) !void {
    const slice = try state.journal.sliceFrom(seq.*);
    var offset: usize = 0;
    while (offset < slice.len) {
        const take = @min(generated.limits.stream_chunk_bytes, slice.len - offset);
        try protocol.writeFrame(stream, .{
            .minor = generated.protocol_minor,
            .type_code = generated.frame_type.output,
            .flags = 0,
            .payload_length = @intCast(take),
            .request_id = 0,
            .stream_seq = seq.* + @as(u64, @intCast(offset)),
        }, slice[offset..][0..take]);
        offset += take;
    }
    seq.* += @as(u64, @intCast(slice.len));
}

/// §20 attach stream for an authorized viewer: when the requested cursor is
/// below the retained journal start, the newest verified HVTCP001 checkpoint
/// envelope is sent as correlated SNAPSHOT_BYTES chunks; every retained byte
/// after the effective base then replays as ordered OUTPUT. Returns the
/// exclusive high-water written. A cursor the retained journal and checkpoint
/// cannot bridge is a typed CHECKPOINT_UNAVAILABLE failure, never silence.
fn beginViewerStream(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    state: *terminal_state.TerminalState,
    authorized: *const AuthorizedViewer,
) !u64 {
    const attach_header: protocol.Header = .{
        .minor = authorized.attach_minor,
        .type_code = generated.frame_type.host_attach,
        .flags = 0,
        .payload_length = 0,
        .request_id = authorized.attach_request_id,
        .stream_seq = 0,
    };
    var base: u64 = authorized.authorization.after_seq;
    const retained_start = state.retainedOutputStart();
    if (base < retained_start) {
        const checkpoint = state.newestCheckpoint() orelse {
            try writeHostFailure(allocator, stream, attach_header, .checkpoint_unavailable);
            return error.CheckpointUnavailable;
        };
        const through_seq = checkpoint.header.through_seq;
        if (through_seq < retained_start) {
            try writeHostFailure(allocator, stream, attach_header, .checkpoint_unavailable);
            return error.CheckpointUnavailable;
        }
        const file = checkpoint.file;
        var offset: usize = 0;
        while (offset < file.len) {
            const take = @min(generated.limits.stream_chunk_bytes, file.len - offset);
            const final_flag: u16 = if (offset + take == file.len)
                generated.frame_flag.final
            else
                0;
            try protocol.writeFrame(stream, .{
                .minor = authorized.attach_minor,
                .type_code = generated.frame_type.snapshot_bytes,
                .flags = generated.frame_flag.response | final_flag,
                .payload_length = @intCast(take),
                .request_id = authorized.attach_request_id,
                .stream_seq = @intCast(offset),
            }, file[offset..][0..take]);
            offset += take;
        }
        base = through_seq;
    }
    try pushRetainedOutput(stream, state, &base);
    return base;
}

/// Serves one accepted host.sock connection. A broker connection is one RPC.
/// A viewer connection authorizes, streams the attach snapshot/replay, and is
/// returned to the host loop as the live attached viewer; the caller closes
/// the stream in every other outcome.
fn serveSessionConnection(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    state: *terminal_state.TerminalState,
    timer: *std.time.Timer,
) !?AttachedViewer {
    const now_ns = timer.read();
    const deadline = try ConnectionDeadline.init(timer, core.lease, now_ns);
    var hello = (try acceptHostHello(allocator, stream, core, &deadline, now_ns, .either)) orelse return null;
    defer hello.deinit();
    switch (hello.role) {
        .broker => {
            try serveBrokerRequest(allocator, stream, core, hello.build_id, &deadline, now_ns);
            return null;
        },
        .viewer => {
            var authorized = try authorizeViewerAfterHello(
                allocator,
                stream,
                core,
                &hello,
                &deadline,
                now_ns,
            );
            errdefer authorized.authorization.deinit(core.allocator);
            const sent_seq = try beginViewerStream(allocator, stream, state, &authorized);
            return .{
                .stream = stream,
                .authorization = authorized.authorization,
                .sent_seq = sent_seq,
                .acked_seq = authorized.authorization.after_seq,
            };
        },
        .either => unreachable,
    }
}

/// Per-iteration bound on dispatched inbound viewer frames so a chatty viewer
/// cannot starve the PTY pump.
const viewer_inbound_frames_per_iteration = 32;

/// Drives the attached viewer inside the host loop: pushes newly journaled
/// OUTPUT (paused while the unacknowledged window exceeds the negotiated
/// viewer queue bound), then dispatches any ready inbound frames. Any wire
/// error detaches the viewer; the logical pane representation is untouched.
fn detachAttachedViewer(
    allocator: std.mem.Allocator,
    core: *HostCore,
    viewer_slot: *?AttachedViewer,
) void {
    if (viewer_slot.*) |*viewer| {
        // #40: unclean drop must orphan+clear host claim before free of viewer_id.
        core.onViewerDetached(viewer.authorization.viewer_id);
        viewer.close(allocator);
        viewer_slot.* = null;
    }
}

fn pumpAttachedViewer(
    allocator: std.mem.Allocator,
    viewer_slot: *?AttachedViewer,
    core: *HostCore,
    state: *terminal_state.TerminalState,
    timer: *std.time.Timer,
) void {
    if (viewer_slot.*) |*viewer| {
        // One absolute budget per pump call: poll() proves only that SOME
        // byte is readable, so a dribbling attached viewer would otherwise
        // stall the single-threaded loop inside the blocking frame read.
        // Budget exhaustion detaches the viewer (fail closed); an expired
        // lease simply skips the pump — the loop top owns lease teardown.
        const deadline = ConnectionDeadline.init(timer, core.lease, timer.read()) catch return;
        if (state.outputSeq() > viewer.sent_seq and
            viewer.sent_seq - viewer.acked_seq < generated.limits.viewer_queue_bytes)
        {
            pushRetainedOutput(viewer.stream, state, &viewer.sent_seq) catch {
                detachAttachedViewer(allocator, core, viewer_slot);
                return;
            };
        }
        var handled: u32 = 0;
        while (handled < viewer_inbound_frames_per_iteration) : (handled += 1) {
            var fds = [_]std.posix.pollfd{.{
                .fd = viewer.stream.handle,
                .events = std.posix.POLL.IN,
                .revents = 0,
            }};
            const ready = std.posix.poll(&fds, 0) catch 0;
            if (ready == 0 or fds[0].revents == 0) return;
            var frame = readConnectionFrame(allocator, viewer.stream, &deadline) catch {
                detachAttachedViewer(allocator, core, viewer_slot);
                return;
            };
            defer {
                if (frame.header.type_code == generated.frame_type.input_submit)
                    std.crypto.secureZero(u8, frame.payload);
                frame.deinit(allocator);
            }
            if (frame.header.type_code == generated.frame_type.applied) {
                if (viewerOutputAckThroughSeq(allocator, &frame)) |through_seq| {
                    // Duplicate/stale acks are harmless retransmits; an ack
                    // beyond what was sent is a protocol violation.
                    if (through_seq <= viewer.sent_seq) {
                        if (through_seq > viewer.acked_seq) viewer.acked_seq = through_seq;
                        continue;
                    }
                }
                detachAttachedViewer(allocator, core, viewer_slot);
                return;
            }
            handleViewerFrame(
                allocator,
                viewer.stream,
                core,
                state,
                &viewer.authorization,
                &frame,
                timer.read(),
            ) catch {
                detachAttachedViewer(allocator, core, viewer_slot);
                return;
            };
        }
    }
}

/// Parses a viewer→host APPLIED output acknowledgement; null on any shape
/// that is not the frozen output branch.
fn viewerOutputAckThroughSeq(
    allocator: std.mem.Allocator,
    frame: *const protocol.Frame,
) ?u64 {
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.applied_payload,
        frame.payload,
    )) return null;
    const Ack = struct {
        schemaVersion: u8,
        resultKind: []const u8,
        throughSeq: []const u8,
    };
    var parsed = std.json.parseFromSlice(Ack, allocator, frame.payload, .{
        .ignore_unknown_fields = true,
    }) catch return null;
    defer parsed.deinit();
    if (parsed.value.schemaVersion != 1 or
        !std.mem.eql(u8, parsed.value.resultKind, "output"))
        return null;
    return std.fmt.parseInt(u64, parsed.value.throughSeq, 10) catch null;
}

const WireCreateSpec = struct {
    schemaVersion: u8,
    locator: WireLocator,
    cwd: []const u8,
    argv: []const []const u8,
    environment: std.json.Value,
    expectedExecutable: []const u8,
    geometry: WireGeometry,
    visibility: struct {
        workspaceSessionId: []const u8,
        workspacePid: i32,
        workspaceStartToken: []const u8,
        openTerminalRevision: []const u8,
    },
};

/// Same validation as `environmentStrings`, but kept as name/value pairs for
/// the neutral create request, which joins them itself.
fn environmentEntries(
    allocator: std.mem.Allocator,
    value: std.json.Value,
) ![]const neutral_host.EnvironmentEntry {
    const object = switch (value) {
        .object => |object| object,
        else => return error.InvalidEnvironment,
    };
    const result = try allocator.alloc(neutral_host.EnvironmentEntry, object.count());
    var iterator = object.iterator();
    var index: usize = 0;
    while (iterator.next()) |entry| : (index += 1) {
        if (entry.key_ptr.*.len == 0 or
            std.mem.indexOfScalar(u8, entry.key_ptr.*, '=') != null or
            std.mem.indexOfScalar(u8, entry.key_ptr.*, 0) != null)
            return error.InvalidEnvironment;
        const item = switch (entry.value_ptr.*) {
            .string => |item| item,
            else => return error.InvalidEnvironment,
        };
        if (std.mem.indexOfScalar(u8, item, 0) != null)
            return error.InvalidEnvironment;
        result[index] = .{ .name = entry.key_ptr.*, .value = item };
    }
    return result;
}

fn environmentStrings(
    allocator: std.mem.Allocator,
    value: std.json.Value,
) ![]const []const u8 {
    const object = switch (value) {
        .object => |object| object,
        else => return error.InvalidEnvironment,
    };
    const result = try allocator.alloc([]const u8, object.count());
    var iterator = object.iterator();
    var index: usize = 0;
    while (iterator.next()) |entry| : (index += 1) {
        if (entry.key_ptr.*.len == 0 or
            std.mem.indexOfScalar(u8, entry.key_ptr.*, '=') != null or
            std.mem.indexOfScalar(u8, entry.key_ptr.*, 0) != null)
            return error.InvalidEnvironment;
        const item = switch (entry.value_ptr.*) {
            .string => |item| item,
            else => return error.InvalidEnvironment,
        };
        if (std.mem.indexOfScalar(u8, item, 0) != null)
            return error.InvalidEnvironment;
        result[index] = try std.fmt.allocPrint(
            allocator,
            "{s}={s}",
            .{ entry.key_ptr.*, item },
        );
    }
    return result;
}

fn validateSpawnStrings(
    cwd: []const u8,
    expected_executable: []const u8,
    argv: []const []const u8,
) !void {
    if (argv.len == 0 or !std.fs.path.isAbsolute(cwd) or
        std.mem.indexOfScalar(u8, cwd, 0) != null or
        std.mem.indexOfScalar(u8, expected_executable, 0) != null)
        return error.InvalidCreateSpec;
    for (argv) |argument| {
        if (std.mem.indexOfScalar(u8, argument, 0) != null)
            return error.InvalidCreateSpec;
    }
}

fn geometryFixed16_16(value: f64) !u32 {
    const scale = 65_536.0;
    const maximum = @as(f64, @floatFromInt(std.math.maxInt(u32))) / scale;
    if (!std.math.isFinite(value) or value <= 0 or value > maximum)
        return error.InvalidGeometry;
    return @intFromFloat(value * scale);
}

/// Whole-pixel total ÷ cell count as unsigned fixed-point 16.16; 0 when the
/// pixel size or cell count is unknown (matches Geometry's "0 = unknown").
fn cellFixed16_16(total_px: u32, cells: u32) u32 {
    if (total_px == 0 or cells == 0) return 0;
    return @intCast((@as(u64, total_px) << 16) / cells);
}

fn verifyWorkspaceIdentity(pid: i32, start_token: []const u8) !void {
    const identity = switch (process_inspector.observeProcess(pid)) {
        .present => |identity| identity,
        .absent, .unobservable => return error.InvalidWorkspaceIdentity,
    };
    var storage: [64]u8 = undefined;
    const observed = try identity.start_token.format(&storage);
    if (!std.mem.eql(u8, observed, start_token))
        return error.InvalidWorkspaceIdentity;
}

const TimerClock = struct {
    timer: *std.time.Timer,

    fn now(context: *anyopaque) u64 {
        const self: *TimerClock = @ptrCast(@alignCast(context));
        return self.timer.read();
    }
};

const PersistenceCursor = struct {
    checkpoint_seq: ?u64 = null,
};

/// Streaming output batches persist the journal on the §18 batch window; any
/// path that needs the tail durable NOW (terminate, lease expiry, startup) or
/// that just verified a checkpoint (which evicted the covered journal prefix)
/// forces the rewrite.
const JournalPersist = enum { batched, forced };

fn persistTerminalState(
    state: *terminal_state.TerminalState,
    directory: std.fs.Dir,
    cursor: *PersistenceCursor,
    journal: JournalPersist,
) !void {
    const checkpoint_seq: ?u64 = if (state.checkpointAvailable()) checkpointWireSeq(state) else null;
    const new_checkpoint = checkpoint_seq != null and cursor.checkpoint_seq != checkpoint_seq;
    if (journal == .forced or new_checkpoint) {
        try state.persistJournal(directory);
    } else {
        try state.persistJournalIfDue(directory);
    }
    const seq = checkpoint_seq orelse return;
    if (cursor.checkpoint_seq == seq) return;
    try state.persistCheckpoints(directory);
    cursor.checkpoint_seq = seq;
}

fn refreshRegistration(
    core: *HostCore,
    state: *terminal_state.TerminalState,
) void {
    core.registration.record.output_seq = state.outputSeq();
    core.registration.checkpoint_available = state.checkpointAvailable();
    core.registration.record.checkpoint_seq = checkpointWireSeq(state);
}

fn queueInitialInput(
    allocator: std.mem.Allocator,
    encoder: *RealInputEncoder,
    sink: *PtyQueueSink,
    bytes: []const u8,
) !void {
    if (bytes.len == 0) return;
    var encoded: std.ArrayList(u8) = .{};
    defer {
        if (encoded.capacity > 0) std.crypto.secureZero(u8, encoded.allocatedSlice());
        encoded.deinit(allocator);
    }
    const capacity = bytes.len * input_arbiter.encoded_expansion_factor +
        input_arbiter.encoded_framing_slack;
    try encoded.ensureTotalCapacity(allocator, capacity);
    try encoder.encoder().encode(allocator, bytes, .none, &encoded);
    try sink.arbiterSink().write(encoded.items);
}

const NeutralLiveEvidenceSource = struct {
    core: *HostCore,
    pty: *pty_host.PtyHost,
    state: *terminal_state.TerminalState,

    fn provider(self: *NeutralLiveEvidenceSource) neutral_control_plane.EvidenceProvider {
        return .{ .context = self, .measureFn = measure };
    }

    fn measure(
        context: *anyopaque,
        allocator: std.mem.Allocator,
    ) !neutral_control_plane.LiveEvidence {
        const self: *NeutralLiveEvidenceSource = @ptrCast(@alignCast(context));
        var diagnostics: std.ArrayList([]const u8) = .{};
        const foreground_process_group_id: ?i32 = self.pty.foregroundProcessGroupId() catch null;
        const newest_checkpoint: ?neutral_control_plane.CheckpointSnapshot =
            if (self.state.newestCheckpoint()) |checkpoint| .{
                .contentType = "application/vnd.hive.terminal-checkpoint",
                .schemaVersion = "HVTCP001",
                .throughEventSequence = checkpoint.header.through_seq,
                .throughOutputOffset = checkpoint.header.through_seq,
                .opaqueBytes = checkpoint.opaquePayload(),
            } else null;
        var input_owner: ?neutral_control_plane.WireInputClaim = null;
        // Active claim first; otherwise the retained orphan still names the
        // input owner of record while the arbiter holds HUMAN_ORPHANED (#40).
        if (self.core.active_claim orelse self.core.orphaned_claim) |claim| {
            const kind = std.meta.stringToEnum(
                @FieldType(neutral_control_plane.WireInputClaim, "kind"),
                claim.kind,
            );
            if (kind) |value| {
                input_owner = .{
                    .token = try allocator.dupe(u8, claim.token),
                    .writer = try allocator.dupe(u8, claim.writer),
                    .kind = value,
                    .leaseExpiresAt = try allocator.dupe(u8, claim.lease_expires_at),
                };
            } else {
                try diagnostics.append(allocator, "input-owner-kind-invalid");
            }
        }
        return .{
            .foregroundProcessGroupId = foreground_process_group_id,
            .newestCheckpoint = newest_checkpoint,
            .inputOwner = input_owner,
            .diagnostics = try diagnostics.toOwnedSlice(allocator),
        };
    }
};

fn refreshNeutralRecord(
    registry: *neutral_host.Registry,
    session: neutral_host.SessionRef,
    core: *HostCore,
    pty: *pty_host.PtyHost,
    state: *terminal_state.TerminalState,
) !void {
    const checkpoint = state.newestCheckpoint();
    _ = try registry.update(session, .{
        .window = .{
            .columns = core.registration.record.geometry.columns,
            .rows = core.registration.record.geometry.rows,
            .widthPixels = core.registration.record.geometry.width_px,
            .heightPixels = core.registration.record.geometry.height_px,
        },
        .windowRevision = pty.resizeRevision(),
        .eventSequenceHighWater = state.outputSeq(),
        .output = .{
            .retainedStart = state.retainedOutputStart(),
            .retainedEndExclusive = state.outputSeq(),
            .closed = state.outputClosed(),
        },
        .checkpoints = .{
            .retained = state.retainedCheckpointCount(),
            .newestThroughEventSequence = if (checkpoint) |value| value.header.through_seq else null,
            .newestThroughOutputOffset = if (checkpoint) |value| value.header.through_seq else null,
        },
    });
}

const NeutralHostServing = struct {
    operations: *neutral_control_plane.HostOperations,
    core: *HostCore,

    fn handler(self: *NeutralHostServing) neutral_host.OperationHandler {
        return .{ .context = self, .callFn = call };
    }

    fn call(
        context: *anyopaque,
        request: neutral_host.OperationRequest,
    ) !neutral_host.OperationResponse {
        const self: *NeutralHostServing = @ptrCast(@alignCast(context));
        const response = self.operations.handler().call(request) catch |err| {
            switch (request.operation) {
                .inspect, .terminate => self.core.reconcileNeutralOperationFailure(err) catch {},
                else => {},
            }
            return err;
        };
        if (response.accepted) switch (request.operation) {
            .inspect => self.core.acceptNeutralInspection(response.payload) catch |err| {
                self.core.reconcileNeutralOperationFailure(err) catch {};
                return err;
            },
            .terminate => self.core.acceptNeutralTermination(response.payload) catch |err| {
                self.core.reconcileNeutralOperationFailure(err) catch {};
                return err;
            },
            else => {},
        };
        return response;
    }
};

fn serveNeutralAccepted(
    endpoint: *neutral_host.HostEndpoint,
    stream: std.net.Stream,
    handler: neutral_host.OperationHandler,
    timeout_ms: u64,
) !void {
    defer stream.close();
    const flags = c.fcntl(stream.handle, c.F_GETFL);
    if (flags < 0 or
        c.fcntl(stream.handle, c.F_SETFL, flags & ~@as(c_int, c.O_NONBLOCK)) < 0)
        return error.SocketBlockingFailed;
    try setControlTimeoutMs(stream.handle, timeout_ms);
    try endpoint.serveAccepted(stream, handler);
}

fn runHostLoop(
    runtime: *HostRuntime,
    neutral_registry: *neutral_host.Registry,
    neutral_endpoint: *neutral_host.HostEndpoint,
    neutral_serving: *NeutralHostServing,
    core: *HostCore,
    timer: *std.time.Timer,
    pty: *pty_host.PtyHost,
    state: *terminal_state.TerminalState,
    persistence: *PersistenceCursor,
) !void {
    var attached: ?AttachedViewer = null;
    defer if (attached) |*viewer| {
        core.onViewerDetached(viewer.authorization.viewer_id);
        viewer.close(core.allocator);
        attached = null;
    };
    while (!core.terminated) {
        refreshRegistration(core, state);
        const now_ns = timer.read();
        if (core.lease.expired(now_ns)) {
            try persistTerminalState(state, runtime.directory, persistence, .forced);
            refreshRegistration(core, state);
            _ = try core.enforceVisibilityExpiry(now_ns);
            break;
        }

        if (try runtime.accept()) |stream| {
            const connection_now_ns = timer.read();
            if (core.lease.expired(connection_now_ns)) {
                stream.close();
                try persistTerminalState(state, runtime.directory, persistence, .forced);
                refreshRegistration(core, state);
                _ = try core.enforceVisibilityExpiry(connection_now_ns);
                break;
            }
            // A per-connection setup failure — a peer that reset the socket
            // before setsockopt ran, or a momentary lease-timeout race — drops
            // THIS connection and keeps serving. It must never tear down the
            // host (a single client cannot kill the terminal). A genuine lease
            // expiry is caught by the top-of-loop and pre-accept checks above.
            if (!acceptedConnectionReady(core.lease, stream.handle, connection_now_ns)) {
                std.log.err("host connection setup refused; dropping connection", .{});
                stream.close();
                continue;
            }
            const accepted = serveSessionConnection(
                core.allocator,
                stream,
                core,
                state,
                timer,
            ) catch |err| blk: {
                std.log.err("host connection refused: {s}", .{@errorName(err)});
                break :blk null;
            };
            if (accepted) |viewer| {
                // §26 retarget: a later successful attach for this exact
                // generation supersedes the previous viewer connection.
                if (attached) |*old| {
                    // #40: supersede is an unclean drop for the prior viewer.
                    core.onViewerDetached(old.authorization.viewer_id);
                    old.close(core.allocator);
                }
                attached = viewer;
            } else {
                stream.close();
            }
            continue;
        }

        if (try neutral_endpoint.acceptIfReady()) |stream| {
            errdefer stream.close();
            refreshNeutralRecord(
                neutral_registry,
                neutral_endpoint.session,
                core,
                pty,
                state,
            ) catch |err| {
                std.log.err("neutral host evidence refresh failed: {s}", .{@errorName(err)});
                stream.close();
                continue;
            };
            serveNeutralAccepted(
                neutral_endpoint,
                stream,
                neutral_serving.handler(),
                try leaseBoundControlTimeoutMs(core.lease, now_ns),
            ) catch |err| {
                // A timeout after any partial frame is fatal to this stream;
                // serveNeutralAccepted closes it; the next request is fresh.
                std.log.err("neutral host operation refused: {s}", .{@errorName(err)});
            };
            continue;
        }

        _ = pty.writeDrain() catch |err| switch (err) {
            error.Closed => {},
            else => return err,
        };
        const output = pty.readAvailable() catch |err| switch (err) {
            error.Closed => {
                try persistTerminalState(state, runtime.directory, persistence, .forced);
                refreshRegistration(core, state);
                // Best-effort tail push: every journaled byte reaches the
                // attached viewer before the endpoint closes (§20 drain).
                pumpAttachedViewer(core.allocator, &attached, core, state, timer);
                const response = try core.terminateBound(.immediate, null);
                core.allocator.free(response);
                break;
            },
            else => return err,
        };
        if (output.bytes.len > 0) {
            try state.feedOutput(output.bytes);
            // Streaming batch: journal rewrite rides the §18 batch window;
            // checkpoints still persist the moment they verify.
            try persistTerminalState(state, runtime.directory, persistence, .batched);
            refreshRegistration(core, state);
        }
        pumpAttachedViewer(core.allocator, &attached, core, state, timer);
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

/// Entry point for the same executable's `host` role.
pub fn runHostRole(
    allocator: std.mem.Allocator,
    hive_home: []const u8,
) !void {
    const control: std.net.Stream = .{ .handle = inherited_control_fd };
    defer control.close();
    try setControlTimeout(control.handle);
    const control_file: std.fs.File = .{ .handle = control.handle };
    var boot = try readBootMessage(allocator, control_file.deprecatedReader());
    var boot_owned = true;
    defer if (boot_owned) boot.deinit(allocator);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.create_begin_payload,
        boot.spec_json,
    )) return error.InvalidCreateSpec;
    var spec = try std.json.parseFromSlice(WireCreateSpec, allocator, boot.spec_json, .{
        .ignore_unknown_fields = true,
        // The boot envelope is scrubbed once its input and adoption secret
        // have been transferred into their live owners.
        .allocate = .alloc_always,
    });
    defer spec.deinit();
    if (spec.value.schemaVersion != 1) return error.InvalidCreateSpec;
    try validateSpawnStrings(
        spec.value.cwd,
        spec.value.expectedExecutable,
        spec.value.argv,
    );
    try verifyWorkspaceIdentity(
        spec.value.visibility.workspacePid,
        spec.value.visibility.workspaceStartToken,
    );

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const locator = try parseLocator(a, spec.value.locator);
    const revision = try std.fmt.parseInt(
        u64,
        spec.value.visibility.openTerminalRevision,
        10,
    );
    if (revision == 0) return error.InvalidVisibilityRevision;
    const engine_build_digest = try RealVtEngine.engineBuildId();
    const engine_build_hex = std.fmt.bytesToHex(engine_build_digest, .lower);
    try requireEngineBuildId(locator.engine_build_id);

    var runtime = try HostRuntime.open(
        allocator,
        hive_home,
        locator.session_id,
        boot.adoption_secret,
    );
    defer runtime.deinit();
    var timer = try std.time.Timer.start();
    var timer_clock: TimerClock = .{ .timer = &timer };
    const start_ns = timer.read();

    var pty = try pty_host.PtyHost.init(allocator);
    defer pty.deinit();

    // Production create runs through the neutral host, so a created session is
    // recorded in the registry the neutral control plane enumerates and is
    // covered by the create-idempotency ledger. The terminal itself is still
    // this process's `pty`; the neutral host borrows it.
    var neutral_runtime = try neutral_host.Runtime.open(allocator, hive_home);
    defer neutral_runtime.deinit();
    var neutral_registry = try neutral_host.Registry.open(allocator, &neutral_runtime);
    defer neutral_registry.deinit();
    var direct = neutral_host.DirectHost.init(allocator, &neutral_registry, &pty);
    defer direct.deinit();

    const created = try direct.host().create(.{
        // The neutral host never interprets the key; the Hive session id is
        // simply the opaque name the adapter above already chose.
        .key = locator.session_id,
        // The frozen create-begin payload carries no idempotency key, so it is
        // derived from the create attempt this boot envelope represents: a
        // respawned host replaying the same attempt replays the ledger entry
        // instead of launching a second child.
        .idempotencyKey = spec.value.visibility.openTerminalRevision,
        .command = .{
            .executable = spec.value.argv[0],
            .arguments = spec.value.argv[1..],
            .workingDirectory = spec.value.cwd,
            .completeEnvironment = try environmentEntries(a, spec.value.environment),
            .descriptorMap = &.{},
        },
        // Spelled out to preserve the behaviour of the bare spawn this
        // replaced, which passed no profile and so took the terminal layer's
        // defaults. The frozen spec carries no profile to honour yet.
        .terminalProfile = .{
            .inputMode = .literal,
            .echo = false,
            .signalCharacters = false,
            .softwareFlowControl = false,
            .eofByte = 4,
            .startByte = 17,
            .stopByte = 19,
            .hangupOnLastClose = true,
        },
        .initialWindow = .{
            .columns = spec.value.geometry.columns,
            .rows = spec.value.geometry.rows,
            .widthPixels = spec.value.geometry.widthPx,
            .heightPixels = spec.value.geometry.heightPx,
        },
    });
    const launch = switch (created.outcome) {
        .running => |value| value,
        .@"exec-failed" => |failure| {
            std.log.err("provider exec failed at {s}: {s}", .{
                @tagName(failure.layer),
                failure.diagnostic,
            });
            return error.ProviderExecFailed;
        },
        .exited, .unknown => return error.ProviderExecFailed,
    };
    // Evidence the frozen create result does not carry, measured by the create.
    const launch_evidence = direct.launch_evidence orelse return error.ProviderExecFailed;
    var neutral_endpoint = try neutral_host.HostEndpoint.open(
        allocator,
        &neutral_runtime,
        created.session,
    );
    defer neutral_endpoint.deinit();
    var sink: PtyQueueSink = .{ .pty = &pty };
    const real_engine = try RealVtEngine.create(
        allocator,
        spec.value.geometry.columns,
        spec.value.geometry.rows,
        sink.effectSink(),
    );
    var state = terminal_state.TerminalState.init(
        allocator,
        real_engine.engine(),
        RealVtEngine.factory(),
        .{ .context = &timer_clock, .nowFn = TimerClock.now },
        &engine_build_digest,
        .{
            .columns = spec.value.geometry.columns,
            .rows = spec.value.geometry.rows,
            .cell_width_px_16_16 = try geometryFixed16_16(spec.value.geometry.cellWidthPx),
            .cell_height_px_16_16 = try geometryFixed16_16(spec.value.geometry.cellHeightPx),
        },
    );
    defer state.deinit();
    const real_encoder = try RealInputEncoder.create(allocator, real_engine);
    defer real_encoder.deinit();
    var arbiter = input_arbiter.InputArbiter.init(
        allocator,
        sink.arbiterSink(),
        real_encoder.encoder(),
        real_encoder.cancelEncoder(),
    );
    defer arbiter.deinit();
    try queueInitialInput(allocator, real_encoder, &sink, boot.initial_input);
    var persistence: PersistenceCursor = .{};
    try persistTerminalState(&state, runtime.directory, &persistence, .forced);

    const host_identity = switch (process_inspector.observeProcess(c.getpid())) {
        .present => |identity| identity,
        .absent, .unobservable => return error.HostIdentityUnavailable,
    };
    var host_token_storage: [64]u8 = undefined;
    const host_token = try host_identity.start_token.format(&host_token_storage);
    // Already formatted by the create that measured it.
    const root_token = launch.child.startToken;
    const host_executable = host_identity.executablePath();
    if (host_executable.len == 0) return error.HostIdentityUnavailable;
    const host_build_id = try executableBuildHash(allocator, host_executable);
    defer allocator.free(host_build_id);
    var created_storage: [24]u8 = undefined;
    var expiry_storage: [24]u8 = undefined;
    const created_at = try broker.wallDeadline(&created_storage, 0);
    const expires_at = try broker.wallDeadline(
        &expiry_storage,
        generated.limits.visibility_expiry_ms,
    );
    const registration: HostRegistration = .{
        .record = .{
            .locator = locator,
            .host_pid = c.getpid(),
            .host_start_token = try a.dupe(u8, host_token),
            .process_root = .{
                .pid = launch.child.processId,
                .start_token = try a.dupe(u8, root_token),
                .process_group_id = launch.jobControl.childProcessGroupId,
            },
            .expected_executable = spec.value.expectedExecutable,
            .executable_build_hash = try a.dupe(u8, host_build_id),
            .engine_build_id = try a.dupe(u8, &engine_build_hex),
            .protocol_major = generated.protocol_major,
            .protocol_minor = generated.protocol_minor,
            .geometry = .{
                .columns = @intCast(spec.value.geometry.columns),
                .rows = @intCast(spec.value.geometry.rows),
                .width_px = spec.value.geometry.widthPx,
                .height_px = spec.value.geometry.heightPx,
                .cell_width_px = spec.value.geometry.cellWidthPx,
                .cell_height_px = spec.value.geometry.cellHeightPx,
            },
            .state = .live,
            .visibility = .{
                .state = .attaching,
                .workspace_session_id = spec.value.visibility.workspaceSessionId,
                .open_terminal_revision = revision,
                .expires_mono_ns = try std.math.add(
                    u64,
                    start_ns,
                    generated.limits.visibility_expiry_ms * std.time.ns_per_ms,
                ),
            },
            .output_seq = state.outputSeq(),
            .checkpoint_seq = checkpointWireSeq(&state),
        },
        .expires_at = try a.dupe(u8, expires_at),
        .created_at = try a.dupe(u8, created_at),
        .checkpoint_available = state.checkpointAvailable(),
        .executable_verified = std.mem.eql(
            u8,
            launch_evidence.executable,
            spec.value.expectedExecutable,
        ),
        .complete = launch_evidence.rootSnapshotStatus == .stable,
    };
    var core = try HostCore.init(
        allocator,
        registration,
        boot.adoption_secret,
        host_executable,
        "pending-registration",
        start_ns,
    );
    defer core.deinit();
    core.bindTermination(.{
        .pty = &pty,
        .directory = runtime.directory,
        .arbiter = &arbiter,
    });
    var neutral_evidence: NeutralLiveEvidenceSource = .{
        .core = &core,
        .pty = &pty,
        .state = &state,
    };
    var neutral_platform = process_inspector.RealPlatform.init();
    var neutral_operations = try neutral_control_plane.HostOperations.init(
        allocator,
        &neutral_registry,
        neutral_endpoint.session,
        neutral_platform.platform(),
        neutral_evidence.provider(),
        neutral_control_plane.EvidenceClock.system(),
    );
    defer neutral_operations.deinit();
    var neutral_serving: NeutralHostServing = .{
        .operations = &neutral_operations,
        .core = &core,
    };
    boot.deinit(allocator);
    boot_owned = false;
    errdefer if (!core.terminated) {
        const response = core.terminateBound(.immediate, "HOST_START_FAILED") catch null;
        if (response) |bytes| allocator.free(bytes);
    };

    const broker_build_id = try serveRegistrationAfterBoot(
        allocator,
        control,
        core.registration,
        host_build_id,
        start_ns,
    );
    defer allocator.free(broker_build_id);
    core.broker_build_id = broker_build_id;
    try runHostLoop(
        &runtime,
        &neutral_registry,
        &neutral_endpoint,
        &neutral_serving,
        &core,
        &timer,
        &pty,
        &state,
        &persistence,
    );
}

test "ready neutral endpoint drops a timed-out partial frame" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(
        &root_storage,
        "/tmp/nho-{x}",
        .{std.crypto.random.int(u64)},
    );
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var root_directory = try std.fs.openDirAbsolute(root, .{});
    try root_directory.chmod(0o700);
    root_directory.close();

    var runtime = try neutral_host.Runtime.open(std.testing.allocator, root);
    defer runtime.deinit();
    var registry = try neutral_host.Registry.open(std.testing.allocator, &runtime);
    defer registry.deinit();
    const reserved = try registry.reserve(
        "partial-frame-proof",
        "partial-frame-proof-create",
        @splat(0x41),
        .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    );
    const session = switch (reserved) {
        .reserved => |record| record.session,
        .existing => return error.UnexpectedNeutralSessionReplay,
    };
    var endpoint = try neutral_host.HostEndpoint.open(
        std.testing.allocator,
        &runtime,
        session,
    );
    defer endpoint.deinit();
    try std.testing.expect((try endpoint.acceptIfReady()) == null);

    const client = try std.net.connectUnixSocket(endpoint.socketPath);
    defer client.close();
    var accepted: ?std.net.Stream = null;
    var attempts: usize = 0;
    while (accepted == null and attempts < 100) : (attempts += 1) {
        accepted = try endpoint.acceptIfReady();
        if (accepted == null) std.Thread.sleep(std.time.ns_per_ms);
    }
    const server = accepted orelse return error.NeutralEndpointNotReady;
    try client.writeAll("NHOP");

    const NeverCalled = struct {
        called: bool = false,

        fn operation(
            context: *anyopaque,
            _: neutral_host.OperationRequest,
        ) !neutral_host.OperationResponse {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.called = true;
            return .{ .payload = "unexpected" };
        }

        fn handler(self: *@This()) neutral_host.OperationHandler {
            return .{ .context = self, .callFn = operation };
        }
    };
    var handler: NeverCalled = .{};
    if (serveNeutralAccepted(&endpoint, server, handler.handler(), 5)) |_| {
        return error.PartialOperationFrameAccepted;
    } else |_| {}
    try std.testing.expect(!handler.called);
}

test "WELCOME engine build id passes create validation and a wrong id fails" {
    const welcome_engine_build_id = try broker.engineBuildIdHex();
    try requireEngineBuildId(&welcome_engine_build_id);
    var wrong = welcome_engine_build_id;
    wrong[0] = if (wrong[0] == '0') '1' else '0';
    try std.testing.expectError(error.EngineMismatch, requireEngineBuildId(&wrong));
}

test "visibility lease self-expires at the generated fifteen second bound" {
    var lease = try VisibilityLease.initial("workspace-1", 7, 1_000);
    const lifetime = generated.limits.visibility_expiry_ms * std.time.ns_per_ms;
    try std.testing.expect(!lease.expired(1_000 + lifetime - 1));
    try std.testing.expect(lease.expired(1_000 + lifetime));
    try std.testing.expectEqualStrings("expired", @tagName(lease.state));
}

test "visibility positive control rejects stale and cross-workspace renewals" {
    var lease = try VisibilityLease.initial("workspace-1", 7, 1_000);
    try std.testing.expectError(
        error.VisibilityForbidden,
        lease.renew("workspace-2", 8, 2_000),
    );
    try std.testing.expectError(
        error.StaleVisibilityRevision,
        lease.renew("workspace-1", 6, 2_000),
    );
    try lease.renew("workspace-1", 8, 2_000);
    try std.testing.expectEqual(@as(u64, 8), lease.open_terminal_revision);
}

test "host registration confirms a future lease bounded by fifteen seconds" {
    var valid_storage: [24]u8 = undefined;
    const valid = try broker.wallDeadline(
        &valid_storage,
        generated.limits.visibility_expiry_ms,
    );
    const remaining = try validatedHostLeaseRemaining(valid);
    try std.testing.expect(remaining > 0);
    try std.testing.expect(
        remaining <= generated.limits.visibility_expiry_ms * std.time.ns_per_ms,
    );

    var unbounded_storage: [24]u8 = undefined;
    const unbounded = try broker.wallDeadline(
        &unbounded_storage,
        generated.limits.visibility_expiry_ms + 1_000,
    );
    try std.testing.expectError(
        error.InvalidTimestamp,
        validatedHostLeaseRemaining(unbounded),
    );
}

test "accepted broker sockets cannot outlive the visibility deadline" {
    const start_ns: u64 = 1_000;
    const lease = try VisibilityLease.initial("workspace-1", 7, start_ns);
    try std.testing.expectEqual(
        generated.limits.control_rpc_timeout_ms,
        try leaseBoundControlTimeoutMs(lease, start_ns),
    );
    try std.testing.expectEqual(
        @as(u64, 1),
        try leaseBoundControlTimeoutMs(lease, lease.expires_mono_ns - 1),
    );
    try std.testing.expectError(
        error.VisibilityExpired,
        leaseBoundControlTimeoutMs(lease, lease.expires_mono_ns),
    );
}

test "spawn strings reject C ABI truncation with a valid control" {
    const valid_argv = [_][]const u8{ "/bin/sh", "-c" };
    try validateSpawnStrings("/tmp", "/bin/sh", &valid_argv);

    const invalid_argv = [_][]const u8{"/bin/sh\x00ignored"};
    try std.testing.expectError(
        error.InvalidCreateSpec,
        validateSpawnStrings("/tmp", "/bin/sh", &invalid_argv),
    );
    try std.testing.expectError(
        error.InvalidCreateSpec,
        validateSpawnStrings("/tmp\x00ignored", "/bin/sh", &valid_argv),
    );
}

test "terminal cell metrics fail closed before 16.16 conversion" {
    try std.testing.expectEqual(
        @as(u32, 10 << 16),
        try geometryFixed16_16(10),
    );
    try std.testing.expectError(
        error.InvalidGeometry,
        geometryFixed16_16(100_000),
    );
    try std.testing.expectError(
        error.InvalidGeometry,
        geometryFixed16_16(0),
    );
}

test "environment strings reject ambiguous execve entries with a valid control" {
    var valid = try std.json.parseFromSlice(
        std.json.Value,
        std.testing.allocator,
        "{\"KEY\":\"value\"}",
        .{},
    );
    defer valid.deinit();
    var valid_arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer valid_arena.deinit();
    const entries = try environmentStrings(valid_arena.allocator(), valid.value);
    try std.testing.expectEqual(@as(usize, 1), entries.len);
    try std.testing.expectEqualStrings("KEY=value", entries[0]);

    const invalid_json = [_][]const u8{
        "{\"\":\"value\"}",
        "{\"BAD=KEY\":\"value\"}",
        "{\"KEY\":\"before\\u0000after\"}",
    };
    for (invalid_json) |source| {
        var parsed = try std.json.parseFromSlice(
            std.json.Value,
            std.testing.allocator,
            source,
            .{},
        );
        defer parsed.deinit();
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        try std.testing.expectError(
            error.InvalidEnvironment,
            environmentStrings(arena.allocator(), parsed.value),
        );
    }
}

test "bridge export is copied into the caller Zig allocator" {
    const Fixture = struct {
        bytes: [4]u8 = .{ 1, 2, 3, 4 },
        freed: bool = false,

        fn exportBytes(context: *anyopaque, out: *?[*]u8, len: *usize) !void {
            const self: *@This() = @ptrCast(@alignCast(context));
            out.* = @ptrCast(&self.bytes);
            len.* = self.bytes.len;
        }

        fn free(context: *anyopaque, _: [*]u8, _: usize) void {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.freed = true;
        }
    };
    var fixture: Fixture = .{};
    const copied = try (BridgeExport{
        .context = &fixture,
        .exportFn = Fixture.exportBytes,
        .freeFn = Fixture.free,
    }).copyInto(std.testing.allocator);
    defer std.testing.allocator.free(copied);
    try std.testing.expect(fixture.freed);
    try std.testing.expectEqualSlices(u8, &fixture.bytes, copied);
    try std.testing.expect(@intFromPtr(copied.ptr) != @intFromPtr(&fixture.bytes));
}

test "live VT effects use only the bounded PTY sink with an audit control" {
    const Recorder = struct {
        bytes: std.ArrayList(u8) = .{},

        fn write(context: *anyopaque, bytes: []const u8) !void {
            const self: *@This() = @ptrCast(@alignCast(context));
            try self.bytes.appendSlice(std.testing.allocator, bytes);
        }
    };
    var recorder: Recorder = .{};
    defer recorder.bytes.deinit(std.testing.allocator);
    const live = try RealVtEngine.create(std.testing.allocator, 80, 24, .{
        .context = &recorder,
        .writeFn = Recorder.write,
    });
    defer live.engine().deinit();
    const reply = "terminal-reply";
    RealVtEngine.writePtyCallback(live.terminal, live, reply.ptr, reply.len);
    try std.testing.expectEqualStrings(reply, recorder.bytes.items);
    try std.testing.expectEqual(@as(usize, 0), live.effects.items.len);
    try std.testing.expect(!live.effect_failed);
    RealVtEngine.writePtyCallback(live.terminal, live, null, 0);
    try std.testing.expect(!live.effect_failed);
    RealVtEngine.writePtyCallback(live.terminal, live, null, 1);
    try std.testing.expect(live.effect_failed);

    const audit = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    defer audit.engine().deinit();
    RealVtEngine.writePtyCallback(audit.terminal, audit, reply.ptr, reply.len);
    try std.testing.expectEqualStrings(reply, audit.effects.items);
}

test "real libghostty-vt export is copied and TerminalState is sole engine owner" {
    const TestClock = struct {
        fn now(_: *anyopaque) u64 {
            return 1;
        }
    };
    var clock_context: u8 = 0;
    const real_engine = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    const engine = real_engine.engine();
    try engine.write("hello\x1b[31m world");
    const exported = try engine.exportOpaque(std.testing.allocator);
    defer std.testing.allocator.free(exported);
    try std.testing.expect(exported.len > 0);
    try std.testing.expect(real_engine.last_bridge_address != 0);
    try std.testing.expect(real_engine.last_copy_address == @intFromPtr(exported.ptr));
    try std.testing.expect(real_engine.last_bridge_address != real_engine.last_copy_address);

    const engine_build_id = try RealVtEngine.engineBuildId();
    var state = terminal_state.TerminalState.init(
        std.testing.allocator,
        engine,
        RealVtEngine.factory(),
        .{ .context = &clock_context, .nowFn = TestClock.now },
        &engine_build_id,
        .{
            .columns = 80,
            .rows = 24,
            .cell_width_px_16_16 = 10 << 16,
            .cell_height_px_16_16 = 20 << 16,
        },
    );
    defer state.deinit();
    try state.feedOutput("checkpoint-me");
    try state.tryCheckpoint();
    try std.testing.expect(state.checkpointAvailable());
    try std.testing.expect(checkpointWireSeq(&state) == state.outputSeq());
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var cursor: PersistenceCursor = .{};
    try persistTerminalState(&state, temporary.dir, &cursor, .forced);
    const first_checkpoint = try std.posix.fstatat(
        temporary.dir.fd,
        "checkpoint-0.bin",
        std.posix.AT.SYMLINK_NOFOLLOW,
    );
    try state.feedOutput("tail");
    try persistTerminalState(&state, temporary.dir, &cursor, .forced);
    const unchanged_checkpoint = try std.posix.fstatat(
        temporary.dir.fd,
        "checkpoint-0.bin",
        std.posix.AT.SYMLINK_NOFOLLOW,
    );
    try std.testing.expectEqual(first_checkpoint.ino, unchanged_checkpoint.ino);
    // No real_engine.deinit(): TerminalState owns the injected engine and its
    // deferred deinit is the single destruction path.
}

test "real input encoder uses terminal paste mode and separate Ghostty keys" {
    const real_engine = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    defer real_engine.engine().deinit();
    const encoder = try RealInputEncoder.create(std.testing.allocator, real_engine);
    defer encoder.deinit();
    var encoded: std.ArrayList(u8) = .{};
    defer {
        if (encoded.capacity > 0) std.crypto.secureZero(u8, encoded.allocatedSlice());
        encoded.deinit(std.testing.allocator);
    }
    try encoded.ensureTotalCapacity(std.testing.allocator, 256);

    try encoder.encoder().encode(
        std.testing.allocator,
        "hello\nunsafe\x1b",
        .none,
        &encoded,
    );
    try std.testing.expectEqualStrings("hello\runsafe ", encoded.items);

    encoded.clearRetainingCapacity();
    try real_engine.engine().write("\x1b[?2004h");
    try encoder.encoder().encode(
        std.testing.allocator,
        "body",
        .@"return",
        &encoded,
    );
    try std.testing.expect(std.mem.startsWith(u8, encoded.items, "\x1b[200~body\x1b[201~"));
    try std.testing.expectEqual(@as(u8, '\r'), encoded.items[encoded.items.len - 1]);

    encoded.clearRetainingCapacity();
    try encoder.cancelEncoder().encode(std.testing.allocator, &encoded);
    try std.testing.expectEqualStrings("\x03", encoded.items);
}

test "final evidence is O_EXCL and preserves the first writer" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const evidence: FinalEvidence = .{
        .state = "terminated",
        .exitCode = 0,
        .exitSignal = null,
        .waitObserved = true,
        .outputSeq = "12",
        .checkpointSeq = "8",
        .survivors = &.{},
        .errors = &.{},
        .failureCode = null,
    };
    try writeFinalExclusive(std.testing.allocator, tmp.dir, evidence);
    try std.testing.expectError(
        error.PathAlreadyExists,
        writeFinalExclusive(std.testing.allocator, tmp.dir, evidence),
    );
    const file = try tmp.dir.openFile("final.json", .{ .mode = .read_only });
    defer file.close();
    const contents = try file.readToEndAlloc(std.testing.allocator, 4096);
    defer std.testing.allocator.free(contents);
    try std.testing.expect(std.mem.indexOf(u8, contents, "\"waitObserved\":true") != null);
}

test "host runtime accepts the broker layout and rejects a public sessiond directory" {
    var path_storage: [96]u8 = undefined;
    const root = try std.fmt.bufPrint(
        &path_storage,
        "/tmp/h{x}",
        .{std.crypto.random.int(u32)},
    );
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var broker_runtime = try broker.Runtime.open(std.testing.allocator, root);
    defer broker_runtime.deinit();
    const session_id = "ses_018f1e90-7b5a-7cc0-8000-0000000000a1";
    var directory = try broker_runtime.openHostDirectory(session_id, true);
    const secret = try broker.createAdoptionSecret(directory);
    directory.close();

    var home = try std.fs.openDirAbsolute(root, .{});
    defer home.close();
    var runtime_parent = try home.openDir("runtime", .{ .no_follow = true });
    defer runtime_parent.close();
    try runtime_parent.chmod(0o755);
    var host_runtime = try HostRuntime.open(
        std.testing.allocator,
        root,
        session_id,
        secret,
    );
    host_runtime.deinit();

    try broker_runtime.directory.chmod(0o755);
    try std.testing.expectError(
        error.DirectorySubstitution,
        HostRuntime.open(std.testing.allocator, root, session_id, secret),
    );
}

fn fixtureRegistration() HostRegistration {
    return .{
        .record = .{
            .locator = .{
                .instance_id = "instance-a",
                .session_id = "ses_01890f9e-7b9a-7cc2-8e2b-8c6b8b8b8b8b",
                .generation = 1,
                .subject = .{ .agent = "agent-a" },
                .host_kind = .sessiond,
                .engine_build_id = "engine-build-a",
            },
            .host_pid = 123,
            .host_start_token = "100:2",
            .process_root = .{
                .pid = 124,
                .start_token = "101:3",
                .process_group_id = 124,
            },
            .expected_executable = "/usr/bin/true",
            .executable_build_hash = "host-build-a",
            .engine_build_id = "engine-build-a",
            .protocol_major = generated.protocol_major,
            .protocol_minor = generated.protocol_minor,
            .geometry = .{
                .columns = 80,
                .rows = 24,
                .width_px = 800,
                .height_px = 480,
                .cell_width_px = 10,
                .cell_height_px = 20,
            },
            .state = .live,
            .visibility = .{
                .state = .attaching,
                .workspace_session_id = "workspace-a",
                .open_terminal_revision = 1,
                .expires_mono_ns = 15 * std.time.ns_per_s,
            },
            .output_seq = 0,
            .checkpoint_seq = 0,
        },
        .expires_at = "2026-07-17T14:30:15.000Z",
        .created_at = "2026-07-17T14:30:00.000Z",
        .checkpoint_available = false,
        .executable_verified = true,
        .complete = true,
    };
}

const TestIdentityEncoder = struct {
    context: u8 = 0,

    fn encoder(self: *TestIdentityEncoder) input_arbiter.Encoder {
        return .{ .context = self, .encodeFn = encode };
    }

    fn cancelEncoder(self: *TestIdentityEncoder) input_arbiter.CancelEncoder {
        return .{ .context = self, .encodeFn = cancel };
    }

    fn encode(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        body: []const u8,
        submit: input_arbiter.SubmitAction,
        out: *std.ArrayList(u8),
    ) anyerror!void {
        _ = context;
        _ = submit;
        try out.appendSlice(allocator, body);
    }

    fn cancel(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        out: *std.ArrayList(u8),
    ) anyerror!void {
        _ = context;
        _ = allocator;
        _ = out;
    }
};

test "HOST_REGISTER record and CREATED use generated strict schemas" {
    const registration = fixtureRegistration();
    const host_register = try encodeHostRegister(std.testing.allocator, registration);
    defer std.testing.allocator.free(host_register);
    const record = try encodeRecordJson(std.testing.allocator, registration);
    defer std.testing.allocator.free(record);
    const created = try encodeCreatedPayload(std.testing.allocator, registration);
    defer std.testing.allocator.free(created);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.host_register_payload,
        host_register,
    ));
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.host_record_v1,
        record,
    ));
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.created_payload,
        created,
    ));
}

const RegistrationThread = struct {
    stream: std.net.Stream,
    registration: HostRegistration,
    failure: ?anyerror = null,
    boot: ?BootMessage = null,

    fn run(self: *@This()) void {
        self.boot = serveInheritedRegistration(
            std.heap.c_allocator,
            self.stream,
            self.registration,
            self.registration.record.executable_build_hash,
            99,
        ) catch |err| {
            self.failure = err;
            return;
        };
    }
};

fn socketPair() ![2]std.net.Stream {
    var sockets: [2]c_int = .{ -1, -1 };
    if (c.socketpair(c.AF_UNIX, c.SOCK_STREAM, 0, &sockets) != 0)
        return error.SocketPairFailed;
    return .{
        .{ .handle = sockets[0] },
        .{ .handle = sockets[1] },
    };
}

test "inherited control fd completes HELLO and HOST_REGISTER before publication" {
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var expiry_storage: [24]u8 = undefined;
    var registration = fixtureRegistration();
    registration.expires_at = try broker.wallDeadline(
        &expiry_storage,
        generated.limits.visibility_expiry_ms,
    );
    var host: RegistrationThread = .{
        .stream = sockets[1],
        .registration = registration,
    };
    const thread = try std.Thread.spawn(.{}, RegistrationThread.run, .{&host});
    var thread_joined = false;
    defer if (!thread_joined) {
        _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);
        thread.join();
    };
    const secret: [32]u8 = @splat(0x5a);
    var parsed = try completeInheritedRegistration(
        std.testing.allocator,
        sockets[0],
        "{\"schemaVersion\":1}",
        "initial",
        secret,
        "broker-build-a",
        "instance-a",
    );
    defer parsed.deinit(std.testing.allocator);
    thread.join();
    thread_joined = true;
    try std.testing.expect(host.failure == null);
    var boot = &(host.boot orelse return error.MissingBootMessage);
    defer boot.deinit(std.heap.c_allocator);
    try std.testing.expectEqualStrings("initial", boot.initial_input);
    try std.testing.expectEqualSlices(u8, &secret, &boot.adoption_secret);
    try std.testing.expectEqualStrings(
        fixtureRegistration().record.locator.session_id,
        parsed.registration.record.locator.session_id,
    );
    try std.testing.expect(
        parsed.registration.record.visibility.expires_mono_ns > 0 and
            parsed.registration.record.visibility.expires_mono_ns <=
                generated.limits.visibility_expiry_ms * std.time.ns_per_ms,
    );
}

test "pending HOST_REGISTER remains unpublished after a typed rejection" {
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var expiry_storage: [24]u8 = undefined;
    var registration = fixtureRegistration();
    registration.expires_at = try broker.wallDeadline(
        &expiry_storage,
        generated.limits.visibility_expiry_ms,
    );
    var host: RegistrationThread = .{
        .stream = sockets[1],
        .registration = registration,
    };
    const thread = try std.Thread.spawn(.{}, RegistrationThread.run, .{&host});
    var thread_joined = false;
    defer if (!thread_joined) {
        _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);
        thread.join();
    };
    var pending = try beginInheritedRegistration(
        std.testing.allocator,
        sockets[0],
        "{\"schemaVersion\":1}",
        "initial",
        @splat(0x6b),
        "broker-build-a",
        "instance-a",
    );
    defer pending.parsed.deinit(std.testing.allocator);
    try writeHostFailure(
        std.testing.allocator,
        sockets[0],
        pending.request_header,
        .not_ready,
    );
    thread.join();
    thread_joined = true;
    const failure = host.failure orelse return error.MissingHostRejection;
    try std.testing.expectEqualStrings("HostRegistrationRefused", @errorName(failure));
    try std.testing.expect(host.boot == null);
}

test "HostLauncher positive control observes failed same-role exec" {
    var child = try spawnHostProcess(std.testing.allocator, "/definitely/not/hive-sessiond");
    defer child.stream.close();
    var status: c_int = 0;
    try std.testing.expectEqual(child.pid, c.waitpid(child.pid, &status, 0));
    const wait_status: u32 = @bitCast(status);
    try std.testing.expect(std.posix.W.IFEXITED(wait_status));
    try std.testing.expectEqual(@as(u32, 127), std.posix.W.EXITSTATUS(wait_status));
}

test "admitted HOST_REGISTER write failure reaps and removes the launch client" {
    var sockets = try socketPair();
    var pending_stream_open = true;
    defer {
        if (pending_stream_open) sockets[0].close();
    }
    defer sockets[1].close();
    const no_sigpipe: c_int = 1;
    if (c.setsockopt(
        sockets[0].handle,
        c.SOL_SOCKET,
        c.SO_NOSIGPIPE,
        &no_sigpipe,
        @sizeOf(c_int),
    ) != 0 or c.shutdown(sockets[0].handle, c.SHUT_WR) != 0)
        return error.SocketWriteFailureUnavailable;

    const pid = c.fork();
    if (pid < 0) return error.HostForkFailed;
    if (pid == 0) {
        sockets[0].close();
        sockets[1].close();
        c._exit(0);
    }
    var child_reaped = false;
    defer if (!child_reaped) killAndWait(@intCast(pid));

    var expiry_storage: [24]u8 = undefined;
    var registration = fixtureRegistration();
    registration.record.host_pid = @intCast(pid);
    registration.expires_at = try broker.wallDeadline(
        &expiry_storage,
        generated.limits.visibility_expiry_ms,
    );
    const payload = try encodeHostRegister(std.testing.allocator, registration);
    defer std.testing.allocator.free(payload);
    var parsed = try parseRegistration(std.testing.allocator, payload);
    var parsed_owned = true;
    defer if (parsed_owned) parsed.deinit(std.testing.allocator);

    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var wire = try broker.WireHostClient.init(
        std.testing.allocator,
        temporary.dir,
        "/tmp/not-used-host.sock",
        .{ .device = 1, .inode = 2, .owner_uid = std.posix.getuid(), .mode = 0o600 },
        parsed.registration.record,
        "broker-build-a",
    );
    var wire_owned = true;
    defer if (wire_owned) wire.deinit();

    var launcher: ProductionHostLauncher = .{
        .allocator = std.testing.allocator,
        .canonical_home = try std.testing.allocator.dupe(u8, "/tmp"),
    };
    defer launcher.deinit();
    const client = try std.testing.allocator.create(LaunchClient);
    client.* = .{
        .allocator = std.testing.allocator,
        .parsed = parsed,
        .wire = wire,
        .host_pid = @intCast(pid),
        .adoption_secret = @splat(0),
        .pending_id = 1,
        .pending_stream = sockets[0],
        .pending_header = .{
            .minor = generated.protocol_minor,
            .type_code = generated.frame_type.host_register,
            .flags = 0,
            .payload_length = 0,
            .request_id = 2,
            .stream_seq = 0,
        },
    };
    try launcher.clients.append(std.testing.allocator, client);
    parsed_owned = false;
    wire_owned = false;
    pending_stream_open = false;

    try std.testing.expect(!try launcher.finalizeOne(1, .admitted));
    var status: c_int = 0;
    var waited = c.waitpid(pid, &status, c.WNOHANG);
    var attempts: u8 = 0;
    while (waited == 0 and attempts < 100) : (attempts += 1) {
        std.Thread.sleep(std.time.ns_per_ms);
        waited = c.waitpid(pid, &status, c.WNOHANG);
    }
    if (waited == pid or (waited < 0 and std.posix.errno(waited) == .CHILD))
        child_reaped = true;
    try std.testing.expect(waited < 0 and std.posix.errno(waited) == .CHILD);
    try std.testing.expectEqual(@as(usize, 0), launcher.clients.items.len);
}

test "HostLauncher child closes broker descriptors above inherited fd 3" {
    var pipe_fds: [2]c_int = undefined;
    if (c.pipe(&pipe_fds) != 0) return error.PipeFailed;
    defer _ = c.close(pipe_fds[0]);
    var write_fd = pipe_fds[1];
    defer {
        if (write_fd >= 0) _ = c.close(write_fd);
    }
    if (write_fd <= inherited_control_fd) {
        const duplicate = c.fcntl(write_fd, c.F_DUPFD, inherited_control_fd + 1);
        if (duplicate < 0) return error.DescriptorDuplicateFailed;
        _ = c.close(write_fd);
        write_fd = duplicate;
    }
    const pid = c.fork();
    if (pid < 0) return error.HostForkFailed;
    if (pid == 0) {
        _ = c.close(pipe_fds[0]);
        closeHostInheritedDescriptors(c.getdtablesize());
        const byte: u8 = 1;
        const wrote = c.write(write_fd, &byte, 1);
        c._exit(if (wrote < 0 and std.posix.errno(wrote) == .BADF) 0 else 1);
    }
    _ = c.close(write_fd);
    write_fd = -1;
    var status: c_int = 0;
    if (c.waitpid(pid, &status, 0) != pid) return error.ChildWaitFailed;
    const wait_status: u32 = @bitCast(status);
    try std.testing.expect(std.posix.W.IFEXITED(wait_status));
    try std.testing.expectEqual(@as(u32, 0), std.posix.W.EXITSTATUS(wait_status));
    var byte: [1]u8 = undefined;
    try std.testing.expectEqual(@as(isize, 0), c.read(pipe_fds[0], &byte, 1));
}

fn adoptionChallenge(
    allocator: std.mem.Allocator,
    locator: broker.Locator,
    secret: [32]u8,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const secret_hex = std.fmt.bytesToHex(secret, .lower);
    var root = std.json.ObjectMap.init(a);
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("adoptionSecretHex", .{ .string = try a.dupe(u8, &secret_hex) });
    try root.put("expectedLocator", try locatorValue(a, locator));
    try root.put("brokerBuildId", .{ .string = "host-build-a" });
    try root.put("protocol", try protocolValue(a, generated.protocol_major, generated.protocol_minor));
    try root.put("operation", .{ .string = "adopt" });
    return std.json.Stringify.valueAlloc(allocator, std.json.Value{ .object = root }, .{});
}

test "HOST_ADOPT returns exact identity only for matching secret and live lease" {
    const secret: [32]u8 = @splat(0x7b);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const challenge = try adoptionChallenge(std.testing.allocator, registration.record.locator, secret);
    defer std.testing.allocator.free(challenge);
    const response = try core.adopt(challenge, "host-build-a", 2_000);
    defer std.testing.allocator.free(response);
    try std.testing.expect(core.adopted);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.host_adopt_payload,
        response,
    ));
    try std.testing.expect(std.mem.indexOf(u8, response, "\"executable\":\"/tmp/hive-sessiond\"") != null);
}

test "HOST_ADOPT positive controls reject wrong secret and expired lease" {
    const secret: [32]u8 = @splat(0x7b);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const wrong: [32]u8 = @splat(0x7c);
    const wrong_challenge = try adoptionChallenge(
        std.testing.allocator,
        registration.record.locator,
        wrong,
    );
    defer std.testing.allocator.free(wrong_challenge);
    try std.testing.expectError(
        error.InvalidAdoption,
        core.adopt(wrong_challenge, "host-build-a", 2_000),
    );
    try std.testing.expect(!core.adopted);

    const good_challenge = try adoptionChallenge(
        std.testing.allocator,
        registration.record.locator,
        secret,
    );
    defer std.testing.allocator.free(good_challenge);
    const expired_at = 1_000 + generated.limits.visibility_expiry_ms * std.time.ns_per_ms;
    try std.testing.expectError(
        error.VisibilityExpired,
        core.adopt(good_challenge, "host-build-a", expired_at),
    );
    try std.testing.expect(!core.adopted);
}

const HostConnectionThread = struct {
    stream: std.net.Stream,
    core: *HostCore,
    now_ns: u64,
    failure: ?anyerror = null,

    fn run(self: *@This()) void {
        serveHostConnection(
            std.heap.c_allocator,
            self.stream,
            self.core,
            self.now_ns,
        ) catch |err| {
            self.failure = err;
        };
    }
};

fn writeTestBrokerHello(stream: std.net.Stream, registration: HostRegistration) !void {
    const hello = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .buildId = "host-build-a",
        .instanceId = registration.record.locator.instance_id,
        .protocol = .{
            .major = generated.protocol_major,
            .minMinor = generated.protocol_minor,
            .maxMinor = generated.protocol_minor,
        },
        .clientRole = "broker",
    }, .{});
    defer std.testing.allocator.free(hello);
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.hello,
        .flags = 0,
        .payload_length = @intCast(hello.len),
        .request_id = 1,
        .stream_seq = 0,
    }, hello);
}

fn readTestWelcome(stream: std.net.Stream) !void {
    var welcome = try readRequiredFrame(std.testing.allocator, stream);
    defer welcome.deinit(std.testing.allocator);
    try std.testing.expectEqual(generated.frame_type.welcome, welcome.header.type_code);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.welcome_payload,
        welcome.payload,
    ));
}

fn writeTestAdopt(stream: std.net.Stream, challenge: []const u8) !void {
    try writeTestHostRequest(stream, generated.frame_type.host_adopt, challenge);
}

fn writeTestHostRequest(
    stream: std.net.Stream,
    type_code: u16,
    payload: []const u8,
) !void {
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = type_code,
        .flags = 0,
        .payload_length = @intCast(payload.len),
        .request_id = 2,
        .stream_seq = 0,
    }, payload);
}

test "host.sock dispatcher authenticates HELLO and serves HOST_ADOPT" {
    const secret: [32]u8 = @splat(0x4d);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);

    try writeTestBrokerHello(sockets[0], registration);
    try readTestWelcome(sockets[0]);
    const challenge = try adoptionChallenge(std.testing.allocator, registration.record.locator, secret);
    defer std.testing.allocator.free(challenge);
    try writeTestAdopt(sockets[0], challenge);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();

    try std.testing.expect(server.failure == null);
    try std.testing.expect(core.adopted);
    try std.testing.expectEqual(generated.frame_type.host_adopt, response.header.type_code);
    try std.testing.expectEqual(
        generated.frame_flag.response | generated.frame_flag.final,
        response.header.flags,
    );
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.host_adopt_payload,
        response.payload,
    ));
}

test "host.sock positive control returns typed error for wrong adoption secret" {
    const secret: [32]u8 = @splat(0x4d);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);

    try writeTestBrokerHello(sockets[0], registration);
    try readTestWelcome(sockets[0]);
    const wrong: [32]u8 = @splat(0x4e);
    const challenge = try adoptionChallenge(std.testing.allocator, registration.record.locator, wrong);
    defer std.testing.allocator.free(challenge);
    try writeTestAdopt(sockets[0], challenge);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();

    try std.testing.expect(server.failure == null);
    try std.testing.expect(!core.adopted);
    try std.testing.expectEqual(generated.frame_type.@"error", response.header.type_code);
    try std.testing.expectEqual(
        generated.frame_flag.response |
            generated.frame_flag.final |
            generated.frame_flag.error_flag,
        response.header.flags,
    );
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.error_payload,
        response.payload,
    ));
    try std.testing.expect(std.mem.indexOf(u8, response.payload, "UNAUTHENTICATED") != null);
}

/// Runs one full broker-role adoption handshake over its own connection so
/// later RPC connections meet the privileged-RPC adoption precondition.
fn adoptForTest(core: *HostCore, registration: HostRegistration, secret: [32]u8) !void {
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);
    try writeTestBrokerHello(sockets[0], registration);
    try readTestWelcome(sockets[0]);
    const challenge = try adoptionChallenge(std.testing.allocator, registration.record.locator, secret);
    defer std.testing.allocator.free(challenge);
    try writeTestAdopt(sockets[0], challenge);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();
    try std.testing.expect(server.failure == null);
    try std.testing.expect(core.adopted);
}

/// Serves one broker-role request on a fresh connection and returns the raw
/// response frame; the caller owns (and must deinit) the frame.
fn serveOneBrokerRequest(
    core: *HostCore,
    registration: HostRegistration,
    type_code: u16,
    payload: []const u8,
) !protocol.Frame {
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);
    try writeTestBrokerHello(sockets[0], registration);
    try readTestWelcome(sockets[0]);
    try writeTestHostRequest(sockets[0], type_code, payload);
    const response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    thread.join();
    try std.testing.expect(server.failure == null);
    return response;
}

fn expectUnauthenticatedRefusal(response: *const protocol.Frame) !void {
    try std.testing.expectEqual(generated.frame_type.@"error", response.header.type_code);
    try std.testing.expectEqual(
        generated.frame_flag.response |
            generated.frame_flag.final |
            generated.frame_flag.error_flag,
        response.header.flags,
    );
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.error_payload,
        response.payload,
    ));
    try std.testing.expect(std.mem.indexOf(u8, response.payload, "UNAUTHENTICATED") != null);
}

test "host.sock fails closed for privileged broker RPCs before adoption" {
    const secret: [32]u8 = @splat(0x52);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();

    // GRANT_REGISTER pre-adoption: typed refusal, nothing stored.
    const grant_payload = try grantRegistrationPayload(
        std.testing.allocator,
        @splat(0x92),
        generated.limits.attach_grant_timeout_ms,
    );
    defer std.testing.allocator.free(grant_payload);
    var grant_response = try serveOneBrokerRequest(
        &core,
        registration,
        generated.frame_type.grant_register,
        grant_payload,
    );
    defer grant_response.deinit(std.testing.allocator);
    try expectUnauthenticatedRefusal(&grant_response);
    try std.testing.expectEqual(@as(usize, 0), core.grants.items.len);

    // VISIBILITY_RENEW pre-adoption: typed refusal, lease untouched.
    const workspace = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.MissingWorkspaceIdentity;
    var token_storage: [64]u8 = undefined;
    const token = try workspace.start_token.format(&token_storage);
    const renew_payload = try visibilityRenewPayload(
        std.testing.allocator,
        registration,
        c.getpid(),
        token,
        2,
    );
    defer std.testing.allocator.free(renew_payload);
    var renew_response = try serveOneBrokerRequest(
        &core,
        registration,
        generated.frame_type.visibility_renew,
        renew_payload,
    );
    defer renew_response.deinit(std.testing.allocator);
    try expectUnauthenticatedRefusal(&renew_response);
    try std.testing.expectEqual(@as(u64, 1), core.lease.open_terminal_revision);

    // TERMINATE pre-adoption: typed refusal, host still live.
    const terminate_payload = try terminationPayload(std.testing.allocator, registration, "immediate");
    defer std.testing.allocator.free(terminate_payload);
    var terminate_response = try serveOneBrokerRequest(
        &core,
        registration,
        generated.frame_type.terminate,
        terminate_payload,
    );
    defer terminate_response.deinit(std.testing.allocator);
    try expectUnauthenticatedRefusal(&terminate_response);
    try std.testing.expect(!core.terminated);

    // Positive control: after a real adoption handshake the same RPC serves.
    try adoptForTest(&core, registration, secret);
    var granted_response = try serveOneBrokerRequest(
        &core,
        registration,
        generated.frame_type.grant_register,
        grant_payload,
    );
    defer granted_response.deinit(std.testing.allocator);
    try std.testing.expectEqual(generated.frame_type.grant_register, granted_response.header.type_code);
    try std.testing.expectEqual(@as(usize, 1), core.grants.items.len);
}

test "connection deadline fails closed once the absolute budget is spent" {
    var timer = try std.time.Timer.start();
    const lease = try VisibilityLease.initial("ws-fixture", 1, 0);
    var deadline = try ConnectionDeadline.init(&timer, lease, 1);
    // Shrink the 10 s budget so the test does not wait on wall time.
    deadline.budget_ns = 50 * std.time.ns_per_ms;
    try deadline.check();
    std.Thread.sleep(80 * std.time.ns_per_ms);
    try std.testing.expectError(error.ConnectionDeadlineExceeded, deadline.check());
}

test "slow-dribble connection is dropped at the absolute service deadline" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    const secret: [32]u8 = @splat(0x5e);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    // A ~250 ms residual lease shrinks the absolute budget; without the
    // deadline this partial HELLO would stall the loop for the full per-syscall
    // control_rpc_timeout_ms (and re-arm forever if dribbled).
    core.lease.expires_mono_ns = 1_000 + 250 * std.time.ns_per_ms;
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    var timer = try std.time.Timer.start();
    // Dribble: fewer bytes than one frame header, then silence.
    const partial = [_]u8{0} ** 8;
    try sockets[0].writeAll(&partial);
    thread.join();
    const elapsed = timer.read();
    try std.testing.expect(server.failure != null);
    try std.testing.expect(elapsed < generated.limits.control_rpc_timeout_ms * std.time.ns_per_ms);
    // The loop-side proof that renewal cannot be starved: the connection was
    // dropped within roughly the lease-bound budget, not the 10 s default.
    try std.testing.expect(elapsed < 5 * std.time.ns_per_s);
    try std.testing.expect(!core.adopted);
}

fn inputSubmitPayload(allocator: std.mem.Allocator, key: []const u8) ![]u8 {
    const registration = fixtureRegistration();
    return std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .claimToken = "claim-token",
        .transactionId = key,
        .idempotencyKey = key,
        .operation = .{ .kind = "hangup" },
    }, .{});
}

test "replay ledgers evict the oldest entry beyond the retention cap" {
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();

    var key_storage: [32]u8 = undefined;
    var index: usize = 0;
    while (index < max_replay_entries + 4) : (index += 1) {
        const key = try std.fmt.bufPrint(&key_storage, "input-key-{d}", .{index});
        const payload = try inputSubmitPayload(std.testing.allocator, key);
        defer std.testing.allocator.free(payload);
        // No termination binding: the receipt is "binding unavailable", but the
        // replay entry is still reserved — exactly the client-driven growth the
        // cap exists to bound.
        const applied = try core.submitInput(payload, "viewer-a", 2_000);
        defer core.allocator.free(applied);
        try std.testing.expect(core.input_replays.items.len <= max_replay_entries);
    }
    try std.testing.expectEqual(max_replay_entries, core.input_replays.items.len);
    // FIFO: the four oldest keys evicted, the window retains the newest.
    try std.testing.expectEqualStrings("input-key-4", core.input_replays.items[0].idempotency_key);
    var recent_storage: [32]u8 = undefined;
    const recent_key = try std.fmt.bufPrint(&recent_storage, "input-key-{d}", .{max_replay_entries + 3});
    // Recent-key idempotency still works: a replay hits the ledger (no append).
    const replay_payload = try inputSubmitPayload(std.testing.allocator, recent_key);
    defer std.testing.allocator.free(replay_payload);
    const replayed = try core.submitInput(replay_payload, "viewer-a", 2_000);
    defer core.allocator.free(replayed);
    try std.testing.expectEqual(max_replay_entries, core.input_replays.items.len);

    // The resize ledger shares the cap.
    index = 0;
    while (index < max_replay_entries + 2) : (index += 1) {
        const key = try std.fmt.bufPrint(&key_storage, "resize-key-{d}", .{index});
        _ = try core.reserveResizeReplay(.{
            .schemaVersion = 1,
            .session = .{
                .key = registration.record.locator.session_id,
                .incarnation = "1",
            },
            .window = .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
            .revision = "1",
            .idempotencyKey = key,
        }, 1);
        try std.testing.expect(core.resize_replays.items.len <= max_replay_entries);
    }
    try std.testing.expectEqual(max_replay_entries, core.resize_replays.items.len);
    try std.testing.expectEqualStrings("resize-key-2", core.resize_replays.items[0].idempotency_key);
}

test "host child environment strips DYLD_ but keeps the rest" {
    if (c.setenv("DYLD_HIVE_SCRUB_TEST", "1", 1) != 0) return error.SetEnvironmentFailed;
    defer _ = c.unsetenv("DYLD_HIVE_SCRUB_TEST");
    if (c.setenv("HIVE_SCRUB_KEEP_TEST", "1", 1) != 0) return error.SetEnvironmentFailed;
    defer _ = c.unsetenv("HIVE_SCRUB_KEEP_TEST");
    const scrubbed = try scrubbedHostEnvironment(std.testing.allocator);
    defer std.testing.allocator.free(scrubbed);
    try std.testing.expect(scrubbed.len > 0);
    try std.testing.expect(scrubbed[scrubbed.len - 1] == null);
    var kept = false;
    for (scrubbed) |entry| {
        const text = std.mem.span(entry orelse break);
        try std.testing.expect(!std.mem.startsWith(u8, text, "DYLD_"));
        if (std.mem.startsWith(u8, text, "HIVE_SCRUB_KEEP_TEST=")) kept = true;
    }
    try std.testing.expect(kept);
}

test "null-sink VT effects retention fails closed at the journal ceiling" {
    const audit = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    defer audit.engine().deinit();
    // Simulate a verification engine that already retains the §18 journal
    // ceiling: one more PTY-effect byte must fail closed, not grow the
    // session-lifetime copy without bound.
    try audit.effects.ensureTotalCapacity(std.testing.allocator, terminal_state.journal_max_bytes);
    audit.effects.items.len = terminal_state.journal_max_bytes;
    const reply = "x";
    RealVtEngine.writePtyCallback(audit.terminal, audit, reply.ptr, reply.len);
    try std.testing.expect(audit.effect_failed);
    try std.testing.expectEqual(terminal_state.journal_max_bytes, audit.effects.items.len);
}

fn grantRegistrationPayload(
    allocator: std.mem.Allocator,
    hash: [32]u8,
    additional_ms: u64,
) ![]u8 {
    const hash_hex = std.fmt.bytesToHex(hash, .lower);
    var tagged_storage: [71]u8 = undefined;
    const tagged = try std.fmt.bufPrint(&tagged_storage, "sha256:{s}", .{&hash_hex});
    var expiry_storage: [24]u8 = undefined;
    const expires_at = try broker.wallDeadline(&expiry_storage, additional_ms);
    return std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .grantTokenSha256 = tagged,
        .viewerId = "viewer-a",
        .operations = &[_][]const u8{ "view", "human-input" },
        .expiresAt = expires_at,
        .geometry = .{
            .columns = @as(u16, 80),
            .rows = @as(u16, 24),
            .widthPx = @as(u32, 800),
            .heightPx = @as(u32, 480),
            .cellWidthPx = @as(f64, 10),
            .cellHeightPx = @as(f64, 20),
        },
    }, .{});
}

fn hostAttachPayload(
    allocator: std.mem.Allocator,
    locator: broker.Locator,
    token: []const u8,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var geometry = std.json.ObjectMap.init(a);
    try geometry.put("columns", .{ .integer = 80 });
    try geometry.put("rows", .{ .integer = 24 });
    try geometry.put("widthPx", .{ .integer = 800 });
    try geometry.put("heightPx", .{ .integer = 480 });
    try geometry.put("cellWidthPx", .{ .float = 10 });
    try geometry.put("cellHeightPx", .{ .float = 20 });
    var root = std.json.ObjectMap.init(a);
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("locator", try locatorValue(a, locator));
    try root.put("token", .{ .string = token });
    try root.put("geometry", .{ .object = geometry });
    try root.put("afterSeq", .{ .string = "0" });
    return std.json.Stringify.valueAlloc(allocator, std.json.Value{ .object = root }, .{});
}

const ViewerConnectionThread = struct {
    stream: std.net.Stream,
    core: *HostCore,
    now_ns: u64,
    authorization: ?ViewerAuthorization = null,
    failure: ?anyerror = null,

    fn run(self: *@This()) void {
        self.authorization = authorizeViewerConnection(
            std.heap.c_allocator,
            self.stream,
            self.core,
            self.now_ns,
        ) catch |err| {
            self.failure = err;
            return;
        };
    }
};

fn writeTestViewerHello(
    stream: std.net.Stream,
    registration: HostRegistration,
    token: []const u8,
) !void {
    const hello = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .buildId = "viewer-build-a",
        .instanceId = registration.record.locator.instance_id,
        .protocol = .{
            .major = generated.protocol_major,
            .minMinor = generated.protocol_minor,
            .maxMinor = generated.protocol_minor,
        },
        .clientRole = "viewer",
        .grantToken = token,
    }, .{});
    defer std.testing.allocator.free(hello);
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.hello,
        .flags = 0,
        .payload_length = @intCast(hello.len),
        .request_id = 1,
        .stream_seq = 0,
    }, hello);
}

test "HOST_ATTACH consumes an exact one-use viewer grant" {
    const token = "viewer-capability-a";
    var token_hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(token, &token_hash, .{});
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const registration_payload = try grantRegistrationPayload(
        std.testing.allocator,
        token_hash,
        generated.limits.attach_grant_timeout_ms,
    );
    defer std.testing.allocator.free(registration_payload);
    const accepted = try core.registerGrant(registration_payload, 2_000);
    defer std.testing.allocator.free(accepted);
    const attach_payload = try hostAttachPayload(
        std.testing.allocator,
        registration.record.locator,
        token,
    );
    defer std.testing.allocator.free(attach_payload);

    // Positive control: a different HELLO capability neither authorizes nor
    // consumes the registered grant.
    try std.testing.expectError(
        error.InvalidViewerGrant,
        core.authorizeViewerAttach(attach_payload, "wrong-capability", 3_000),
    );
    try std.testing.expectEqual(@as(usize, 1), core.grants.items.len);

    var authorization = try core.authorizeViewerAttach(attach_payload, token, 3_000);
    defer authorization.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("viewer-a", authorization.viewer_id);
    try std.testing.expect(authorization.operations.view);
    try std.testing.expect(authorization.operations.human_input);
    try std.testing.expectEqual(@as(u64, 0), authorization.after_seq);
    try std.testing.expectEqual(@as(usize, 0), core.grants.items.len);
    try std.testing.expectError(
        error.InvalidViewerGrant,
        core.authorizeViewerAttach(attach_payload, token, 3_000),
    );
}

test "CLAIM_RESULT reports unknown without inventing an owner when the arbiter is unavailable" {
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const payload = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-a",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 1_000),
        .idempotencyKey = "claim-unknown",
    }, .{});
    defer std.testing.allocator.free(payload);
    const result = try core.claimInput(payload, "viewer-a", 2_000);
    defer std.testing.allocator.free(result);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.claim_result_payload,
        result,
    ));
    try std.testing.expect(std.mem.indexOf(u8, result, "\"state\":\"unknown\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "\"owner\"") == null);
}

// #40 RED control: after viewer-a is granted a human claim, a second viewer
// (or the same viewer after a drop without CLAIM_RELEASE) is denied while
// host `active_claim` is never cleared on stream close. Documents the orphan
// / permanent-input-death mechanism until onViewerDetached + claimRelease land.
test "CLAIM_ACQUIRE denied for second viewer while prior active_claim uncleared" {
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    var sink: PtyQueueSink = .{ .pty = &pty };
    var encoder: TestIdentityEncoder = .{};
    var arbiter = input_arbiter.InputArbiter.init(
        std.testing.allocator,
        sink.arbiterSink(),
        encoder.encoder(),
        encoder.cancelEncoder(),
    );
    defer arbiter.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    core.bindTermination(.{ .pty = &pty, .directory = tmp.dir, .arbiter = &arbiter });

    const first = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-a",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-a",
    }, .{});
    defer std.testing.allocator.free(first);
    const granted = try core.claimInput(first, "viewer-a", 2_000);
    defer std.testing.allocator.free(granted);
    try std.testing.expect(std.mem.indexOf(u8, granted, "\"state\":\"granted\"") != null);
    try std.testing.expect(core.active_claim != null);

    // Simulate drop without CLAIM_RELEASE / onViewerDetached (today's host loop).
    const second = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-b",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-b",
    }, .{});
    defer std.testing.allocator.free(second);
    const denied = try core.claimInput(second, "viewer-b", 3_000);
    defer std.testing.allocator.free(denied);
    try std.testing.expect(std.mem.indexOf(u8, denied, "\"state\":\"denied\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, denied, "input already claimed") != null);
    // Host still holds the first claim — second reattach cannot recover without detach.
    try std.testing.expect(core.active_claim != null);

    // Unclean drop path (#40 fix): onViewerDetached clears host claim + orphans arbiter.
    core.onViewerDetached("viewer-a");
    try std.testing.expect(core.active_claim == null);
    try std.testing.expectEqual(input_arbiter.State.human_orphaned, arbiter.currentState());
    // The dropped claim is retained as the input owner of record for
    // inspection (real-host-golden inspects inputOwner after viewer detach).
    try std.testing.expect(core.orphaned_claim != null);
    try std.testing.expectEqualStrings("viewer-a", core.orphaned_claim.?.writer);
    try std.testing.expectEqualStrings("human", core.orphaned_claim.?.kind);
    try std.testing.expect(core.orphaned_claim.?.token.len > 0);
    try std.testing.expect(core.orphaned_claim.?.lease_expires_at.len > 0);

    // Never-steal mutation: automation still cannot take an orphaned human lease.
    const automation = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "automation-contender",
        .kind = "automation",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-auto",
    }, .{});
    defer std.testing.allocator.free(automation);
    const auto_denied = try core.claimInput(automation, "automation-contender", 3_500);
    defer std.testing.allocator.free(auto_denied);
    // Invariant must bite as a real denial — unknown/error paths do not count.
    try std.testing.expect(std.mem.indexOf(u8, auto_denied, "\"state\":\"denied\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, auto_denied, "HumanOrphaned") != null);
    try std.testing.expectEqual(input_arbiter.State.human_orphaned, arbiter.currentState());

    // Returning human (viewer-b as operator resume) is granted a new claim.
    const third = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-b",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-b-resume",
    }, .{});
    defer std.testing.allocator.free(third);
    const resumed = try core.claimInput(third, "viewer-b", 4_000);
    defer std.testing.allocator.free(resumed);
    try std.testing.expect(std.mem.indexOf(u8, resumed, "\"state\":\"granted\"") != null);
    try std.testing.expect(core.active_claim != null);
    // A grant resolves ownership: the retained orphan is gone.
    try std.testing.expect(core.orphaned_claim == null);
    try std.testing.expectEqual(input_arbiter.State.human_owned, arbiter.currentState());

    // Clean CLAIM_RELEASE → FREE; next human acquires without resume.
    const token = core.active_claim.?.token;
    const release_payload = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .claimToken = token,
        .kind = "cancel",
    }, .{});
    defer std.testing.allocator.free(release_payload);
    const released = try core.releaseInput(release_payload, "viewer-b", 5_000);
    defer std.testing.allocator.free(released);
    try std.testing.expect(core.active_claim == null);
    try std.testing.expectEqual(input_arbiter.State.free, arbiter.currentState());

    const fourth = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-c",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-c-clean",
    }, .{});
    defer std.testing.allocator.free(fourth);
    const clean = try core.claimInput(fourth, "viewer-c", 6_000);
    defer std.testing.allocator.free(clean);
    try std.testing.expect(std.mem.indexOf(u8, clean, "\"state\":\"granted\"") != null);
    try std.testing.expectEqual(input_arbiter.State.human_owned, arbiter.currentState());
}

test "VISIBILITY_RENEW extends the active input claim with the lease" {
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    var sink: PtyQueueSink = .{ .pty = &pty };
    var encoder: TestIdentityEncoder = .{};
    var arbiter = input_arbiter.InputArbiter.init(
        std.testing.allocator,
        sink.arbiterSink(),
        encoder.encoder(),
        encoder.cancelEncoder(),
    );
    defer arbiter.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    core.bindTermination(.{ .pty = &pty, .directory = tmp.dir, .arbiter = &arbiter });

    // The viewer's 60 s request clamps to the residual visibility lease, so
    // the claim starts life with the lease's expiry.
    const claim_payload = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-a",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-renewal",
    }, .{});
    defer std.testing.allocator.free(claim_payload);
    const granted = try core.claimInput(claim_payload, "viewer-a", 2_000);
    defer std.testing.allocator.free(granted);
    try std.testing.expect(std.mem.indexOf(u8, granted, "\"state\":\"granted\"") != null);
    // The grant-time clamp floors to whole milliseconds, so the claim starts
    // at or just under the lease expiry — never beyond it.
    try std.testing.expect(core.active_claim.?.expires_mono_ns <= core.lease.expires_mono_ns);

    // Renewing visibility extends the claim too. Without this the claim dies
    // 10–15 s after acquire while the pane is still visible, and the next
    // keystroke is rejected "input claim expired".
    const workspace = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.MissingWorkspaceIdentity;
    var token_storage: [64]u8 = undefined;
    const token = try workspace.start_token.format(&token_storage);
    const renew = try visibilityRenewPayload(
        std.testing.allocator,
        registration,
        c.getpid(),
        token,
        2,
    );
    defer std.testing.allocator.free(renew);
    const renewed = try core.renewVisibility(renew, 10_000);
    defer std.testing.allocator.free(renewed);
    try std.testing.expectEqual(
        @as(u64, 10_000 + generated.limits.visibility_expiry_ms * std.time.ns_per_ms),
        core.lease.expires_mono_ns,
    );
    try std.testing.expectEqual(core.lease.expires_mono_ns, core.active_claim.?.expires_mono_ns);
}

test "INPUT_SUBMIT hangup closes a real PTY and returns a distinct ordered receipt" {
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    _ = switch (try pty.spawn(.{
        .argv = &[_][]const u8{"/bin/cat"},
        .geometry = .{ .columns = 80, .rows = 24 },
    })) {
        .running => |readback| readback,
        .exec_failed => return error.TestUnexpectedResult,
    };
    var sink: PtyQueueSink = .{ .pty = &pty };
    var encoder: TestIdentityEncoder = .{};
    var arbiter = input_arbiter.InputArbiter.init(
        std.testing.allocator,
        sink.arbiterSink(),
        encoder.encoder(),
        encoder.cancelEncoder(),
    );
    defer arbiter.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    core.bindTermination(.{ .pty = &pty, .directory = tmp.dir, .arbiter = &arbiter });

    const claim_payload = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-a",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 1_000),
        .idempotencyKey = "claim-hangup",
    }, .{});
    defer std.testing.allocator.free(claim_payload);
    const claim_result = try core.claimInput(claim_payload, "viewer-a", 2_000);
    defer std.testing.allocator.free(claim_result);
    const Granted = struct { result: struct { claim: struct { token: []const u8 } } };
    var granted = try std.json.parseFromSlice(Granted, std.testing.allocator, claim_result, .{
        .ignore_unknown_fields = true,
    });
    defer granted.deinit();
    const input_payload = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .claimToken = granted.value.result.claim.token,
        .transactionId = "hangup-transaction",
        .idempotencyKey = "hangup-idempotency",
        .operation = .{ .kind = "hangup" },
    }, .{});
    defer std.testing.allocator.free(input_payload);
    const applied = try core.submitInput(input_payload, "viewer-a", 3_000);
    defer std.testing.allocator.free(applied);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.applied_payload,
        applied,
    ));
    const Applied = struct {
        resultKind: []const u8,
        receipt: struct { stage: []const u8, orderedAt: []const u8, byteRange: ?std.json.Value },
    };
    var parsed = try std.json.parseFromSlice(Applied, std.testing.allocator, applied, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    try std.testing.expectEqualStrings("input", parsed.value.resultKind);
    try std.testing.expectEqualStrings("accepted", parsed.value.receipt.stage);
    try std.testing.expectEqualStrings("1", parsed.value.receipt.orderedAt);
    try std.testing.expect(parsed.value.receipt.byteRange == null);
    const exit = try pty.waitExit(true);
    try std.testing.expect(exit.reaped);
}

test "viewer wire authenticates HELLO and validates HOST_ATTACH before streaming" {
    const token = "viewer-capability-wire-a";
    var token_hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(token, &token_hash, .{});
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const registration_payload = try grantRegistrationPayload(
        std.testing.allocator,
        token_hash,
        generated.limits.attach_grant_timeout_ms,
    );
    defer std.testing.allocator.free(registration_payload);
    const accepted = try core.registerGrant(registration_payload, 2_000);
    defer std.heap.c_allocator.free(accepted);

    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: ViewerConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 3_000,
    };
    const thread = try std.Thread.spawn(.{}, ViewerConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);
    try writeTestViewerHello(sockets[0], registration, token);
    try readTestWelcome(sockets[0]);
    const attach = try hostAttachPayload(
        std.testing.allocator,
        registration.record.locator,
        token,
    );
    defer std.testing.allocator.free(attach);
    try writeTestHostRequest(sockets[0], generated.frame_type.host_attach, attach);
    thread.join();

    try std.testing.expect(server.failure == null);
    var authorization = &(server.authorization orelse return error.MissingViewerAuthorization);
    defer authorization.deinit(std.heap.c_allocator);
    try std.testing.expectEqualStrings("viewer-a", authorization.viewer_id);
    try std.testing.expectEqual(@as(usize, 0), core.grants.items.len);
}

test "host.sock GRANT_REGISTER stores only the one-use hash" {
    const secret: [32]u8 = @splat(0x31);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    // Privileged broker RPCs fail closed until adoption (the broker opens one
    // connection per RPC, so adoption runs on its own connection first).
    try adoptForTest(&core, registration, secret);
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);

    try writeTestBrokerHello(sockets[0], registration);
    try readTestWelcome(sockets[0]);
    const hash: [32]u8 = @splat(0x92);
    const payload = try grantRegistrationPayload(
        std.testing.allocator,
        hash,
        generated.limits.attach_grant_timeout_ms,
    );
    defer std.testing.allocator.free(payload);
    try writeTestHostRequest(sockets[0], generated.frame_type.grant_register, payload);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();

    try std.testing.expect(server.failure == null);
    try std.testing.expectEqual(generated.frame_type.grant_register, response.header.type_code);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.grant_register_payload,
        response.payload,
    ));
    try std.testing.expectEqual(@as(usize, 1), core.grants.items.len);
    try std.testing.expectEqualSlices(u8, &hash, &core.grants.items[0].hash);
    try std.testing.expectEqualStrings("viewer-a", core.grants.items[0].viewer_id);
}

test "GRANT_REGISTER positive control rejects an expired grant" {
    const secret: [32]u8 = @splat(0x31);
    var core = try HostCore.init(
        std.testing.allocator,
        fixtureRegistration(),
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const payload = try grantRegistrationPayload(
        std.testing.allocator,
        @splat(0x92),
        0,
    );
    defer std.testing.allocator.free(payload);
    try std.testing.expectError(error.Expired, core.registerGrant(payload, 2_000));
    try std.testing.expectEqual(@as(usize, 0), core.grants.items.len);
}

fn orphanDiscardPayload(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    var root = std.json.ObjectMap.init(arena.allocator());
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("locator", try locatorValue(arena.allocator(), registration.record.locator));
    return std.json.Stringify.valueAlloc(
        allocator,
        std.json.Value{ .object = root },
        .{},
    );
}

// §22 / 2026-07-21 messaging regression. A human claim orphaned by an unclean
// viewer drop denied every automation claim forever, and operatorDiscard had no
// caller. INPUT_ORPHAN_DISCARD is that caller. This walks the whole deadlock:
// claim -> unclean drop -> automation DENIED -> discard -> automation GRANTED.
test "INPUT_ORPHAN_DISCARD ends the HumanOrphaned deadlock and automation is heard again" {
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    var sink: PtyQueueSink = .{ .pty = &pty };
    var encoder: TestIdentityEncoder = .{};
    var arbiter = input_arbiter.InputArbiter.init(
        std.testing.allocator,
        sink.arbiterSink(),
        encoder.encoder(),
        encoder.cancelEncoder(),
    );
    defer arbiter.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    core.bindTermination(.{ .pty = &pty, .directory = tmp.dir, .arbiter = &arbiter });

    const discard_payload = try orphanDiscardPayload(std.testing.allocator, registration);
    defer std.testing.allocator.free(discard_payload);

    // POSITIVE CONTROL: a FREE arbiter is refused, in-band, naming its state.
    // Without this the "discarded":true below could be a constant.
    const free_refusal = try core.discardInputOrphan(discard_payload);
    defer std.testing.allocator.free(free_refusal);
    try std.testing.expect(std.mem.indexOf(u8, free_refusal, "\"discarded\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, free_refusal, "free") != null);

    const human = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-a",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-a",
    }, .{});
    defer std.testing.allocator.free(human);
    const granted = try core.claimInput(human, "viewer-a", 2_000);
    defer std.testing.allocator.free(granted);
    try std.testing.expect(std.mem.indexOf(u8, granted, "\"state\":\"granted\"") != null);

    // NEVER-STEAL CONTROL: a LIVE human claim is refused too. This is the whole
    // #40 invariant; if this ever passes, the discard has become a steal.
    const live_refusal = try core.discardInputOrphan(discard_payload);
    defer std.testing.allocator.free(live_refusal);
    try std.testing.expect(std.mem.indexOf(u8, live_refusal, "\"discarded\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, live_refusal, "human_owned") != null);
    try std.testing.expectEqual(input_arbiter.State.human_owned, arbiter.currentState());

    // The arming condition: the viewer dies without releasing.
    core.onViewerDetached("viewer-a");
    try std.testing.expectEqual(input_arbiter.State.human_orphaned, arbiter.currentState());

    const automation = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "hive-daemon",
        .kind = "automation",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-auto-1",
    }, .{});
    defer std.testing.allocator.free(automation);
    const deadlocked = try core.claimInput(automation, "hive-daemon", 3_000);
    defer std.testing.allocator.free(deadlocked);
    try std.testing.expect(std.mem.indexOf(u8, deadlocked, "\"state\":\"denied\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, deadlocked, "HumanOrphaned") != null);

    // The exit: discard reports the orphan's owner of record and frees input.
    const discarded = try core.discardInputOrphan(discard_payload);
    defer std.testing.allocator.free(discarded);
    try std.testing.expect(std.mem.indexOf(u8, discarded, "\"discarded\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, discarded, "\"priorOwnerViewerId\":\"viewer-a\"") != null);
    try std.testing.expectEqual(input_arbiter.State.free, arbiter.currentState());
    try std.testing.expect(core.orphaned_claim == null);

    // Retry: the same automation claim the deadlock denied is now granted.
    const retry = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "hive-daemon",
        .kind = "automation",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-auto-2",
    }, .{});
    defer std.testing.allocator.free(retry);
    const retried = try core.claimInput(retry, "hive-daemon", 4_000);
    defer std.testing.allocator.free(retried);
    try std.testing.expect(std.mem.indexOf(u8, retried, "\"state\":\"granted\"") != null);
}

fn a3BytesPayload(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
    claim_token: []const u8,
    transaction_id: []const u8,
    idempotency_key: []const u8,
    body: []const u8,
) ![]u8 {
    const encoded = try allocator.alloc(u8, std.base64.standard.Encoder.calcSize(body.len));
    defer allocator.free(encoded);
    _ = std.base64.standard.Encoder.encode(encoded, body);
    return std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .claimToken = claim_token,
        .transactionId = transaction_id,
        .idempotencyKey = idempotency_key,
        .operation = .{ .kind = "bytes", .encoding = "base64", .bytes = encoded },
    }, .{});
}

test "A3 live drill: automation never writes inside a human composition" {
    const human_bytes = [_][]const u8{ "H1", "H2", "H3", "H4" };
    const composition = "H1H2H3H4";
    const automation = "AUTOMATION";

    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const output_name = "a3-interleaving.bin";
    const created = try tmp.dir.createFile(output_name, .{});
    created.close();
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const output_path = try tmp.dir.realpath(output_name, &path_buf);
    switch (try pty.spawn(.{
        .argv = &[_][]const u8{
            "/bin/sh",
            "-c",
            "exec /bin/cat >> \"$1\"",
            "hive-a3-drill",
            output_path,
        },
        .geometry = .{ .columns = 80, .rows = 24 },
    })) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }

    var sink: PtyQueueSink = .{ .pty = &pty };
    var encoder: TestIdentityEncoder = .{};
    var arbiter = input_arbiter.InputArbiter.init(
        std.testing.allocator,
        sink.arbiterSink(),
        encoder.encoder(),
        encoder.cancelEncoder(),
    );
    defer arbiter.deinit();
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    core.bindTermination(.{ .pty = &pty, .directory = tmp.dir, .arbiter = &arbiter });

    const human_claim = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-human",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 10_000),
        .idempotencyKey = "a3-human",
    }, .{});
    defer std.testing.allocator.free(human_claim);
    const human_granted = try core.claimInput(human_claim, "viewer-human", 2_000);
    defer std.testing.allocator.free(human_granted);
    try std.testing.expect(std.mem.indexOf(u8, human_granted, "\"state\":\"granted\"") != null);
    try std.testing.expectEqual(input_arbiter.State.human_owned, arbiter.currentState());
    const human_token = core.active_claim.?.token;

    // Contend at every transaction boundary: the active human claim denies
    // automation, and a submit attempted with a forged token is fenced by the
    // single host write path before it can reach the PTY.
    for (human_bytes, 0..) |body, index| {
        var id_storage: [48]u8 = undefined;
        const id = try std.fmt.bufPrint(&id_storage, "a3-human-{d}", .{index});
        const human_submit = try a3BytesPayload(
            std.testing.allocator,
            registration,
            human_token,
            id,
            id,
            body,
        );
        defer std.testing.allocator.free(human_submit);
        const human_applied = try core.submitInput(human_submit, "viewer-human", 3_000);
        defer std.testing.allocator.free(human_applied);
        try std.testing.expect(
            std.mem.indexOf(u8, human_applied, "\"stage\":\"written-to-terminal\"") != null,
        );

        var auto_id_storage: [48]u8 = undefined;
        const auto_id = try std.fmt.bufPrint(&auto_id_storage, "a3-auto-{d}", .{index});
        const auto_claim = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
            .schemaVersion = @as(u8, 1),
            .session = .{
                .key = registration.record.locator.session_id,
                .incarnation = "1",
            },
            .writer = "hive-daemon",
            .kind = "automation",
            .leaseMilliseconds = @as(u64, 10_000),
            .idempotencyKey = auto_id,
        }, .{});
        defer std.testing.allocator.free(auto_claim);
        const auto_denied = try core.claimInput(auto_claim, "hive-daemon", 3_000);
        defer std.testing.allocator.free(auto_denied);
        try std.testing.expect(std.mem.indexOf(u8, auto_denied, "\"state\":\"denied\"") != null);
        try std.testing.expect(std.mem.indexOf(u8, auto_denied, human_token) != null);

        const forced_submit = try a3BytesPayload(
            std.testing.allocator,
            registration,
            "forged-automation-claim",
            auto_id,
            auto_id,
            automation,
        );
        defer std.testing.allocator.free(forced_submit);
        const auto_refused = try core.submitInput(forced_submit, "hive-daemon", 3_000);
        defer std.testing.allocator.free(auto_refused);
        try std.testing.expect(std.mem.indexOf(u8, auto_refused, "\"stage\":\"rejected\"") != null);
        try std.testing.expect(std.mem.indexOf(u8, auto_refused, "input claim fenced") != null);
    }

    for (0..500) |_| {
        const file = try tmp.dir.openFile(output_name, .{});
        const size = try file.getEndPos();
        file.close();
        if (size >= composition.len) break;
        std.Thread.sleep(2 * std.time.ns_per_ms);
    }
    std.Thread.sleep(150 * std.time.ns_per_ms);
    const during_file = try tmp.dir.openFile(output_name, .{});
    defer during_file.close();
    const during = try during_file.readToEndAlloc(std.testing.allocator, 4096);
    defer std.testing.allocator.free(during);
    try std.testing.expectEqualStrings(composition, during);

    const release = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .claimToken = human_token,
        .kind = "submit",
    }, .{});
    defer std.testing.allocator.free(release);
    const released = try core.releaseInput(release, "viewer-human", 4_000);
    defer std.testing.allocator.free(released);
    try std.testing.expectEqual(input_arbiter.State.free, arbiter.currentState());

    // Positive control: the same automation path reaches the child immediately
    // after release, so its absence above is the human claim, not a dead path.
    const auto_claim = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "hive-daemon",
        .kind = "automation",
        .leaseMilliseconds = @as(u64, 10_000),
        .idempotencyKey = "a3-auto-after-release",
    }, .{});
    defer std.testing.allocator.free(auto_claim);
    const auto_granted = try core.claimInput(auto_claim, "hive-daemon", 5_000);
    defer std.testing.allocator.free(auto_granted);
    try std.testing.expect(std.mem.indexOf(u8, auto_granted, "\"state\":\"granted\"") != null);
    const auto_submit = try a3BytesPayload(
        std.testing.allocator,
        registration,
        core.active_claim.?.token,
        "a3-auto-submit",
        "a3-auto-submit",
        automation,
    );
    defer std.testing.allocator.free(auto_submit);
    const auto_applied = try core.submitInput(auto_submit, "hive-daemon", 5_000);
    defer std.testing.allocator.free(auto_applied);
    try std.testing.expect(
        std.mem.indexOf(u8, auto_applied, "\"stage\":\"written-to-terminal\"") != null,
    );

    for (0..500) |_| {
        const file = try tmp.dir.openFile(output_name, .{});
        const size = try file.getEndPos();
        file.close();
        if (size >= composition.len + automation.len) break;
        std.Thread.sleep(2 * std.time.ns_per_ms);
    }
    std.Thread.sleep(150 * std.time.ns_per_ms);
    const final_file = try tmp.dir.openFile(output_name, .{});
    defer final_file.close();
    const recorded = try final_file.readToEndAlloc(std.testing.allocator, 4096);
    defer std.testing.allocator.free(recorded);
    try std.testing.expectEqualStrings(composition ++ automation, recorded);
}

test "INPUT_ORPHAN_DISCARD rejects a locator that is not this host's" {
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    var sink: PtyQueueSink = .{ .pty = &pty };
    var encoder: TestIdentityEncoder = .{};
    var arbiter = input_arbiter.InputArbiter.init(
        std.testing.allocator,
        sink.arbiterSink(),
        encoder.encoder(),
        encoder.cancelEncoder(),
    );
    defer arbiter.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    core.bindTermination(.{ .pty = &pty, .directory = tmp.dir, .arbiter = &arbiter });

    registration.record.locator.generation = 2;
    const foreign = try orphanDiscardPayload(std.testing.allocator, registration);
    defer std.testing.allocator.free(foreign);
    try std.testing.expectError(error.InvalidOrphanDiscard, core.discardInputOrphan(foreign));
}

fn visibilityRenewPayload(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
    workspace_pid: i32,
    workspace_start_token: []const u8,
    revision: u64,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    var revision_storage: [32]u8 = undefined;
    const revision_text = try std.fmt.bufPrint(&revision_storage, "{d}", .{revision});
    var root = std.json.ObjectMap.init(arena.allocator());
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("locator", try locatorValue(arena.allocator(), registration.record.locator));
    try root.put("workspaceSessionId", .{ .string = registration.record.visibility.workspace_session_id });
    try root.put("workspacePid", .{ .integer = workspace_pid });
    try root.put("workspaceStartToken", .{ .string = workspace_start_token });
    try root.put("openTerminalRevision", .{ .string = try arena.allocator().dupe(u8, revision_text) });
    return std.json.Stringify.valueAlloc(
        allocator,
        std.json.Value{ .object = root },
        .{},
    );
}

test "host.sock VISIBILITY_RENEW verifies workspace identity and extends exact lease" {
    const secret: [32]u8 = @splat(0x31);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const workspace = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.MissingWorkspaceIdentity;
    var token_storage: [64]u8 = undefined;
    const token = try workspace.start_token.format(&token_storage);
    const payload = try visibilityRenewPayload(
        std.testing.allocator,
        registration,
        c.getpid(),
        token,
        2,
    );
    defer std.testing.allocator.free(payload);
    // Privileged broker RPCs fail closed until adoption.
    try adoptForTest(&core, registration, secret);
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);

    try writeTestBrokerHello(sockets[0], registration);
    try readTestWelcome(sockets[0]);
    try writeTestHostRequest(sockets[0], generated.frame_type.visibility_renew, payload);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();

    try std.testing.expect(server.failure == null);
    try std.testing.expectEqual(generated.frame_type.renewed, response.header.type_code);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.renewed_payload,
        response.payload,
    ));
    try std.testing.expectEqual(@as(u64, 2), core.lease.open_terminal_revision);
    try std.testing.expectEqual(
        @as(u64, 2_000 + generated.limits.visibility_expiry_ms * std.time.ns_per_ms),
        core.lease.expires_mono_ns,
    );
}

test "VISIBILITY_RENEW positive control rejects a false workspace start token" {
    const secret: [32]u8 = @splat(0x31);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const payload = try visibilityRenewPayload(
        std.testing.allocator,
        registration,
        c.getpid(),
        "0:0",
        2,
    );
    defer std.testing.allocator.free(payload);
    try std.testing.expectError(
        error.InvalidWorkspaceIdentity,
        core.renewVisibility(payload, 2_000),
    );
    try std.testing.expectEqual(@as(u64, 1), core.lease.open_terminal_revision);
}

fn terminationPayload(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
    mode: []const u8,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var incarnation_storage: [32]u8 = undefined;
    const incarnation = try std.fmt.bufPrint(
        &incarnation_storage,
        "{d}",
        .{registration.record.locator.generation},
    );
    var session = std.json.ObjectMap.init(a);
    try session.put("key", .{ .string = registration.record.locator.session_id });
    try session.put("incarnation", .{ .string = try a.dupe(u8, incarnation) });
    var root = std.json.ObjectMap.init(a);
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("session", .{ .object = session });
    try root.put("mode", .{ .string = mode });
    try root.put("target", .{ .string = "process-tree" });
    try root.put("deadline", .{ .string = "2099-01-01T00:00:00.000Z" });
    try root.put("idempotencyKey", .{ .string = "req_01890f9e-7b9a-7cc2-8e2b-8c6b8b8b8b8b" });
    return std.json.Stringify.valueAlloc(
        allocator,
        std.json.Value{ .object = root },
        .{},
    );
}

fn spawnUnrelatedSleep() !i32 {
    const pid = c.fork();
    if (pid < 0) return error.ForkFailed;
    if (pid == 0) {
        const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
        _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(std.c.environ));
        c._exit(127);
    }
    return @intCast(pid);
}

fn killTestProcess(pid: i32) void {
    if (pid <= 0) return;
    _ = c.kill(pid, c.SIGKILL);
    var status: c_int = 0;
    _ = c.waitpid(pid, &status, 0);
}

fn bindTestProvider(
    allocator: std.mem.Allocator,
    core: *HostCore,
    pty: *pty_host.PtyHost,
    directory: std.fs.Dir,
) !void {
    const argv = [_][]const u8{ "/bin/sleep", "60" };
    const outcome = try pty.spawn(.{
        .argv = &argv,
        .geometry = .{ .columns = 80, .rows = 24, .width_px = 800, .height_px = 480 },
    });
    const readback = switch (outcome) {
        .running => |value| value,
        .exec_failed => return error.TestUnexpectedResult,
    };
    var token_storage: [64]u8 = undefined;
    const token = try readback.start_token.format(&token_storage);
    core.registration.record.process_root = .{
        .pid = readback.pid,
        .start_token = try allocator.dupe(u8, token),
        .process_group_id = readback.pgid,
    };
    core.bindTermination(.{ .pty = pty, .directory = directory });
}

test "optional provider graceful action reaches the PTY without fabricated bytes" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    const outcome = try pty.spawn(.{
        .argv = &[_][]const u8{"/bin/cat"},
        .geometry = .{ .columns = 80, .rows = 24, .width_px = 800, .height_px = 480 },
    });
    switch (outcome) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }
    // Trailing NL is intentional input; OPOST|ONLCR expands it to CRLF on the
    // master read path (same contract as the interactive shell).
    const action = "explicit-provider-graceful-action\n";
    const echoed = "explicit-provider-graceful-action\r\n";
    try deliverGracefulAction(.{
        .pty = &pty,
        .directory = temporary.dir,
        .graceful_action = action,
    });
    var output: std.ArrayList(u8) = .{};
    defer output.deinit(std.testing.allocator);
    var attempts: usize = 0;
    while (attempts < 200 and std.mem.indexOf(u8, output.items, echoed) == null) : (attempts += 1) {
        const chunk = pty.readAvailable() catch |err| switch (err) {
            error.Closed => break,
            else => return err,
        };
        try output.appendSlice(std.testing.allocator, chunk.bytes);
        if (chunk.bytes.len == 0) std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(std.mem.indexOf(u8, output.items, echoed) != null);
}

test "host.sock TERMINATE returns process evidence, writes final, and spares sentinel" {
    const sentinel = try spawnUnrelatedSleep();
    defer killTestProcess(sentinel);
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var pty = try pty_host.PtyHost.init(std.heap.c_allocator);
    defer pty.deinit();
    const secret: [32]u8 = @splat(0x31);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer {
        if (!std.mem.eql(
            u8,
            core.registration.record.process_root.start_token,
            registration.record.process_root.start_token,
        )) core.allocator.free(core.registration.record.process_root.start_token);
        core.deinit();
    }
    try bindTestProvider(std.heap.c_allocator, &core, &pty, temporary.dir);
    const payload = try terminationPayload(std.testing.allocator, core.registration, "immediate");
    defer std.testing.allocator.free(payload);
    // Privileged broker RPCs fail closed until adoption.
    try adoptForTest(&core, core.registration, secret);
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);

    try writeTestBrokerHello(sockets[0], core.registration);
    try readTestWelcome(sockets[0]);
    try writeTestHostRequest(sockets[0], generated.frame_type.terminate, payload);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();

    try std.testing.expect(server.failure == null);
    try std.testing.expectEqual(generated.frame_type.terminated, response.header.type_code);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.terminated_payload,
        response.payload,
    ));
    try std.testing.expect(core.terminated);
    const final = try temporary.dir.readFileAlloc(
        std.testing.allocator,
        "final.json",
        generated.limits.control_json_bytes,
    );
    defer std.testing.allocator.free(final);
    try std.testing.expect(std.mem.indexOf(u8, final, "\"state\":\"terminated\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, final, "\"waitObserved\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, final, "\"outputSeq\":\"0\"") != null);
    try std.testing.expect(switch (process_inspector.observeProcess(sentinel)) {
        .present => true,
        .absent, .unobservable => false,
    });
}

test "visibility expiry self-terminates without a broker and records failure code" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    const secret: [32]u8 = @splat(0x31);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer {
        if (!std.mem.eql(
            u8,
            core.registration.record.process_root.start_token,
            registration.record.process_root.start_token,
        )) core.allocator.free(core.registration.record.process_root.start_token);
        core.deinit();
    }
    try bindTestProvider(std.testing.allocator, &core, &pty, temporary.dir);
    const provider_pid = core.registration.record.process_root.pid;
    const expiry = 1_000 + generated.limits.visibility_expiry_ms * std.time.ns_per_ms;
    try std.testing.expect(!try core.enforceVisibilityExpiry(expiry - 1));
    try std.testing.expect(try core.enforceVisibilityExpiry(expiry));
    try std.testing.expect(core.terminated);
    try std.testing.expect(switch (process_inspector.observeProcess(provider_pid)) {
        .absent => true,
        .present, .unobservable => false,
    });
    const final = try temporary.dir.readFileAlloc(
        std.testing.allocator,
        "final.json",
        generated.limits.control_json_bytes,
    );
    defer std.testing.allocator.free(final);
    try std.testing.expect(std.mem.indexOf(u8, final, "VISIBILITY_EXPIRED") != null);
}

comptime {
    // Composition imports are deliberate even before every surface is wired.
    _ = broker;
    _ = input_arbiter;
    _ = process_inspector;
    _ = protocol;
    _ = pty_host;
}
