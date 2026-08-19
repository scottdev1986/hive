const std = @import("std");
const final_evidence = @import("final_evidence");
const generated = @import("session_protocol_generated");
const host_record = @import("host_record");
const host_registration = @import("host_registration");
const input_arbiter = @import("input_arbiter");
const process_inspector = @import("process_inspector");
const protocol = @import("protocol");
const pty_host = @import("pty_host");
const session_types = @import("session_types");
const terminal_state = @import("terminal_state");
const wall_clock = @import("wall_clock");
const VisibilityLease = @import("visibility_lease").VisibilityLease;
const neutral_evidence = @import("neutral_evidence");
const WireLocator = host_record.WireLocator;
const WireGeometry = host_record.WireGeometry;
const HostRegistration = host_record.HostRegistration;
const locatorValue = host_record.locatorValue;
const processRootValue = host_record.processRootValue;
const protocolValue = host_record.protocolValue;
const visibilityValue = host_record.visibilityValue;
const parseLocator = host_registration.parseLocator;
const FinalError = final_evidence.FinalError;
const FinalSurvivor = final_evidence.FinalSurvivor;
const writeFinalExclusive = final_evidence.writeExclusive;

const c = @cImport({
    @cInclude("sys/wait.h");
});

pub fn checkpointWireSeq(state: *const terminal_state.TerminalState) u64 {
    if (!state.checkpointAvailable()) return 0;
    return state.checkpointSeq();
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

const WireInputOperation = struct {
    kind: []const u8,
    encoding: ?[]const u8 = null,
    bytes: ?[]const u8 = null,
};

const WireExpectedForeground = struct {
    pid: i32,
    startToken: []const u8,
    processGroupId: i32,
};

const WireInputSubmit = struct {
    schemaVersion: u8,
    session: WireTerminalSessionRef,
    provenance: []const u8,
    action: []const u8,
    transactionId: []const u8,
    idempotencyKey: []const u8,
    expectedForeground: ?WireExpectedForeground = null,
    operation: WireInputOperation,
};

const WireInputProvenance = generated.InputProvenance;
const WireInputAction = generated.InputAction;
const WireTerminalWindow = generated.TerminalHostWindowSize;

const WireResize = struct {
    schemaVersion: u8,
    session: WireTerminalSessionRef,
    window: WireTerminalWindow,
    revision: []const u8,
    idempotencyKey: []const u8,
};

pub const GrantOperations = packed struct {
    view: bool = false,
    user_input: bool = false,
    resize: bool = false,
};

const GrantEntry = struct {
    hash: [32]u8,
    viewer_id: []u8,
    operations: GrantOperations,
    geometry: session_types.Geometry,
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
    geometry: session_types.Geometry,
    after_seq: u64,

    pub fn deinit(self: *ViewerAuthorization, allocator: std.mem.Allocator) void {
        allocator.free(self.viewer_id);
        self.* = undefined;
    }
};

fn sameGeometry(left: session_types.Geometry, right: WireGeometry) bool {
    return left.columns == right.columns and
        left.rows == right.rows and
        left.width_px == right.widthPx and
        left.height_px == right.heightPx and
        left.cell_width_px == right.cellWidthPx and
        left.cell_height_px == right.cellHeightPx;
}

/// Stringifies a built control-response object and validates it against its
/// wire schema; an invalid payload fails with the caller's error.
fn stringifyValidatedPayload(
    allocator: std.mem.Allocator,
    root: std.json.ObjectMap,
    schema_name: []const u8,
    comptime invalid: anyerror,
) ![]u8 {
    const payload = try std.json.Stringify.valueAlloc(
        allocator,
        std.json.Value{ .object = root },
        .{},
    );
    errdefer allocator.free(payload);
    if (!protocol.validateControlPayload(allocator, schema_name, payload)) return invalid;
    return payload;
}

pub const TerminationBinding = struct {
    pty: *pty_host.PtyHost,
    directory: std.fs.Dir,
    arbiter: ?*input_arbiter.InputArbiter = null,
    /// Optional provider-adapter bytes. No current SessionSpec supplies them; absence intentionally degrades to TERM-first rather than fabrication.
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

/// Routes root-child waits through PtyHost so tree termination cannot consume the wait status without recording it in the terminal-host exit evidence.
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

pub fn deliverGracefulAction(binding: TerminationBinding) !void {
    const bytes = binding.graceful_action orelse return;
    if (bytes.len == 0) return;
    _ = try binding.pty.writeAccept(bytes);
    while (true) {
        const count = try binding.pty.writeDrain();
        if (count == 0) return;
    }
}

fn terminateProvider(
    allocator: std.mem.Allocator,
    binding: TerminationBinding,
    root: session_types.ProcessRoot,
    mode: process_inspector.TerminationMode,
) !ProviderTermination {
    var arbiter_error: ?[]const u8 = null;
    if (binding.arbiter) |arbiter| {
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
        try process_inspector.StartToken.parse(root.start_token),
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

const InputOperationKind = enum { bytes, canonical_eof, hangup };

/// Replay ledgers are bounded FIFOs, sized like the file's other generated-limits-style caps: past the cap the oldest entry evicts before the new one reserves, so unique client-chosen idempotency keys can never grow the host without limit. Eviction only forfeits dedup of ancient keys a replayed recent key still hits, a re-submitted ancient key simply re-derives its outcome under a fresh ledger entry.
pub const max_replay_entries: usize = 256;

const InputReplay = struct {
    idempotency_key: []u8,
    /// A writer may replay its own byte-identical operation, but another viewer cannot read that receipt by guessing the idempotency key.
    owner_viewer_id: []u8,
    transaction_id: []u8,
    operation_kind: InputOperationKind,
    operation_digest: [32]u8,
    receipt: ?InputReceiptData = null,

    fn deinit(self: *InputReplay, allocator: std.mem.Allocator) void {
        allocator.free(self.idempotency_key);
        allocator.free(self.owner_viewer_id);
        allocator.free(self.transaction_id);
        self.* = undefined;
    }

    fn matches(
        self: *const InputReplay,
        request: WireInputSubmit,
        viewer_id: []const u8,
        kind: InputOperationKind,
        digest: [32]u8,
    ) bool {
        return std.mem.eql(u8, self.owner_viewer_id, viewer_id) and
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

/// A terminal is alive if and only if its process is alive, and its right to live is OBSERVED here rather than MAINTAINED by a message arriving on time. The message form is what a wide spawn burst starves: renewals queue behind the creates that made them necessary, and the fleet dies at its busiest moment. `kill(pid, 0)` cannot be starved. The grace window exists for exactly one case: a daemon restart hands these hosts to a NEW broker, which adopts them off disk. Until that adoption lands the old supervisor is genuinely gone, and a host that died the instant it noticed could never be recovered.
pub const SupervisorWatch = struct {
    pid: i32,
    start_token: process_inspector.StartToken,
    lost_since_ns: ?u64 = null,

    pub fn of(pid: i32) ?SupervisorWatch {
        const identity = process_inspector.observeProcessPresent(pid) orelse return null;
        return .{ .pid = pid, .start_token = identity.start_token };
    }

    /// A new broker proved the 32-byte adoption secret, so it is this host's supervisor now. Clears any absence recorded against its predecessor.
    pub fn adoptedBy(self: *SupervisorWatch, pid: i32) void {
        const identity = process_inspector.observeProcessPresent(pid) orelse return;
        self.pid = pid;
        self.start_token = identity.start_token;
        self.lost_since_ns = null;
    }

    /// True once the supervisor has been continuously absent for the whole grace window. `unobservable` is NOT absence: an unreadable process is unknown, and unknown must never be read as permission to kill an agent's work.
    pub fn lost(self: *SupervisorWatch, now_ns: u64) bool {
        const observed = process_inspector.observeProcess(self.pid);
        const present = switch (observed) {
            .present => |identity| identity.start_token.eql(self.start_token),
            .absent => false,
            .unobservable => {
                self.lost_since_ns = null;
                return false;
            },
        };
        if (present) {
            self.lost_since_ns = null;
            return false;
        }
        const since = self.lost_since_ns orelse {
            self.lost_since_ns = now_ns;
            return false;
        };
        if (now_ns <= since) return false;
        return now_ns - since >= supervisor_grace_ns;
    }
};

/// How long a host outlives an observably dead supervisor. This is the window a restarting broker has to recover this host off disk and prove the adoption secret. A short grace does not scale with fleet width: a broker that dies mid-burst must re-adopt every host it had, one IPC each, and a tight window kills working agents before adoption finishes. The cost of being generous is only that a genuinely orphaned host lingers longer before reaping itself, and that is the backstop path — the daemon's explicit terminate and the broker's `terminateAll` on observed owner death both act immediately. Being ungenerous costs agents' work.
pub const supervisor_grace_ns: u64 = 90 * std.time.ns_per_s;

pub const HostCore = struct {
    allocator: std.mem.Allocator,
    registration: HostRegistration,
    adoption_secret: [32]u8,
    host_executable: []const u8,
    broker_build_id: []const u8,
    lease: VisibilityLease,
    /// Bound by the production host role once it knows which broker launched it. Null in harnesses that drive a core directly: nothing observes a supervisor there, so nothing may kill on its absence either.
    supervisor: ?SupervisorWatch = null,
    grants: std.ArrayList(GrantEntry) = .{},
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

    pub fn bindSupervisor(self: *HostCore, watch: SupervisorWatch) void {
        self.supervisor = watch;
    }

    /// The peer that just proved the adoption secret is this host's supervisor from now on. Without this a recovered host would keep watching the dead broker that launched it and terminate mid-recovery.
    pub fn supervisorAdoptedBy(self: *HostCore, pid: i32) void {
        if (self.supervisor == null) return;
        self.supervisor.?.adoptedBy(pid);
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
        return stringifyValidatedPayload(
            self.allocator,
            root,
            generated.wire_schema.applied_payload,
            error.InvalidAppliedResult,
        );
    }

    fn reserveInputReplay(
        self: *HostCore,
        request: WireInputSubmit,
        viewer_id: []const u8,
        kind: InputOperationKind,
        digest: [32]u8,
    ) !*InputReplay {
        var replay: InputReplay = .{
            .idempotency_key = try self.allocator.dupe(u8, request.idempotencyKey),
            .owner_viewer_id = undefined,
            .transaction_id = undefined,
            .operation_kind = kind,
            .operation_digest = digest,
        };
        var initialized_fields: usize = 1;
        errdefer {
            if (initialized_fields >= 1) self.allocator.free(replay.idempotency_key);
            if (initialized_fields >= 2) self.allocator.free(replay.owner_viewer_id);
            if (initialized_fields >= 3) self.allocator.free(replay.transaction_id);
        }
        replay.owner_viewer_id = try self.allocator.dupe(u8, viewer_id);
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
        _ = now_ns;
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
        if (std.meta.stringToEnum(WireInputProvenance, request.provenance) == null or
            std.meta.stringToEnum(WireInputAction, request.action) == null)
            return error.InvalidInputSubmit;

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
        digest_hasher.update(request.provenance);
        digest_hasher.update(&[_]u8{0});
        digest_hasher.update(request.action);
        digest_hasher.update(&[_]u8{0});
        if (decoded) |bytes| digest_hasher.update(bytes);
        if (request.expectedForeground) |expected| {
            digest_hasher.update(std.mem.asBytes(&expected.pid));
            digest_hasher.update(expected.startToken);
            digest_hasher.update(std.mem.asBytes(&expected.processGroupId));
        }
        const operation_digest = digest_hasher.finalResult();

        for (self.input_replays.items) |*replay| {
            if (!std.mem.eql(u8, replay.idempotency_key, request.idempotencyKey)) continue;
            if (!replay.matches(request, viewer_id, kind, operation_digest))
                return self.encodeInputApplied(rejectedInputReceipt(
                    request.transactionId,
                    "idempotency key reused with different input",
                ));
            const receipt = replay.receipt orelse return error.InputReplayIncomplete;
            return self.encodeInputApplied(receipt);
        }
        const replay = try self.reserveInputReplay(request, viewer_id, kind, operation_digest);
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
        if (request.expectedForeground) |expected| {
            const foreground_group = binding.pty.foregroundProcessGroupId() catch {
                replay.receipt = rejectedInputReceipt(
                    replay.transaction_id,
                    "foreground-changed",
                );
                return self.encodeInputApplied(replay.receipt.?);
            };
            const expected_token = process_inspector.StartToken.parse(expected.startToken) catch {
                replay.receipt = rejectedInputReceipt(
                    replay.transaction_id,
                    "foreground-changed",
                );
                return self.encodeInputApplied(replay.receipt.?);
            };
            const foreground_matches = foreground_group == expected.processGroupId and
                (switch (process_inspector.observeProcess(expected.pid)) {
                    .present => |identity| identity.start_token.eql(expected_token) and
                        identity.pgid == expected.processGroupId,
                    .absent, .unobservable => false,
                });
            if (!foreground_matches) {
                replay.receipt = rejectedInputReceipt(
                    replay.transaction_id,
                    "foreground-changed",
                );
                return self.encodeInputApplied(replay.receipt.?);
            }
        }
        const accepted = arbiter.submit(input_bytes) catch |err| {
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
        const ordered_at = binding.pty.operationSequence();
        binding.pty.writeDrainAll() catch |err| {
            // DrainStalled: the child stopped reading and the bounded drain gave up, but the bytes are still queued and the host loop keeps draining — receipt "queued"/"partial" (never "unknown", which would permanently fence client input).
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

    /// Queues authenticated interactive bytes and makes one nonblocking PTY
    /// write attempt. The host loop drains any remainder; a slow child must not
    /// turn one keystroke into a synchronous retry loop.
    pub fn submitRawInput(self: *HostCore, bytes: []const u8) !void {
        if (bytes.len == 0) return;
        if (bytes.len > input_arbiter.user_input_max_bytes)
            return error.InputPayloadTooLarge;
        const binding = self.termination orelse return error.InputBindingUnavailable;
        const arbiter = binding.arbiter orelse return error.InputArbiterUnavailable;
        _ = try arbiter.submit(bytes);
        _ = binding.pty.writeDrain() catch |err| switch (err) {
            error.Closed => return,
            else => return err,
        };
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
        return stringifyValidatedPayload(
            self.allocator,
            root,
            generated.wire_schema.applied_payload,
            error.InvalidAppliedResult,
        );
    }

    pub fn reserveResizeReplay(
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
        var prepared = state.prepareResize(.{
            .columns = geometry.columns,
            .rows = geometry.rows,
            .cell_width_px_16_16 = pty_host.cellFixed16_16(geometry.width_px, geometry.columns),
            .cell_height_px_16_16 = pty_host.cellFixed16_16(geometry.height_px, geometry.rows),
        }) catch |err| {
            replay.result = .{ .unknown = @errorName(err) };
            return self.encodeResizeApplied(replay.result.?);
        };
        defer prepared.deinit();
        state.applyPreparedResize(&prepared) catch |err| {
            replay.result = .{ .unknown = @errorName(err) };
            return self.encodeResizeApplied(replay.result.?);
        };
        const receipt = binding.pty.resize(geometry, revision) catch |err| {
            state.rollbackPreparedResize(&prepared) catch {
                state.reconnect_available = false;
                replay.result = .{ .unknown = "CheckpointUnavailable" };
                return self.encodeResizeApplied(replay.result.?);
            };
            replay.result = if (err == error.StaleResizeRevision)
                .{ .stale = binding.pty.resizeRevision() }
            else
                .{ .unknown = @errorName(err) };
            return self.encodeResizeApplied(replay.result.?);
        };
        state.finalizePreparedResize(&prepared);
        self.registration.record.geometry.columns = @intCast(receipt.readback.columns);
        self.registration.record.geometry.rows = @intCast(receipt.readback.rows);
        self.registration.record.geometry.width_px = receipt.readback.width_px;
        self.registration.record.geometry.height_px = receipt.readback.height_px;
        replay.result = .{ .applied = receipt };
        return self.encodeResizeApplied(replay.result.?);
    }

    pub fn adopt(
        self: *HostCore,
        payload: []const u8,
        hello_build_id: []const u8,
        now_ns: u64,
    ) ![]u8 {
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
        var locator_arena = std.heap.ArenaAllocator.init(self.allocator);
        defer locator_arena.deinit();
        const locator = try parseLocator(locator_arena.allocator(), parsed.value.expectedLocator);
        if (!locator.eql(self.registration.record.locator))
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
        // A3: registration.record.checkpoint_seq was populated through checkpointWireSeq, never by an unchecked TerminalState read.
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
        return wall_clock.deadline(storage, remaining_ms);
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
        const expires_mono_ns = try wall_clock.expiryToMonotonic(
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
            else if (std.mem.eql(u8, operation, "user-input"))
                operations.user_input = true
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

    /// Validates and consumes one viewer capability. Streaming begins only after the caller has established the generated SNAPSHOT/OUTPUT wire contract; this method does not invent a HOST_ATTACH response shape.
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
        var locator_arena = std.heap.ArenaAllocator.init(self.allocator);
        defer locator_arena.deinit();
        const locator = try parseLocator(locator_arena.allocator(), parsed.value.locator);
        if (!locator.eql(self.registration.record.locator))
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

    /// Crash invariant enforcement. The caller invokes this from the host lifecycle clock even when no broker transport is connected: a host whose supervisor is gone would otherwise reparent to launchd and keep burning a vendor's tokens forever.
    pub fn enforceSupervisorLoss(self: *HostCore, now_ns: u64) !bool {
        if (self.terminated) return true;
        if (self.supervisor == null) return false;
        if (!self.supervisor.?.lost(now_ns)) return false;
        const response = try self.terminateBound(.graceful, "SUPERVISOR_GONE");
        self.allocator.free(response);
        return true;
    }

    pub fn terminateBound(
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
        if (outcome.tree.state == .unknown and outcome.tree.snapshot_status == .stable and
            survivors_json.items.len == 0 and !outcome.tree.deadline_expired)
            try diagnostics.append(.{ .string = "process-tree-escapees-unaccounted" });

        var exit_value: std.json.Value = .null;
        var observed_storage: [24]u8 = undefined;
        const observed_at = try wall_clock.deadline(&observed_storage, 0);
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
        const response = try stringifyValidatedPayload(
            self.allocator,
            root,
            generated.wire_schema.terminated_payload,
            error.InvalidTerminationResponse,
        );
        errdefer self.allocator.free(response);

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

    pub fn reconcileNeutralOperationFailure(self: *HostCore, operation_error: anyerror) !void {
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

    pub fn acceptNeutralInspection(self: *HostCore, payload: []const u8) !void {
        var parsed = try std.json.parseFromSlice(
            neutral_evidence.WireInspectionPayload,
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

    pub fn acceptNeutralTermination(self: *HostCore, payload: []const u8) !void {
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.terminated_payload,
            payload,
        )) return error.InvalidTerminationResponse;
        var parsed = try std.json.parseFromSlice(
            neutral_evidence.WireTerminationPayload,
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
