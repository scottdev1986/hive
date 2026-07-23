const std = @import("std");
const generated = @import("session_protocol_generated");
const neutral_host = @import("neutral_host");
const process_inspector = @import("process_inspector");
const wall_clock = @import("wall_clock");

const c = @cImport({
    @cInclude("sys/wait.h");
    @cInclude("errno.h");
    @cInclude("signal.h");
    @cInclude("unistd.h");
});

pub const Completeness = enum { complete, partial, unavailable, unknown };

pub const WireProcessIdentity = struct {
    processId: i32,
    startToken: []const u8,
};

pub const WireWindowSize = struct {
    columns: u32,
    rows: u32,
    widthPixels: u32,
    heightPixels: u32,
};

pub const WireJobControlEvidence = struct {
    sessionLeader: bool,
    controllingTerminal: bool,
    standardStreamsShareTerminal: bool,
    childSessionId: i32,
    childProcessGroupId: i32,
    foregroundProcessGroupId: i32,
    terminalIdentity: []const u8,
    initialProfileAppliedBeforeExec: bool,
    initialWindowAppliedBeforeExec: bool,
    completeness: Completeness,
};

pub const WireExitStatus = struct {
    code: ?i32,
    signal: ?i32,
    observedAt: []const u8,
};

pub const WireReapEvidence = struct {
    authority: enum { @"direct-parent", @"durable-parent-record", unavailable },
    reaped: bool,
    status: ?WireExitStatus,
    completeness: Completeness,
};

pub const WireCheckpoint = struct {
    contentType: []const u8,
    schemaVersion: []const u8,
    hashAlgorithm: enum { sha256 } = .sha256,
    hash: []const u8,
    throughEventSequence: []const u8,
    throughOutputOffset: []const u8,
    opaqueBytes: []const u8,
};

pub const WireInputClaim = struct {
    token: []const u8,
    writer: []const u8,
    kind: enum { human, automation },
    leaseExpiresAt: []const u8,
};

pub const WireSurvivor = struct {
    process: WireProcessIdentity,
    reason: []const u8,
};

pub const WireInspection = struct {
    session: neutral_host.SessionRef,
    lifecycle: enum { creating, running, exited, lost, unknown },
    completeness: Completeness,
    host: ?WireProcessIdentity,
    child: ?WireProcessIdentity,
    jobControl: ?WireJobControlEvidence,
    window: struct { value: WireWindowSize, revision: []const u8 },
    output: struct {
        closed: bool,
        retained: struct { start: []const u8, endExclusive: []const u8 },
    },
    checkpoints: struct { retained: u32, newest: ?WireCheckpoint },
    inputOwner: ?WireInputClaim,
    exit: ?WireExitStatus,
    reap: WireReapEvidence,
    descendants: []const WireProcessIdentity,
    survivors: []const WireSurvivor,
    evidenceAt: []const u8,
    diagnostics: []const []const u8,
};

pub const WireInspectionPayload = struct {
    schemaVersion: u8 = 1,
    session: neutral_host.SessionRef,
    lifecycle: @FieldType(WireInspection, "lifecycle"),
    completeness: Completeness,
    host: ?WireProcessIdentity,
    child: ?WireProcessIdentity,
    jobControl: ?WireJobControlEvidence,
    window: @FieldType(WireInspection, "window"),
    output: @FieldType(WireInspection, "output"),
    checkpoints: @FieldType(WireInspection, "checkpoints"),
    inputOwner: ?WireInputClaim,
    exit: ?WireExitStatus,
    reap: WireReapEvidence,
    descendants: []const WireProcessIdentity,
    survivors: []const WireSurvivor,
    evidenceAt: []const u8,
    diagnostics: []const []const u8,
};

