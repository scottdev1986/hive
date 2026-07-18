//! Frozen A0 LIST/INSPECT/TERMINATE projection for the neutral host seam.
//!
//! Hive locator and visibility policy never crosses this module. Controller
//! operations address only an exact neutral SessionRef and preserve measured
//! partial/unavailable evidence when a live host cannot be reached.

const std = @import("std");
const generated = @import("session_protocol_generated");
const neutral_host = @import("neutral_host");
const process_inspector = @import("process_inspector");

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
        try appendDiagnostic(diagnostics, allocator, "checkpoint-body-omitted-from-list-projection");
        return null;
    }
    const snapshot = if (live) |value| value.newestCheckpoint orelse {
        try appendDiagnostic(diagnostics, allocator, "checkpoint-body-unavailable");
        return null;
    } else {
        try appendDiagnostic(diagnostics, allocator, "checkpoint-body-unavailable");
        return null;
    };
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
    controller_fallback: bool,
    leading_diagnostic: ?[]const u8,
) !WireInspection {
    var diagnostics: std.ArrayList([]const u8) = .{};
    if (leading_diagnostic) |value| try appendDiagnostic(&diagnostics, allocator, value);
    if (live) |value| {
        for (value.diagnostics) |diagnostic| try appendDiagnostic(&diagnostics, allocator, diagnostic);
    }

    var descendants: std.ArrayList(WireProcessIdentity) = .{};
    var lifecycle: @FieldType(WireInspection, "lifecycle") = switch (record.lifecycle) {
        .reserved => .creating,
        .live => .running,
        .exited, .reaped => .exited,
        .unknown => .unknown,
    };
    if (record.child) |child| {
        const token = parseStartToken(child.startToken) catch null;
        if (token) |expected| {
            var snapshot = process_inspector.snapshotTree(
                platform,
                allocator,
                child.processId,
                expected,
            ) catch null;
            if (snapshot) |*observed| {
                defer observed.deinit(allocator);
                if (observed.status != .stable) {
                    try appendDiagnostic(&diagnostics, allocator, "process-tree-snapshot-unstable");
                }
                if (observed.root_missing and record.lifecycle == .live) lifecycle = .lost;
                for (observed.members) |member| {
                    if (member.pid == child.processId and member.start_token.eql(expected)) continue;
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
        record.initialWindowAppliedBeforeExec != null)
    {
        const fresh_foreground = if (live) |value| value.foregroundProcessGroupId else null;
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
    const reap = if (record.reap) |value|
        wireReap(value)
    else if (!controller_fallback and record.lifecycle == .live)
        WireReapEvidence{
            .authority = .@"direct-parent",
            .reaped = false,
            .status = null,
            .completeness = .complete,
        }
    else
        WireReapEvidence{
            .authority = .unavailable,
            .reaped = false,
            .status = null,
            .completeness = .unknown,
        };

    const diagnostic_slice = try diagnostics.toOwnedSlice(allocator);
    const completeness: Completeness = if (record.lifecycle == .unknown)
        .unknown
    else if (diagnostic_slice.len == 0)
        .complete
    else
        .partial;
    return .{
        .session = record.session,
        .lifecycle = lifecycle,
        .completeness = completeness,
        .host = if (record.host) |value| wireProcess(value) else null,
        .child = if (record.child) |value| wireProcess(value) else null,
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
        .survivors = &.{},
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
    ) HostOperations {
        return .{
            .allocator = allocator,
            .registry = registry,
            .session = session,
            .platform = platform,
            .evidence = evidence,
            .clock = clock,
            .scratch = std.heap.ArenaAllocator.init(allocator),
        };
    }

    pub fn deinit(self: *HostOperations) void {
        self.scratch.deinit();
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
            else => .{ .accepted = false, .payload = "operation-not-implemented" },
        };
    }

    fn inspect(self: *HostOperations, payload: []const u8) !neutral_host.OperationResponse {
        _ = self.scratch.reset(.retain_capacity);
        const allocator = self.scratch.allocator();
        var parsed = try std.json.parseFromSlice(HostInspectRequest, allocator, payload, .{});
        defer parsed.deinit();
        if (parsed.value.schemaVersion != 1) return error.InvalidInspectRequest;
        const record = self.registry.get(self.session) orelse return error.SessionNotFound;
        const live = self.evidence.measure(allocator) catch null;
        var time_storage: [24]u8 = undefined;
        const evidence_at = try allocator.dupe(u8, try self.clock.now(&time_storage));
        var inspection = try buildInspection(
            allocator,
            record,
            self.platform,
            live,
            evidence_at,
            parsed.value.includeCheckpoint,
            false,
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
            var retry_storage: [24]u8 = undefined;
            const retry_time = try retry_allocator.dupe(u8, try self.clock.now(&retry_storage));
            inspection = try buildInspection(
                retry_allocator,
                retry_record,
                self.platform,
                retry_live,
                retry_time,
                false,
                false,
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
            true,
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

    pub fn list(self: *Controller, payload: []const u8) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        var request = try std.json.parseFromSlice(ListRequest, allocator, payload, .{});
        defer request.deinit();
        if (request.value.schemaVersion != 1) return error.InvalidListRequest;
        var entries = std.json.Array.init(allocator);
        for (self.registry.list()) |record| {
            const encoded = self.callInspect(allocator, record, false) catch null;
            const entry = if (encoded) |value| blk: {
                if (value.len > generated.limits.control_json_bytes / 32) {
                    break :blk try self.fallbackInspectionValue(
                        allocator,
                        record,
                        "list-entry-exceeds-projection-budget",
                    );
                }
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
        if (response.len > generated.limits.control_json_bytes) {
            self.allocator.free(response);
            return error.ListResponseTooLarge;
        }
        return response;
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
