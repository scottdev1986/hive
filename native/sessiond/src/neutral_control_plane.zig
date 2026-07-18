//! Frozen A0 LIST/INSPECT/TERMINATE projection for the neutral host seam.
//!
//! Hive locator and visibility policy never crosses this module. Controller
//! operations address only an exact neutral SessionRef and preserve measured
//! partial/unavailable evidence when a live host cannot be reached.

const std = @import("std");
const generated = @import("session_protocol_generated");
const neutral_host = @import("neutral_host");
const process_inspector = @import("process_inspector");

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

const ListRequest = struct { schemaVersion: u8 };
const InspectRequest = struct { schemaVersion: u8, session: neutral_host.SessionRef };
const HostInspectRequest = struct { schemaVersion: u8, includeCheckpoint: bool };
const TerminateRequest = struct {
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

fn decimal(allocator: std.mem.Allocator, value: u64) ![]const u8 {
    return std.fmt.allocPrint(allocator, "{d}", .{value});
}

fn positiveProcessId(value: ?i32) ?i32 {
    const present = value orelse return null;
    return if (present > 0) present else null;
}

fn wireWindow(value: neutral_host.WindowSize) WireWindowSize {
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

fn validProcessIdentity(value: neutral_host.ProcessIdentity) bool {
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

fn parseStartToken(value: []const u8) !process_inspector.StartToken {
    const separator = std.mem.indexOfScalar(u8, value, ':') orelse return error.InvalidStartToken;
    if (separator == 0 or separator + 1 == value.len or
        std.mem.indexOfScalarPos(u8, value, separator + 1, ':') != null)
        return error.InvalidStartToken;
    return .{
        .seconds = try std.fmt.parseInt(u64, value[0..separator], 10),
        .microseconds = try std.fmt.parseInt(u64, value[separator + 1 ..], 10),
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

fn monotonicDeadline(platform: process_inspector.Platform, value: []const u8) !?u64 {
    const deadline_ms = try wallTimestampMillis(value);
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

fn makeCheckpoint(
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

fn buildInspection(
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
        const token = parseStartToken(child_identity.startToken) catch null;
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

fn inspectionPayload(inspection: WireInspection) WireInspectionPayload {
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

fn terminationPayload(result: WireTerminationResult) WireTerminationPayload {
    return .{
        .state = result.state,
        .exit = result.exit,
        .reap = result.reap,
        .survivors = result.survivors,
        .completeness = result.completeness,
        .diagnostics = result.diagnostics,
    };
}

fn canonicalTermination(
    allocator: std.mem.Allocator,
    request: TerminateRequest,
) !struct { bytes: []u8, digest: [32]u8 } {
    const bytes = try std.json.Stringify.valueAlloc(allocator, request, .{});
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    return .{ .bytes = bytes, .digest = digest };
}

const RootReapPlatform = struct {
    delegate: process_inspector.Platform,
    rootPid: i32,
    status: ?c_int = null,
    observedRunning: bool = false,
    unavailable: bool = false,

    fn platform(self: *RootReapPlatform) process_inspector.Platform {
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

    fn evidence(
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

fn durableTermination(
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

fn terminationFromTree(
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

fn measureDirectChildReap(
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

pub const HostOperations = struct {
    allocator: std.mem.Allocator,
    registry: *neutral_host.Registry,
    session: neutral_host.SessionRef,
    platform: process_inspector.Platform,
    evidence: EvidenceProvider,
    clock: EvidenceClock,
    scratch: std.heap.ArenaAllocator,

    pub fn init(
        allocator: std.mem.Allocator,
        registry: *neutral_host.Registry,
        session: neutral_host.SessionRef,
        platform: process_inspector.Platform,
        evidence: EvidenceProvider,
        clock: EvidenceClock,
    ) !HostOperations {
        const key = try allocator.dupe(u8, session.key);
        errdefer allocator.free(key);
        return .{
            .allocator = allocator,
            .registry = registry,
            .session = .{
                .key = key,
                .incarnation = try allocator.dupe(u8, session.incarnation),
            },
            .platform = platform,
            .evidence = evidence,
            .clock = clock,
            .scratch = std.heap.ArenaAllocator.init(allocator),
        };
    }

    pub fn deinit(self: *HostOperations) void {
        self.scratch.deinit();
        self.allocator.free(self.session.incarnation);
        self.allocator.free(self.session.key);
        self.* = undefined;
    }

    pub fn handler(self: *HostOperations) neutral_host.OperationHandler {
        return .{ .context = self, .callFn = call };
    }

    fn call(context: *anyopaque, request: neutral_host.OperationRequest) !neutral_host.OperationResponse {
        const self: *HostOperations = @ptrCast(@alignCast(context));
        if (!request.session.eql(self.session)) return error.StaleSessionRef;
        return switch (request.operation) {
            .inspect => self.inspect(request.payload),
            .terminate => self.terminate(request),
            else => .{ .accepted = false, .payload = "operation-not-implemented" },
        };
    }

    fn commitTerminationResult(
        self: *HostOperations,
        allocator: std.mem.Allocator,
        request: TerminateRequest,
        digest: [32]u8,
        result: WireTerminationResult,
    ) !neutral_host.OperationResponse {
        const encoded = try std.json.Stringify.valueAlloc(
            allocator,
            terminationPayload(result),
            .{},
        );
        if (encoded.len > generated.limits.control_json_bytes)
            return error.TerminationResponseTooLarge;
        const stored = try self.registry.commitTermination(
            self.session,
            request.idempotencyKey,
            digest,
            encoded,
        );
        return .{ .payload = try allocator.dupe(u8, stored) };
    }

    fn terminate(
        self: *HostOperations,
        operation: neutral_host.OperationRequest,
    ) !neutral_host.OperationResponse {
        _ = self.scratch.reset(.retain_capacity);
        const allocator = self.scratch.allocator();
        var parsed = try std.json.parseFromSlice(TerminateRequest, allocator, operation.payload, .{});
        defer parsed.deinit();
        const request = parsed.value;
        if (request.schemaVersion != 1 or !request.session.eql(self.session) or
            !std.mem.eql(u8, request.idempotencyKey, operation.idempotencyKey))
            return error.InvalidTerminationRequest;
        const canonical = try canonicalTermination(allocator, request);
        switch (try self.registry.reserveTermination(
            self.session,
            request.idempotencyKey,
            canonical.digest,
        )) {
            .replay => |stored| return .{ .payload = try allocator.dupe(u8, stored) },
            .reserved, .pending => {},
        }

        const record = self.registry.get(self.session) orelse return error.SessionNotFound;
        if (record.reap != null and record.reap.?.reaped) {
            const result = try durableTermination(
                allocator,
                record,
                "termination-completed-from-durable-reap-evidence",
            );
            return self.commitTerminationResult(
                allocator,
                request,
                canonical.digest,
                result,
            );
        }
        const deadline = try monotonicDeadline(self.platform, request.deadline) orelse {
            const result = try durableTermination(
                allocator,
                record,
                "termination-deadline-expired-before-signal",
            );
            return self.commitTerminationResult(
                allocator,
                request,
                canonical.digest,
                result,
            );
        };
        const child = record.child orelse {
            const result = try durableTermination(
                allocator,
                record,
                "termination-child-identity-unavailable",
            );
            return self.commitTerminationResult(
                allocator,
                request,
                canonical.digest,
                result,
            );
        };
        if (!validProcessIdentity(child)) {
            const result = try durableTermination(
                allocator,
                record,
                "termination-child-identity-invalid",
            );
            return self.commitTerminationResult(
                allocator,
                request,
                canonical.digest,
                result,
            );
        }
        const child_start_token = parseStartToken(child.startToken) catch {
            const result = try durableTermination(
                allocator,
                record,
                "termination-child-start-token-invalid",
            );
            return self.commitTerminationResult(
                allocator,
                request,
                canonical.digest,
                result,
            );
        };
        const target: process_inspector.TerminationTarget = switch (request.target) {
            .@"process-tree" => .process_tree,
            .@"foreground-group" => .{ .foreground_group = positiveProcessId(record.foregroundProcessGroupId) orelse {
                const result = try durableTermination(
                    allocator,
                    record,
                    "foreground-process-group-unavailable",
                );
                return self.commitTerminationResult(
                    allocator,
                    request,
                    canonical.digest,
                    result,
                );
            } },
            .@"session-members" => .{ .session_members = positiveProcessId(record.childSessionId) orelse {
                const result = try durableTermination(
                    allocator,
                    record,
                    "child-session-id-unavailable",
                );
                return self.commitTerminationResult(
                    allocator,
                    request,
                    canonical.digest,
                    result,
                );
            } },
        };
        var reap_platform: RootReapPlatform = .{
            .delegate = self.platform,
            .rootPid = child.processId,
        };
        var tree = process_inspector.terminateTreeTargetedUntil(
            reap_platform.platform(),
            allocator,
            child.processId,
            child_start_token,
            switch (request.mode) {
                .graceful => .graceful,
                .immediate => .immediate,
            },
            target,
            deadline,
        ) catch {
            const result = try durableTermination(
                allocator,
                record,
                "process-tree-termination-unavailable",
            );
            return self.commitTerminationResult(
                allocator,
                request,
                canonical.digest,
                result,
            );
        };
        defer tree.deinit(allocator);
        const reap = try reap_platform.evidence(allocator, self.clock);
        const result = try terminationFromTree(allocator, tree, reap);
        if (reap.reaped) {
            const status = reap.status orelse return error.InvalidReapEvidence;
            _ = try self.registry.update(self.session, .{
                .lifecycle = .reaped,
                .exit = .{
                    .code = status.code,
                    .signal = status.signal,
                    .observedAt = status.observedAt,
                },
                .reap = .{
                    .authority = .@"direct-parent",
                    .reaped = true,
                    .status = .{
                        .code = status.code,
                        .signal = status.signal,
                        .observedAt = status.observedAt,
                    },
                    .completeness = switch (result.completeness) {
                        .complete => .complete,
                        .partial => .partial,
                        .unavailable => .unavailable,
                        .unknown => .unknown,
                    },
                },
            });
        }
        return self.commitTerminationResult(
            allocator,
            request,
            canonical.digest,
            result,
        );
    }

    fn inspect(self: *HostOperations, payload: []const u8) !neutral_host.OperationResponse {
        _ = self.scratch.reset(.retain_capacity);
        const allocator = self.scratch.allocator();
        const request = try std.json.parseFromSliceLeaky(HostInspectRequest, allocator, payload, .{});
        if (request.schemaVersion != 1) return error.InvalidInspectRequest;
        var time_storage: [24]u8 = undefined;
        const evidence_at = try allocator.dupe(u8, try self.clock.now(&time_storage));
        var record = self.registry.get(self.session) orelse return error.SessionNotFound;
        const measured_reap = try measureDirectChildReap(allocator, record, self.clock);
        if (measured_reap) |reap| {
            if (reap.reaped) {
                const status = reap.status orelse return error.InvalidReapEvidence;
                record = try self.registry.update(self.session, .{
                    .lifecycle = .reaped,
                    .exit = .{
                        .code = status.code,
                        .signal = status.signal,
                        .observedAt = status.observedAt,
                    },
                    .reap = .{
                        .authority = .@"direct-parent",
                        .reaped = true,
                        .status = .{
                            .code = status.code,
                            .signal = status.signal,
                            .observedAt = status.observedAt,
                        },
                        .completeness = switch (reap.completeness) {
                            .complete => .complete,
                            .partial => .partial,
                            .unavailable => .unavailable,
                            .unknown => .unknown,
                        },
                    },
                });
            }
        }
        const live = self.evidence.measure(allocator) catch null;
        var inspection = try buildInspection(
            allocator,
            record,
            self.platform,
            live,
            evidence_at,
            request.includeCheckpoint,
            measured_reap,
            if (live == null) "live-evidence-provider-unavailable" else null,
        );
        var response = try std.json.Stringify.valueAlloc(
            allocator,
            inspectionPayload(inspection),
            .{},
        );
        if (response.len > generated.limits.control_json_bytes and inspection.checkpoints.newest != null) {
            _ = self.scratch.reset(.retain_capacity);
            const retry_allocator = self.scratch.allocator();
            const retry_live = self.evidence.measure(retry_allocator) catch null;
            const retry_record = self.registry.get(self.session) orelse return error.SessionNotFound;
            const retry_reap = try measureDirectChildReap(retry_allocator, retry_record, self.clock);
            var retry_storage: [24]u8 = undefined;
            const retry_time = try retry_allocator.dupe(u8, try self.clock.now(&retry_storage));
            inspection = try buildInspection(
                retry_allocator,
                retry_record,
                self.platform,
                retry_live,
                retry_time,
                false,
                retry_reap,
                "checkpoint-body-exceeds-control-frame",
            );
            response = try std.json.Stringify.valueAlloc(
                retry_allocator,
                inspectionPayload(inspection),
                .{},
            );
        }
        if (response.len > generated.limits.control_json_bytes) return error.InspectResponseTooLarge;
        return .{ .payload = response };
    }
};

pub const Controller = struct {
    allocator: std.mem.Allocator,
    registry: *neutral_host.Registry,
    platform: process_inspector.Platform,
    clock: EvidenceClock,

    fn fallbackInspectionValue(
        self: *Controller,
        allocator: std.mem.Allocator,
        record: neutral_host.Record,
        diagnostic: []const u8,
    ) !std.json.Value {
        var time_storage: [24]u8 = undefined;
        const evidence_at = try allocator.dupe(u8, try self.clock.now(&time_storage));
        const inspection = try buildInspection(
            allocator,
            record,
            self.platform,
            null,
            evidence_at,
            false,
            null,
            diagnostic,
        );
        const encoded = try std.json.Stringify.valueAlloc(allocator, inspection, .{});
        return std.json.parseFromSliceLeaky(std.json.Value, allocator, encoded, .{});
    }

    fn callInspect(
        self: *Controller,
        allocator: std.mem.Allocator,
        record: neutral_host.Record,
        include_checkpoint: bool,
    ) ![]u8 {
        var client = try self.registry.connect(record.session);
        defer client.deinit();
        const request = if (include_checkpoint)
            "{\"schemaVersion\":1,\"includeCheckpoint\":true}"
        else
            "{\"schemaVersion\":1,\"includeCheckpoint\":false}";
        var response = try client.call(allocator, .inspect, "", request);
        defer response.deinit();
        if (!response.accepted) return error.InspectRejected;
        var parsed = try std.json.parseFromSlice(WireInspectionPayload, allocator, response.payload, .{});
        defer parsed.deinit();
        if (parsed.value.schemaVersion != 1 or !parsed.value.session.eql(record.session))
            return error.InvalidInspectResponse;
        return allocator.dupe(u8, response.payload);
    }

    pub fn inspect(self: *Controller, payload: []const u8) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        var request = try std.json.parseFromSlice(InspectRequest, allocator, payload, .{});
        defer request.deinit();
        if (request.value.schemaVersion != 1) return error.InvalidInspectRequest;
        const record = self.registry.get(request.value.session) orelse return error.SessionNotFound;
        return self.callInspect(self.allocator, record, true) catch {
            const fallback = try self.fallbackInspectionValue(
                allocator,
                record,
                "neutral-host-control-unavailable",
            );
            var root = std.json.ObjectMap.init(allocator);
            try root.put("schemaVersion", .{ .integer = 1 });
            for (fallback.object.keys(), fallback.object.values()) |key, value| try root.put(key, value);
            const response = try std.json.Stringify.valueAlloc(
                self.allocator,
                std.json.Value{ .object = root },
                .{},
            );
            if (response.len > generated.limits.control_json_bytes) {
                self.allocator.free(response);
                return error.InspectResponseTooLarge;
            }
            return response;
        };
    }

    fn commitFallbackTermination(
        self: *Controller,
        allocator: std.mem.Allocator,
        request: TerminateRequest,
        digest: [32]u8,
        diagnostic: []const u8,
    ) ![]u8 {
        const record = self.registry.get(request.session) orelse return error.SessionNotFound;
        const result = try durableTermination(allocator, record, diagnostic);
        const encoded = try std.json.Stringify.valueAlloc(
            allocator,
            terminationPayload(result),
            .{},
        );
        if (encoded.len > generated.limits.control_json_bytes)
            return error.TerminationResponseTooLarge;
        const stored = try self.registry.commitTermination(
            request.session,
            request.idempotencyKey,
            digest,
            encoded,
        );
        return self.allocator.dupe(u8, stored);
    }

    pub fn terminate(self: *Controller, payload: []const u8) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        var parsed = try std.json.parseFromSlice(TerminateRequest, allocator, payload, .{});
        defer parsed.deinit();
        const request = parsed.value;
        if (request.schemaVersion != 1) return error.InvalidTerminationRequest;
        const canonical = try canonicalTermination(allocator, request);
        switch (try self.registry.reserveTermination(
            request.session,
            request.idempotencyKey,
            canonical.digest,
        )) {
            .replay => |stored| return self.allocator.dupe(u8, stored),
            .reserved, .pending => {},
        }

        const call_result = blk: {
            var client = self.registry.connect(request.session) catch break :blk null;
            defer client.deinit();
            var response = client.call(
                self.allocator,
                .terminate,
                request.idempotencyKey,
                canonical.bytes,
            ) catch break :blk null;
            defer response.deinit();
            if (!response.accepted) break :blk null;
            var validated = std.json.parseFromSlice(
                WireTerminationPayload,
                allocator,
                response.payload,
                .{},
            ) catch break :blk null;
            defer validated.deinit();
            if (validated.value.schemaVersion != 1) break :blk null;
            break :blk try self.allocator.dupe(u8, response.payload);
        };
        if (call_result) |response| return response;

        // The host may have committed immediately before its socket vanished.
        // Refresh, then prefer the exact durable replay over reconstruction.
        try self.registry.recover();
        switch (try self.registry.reserveTermination(
            request.session,
            request.idempotencyKey,
            canonical.digest,
        )) {
            .replay => |stored| return self.allocator.dupe(u8, stored),
            .reserved, .pending => {},
        }
        return self.commitFallbackTermination(
            allocator,
            request,
            canonical.digest,
            "neutral-host-control-unavailable-during-termination",
        );
    }

    fn listProjection(
        self: *Controller,
        allocator: std.mem.Allocator,
        include_checkpoint: bool,
    ) ![]u8 {
        var entries = std.json.Array.init(allocator);
        for (self.registry.list()) |record| {
            const encoded = self.callInspect(allocator, record, include_checkpoint) catch null;
            const entry = if (encoded) |value| blk: {
                var parsed = try std.json.parseFromSliceLeaky(std.json.Value, allocator, value, .{});
                _ = parsed.object.swapRemove("schemaVersion");
                break :blk parsed;
            } else try self.fallbackInspectionValue(
                allocator,
                record,
                "neutral-host-control-unavailable",
            );
            try entries.append(entry);
        }
        var root = std.json.ObjectMap.init(allocator);
        try root.put("schemaVersion", .{ .integer = 1 });
        try root.put("entries", .{ .array = entries });
        const response = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .object = root },
            .{},
        );
        return response;
    }

    pub fn list(self: *Controller, payload: []const u8) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        var request = try std.json.parseFromSlice(ListRequest, allocator, payload, .{});
        defer request.deinit();
        if (request.value.schemaVersion != 1) return error.InvalidListRequest;

        const full = try self.listProjection(allocator, true);
        if (full.len <= generated.limits.control_json_bytes) return full;
        self.allocator.free(full);

        const bounded = try self.listProjection(allocator, false);
        if (bounded.len > generated.limits.control_json_bytes) {
            self.allocator.free(bounded);
            return error.ListResponseTooLarge;
        }
        return bounded;
    }
};

test "RFC3339 system clock emits the frozen millisecond UTC shape" {
    var storage: [24]u8 = undefined;
    const value = try EvidenceClock.system().now(&storage);
    try std.testing.expectEqual(@as(usize, 24), value.len);
    try std.testing.expectEqual(@as(u8, 'T'), value[10]);
    try std.testing.expectEqual(@as(u8, '.'), value[19]);
    try std.testing.expectEqual(@as(u8, 'Z'), value[23]);
}

test "checkpoint projection preserves independent cursors and opaque bytes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const record: neutral_host.Record = .{
        .session = .{ .key = "checkpoint-proof", .incarnation = "one" },
        .createIdempotencyKey = "create-checkpoint-proof",
        .requestSha256 = @splat(0),
        .window = .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
        .eventSequenceHighWater = 7,
        .output = .{ .retainedStart = 0, .retainedEndExclusive = 19, .closed = false },
        .checkpoints = .{
            .retained = 1,
            .newestThroughEventSequence = 7,
            .newestThroughOutputOffset = 19,
        },
    };
    const live: LiveEvidence = .{ .newestCheckpoint = .{
        .contentType = "application/vnd.hive.terminal-checkpoint",
        .schemaVersion = "proof-v1",
        .throughEventSequence = 7,
        .throughOutputOffset = 19,
        .opaqueBytes = "opaque-checkpoint",
    } };
    var diagnostics: std.ArrayList([]const u8) = .{};
    const checkpoint = (try makeCheckpoint(
        allocator,
        record,
        live,
        true,
        &diagnostics,
    )) orelse return error.CheckpointProjectionMissing;
    try std.testing.expectEqualStrings("7", checkpoint.throughEventSequence);
    try std.testing.expectEqualStrings("19", checkpoint.throughOutputOffset);
    const decoded_size = try std.base64.standard.Decoder.calcSizeForSlice(checkpoint.opaqueBytes);
    const decoded = try allocator.alloc(u8, decoded_size);
    try std.base64.standard.Decoder.decode(decoded, checkpoint.opaqueBytes);
    try std.testing.expectEqualStrings("opaque-checkpoint", decoded);
    try std.testing.expectEqual(@as(usize, 0), diagnostics.items.len);
}

test "inspection projects durable measured survivors from termination replay" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var real_platform = process_inspector.RealPlatform.init();
    const record: neutral_host.Record = .{
        .session = .{ .key = "survivor-proof", .incarnation = "one" },
        .createIdempotencyKey = "survivor-proof-create",
        .requestSha256 = @splat(0),
        .terminationIdempotencyKey = "survivor-proof-terminate",
        .terminationRequestSha256 = @splat(1),
        .terminationResultJson =
        \\{"schemaVersion":1,"state":"survivors","exit":null,"reap":{"authority":"unavailable","reaped":false,"status":null,"completeness":"unknown"},"survivors":[{"process":{"processId":42,"startToken":"1:2"},"reason":"still-running"}],"completeness":"partial","diagnostics":[]}
        ,
        .lifecycle = .unknown,
        .window = .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    };
    const inspection = try buildInspection(
        arena.allocator(),
        record,
        real_platform.platform(),
        null,
        "2026-07-18T00:00:00.000Z",
        false,
        null,
        null,
    );
    try std.testing.expectEqual(@as(usize, 1), inspection.survivors.len);
    try std.testing.expectEqual(@as(i32, 42), inspection.survivors[0].process.processId);
    try std.testing.expectEqualStrings("still-running", inspection.survivors[0].reason);
}

test "create failure projects as lost unknown evidence" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var real_platform = process_inspector.RealPlatform.init();
    const record: neutral_host.Record = .{
        .session = .{ .key = "failed-create", .incarnation = "one" },
        .createIdempotencyKey = "failed-create-key",
        .requestSha256 = @splat(0),
        .lifecycle = .create_failed,
        .window = .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    };
    const inspection = try buildInspection(
        arena.allocator(),
        record,
        real_platform.platform(),
        null,
        "2026-07-18T00:00:00.000Z",
        false,
        null,
        null,
    );
    try std.testing.expectEqual(
        @as(@FieldType(WireInspection, "lifecycle"), .lost),
        inspection.lifecycle,
    );
    try std.testing.expectEqual(Completeness.unknown, inspection.completeness);
    try std.testing.expect(inspection.diagnostics.len >= 1);
}

const ProofEvidence = struct {
    foregroundProcessGroupId: i32,
    oversizeCheckpoint: bool = false,

    fn measure(context: *anyopaque, allocator: std.mem.Allocator) !LiveEvidence {
        const self: *ProofEvidence = @ptrCast(@alignCast(context));
        const checkpoint = if (self.oversizeCheckpoint) blk: {
            const bytes = try allocator.alloc(u8, generated.limits.control_json_bytes);
            @memset(bytes, 'x');
            break :blk bytes;
        } else "real-proof-checkpoint";
        return .{
            .foregroundProcessGroupId = self.foregroundProcessGroupId,
            .newestCheckpoint = .{
                .contentType = "application/vnd.hive.terminal-checkpoint",
                .schemaVersion = "proof-v1",
                .throughEventSequence = 2,
                .throughOutputOffset = 9,
                .opaqueBytes = checkpoint,
            },
        };
    }

    fn provider(self: *ProofEvidence) EvidenceProvider {
        return .{ .context = self, .measureFn = measure };
    }
};

fn spawnProofProcessTree() !i32 {
    const ready = try std.posix.pipe();
    const root = try std.posix.fork();
    if (root == 0) {
        std.posix.close(ready[0]);
        _ = c.setsid();
        const descendant = std.posix.fork() catch std.posix.exit(126);
        if (descendant == 0) {
            std.posix.close(ready[1]);
            const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
            const envp = [_:null]?[*:0]const u8{};
            _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(&envp));
            std.posix.exit(127);
        }
        _ = std.posix.write(ready[1], "r") catch {};
        std.posix.close(ready[1]);
        const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
        const envp = [_:null]?[*:0]const u8{};
        _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(&envp));
        std.posix.exit(127);
    }
    std.posix.close(ready[1]);
    var byte: [1]u8 = undefined;
    const count = try std.posix.read(ready[0], &byte);
    std.posix.close(ready[0]);
    if (count != 1 or byte[0] != 'r') return error.ProofProcessNotReady;
    return root;
}

fn cleanupProofProcessTree(root: i32) void {
    if (root <= 1) return;
    _ = c.kill(-root, c.SIGKILL);
    _ = c.kill(root, c.SIGKILL);
    var status: c_int = 0;
    _ = c.waitpid(root, &status, c.WNOHANG);
}

fn runProofHost(root: []const u8, session: neutral_host.SessionRef, ready_fd: std.posix.fd_t) !void {
    const allocator = std.heap.page_allocator;
    var runtime = try neutral_host.Runtime.open(allocator, root);
    defer runtime.deinit();
    var registry = try neutral_host.Registry.open(allocator, &runtime);
    defer registry.deinit();

    const child_pid = try spawnProofProcessTree();
    defer cleanupProofProcessTree(child_pid);
    var child_identity: ?process_inspector.ProcessIdentity = null;
    var attempts: usize = 0;
    while (attempts < 100) : (attempts += 1) {
        child_identity = process_inspector.observeProcessPresent(child_pid);
        if (child_identity != null) break;
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    const child = child_identity orelse return error.ProofChildUnobservable;
    const host = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.ProofHostUnobservable;
    var host_token_storage: [64]u8 = undefined;
    const host_token = try host.start_token.format(&host_token_storage);
    var child_token_storage: [64]u8 = undefined;
    const child_token = try child.start_token.format(&child_token_storage);
    _ = try registry.register(session, .{
        .host = .{ .processId = host.pid, .startToken = host_token },
        .child = .{ .processId = child.pid, .startToken = child_token },
        .childSessionId = child.session,
        .childProcessGroupId = child.pgid,
        .foregroundProcessGroupId = child.pgid,
        .terminalIdentity = "proof-session-without-controlling-terminal",
        .sessionLeader = child.session == child.pid,
        .controllingTerminal = false,
        .standardStreamsShareTerminal = false,
        .initialProfileAppliedBeforeExec = false,
        .initialWindowAppliedBeforeExec = false,
        .window = .{ .columns = 100, .rows = 30, .widthPixels = 1000, .heightPixels = 600 },
    });
    _ = try registry.update(session, .{
        .eventSequenceHighWater = 2,
        .output = .{ .retainedStart = 0, .retainedEndExclusive = 9, .closed = false },
        .checkpoints = .{
            .retained = 1,
            .newestThroughEventSequence = 2,
            .newestThroughOutputOffset = 9,
        },
    });

    var endpoint = try neutral_host.HostEndpoint.open(allocator, &runtime, session);
    defer endpoint.deinit();
    var real_platform = process_inspector.RealPlatform.init();
    var evidence: ProofEvidence = .{
        .foregroundProcessGroupId = child.pgid,
        .oversizeCheckpoint = true,
    };
    var operations = try HostOperations.init(
        allocator,
        &registry,
        endpoint.session,
        real_platform.platform(),
        evidence.provider(),
        EvidenceClock.system(),
    );
    defer operations.deinit();

    var ready_storage: [32]u8 = undefined;
    const ready_message = try std.fmt.bufPrint(&ready_storage, "{d}\n", .{child_pid});
    if (try std.posix.write(ready_fd, ready_message) != ready_message.len)
        return error.ProofReadyWriteFailed;
    std.posix.close(ready_fd);
    try endpoint.serveOne(operations.handler());
    try endpoint.serveOne(operations.handler());
    try endpoint.serveOne(operations.handler());
}

test "live neutral session lists inspects and terminates with direct wait replay evidence" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    const testing = std.testing;
    const allocator = testing.allocator;
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/ncp-{x}", .{
        std.crypto.random.int(u64),
    });
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var root_directory = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try root_directory.chmod(0o700);
    root_directory.close();

    var runtime = try neutral_host.Runtime.open(allocator, root);
    defer runtime.deinit();
    var registry = try neutral_host.Registry.open(allocator, &runtime);
    defer registry.deinit();
    var create_digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("control-plane-live-proof", &create_digest, .{});
    const reserved = switch (try registry.reserve(
        "foreign://neutral/control-proof",
        "create-proof-1",
        create_digest,
        .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    )) {
        .reserved => |record| record,
        .existing => return error.UnexpectedCreateReplay,
    };
    const session_key = try allocator.dupe(u8, reserved.session.key);
    defer allocator.free(session_key);
    const session_incarnation = try allocator.dupe(u8, reserved.session.incarnation);
    defer allocator.free(session_incarnation);
    const session: neutral_host.SessionRef = .{
        .key = session_key,
        .incarnation = session_incarnation,
    };

    const ready = try std.posix.pipe();
    const host_pid = try std.posix.fork();
    if (host_pid == 0) {
        std.posix.close(ready[0]);
        runProofHost(root, session, ready[1]) catch std.posix.exit(70);
        std.posix.exit(0);
    }
    std.posix.close(ready[1]);
    var host_owned = true;
    var proof_child: i32 = -1;
    defer if (host_owned) {
        if (proof_child > 1) {
            _ = c.kill(-proof_child, c.SIGKILL);
            _ = c.kill(proof_child, c.SIGKILL);
        }
        _ = c.kill(host_pid, c.SIGKILL);
        var status: c_int = 0;
        _ = c.waitpid(host_pid, &status, 0);
    };
    var ready_bytes: [32]u8 = undefined;
    var ready_length: usize = 0;
    while (ready_length < ready_bytes.len) {
        const count = try std.posix.read(ready[0], ready_bytes[ready_length..]);
        if (count == 0) break;
        ready_length += count;
        if (std.mem.indexOfScalar(u8, ready_bytes[0..ready_length], '\n') != null) break;
    }
    std.posix.close(ready[0]);
    proof_child = try std.fmt.parseInt(
        i32,
        std.mem.trim(u8, ready_bytes[0..ready_length], " \r\n\t"),
        10,
    );
    try registry.recover();
    var controller_platform = process_inspector.RealPlatform.init();
    var controller: Controller = .{
        .allocator = allocator,
        .registry = &registry,
        .platform = controller_platform.platform(),
        .clock = EvidenceClock.system(),
    };

    const inspect_request = try std.json.Stringify.valueAlloc(
        allocator,
        InspectRequest{ .schemaVersion = 1, .session = session },
        .{},
    );
    defer allocator.free(inspect_request);
    const inspected_bytes = try controller.inspect(inspect_request);
    defer allocator.free(inspected_bytes);
    var inspected = try std.json.parseFromSlice(WireInspectionPayload, allocator, inspected_bytes, .{});
    defer inspected.deinit();
    try testing.expectEqual(@as(u8, 1), inspected.value.schemaVersion);
    try testing.expectEqual(@as(@FieldType(WireInspection, "lifecycle"), .running), inspected.value.lifecycle);
    try testing.expect(inspected.value.jobControl != null);
    try testing.expect(inspected.value.descendants.len >= 1);
    try testing.expectEqual(@as(u32, 1), inspected.value.checkpoints.retained);
    try testing.expect(inspected.value.checkpoints.newest == null);
    try testing.expectEqual(Completeness.partial, inspected.value.completeness);
    var found_size_diagnostic = false;
    for (inspected.value.diagnostics) |diagnostic| {
        if (std.mem.eql(u8, diagnostic, "checkpoint-body-exceeds-control-frame"))
            found_size_diagnostic = true;
    }
    try testing.expect(found_size_diagnostic);
    try testing.expectEqual(@as(@FieldType(WireReapEvidence, "authority"), .@"direct-parent"), inspected.value.reap.authority);
    try testing.expect(!inspected.value.reap.reaped);

    const listed_bytes = try controller.list("{\"schemaVersion\":1}");
    defer allocator.free(listed_bytes);
    const Listed = struct { schemaVersion: u8, entries: []WireInspection };
    var listed = try std.json.parseFromSlice(Listed, allocator, listed_bytes, .{});
    defer listed.deinit();
    try testing.expectEqual(@as(u8, 1), listed.value.schemaVersion);
    try testing.expectEqual(@as(usize, 1), listed.value.entries.len);
    try testing.expect(listed.value.entries[0].session.eql(session));
    try testing.expectEqual(@as(u32, 1), listed.value.entries[0].checkpoints.retained);
    try testing.expect(listed.value.entries[0].checkpoints.newest == null);
    var listed_size_diagnostic = false;
    for (listed.value.entries[0].diagnostics) |diagnostic| {
        if (std.mem.eql(u8, diagnostic, "checkpoint-body-exceeds-control-frame"))
            listed_size_diagnostic = true;
    }
    try testing.expect(listed_size_diagnostic);

    const terminate_request: TerminateRequest = .{
        .schemaVersion = 1,
        .session = session,
        .mode = .immediate,
        .target = .@"process-tree",
        .deadline = "2099-01-01T00:00:00.000Z",
        .idempotencyKey = "terminate-proof-1",
    };
    const terminate_bytes = try std.json.Stringify.valueAlloc(allocator, terminate_request, .{});
    defer allocator.free(terminate_bytes);
    const terminated_bytes = try controller.terminate(terminate_bytes);
    defer allocator.free(terminated_bytes);
    var terminated = try std.json.parseFromSlice(
        WireTerminationPayload,
        allocator,
        terminated_bytes,
        .{},
    );
    defer terminated.deinit();
    try testing.expectEqual(@as(@FieldType(WireTerminationResult, "state"), .terminated), terminated.value.state);
    try testing.expectEqual(@as(@FieldType(WireReapEvidence, "authority"), .@"direct-parent"), terminated.value.reap.authority);
    try testing.expect(terminated.value.reap.reaped);
    try testing.expect(terminated.value.reap.status != null);
    try testing.expectEqual(@as(?i32, c.SIGKILL), terminated.value.reap.status.?.signal);
    try testing.expectEqual(Completeness.complete, terminated.value.completeness);
    try testing.expectEqual(@as(usize, 0), terminated.value.survivors.len);

    const replayed = try controller.terminate(terminate_bytes);
    defer allocator.free(replayed);
    try testing.expectEqualStrings(terminated_bytes, replayed);
    var conflict_request = terminate_request;
    conflict_request.target = .@"session-members";
    const conflict_bytes = try std.json.Stringify.valueAlloc(allocator, conflict_request, .{});
    defer allocator.free(conflict_bytes);
    try testing.expectError(error.TerminationConflict, controller.terminate(conflict_bytes));

    var host_status: c_int = 0;
    try testing.expectEqual(host_pid, c.waitpid(host_pid, &host_status, 0));
    host_owned = false;
    const host_status_bits: u32 = @bitCast(host_status);
    try testing.expect(std.posix.W.IFEXITED(host_status_bits));
    try testing.expectEqual(@as(u8, 0), std.posix.W.EXITSTATUS(host_status_bits));
    try registry.recover();
    const final = registry.get(session) orelse return error.FinalRecordMissing;
    try testing.expectEqual(neutral_host.Lifecycle.reaped, final.lifecycle);
    try testing.expect(final.reap != null and final.reap.?.reaped);
    try testing.expectEqual(
        @as(@FieldType(neutral_host.ReapEvidence, "authority"), .@"direct-parent"),
        final.reap.?.authority,
    );
    try testing.expect(final.terminationResultJson != null);
    try testing.expectEqualStrings(terminated_bytes, final.terminationResultJson.?);
    try testing.expect(switch (process_inspector.observeProcess(proof_child)) {
        .absent => true,
        .present, .unobservable => false,
    });
}