pub const ListRequest = struct { schemaVersion: u8 };
pub const InspectRequest = struct { schemaVersion: u8, session: neutral_host.SessionRef };
pub const ResizeRequest = struct {
    schemaVersion: u8,
    session: neutral_host.SessionRef,
    window: WireWindowSize,
    revision: []const u8,
    idempotencyKey: []const u8,
};

/// §5 outcomes. Each carries `schemaVersion` on top of the frozen result shape,
/// exactly as the termination payload carries it on top of its result. The
/// applied variant reports the geometry read back from the terminal AFTER the
/// set, and has deliberately no field claiming the foreground application
/// handled its notification: the host cannot observe that, so the projection
/// cannot say it. A superseded revision is `stale` and names the revision that
/// superseded it, so a caller learns where the order actually is.
pub const WireAppliedResizePayload = struct {
    schemaVersion: u8 = 1,
    state: enum { applied } = .applied,
    revision: []const u8,
    readback: WireWindowSize,
    orderedAt: []const u8,
    foregroundProcessObservation: enum { @"not-claimed" } = .@"not-claimed",
};

pub const WireStaleResizePayload = struct {
    schemaVersion: u8 = 1,
    state: enum { stale } = .stale,
    currentRevision: []const u8,
};

pub const WireUnknownResizePayload = struct {
    schemaVersion: u8 = 1,
    state: enum { unknown } = .unknown,
    diagnostic: []const u8,
};

pub fn staleResize(
    allocator: std.mem.Allocator,
    current_revision: u64,
) !neutral_host.OperationResponse {
    return .{ .payload = try std.json.Stringify.valueAlloc(allocator, WireStaleResizePayload{
        .currentRevision = try decimal(allocator, current_revision),
    }, .{}) };
}

pub fn unknownResize(
    allocator: std.mem.Allocator,
    diagnostic: []const u8,
) !neutral_host.OperationResponse {
    return .{ .payload = try std.json.Stringify.valueAlloc(allocator, WireUnknownResizePayload{
        .diagnostic = diagnostic,
    }, .{}) };
}

/// §5 applied evidence from the terminal the control plane does not own.
pub const AppliedResize = struct {
    revision: u64,
    orderedAt: u64,
    readback: neutral_host.WindowSize,
};

/// What the terminal says when it will not apply a revision. It reports the
/// order IT is in, because the durable record is not authoritative here: a set
/// that succeeded before its commit failed leaves the record behind the
/// terminal, and answering from the record would name a revision that is in
/// force nowhere. `current` is the state that revision left behind, so a caller
/// retrying the revision the terminal already holds can be answered with the
/// receipt it should have received the first time.
pub const TerminalResize = union(enum) {
    applied: AppliedResize,
    superseded: AppliedResize,
};

/// Host-side seam for ordered terminal mutation. Inspection reads evidence
/// through EvidenceProvider; a mutation needs the terminal itself, which this
/// control plane deliberately does not own. Optional-null on HostOperations for
/// the same reason Controller.host is: only the mutating operation needs it.
pub const TerminalProvider = struct {
    context: *anyopaque,
    resizeFn: *const fn (*anyopaque, neutral_host.WindowSize, u64) anyerror!TerminalResize,

    pub fn resize(
        self: TerminalProvider,
        window: neutral_host.WindowSize,
        revision: u64,
    ) !TerminalResize {
        return self.resizeFn(self.context, window, revision);
    }
};
pub const HostInspectRequest = struct { schemaVersion: u8, includeCheckpoint: bool };
pub const TerminateRequest = struct {
    schemaVersion: u8,
    session: neutral_host.SessionRef,
    mode: enum { graceful, immediate },
    target: enum { @"foreground-group", @"session-members", @"process-tree" },
    deadline: []const u8,
    idempotencyKey: []const u8,
};

pub const WireTerminationResult = struct {
    state: enum { terminated, survivors, unknown },
    exit: ?WireExitStatus,
    reap: WireReapEvidence,
    survivors: []const WireSurvivor,
    completeness: Completeness,
    diagnostics: []const []const u8,
};

pub const WireTerminationPayload = struct {
    schemaVersion: u8 = 1,
    state: @FieldType(WireTerminationResult, "state"),
    exit: ?WireExitStatus,
    reap: WireReapEvidence,
    survivors: []const WireSurvivor,
    completeness: Completeness,
    diagnostics: []const []const u8,
};

pub const CheckpointSnapshot = struct {
    contentType: []const u8,
    schemaVersion: []const u8,
    throughEventSequence: u64,
    throughOutputOffset: u64,
    opaqueBytes: []const u8,
};

pub const LiveEvidence = struct {
    foregroundProcessGroupId: ?i32 = null,
    newestCheckpoint: ?CheckpointSnapshot = null,
    inputOwner: ?WireInputClaim = null,
    diagnostics: []const []const u8 = &.{},
};

pub const EvidenceProvider = struct {
    context: *anyopaque,
    measureFn: *const fn (*anyopaque, std.mem.Allocator) anyerror!LiveEvidence,

    pub fn measure(self: EvidenceProvider, allocator: std.mem.Allocator) !LiveEvidence {
        return self.measureFn(self.context, allocator);
    }
};

pub const EvidenceClock = struct {
    context: *anyopaque,
    nowFn: *const fn (*anyopaque, []u8) anyerror![]const u8,

    pub fn now(self: EvidenceClock, storage: []u8) ![]const u8 {
        return self.nowFn(self.context, storage);
    }

    pub fn system() EvidenceClock {
        return .{ .context = undefined, .nowFn = systemNow };
    }

    fn systemNow(_: *anyopaque, output: []u8) ![]const u8 {
        const now_ms = std.time.milliTimestamp();
        if (now_ms < 0) return error.InvalidTimestamp;
        const millis: u64 = @intCast(now_ms);
        const epoch_seconds: std.time.epoch.EpochSeconds = .{ .secs = millis / std.time.ms_per_s };
        const year_day = epoch_seconds.getEpochDay().calculateYearDay();
        const month_day = year_day.calculateMonthDay();
        const day_seconds = epoch_seconds.getDaySeconds();
        return std.fmt.bufPrint(output, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{
            year_day.year,
            month_day.month.numeric(),
            month_day.day_index + 1,
            day_seconds.getHoursIntoDay(),
            day_seconds.getMinutesIntoHour(),
            day_seconds.getSecondsIntoMinute(),
            millis % std.time.ms_per_s,
        });
    }
};

pub fn decimal(allocator: std.mem.Allocator, value: u64) ![]const u8 {
    return std.fmt.allocPrint(allocator, "{d}", .{value});
}

pub fn positiveProcessId(value: ?i32) ?i32 {
    const present = value orelse return null;
    return if (present > 0) present else null;
}

pub fn wireWindow(value: neutral_host.WindowSize) WireWindowSize {
    return .{
        .columns = value.columns,
        .rows = value.rows,
        .widthPixels = value.widthPixels,
        .heightPixels = value.heightPixels,
    };
}

fn wireProcess(value: neutral_host.ProcessIdentity) WireProcessIdentity {
    return .{ .processId = value.processId, .startToken = value.startToken };
}

pub fn validProcessIdentity(value: neutral_host.ProcessIdentity) bool {
    return value.processId > 0 and value.startToken.len > 0;
}

fn wireExit(value: neutral_host.ExitStatus) WireExitStatus {
    return .{ .code = value.code, .signal = value.signal, .observedAt = value.observedAt };
}

fn wireReap(value: neutral_host.ReapEvidence) WireReapEvidence {
    return .{
        .authority = switch (value.authority) {
            .@"direct-parent" => .@"direct-parent",
            .@"durable-parent-record" => .@"durable-parent-record",
            .unavailable => .unavailable,
        },
        .reaped = value.reaped,
        .status = if (value.status) |status| wireExit(status) else null,
        .completeness = switch (value.completeness) {
            .complete => .complete,
            .partial => .partial,
            .unavailable => .unavailable,
            .unknown => .unknown,
        },
    };
}

pub fn monotonicDeadline(platform: process_inspector.Platform, value: []const u8) !?u64 {
    const deadline_ms = try wall_clock.parseMillis(value);
    const wall_now = std.time.milliTimestamp();
    if (wall_now < 0) return error.InvalidTimestamp;
    const now_ms: u64 = @intCast(wall_now);
    if (deadline_ms <= now_ms) return null;
    const monotonic_now = platform.monoNow();
    const remaining_ms = deadline_ms - now_ms;
    const maximum_ms = (std.math.maxInt(u64) - monotonic_now) / std.time.ns_per_ms;
    if (remaining_ms > maximum_ms) return @as(?u64, std.math.maxInt(u64));
    return @as(?u64, monotonic_now + remaining_ms * std.time.ns_per_ms);
}

fn appendDiagnostic(
    diagnostics: *std.ArrayList([]const u8),
    allocator: std.mem.Allocator,
    value: []const u8,
) !void {
    try diagnostics.append(allocator, value);
}

pub fn makeCheckpoint(
    allocator: std.mem.Allocator,
    record: neutral_host.Record,
    live: ?LiveEvidence,
    include_checkpoint: bool,
    diagnostics: *std.ArrayList([]const u8),
) !?WireCheckpoint {
    if (record.checkpoints.retained == 0) return null;
    if (!include_checkpoint) {
        try appendDiagnostic(diagnostics, allocator, "checkpoint-body-omitted-from-bounded-control-projection");
        return null;
    }
    const snapshot = if (live) |value| value.newestCheckpoint orelse {
        try appendDiagnostic(diagnostics, allocator, "checkpoint-body-unavailable");
        return null;
    } else {
        try appendDiagnostic(diagnostics, allocator, "checkpoint-body-unavailable");
        return null;
    };
    if (snapshot.contentType.len == 0 or snapshot.schemaVersion.len == 0) {
        try appendDiagnostic(diagnostics, allocator, "checkpoint-metadata-invalid");
        return null;
    }
    const event_sequence = record.checkpoints.newestThroughEventSequence orelse {
        try appendDiagnostic(diagnostics, allocator, "checkpoint-cursors-unavailable");
        return null;
    };
    const output_offset = record.checkpoints.newestThroughOutputOffset orelse {
        try appendDiagnostic(diagnostics, allocator, "checkpoint-cursors-unavailable");
        return null;
    };
    if (snapshot.throughEventSequence != event_sequence or
        snapshot.throughOutputOffset != output_offset)
    {
        try appendDiagnostic(diagnostics, allocator, "checkpoint-cursor-readback-mismatch");
        return null;
    }
    const encoded_size = std.base64.standard.Encoder.calcSize(snapshot.opaqueBytes.len);
    const encoded = try allocator.alloc(u8, encoded_size);
    _ = std.base64.standard.Encoder.encode(encoded, snapshot.opaqueBytes);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(snapshot.opaqueBytes, &digest, .{});
    const digest_hex = std.fmt.bytesToHex(digest, .lower);
    return .{
        .contentType = snapshot.contentType,
        .schemaVersion = snapshot.schemaVersion,
        .hash = try allocator.dupe(u8, &digest_hex),
        .throughEventSequence = try decimal(allocator, event_sequence),
        .throughOutputOffset = try decimal(allocator, output_offset),
        .opaqueBytes = encoded,
    };
}

pub fn buildInspection(
    allocator: std.mem.Allocator,
    record: neutral_host.Record,
    platform: process_inspector.Platform,
    live: ?LiveEvidence,
    evidence_at: []const u8,
    include_checkpoint: bool,
    measured_reap: ?WireReapEvidence,
    leading_diagnostic: ?[]const u8,
) !WireInspection {
    var diagnostics: std.ArrayList([]const u8) = .{};
    if (leading_diagnostic) |value| try appendDiagnostic(&diagnostics, allocator, value);
    if (live) |value| {
        for (value.diagnostics) |diagnostic| try appendDiagnostic(&diagnostics, allocator, diagnostic);
    }
    if (measured_reap) |reap| {
        if (reap.reaped and reap.completeness != .complete)
            try appendDiagnostic(
                &diagnostics,
                allocator,
                "descendant-completeness-unavailable-after-root-reap",
            );
    }

    var descendants: std.ArrayList(WireProcessIdentity) = .{};
    const host = if (record.host) |value|
        if (validProcessIdentity(value)) value else null
    else
        null;
    const child = if (record.child) |value|
        if (validProcessIdentity(value)) value else null
    else
        null;
    if (record.host != null and host == null)
        try appendDiagnostic(&diagnostics, allocator, "host-identity-invalid");
    if (record.child != null and child == null)
        try appendDiagnostic(&diagnostics, allocator, "child-identity-invalid");
    var lifecycle: @FieldType(WireInspection, "lifecycle") = switch (record.lifecycle) {
        .reserved => .creating,
        .create_failed => .lost,
        .live => .running,
        .exited, .reaped => .exited,
        .unknown => .unknown,
    };
    if (record.lifecycle == .create_failed)
        try appendDiagnostic(&diagnostics, allocator, "create-failed-before-live-host-registration");
    if (child) |child_identity| {
        const token = process_inspector.StartToken.parse(child_identity.startToken) catch null;
        if (token) |expected| {
            var snapshot = process_inspector.snapshotTree(
                platform,
                allocator,
                child_identity.processId,
                expected,
            ) catch null;
            if (snapshot) |*observed| {
                defer observed.deinit(allocator);
                if (observed.status != .stable) {
                    try appendDiagnostic(&diagnostics, allocator, "process-tree-snapshot-unstable");
                }
                if (observed.root_missing and record.lifecycle == .live) lifecycle = .lost;
                for (observed.members) |member| {
                    if (member.pid == child_identity.processId and member.start_token.eql(expected)) continue;
                    var token_storage: [64]u8 = undefined;
                    const start_token = try member.start_token.format(&token_storage);
                    try descendants.append(allocator, .{
                        .processId = member.pid,
                        .startToken = try allocator.dupe(u8, start_token),
                    });
                }
            } else {
                try appendDiagnostic(&diagnostics, allocator, "process-tree-inspection-unavailable");
            }
        } else {
            try appendDiagnostic(&diagnostics, allocator, "child-start-token-invalid");
        }
    } else if (record.lifecycle == .live) {
        try appendDiagnostic(&diagnostics, allocator, "child-identity-unavailable");
    }

    var job_control: ?WireJobControlEvidence = null;
    if (record.sessionLeader != null and record.controllingTerminal != null and
        record.standardStreamsShareTerminal != null and record.childSessionId != null and
        record.childProcessGroupId != null and record.foregroundProcessGroupId != null and
        record.terminalIdentity != null and record.initialProfileAppliedBeforeExec != null and
        record.initialWindowAppliedBeforeExec != null and record.childSessionId.? > 0 and
        record.childProcessGroupId.? > 0 and record.foregroundProcessGroupId.? > 0 and
        record.terminalIdentity.?.len > 0)
    {
        const fresh_foreground = if (live) |value|
            positiveProcessId(value.foregroundProcessGroupId)
        else
            null;
        if (fresh_foreground == null)
            try appendDiagnostic(&diagnostics, allocator, "foreground-process-group-live-readback-unavailable");
        job_control = .{
            .sessionLeader = record.sessionLeader.?,
            .controllingTerminal = record.controllingTerminal.?,
            .standardStreamsShareTerminal = record.standardStreamsShareTerminal.?,
            .childSessionId = record.childSessionId.?,
            .childProcessGroupId = record.childProcessGroupId.?,
            .foregroundProcessGroupId = fresh_foreground orelse record.foregroundProcessGroupId.?,
            .terminalIdentity = record.terminalIdentity.?,
            .initialProfileAppliedBeforeExec = record.initialProfileAppliedBeforeExec.?,
            .initialWindowAppliedBeforeExec = record.initialWindowAppliedBeforeExec.?,
            .completeness = if (fresh_foreground != null) .complete else .partial,
        };
    } else {
        try appendDiagnostic(&diagnostics, allocator, "job-control-evidence-unavailable");
    }

    const newest = try makeCheckpoint(
        allocator,
        record,
        live,
        include_checkpoint,
        &diagnostics,
    );
    const reap = if (measured_reap) |value|
        value
    else if (record.reap) |value|
        wireReap(value)
    else
        WireReapEvidence{
            .authority = .unavailable,
            .reaped = false,
            .status = null,
            .completeness = .unknown,
        };
    if (reap.completeness != .complete)
        try appendDiagnostic(&diagnostics, allocator, "reap-evidence-incomplete");

    var survivors: []const WireSurvivor = &.{};
    if (record.terminationResultJson) |encoded| {
        const terminated = std.json.parseFromSliceLeaky(
            WireTerminationPayload,
            allocator,
            encoded,
            .{},
        ) catch null;
        if (terminated) |value| {
            if (value.schemaVersion == 1) {
                survivors = value.survivors;
            } else {
                try appendDiagnostic(&diagnostics, allocator, "termination-result-schema-unsupported");
            }
        } else {
            try appendDiagnostic(&diagnostics, allocator, "termination-result-evidence-invalid");
        }
    }

    const diagnostic_slice = try diagnostics.toOwnedSlice(allocator);
    const completeness: Completeness = if (record.lifecycle == .unknown or
        reap.completeness == .unknown)
        .unknown
    else if (record.lifecycle == .create_failed)
        .partial
    else if (diagnostic_slice.len == 0)
        .complete
    else
        .partial;
    return .{
        .session = record.session,
        .lifecycle = lifecycle,
        .completeness = completeness,
        .host = if (host) |value| wireProcess(value) else null,
        .child = if (child) |value| wireProcess(value) else null,
        .jobControl = job_control,
        .window = .{
            .value = wireWindow(record.window),
            .revision = try decimal(allocator, record.windowRevision),
        },
        .output = .{
            .closed = record.output.closed,
            .retained = .{
                .start = try decimal(allocator, record.output.retainedStart),
                .endExclusive = try decimal(allocator, record.output.retainedEndExclusive),
            },
        },
        .checkpoints = .{ .retained = record.checkpoints.retained, .newest = newest },
        .inputOwner = if (live) |value| value.inputOwner else null,
        .exit = if (record.exit) |value| wireExit(value) else null,
        .reap = reap,
        .descendants = try descendants.toOwnedSlice(allocator),
        .survivors = survivors,
        .evidenceAt = evidence_at,
        .diagnostics = diagnostic_slice,
    };
}

pub fn inspectionPayload(inspection: WireInspection) WireInspectionPayload {
    return .{
        .session = inspection.session,
        .lifecycle = inspection.lifecycle,
        .completeness = inspection.completeness,
        .host = inspection.host,
        .child = inspection.child,
        .jobControl = inspection.jobControl,
        .window = inspection.window,
        .output = inspection.output,
        .checkpoints = inspection.checkpoints,
        .inputOwner = inspection.inputOwner,
        .exit = inspection.exit,
        .reap = inspection.reap,
        .descendants = inspection.descendants,
        .survivors = inspection.survivors,
        .evidenceAt = inspection.evidenceAt,
        .diagnostics = inspection.diagnostics,
    };
}

pub fn terminationPayload(result: WireTerminationResult) WireTerminationPayload {
    return .{
        .state = result.state,
        .exit = result.exit,
        .reap = result.reap,
        .survivors = result.survivors,
        .completeness = result.completeness,
        .diagnostics = result.diagnostics,
    };
}

pub fn canonicalTermination(
    allocator: std.mem.Allocator,
    request: TerminateRequest,
) !struct { bytes: []u8, digest: [32]u8 } {
    const bytes = try std.json.Stringify.valueAlloc(allocator, request, .{});
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    return .{ .bytes = bytes, .digest = digest };
}

pub const RootReapPlatform = struct {
    delegate: process_inspector.Platform,
    rootPid: i32,
    status: ?c_int = null,
    observedRunning: bool = false,
    unavailable: bool = false,

    pub fn platform(self: *RootReapPlatform) process_inspector.Platform {
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
        const self: *RootReapPlatform = @ptrCast(@alignCast(context));
        return self.delegate.monoNow();
    }

    fn sleep(context: *anyopaque, nanoseconds: u64) void {
        const self: *RootReapPlatform = @ptrCast(@alignCast(context));
        self.delegate.sleep(nanoseconds);
    }

    fn kill(context: *anyopaque, pid: i32, signal: i32) bool {
        const self: *RootReapPlatform = @ptrCast(@alignCast(context));
        return self.delegate.kill(pid, signal);
    }

    fn observe(context: *anyopaque, pid: i32) process_inspector.ObserveResult {
        const self: *RootReapPlatform = @ptrCast(@alignCast(context));
        return self.delegate.observe(pid);
    }

    fn waitNoHang(context: *anyopaque, pid: i32) bool {
        const self: *RootReapPlatform = @ptrCast(@alignCast(context));
        if (pid != self.rootPid) return self.delegate.waitNoHang(pid);
        return self.probe();
    }

    fn listChildren(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        pid: i32,
    ) anyerror![]i32 {
        const self: *RootReapPlatform = @ptrCast(@alignCast(context));
        return self.delegate.listChildren(allocator, pid);
    }

    fn probe(self: *RootReapPlatform) bool {
        if (self.status != null) return true;
        var status: c_int = 0;
        const waited = c.waitpid(self.rootPid, &status, c.WNOHANG);
        if (waited == self.rootPid) {
            self.status = status;
            self.observedRunning = false;
            self.unavailable = false;
            return true;
        }
        if (waited == 0) {
            self.observedRunning = true;
            return false;
        }
        self.unavailable = true;
        return false;
    }

    pub fn evidence(
        self: *RootReapPlatform,
        allocator: std.mem.Allocator,
        clock: EvidenceClock,
    ) !WireReapEvidence {
        _ = self.probe();
        if (self.status) |status| {
            const status_bits: u32 = @bitCast(status);
            var time_storage: [24]u8 = undefined;
            const observed_at = try allocator.dupe(u8, try clock.now(&time_storage));
            const exit = WireExitStatus{
                .code = if (std.posix.W.IFEXITED(status_bits))
                    @intCast(std.posix.W.EXITSTATUS(status_bits))
                else
                    null,
                .signal = if (std.posix.W.IFSIGNALED(status_bits))
                    @intCast(std.posix.W.TERMSIG(status_bits))
                else
                    null,
                .observedAt = observed_at,
            };
            return .{
                .authority = .@"direct-parent",
                .reaped = true,
                .status = exit,
                .completeness = .complete,
            };
        }
        if (self.observedRunning) return .{
            .authority = .@"direct-parent",
            .reaped = false,
            .status = null,
            .completeness = .complete,
        };
        return .{
            .authority = .unavailable,
            .reaped = false,
            .status = null,
            .completeness = .unknown,
        };
    }
};

pub fn durableTermination(
    allocator: std.mem.Allocator,
    record: neutral_host.Record,
    diagnostic: []const u8,
) !WireTerminationResult {
    const reap = if (record.reap) |value| wireReap(value) else WireReapEvidence{
        .authority = .unavailable,
        .reaped = false,
        .status = null,
        .completeness = .unknown,
    };
    const diagnostics = try allocator.alloc([]const u8, 1);
    diagnostics[0] = diagnostic;
    return .{
        .state = if (reap.reaped and reap.completeness == .complete) .terminated else .unknown,
        .exit = if (record.exit) |value| wireExit(value) else reap.status,
        .reap = reap,
        .survivors = &.{},
        .completeness = if (reap.reaped and reap.completeness == .complete) .complete else .unknown,
        .diagnostics = diagnostics,
    };
}

pub fn terminationFromTree(
    allocator: std.mem.Allocator,
    tree: process_inspector.TerminationResult,
    reap: WireReapEvidence,
) !WireTerminationResult {
    var survivors: std.ArrayList(WireSurvivor) = .{};
    var diagnostics: std.ArrayList([]const u8) = .{};
    for (tree.members) |member| {
        if (member.fate == .terminated) continue;
        var token_storage: [64]u8 = undefined;
        const token = try member.identity.start_token.format(&token_storage);
        try survivors.append(allocator, .{
            .process = .{
                .processId = member.identity.pid,
                .startToken = try allocator.dupe(u8, token),
            },
            .reason = member.reason,
        });
        if (member.fate == .unknown)
            try diagnostics.append(allocator, "termination-member-fate-unknown");
    }
    if (tree.snapshot_status == .unknown)
        try diagnostics.append(allocator, "process-tree-snapshot-unstable");
    if (tree.deadline_expired)
        try diagnostics.append(allocator, "termination-deadline-expired");
    if (reap.completeness != .complete)
        try diagnostics.append(allocator, "direct-parent-reap-unavailable");
    const completeness: Completeness = if (tree.state == .unknown or tree.snapshot_status == .unknown)
        .unknown
    else if (reap.completeness != .complete)
        .partial
    else
        .complete;
    return .{
        .state = switch (tree.state) {
            .terminated => .terminated,
            .survivors => .survivors,
            .unknown => .unknown,
        },
        .exit = reap.status,
        .reap = reap,
        .survivors = try survivors.toOwnedSlice(allocator),
        .completeness = completeness,
        .diagnostics = try diagnostics.toOwnedSlice(allocator),
    };
}

pub fn measureDirectChildReap(
    allocator: std.mem.Allocator,
    record: neutral_host.Record,
    clock: EvidenceClock,
) !?WireReapEvidence {
    if (record.lifecycle != .live) return null;
    const child = record.child orelse return null;
    if (!validProcessIdentity(child)) return null;
    var status: c_int = 0;
    const waited = c.waitpid(child.processId, &status, c.WNOHANG);
    if (waited == 0) return WireReapEvidence{
        .authority = .@"direct-parent",
        .reaped = false,
        .status = null,
        .completeness = .complete,
    };
    if (waited != child.processId) return null;
    const status_bits: u32 = @bitCast(status);
    var time_storage: [24]u8 = undefined;
    const observed_at = try allocator.dupe(u8, try clock.now(&time_storage));
    const exit = WireExitStatus{
        .code = if (std.posix.W.IFEXITED(status_bits))
            @intCast(std.posix.W.EXITSTATUS(status_bits))
        else
            null,
        .signal = if (std.posix.W.IFSIGNALED(status_bits))
            @intCast(std.posix.W.TERMSIG(status_bits))
        else
            null,
        .observedAt = observed_at,
    };
    return WireReapEvidence{
        .authority = .@"direct-parent",
        .reaped = true,
        .status = exit,
        // A passive inspect can prove the direct child was reaped, but it did
        // not capture/contain the pre-exit descendant set.
        .completeness = .partial,
    };
}
