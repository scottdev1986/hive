//! Real broker → real host → real `/bin/sh` provider golden.
//!
//! This harness overrides `HIVE_HOME` to a private temp root before spawning
//! the host role (see `setenv` in `runGolden`), so an ambient agent home is
//! never in play. Expected stderr noise on a PASSING run: the host logs
//! `host connection refused: AttachLocatorMismatch` once — that is the §06
//! wrong-generation attach fence being exercised, not a failure. (An earlier
//! theory blamed inherited HIVE_HOME for golden reds; that was refuted.)
const std = @import("std");
const broker = @import("broker");
const generated = @import("session_protocol_generated");
const process_inspector = @import("process_inspector");
const protocol = @import("protocol");
const session_host = @import("session_host");

const c = @cImport({
    @cInclude("fcntl.h");
    @cInclude("stdlib.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
});

const session_id = "ses_018f1e90-7b5a-7cc0-8000-0000000000f4";
const instance_id = "real-host-golden";
const EmptyEnvironment = struct {};
const WireLocatorPayload = struct {
    schemaVersion: u8,
    instanceId: []const u8,
    subject: struct { kind: []const u8, agentId: []const u8 },
    generation: u64,
    sessionId: []const u8,
    hostKind: []const u8,
    engineBuildId: []const u8,
};

pub fn main() !void {
    var debug_allocator: std.heap.DebugAllocator(.{}) = .init;
    defer _ = debug_allocator.deinit();
    const allocator = debug_allocator.allocator();

    var args = std.process.args();
    _ = args.next();
    if (args.next()) |role| {
        if (!std.mem.eql(u8, role, "host") or args.next() != null)
            return error.UnexpectedArgument;
        const hive_home = try std.process.getEnvVarOwned(allocator, "HIVE_HOME");
        defer allocator.free(hive_home);
        return session_host.runHostRole(allocator, hive_home);
    }
    try runGolden(allocator);
    try runDeadParentRecoveryDrill(allocator);
}

fn runGolden(allocator: std.mem.Allocator) !void {
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(
        &root_storage,
        "/tmp/g{x}",
        .{std.crypto.random.int(u32)},
    );
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var home = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try home.chmod(0o700);
    home.close();

    const root_z = try allocator.dupeZ(u8, root);
    defer allocator.free(root_z);
    if (c.setenv("HIVE_HOME", root_z.ptr, 1) != 0) return error.SetEnvironmentFailed;

    const engine_digest = try session_host.RealVtEngine.engineBuildId();
    const engine_build_id = std.fmt.bytesToHex(engine_digest, .lower);
    const input_proof_path = try std.fs.path.join(allocator, &.{ root, "input-proof.txt" });
    defer allocator.free(input_proof_path);
    const provider_script = try std.fmt.allocPrint(
        allocator,
        "printf 'GOLDEN-BANNER\\n'; while IFS= read -r line; do printf '%s\\n' \"$line\" >> {s}; printf 'OUT:%s\\n' \"$line\"; done",
        .{input_proof_path},
    );
    defer allocator.free(provider_script);
    const locator: broker.Locator = .{
        .instance_id = instance_id,
        .session_id = session_id,
        .generation = 1,
        .subject = .{ .agent = "aaron" },
        .host_kind = .sessiond,
        .engine_build_id = &engine_build_id,
    };
    const workspace = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.WorkspaceIdentityUnavailable;
    var workspace_token_storage: [64]u8 = undefined;
    const workspace_token = try workspace.start_token.format(&workspace_token_storage);
    const spec = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .locator = .{
            .schemaVersion = @as(u8, 1),
            .instanceId = instance_id,
            .subject = .{ .kind = "agent", .agentId = "aaron" },
            .generation = @as(u64, 1),
            .sessionId = session_id,
            .hostKind = "sessiond",
            .engineBuildId = &engine_build_id,
        },
        .provider = "codex",
        .toolSessionId = @as(?[]const u8, null),
        .cwd = root,
        .argv = [_][]const u8{ "/bin/sh", "-c", provider_script },
        .environment = EmptyEnvironment{},
        .expectedExecutable = "/bin/sh",
        .readOnly = false,
        .capabilityEpoch = @as(u64, 0),
        .geometry = .{
            .columns = @as(u16, 80),
            .rows = @as(u16, 24),
            .widthPx = @as(u32, 800),
            .heightPx = @as(u32, 480),
            .cellWidthPx = @as(f64, 10),
            .cellHeightPx = @as(f64, 20),
        },
        .launchGrantId = "golden-launch-grant",
        .launchGrantRevision = @as(u64, 1),
        .visibility = .{
            .workspaceSessionId = "golden-workspace",
            .workspacePid = c.getpid(),
            .workspaceStartToken = workspace_token,
            .openTerminalRevision = "1",
        },
    }, .{});
    defer allocator.free(spec);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.create_begin_payload,
        spec,
    )) return error.InvalidGoldenSpec;

    const created_pipe = try std.posix.pipe();
    var pipe_owned = true;
    errdefer if (pipe_owned) {
        std.posix.close(created_pipe[0]);
        std.posix.close(created_pipe[1]);
    };
    try setCloseOnExec(created_pipe[0]);
    try setCloseOnExec(created_pipe[1]);
    const create_broker_pid = try std.posix.fork();
    if (create_broker_pid == 0) {
        std.posix.close(created_pipe[0]);
        const created_writer: std.fs.File = .{ .handle = created_pipe[1] };
        runCreateBroker(allocator, root, spec, locator, created_writer) catch |err| {
            std.debug.print("create broker failed: {s}\n", .{@errorName(err)});
            created_writer.close();
            std.posix.exit(125);
        };
        created_writer.close();
        std.posix.exit(0);
    }
    std.posix.close(created_pipe[1]);
    pipe_owned = false;
    const created_reader: std.fs.File = .{ .handle = created_pipe[0] };
    defer created_reader.close();
    var create_status: c_int = 0;
    if (c.waitpid(create_broker_pid, &create_status, 0) != create_broker_pid)
        return error.CreateBrokerWaitFailed;
    const create_status_bits: u32 = @bitCast(create_status);
    if (!std.posix.W.IFEXITED(create_status_bits) or
        std.posix.W.EXITSTATUS(create_status_bits) != 0)
        return error.CreateBrokerFailed;
    const created = try created_reader.readToEndAlloc(
        allocator,
        generated.limits.control_json_bytes,
    );
    defer allocator.free(created);
    if (created.len == 0) return error.MissingCreatedResponse;

    const CreatedProjection = struct {
        created: bool,
        inspection: struct {
            presence: []const u8,
            complete: bool,
            hostPid: i32,
            providerRoot: struct { pid: i32 },
        },
    };
    var parsed_created = try std.json.parseFromSlice(CreatedProjection, allocator, created, .{
        .ignore_unknown_fields = true,
    });
    defer parsed_created.deinit();
    if (!parsed_created.value.created or
        !std.mem.eql(u8, parsed_created.value.inspection.presence, "present") or
        parsed_created.value.inspection.hostPid == c.getpid() or
        parsed_created.value.inspection.hostPid == create_broker_pid or
        parsed_created.value.inspection.providerRoot.pid == c.getpid() or
        parsed_created.value.inspection.providerRoot.pid == create_broker_pid or
        parsed_created.value.inspection.providerRoot.pid == parsed_created.value.inspection.hostPid)
        return error.ProductionHostCanaryFailed;

    var runtime = try broker.Runtime.open(allocator, root);
    defer runtime.deinit();
    const self_executable = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(self_executable);
    const build_id = try executableBuildHash(allocator, self_executable);
    defer allocator.free(build_id);
    var recovered = broker.RecoveredRegistry.init(allocator);
    defer recovered.deinit();
    var connector = broker.WireRecoveryConnector.init(allocator, runtime.canonical_home, build_id);
    defer connector.deinit();
    try recovered.recover(&runtime, 3, connector.connector());

    const lookup = recovered.registry.lookup(locator) orelse
        return error.AdoptedHostMissing;
    switch (lookup) {
        .entry => {},
        .failure => return error.HostAdoptionFailed,
    }
    var lifecycle_launcher = try session_host.ProductionHostLauncher.init(allocator, root);
    defer lifecycle_launcher.deinit();
    var control_plane: broker.ProductionControlPlane = undefined;
    try control_plane.init(allocator, root);
    defer control_plane.deinit();
    var lifecycle_backend = broker.ProductionBackend.init(
        allocator,
        &runtime,
        &recovered.registry,
        &control_plane,
        lifecycle_launcher.launcher(),
    );
    defer lifecycle_backend.deinit();
    const backend = lifecycle_backend.backend();
    const wire_locator: WireLocatorPayload = .{
        .schemaVersion = @as(u8, 1),
        .instanceId = instance_id,
        .subject = .{ .kind = "agent", .agentId = "aaron" },
        .generation = @as(u64, 1),
        .sessionId = session_id,
        .hostKind = "sessiond",
        .engineBuildId = &engine_build_id,
    };
    // §19/§20 broker attach issuance: ATTACH_REQUEST through the production
    // dispatch path returns a schema-valid one-use ATTACH_GRANT whose endpoint
    // names this host's socket. The token drives the replay re-attach leg.
    const attach_request_payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .locator = wire_locator,
        .viewerId = "golden-viewer-b",
        .geometry = .{
            .columns = @as(u16, 80),
            .rows = @as(u16, 24),
            .widthPx = @as(u32, 800),
            .heightPx = @as(u32, 480),
            .cellWidthPx = @as(f64, 10),
            .cellHeightPx = @as(f64, 20),
        },
        .operations = [_][]const u8{"view"},
    }, .{});
    defer allocator.free(attach_request_payload);
    const grant_dispatch = broker.dispatchFrame(
        allocator,
        .{
            .header = requestHeader(generated.frame_type.attach_request, attach_request_payload.len),
            .payload = attach_request_payload,
        },
        4,
        backend,
    );
    const grant_response = switch (grant_dispatch) {
        .response => |value| value,
        else => return error.AttachGrantIssueFailed,
    };
    defer grant_response.deinit(allocator);
    if (grant_response.header.type_code != generated.frame_type.attach_grant)
        return error.AttachGrantIssueFailed;
    const GrantProjection = struct {
        token: []const u8,
        endpoint: []const u8,
        outputSeq: []const u8,
    };
    var parsed_grant = try std.json.parseFromSlice(
        GrantProjection,
        allocator,
        grant_response.payload,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed_grant.deinit();
    const expected_endpoint_suffix = try std.fs.path.join(
        allocator,
        &.{ "runtime/sessiond/hosts", session_id, "host.sock" },
    );
    defer allocator.free(expected_endpoint_suffix);
    if (!std.mem.endsWith(u8, parsed_grant.value.endpoint, expected_endpoint_suffix))
        return error.AttachGrantWrongEndpoint;

    try driveViewerWire(
        allocator,
        root,
        &recovered.registry,
        backend,
        locator,
        wire_locator,
        input_proof_path,
        parsed_created.value.inspection.providerRoot.pid,
        parsed_grant.value.token,
    );

    // Frozen A0 LIST is unscoped (no Hive instanceId). Expect the real session
    // key under the SessionRef projection.
    const list_payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
    }, .{});
    defer allocator.free(list_payload);
    const listed = switch (backend.call(
        allocator,
        requestHeader(generated.frame_type.list, list_payload.len),
        list_payload,
        4,
    )) {
        .response => |payload| payload,
        .no_response, .failure => return error.RealListFailed,
    };
    defer allocator.free(listed);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.listed_payload,
        listed,
    ) or std.mem.indexOf(u8, listed, session_id) == null) return error.InvalidRealList;
    const ListedProjection = struct {
        entries: []const struct {
            session: struct { key: []const u8, incarnation: []const u8 },
        },
    };
    var parsed_listed = try std.json.parseFromSlice(
        ListedProjection,
        allocator,
        listed,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed_listed.deinit();
    const control_session = blk: {
        for (parsed_listed.value.entries) |entry| {
            if (std.mem.eql(u8, entry.session.key, session_id)) break :blk entry.session;
        }
        return error.RealSessionRefMissing;
    };

    const inspect_payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = control_session,
    }, .{});
    defer allocator.free(inspect_payload);
    const inspected = switch (backend.call(
        allocator,
        requestHeader(generated.frame_type.inspect, inspect_payload.len),
        inspect_payload,
        5,
    )) {
        .response => |payload| payload,
        .no_response, .failure => return error.RealInspectFailed,
    };
    defer allocator.free(inspected);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.inspected_payload,
        inspected,
    )) return error.InvalidRealInspection;
    const InspectedProjection = struct {
        lifecycle: []const u8,
        completeness: []const u8,
        child: ?struct { processId: i32 },
        jobControl: ?struct {
            foregroundProcessGroupId: i32,
            completeness: []const u8,
        },
        inputOwner: ?struct {
            token: []const u8,
            writer: []const u8,
            kind: []const u8,
            leaseExpiresAt: []const u8,
        },
        diagnostics: []const []const u8,
    };
    var parsed_inspected = try std.json.parseFromSlice(
        InspectedProjection,
        allocator,
        inspected,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed_inspected.deinit();
    if (std.mem.indexOf(u8, inspected, "neutral-host-control-unavailable") != null)
        return error.NeutralHostControlUnavailable;
    if (std.mem.indexOf(u8, inspected, "live-evidence-provider-unavailable") != null)
        return error.LiveEvidenceProviderUnavailable;
    if (!std.mem.eql(u8, parsed_inspected.value.lifecycle, "running") or
        !std.mem.eql(u8, parsed_inspected.value.completeness, "complete") or
        parsed_inspected.value.jobControl == null or
        parsed_inspected.value.jobControl.?.foregroundProcessGroupId <= 0 or
        !std.mem.eql(u8, parsed_inspected.value.jobControl.?.completeness, "complete") or
        parsed_inspected.value.inputOwner == null or
        !std.mem.eql(u8, parsed_inspected.value.inputOwner.?.writer, "golden-viewer") or
        !std.mem.eql(u8, parsed_inspected.value.inputOwner.?.kind, "human") or
        parsed_inspected.value.inputOwner.?.token.len == 0 or
        parsed_inspected.value.inputOwner.?.leaseExpiresAt.len == 0 or
        parsed_inspected.value.child == null or
        parsed_inspected.value.child.?.processId != parsed_created.value.inspection.providerRoot.pid)
    {
        // stderr only — stdout may be a captured build-step pipe. The raw
        // payload names the failing condition; without it a red here is one
        // opaque error for ~14 independent assertions (issue #54 history).
        std.debug.print(
            "real-host-golden: inspect content assertion failed; payload: {s}\n",
            .{inspected},
        );
        return error.InvalidRealInspection;
    }

    const terminate_payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = control_session,
        .mode = "immediate",
        .target = "process-tree",
        .deadline = "2099-01-01T00:00:00.000Z",
        .idempotencyKey = "req_018f1e90-7b5a-7cc0-8000-0000000000f4",
    }, .{});
    defer allocator.free(terminate_payload);
    const terminated = switch (backend.call(
        allocator,
        requestHeader(generated.frame_type.terminate, terminate_payload.len),
        terminate_payload,
        6,
    )) {
        .response => |payload| payload,
        .no_response, .failure => return error.HostTerminationFailed,
    };
    defer allocator.free(terminated);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.terminated_payload,
        terminated,
    )) return error.HostTerminationFailed;
    const TerminatedProjection = struct {
        state: []const u8,
        reap: struct { authority: []const u8, reaped: bool, completeness: []const u8 },
        survivors: []const std.json.Value,
        completeness: []const u8,
        diagnostics: []const []const u8,
    };
    var parsed_terminated = try std.json.parseFromSlice(
        TerminatedProjection,
        allocator,
        terminated,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed_terminated.deinit();
    if (!std.mem.eql(u8, parsed_terminated.value.state, "terminated") or
        !std.mem.eql(u8, parsed_terminated.value.reap.authority, "direct-parent") or
        !parsed_terminated.value.reap.reaped or
        !std.mem.eql(u8, parsed_terminated.value.reap.completeness, "complete") or
        parsed_terminated.value.survivors.len != 0 or
        !std.mem.eql(u8, parsed_terminated.value.completeness, "complete") or
        parsed_terminated.value.diagnostics.len != 0 or
        std.mem.indexOf(u8, terminated, "neutral-host-control-unavailable") != null)
        return error.HostTerminationFailed;
    try waitForProcessAbsence(parsed_created.value.inspection.providerRoot.pid);
    try waitForProcessAbsence(parsed_created.value.inspection.hostPid);

    const final_path = try std.fs.path.join(allocator, &.{
        root,
        "runtime/sessiond/hosts",
        session_id,
        "final.json",
    });
    defer allocator.free(final_path);
    const final_stat = try std.posix.fstatat(
        std.posix.AT.FDCWD,
        final_path,
        std.posix.AT.SYMLINK_NOFOLLOW,
    );
    if (final_stat.uid != std.posix.getuid() or
        final_stat.mode & std.posix.S.IFMT != std.posix.S.IFREG or
        final_stat.mode & 0o777 != 0o600)
        return error.InvalidFinalEvidenceMode;
    const final_file = try std.fs.openFileAbsolute(final_path, .{ .mode = .read_only });
    defer final_file.close();
    const final_json = try final_file.readToEndAlloc(
        allocator,
        generated.limits.control_json_bytes,
    );
    defer allocator.free(final_json);
    const FinalProjection = struct {
        state: []const u8,
        waitObserved: bool,
        survivors: []const std.json.Value,
        errors: []const std.json.Value,
    };
    var parsed_final = try std.json.parseFromSlice(FinalProjection, allocator, final_json, .{
        .ignore_unknown_fields = true,
    });
    defer parsed_final.deinit();
    // The PTY owner records the direct-child wait status even when tree
    // termination triggers the wait.
    if (!std.mem.eql(u8, parsed_final.value.state, "terminated") or
        !parsed_final.value.waitObserved or
        parsed_final.value.survivors.len != 0 or
        parsed_final.value.errors.len != 0)
        return error.InvalidFinalEvidence;
}

const dead_parent_session_id = "ses_018f1e90-7b5a-7cc0-8000-0000000000f6";

/// Freeze case G's second half. The first half — a broker restart reattaching
/// to a durable parent — is the golden above: the create broker exits and is
/// reaped before a fresh `RecoveredRegistry` adopts the surviving host and goes
/// on to inspect, attach and terminate it with direct-parent reap evidence.
///
/// This drill kills the durable parent for real and requires recovery to say so.
/// It recovers TWICE against the same record: once while the host is alive, which
/// must produce an entry, and once after the kill, which must produce
/// `verification_unknown`. Without the live leg a wrong home, a too-long socket
/// path or any other setup fault would report the same unknown and read as a
/// pass; the two legs differ only by the kill.
///
/// It owns its own home: `broker.Runtime.open` is exclusive, so the create
/// broker cannot fork out of a process that already holds the golden's runtime.
fn runDeadParentRecoveryDrill(allocator: std.mem.Allocator) !void {
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(
        &root_storage,
        "/tmp/d{x}",
        .{std.crypto.random.int(u32)},
    );
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var home = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try home.chmod(0o700);
    home.close();
    const root_z = try allocator.dupeZ(u8, root);
    defer allocator.free(root_z);
    if (c.setenv("HIVE_HOME", root_z.ptr, 1) != 0) return error.SetEnvironmentFailed;

    const engine_digest = try session_host.RealVtEngine.engineBuildId();
    const engine_build_id = std.fmt.bytesToHex(engine_digest, .lower);
    const workspace = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.WorkspaceIdentityUnavailable;
    var workspace_token_storage: [64]u8 = undefined;
    const workspace_token = try workspace.start_token.format(&workspace_token_storage);

    const locator: broker.Locator = .{
        .instance_id = instance_id,
        .session_id = dead_parent_session_id,
        .generation = 1,
        .subject = .{ .agent = "aaron" },
        .host_kind = .sessiond,
        .engine_build_id = &engine_build_id,
    };
    const spec = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .locator = .{
            .schemaVersion = @as(u8, 1),
            .instanceId = instance_id,
            .subject = .{ .kind = "agent", .agentId = "aaron" },
            .generation = @as(u64, 1),
            .sessionId = dead_parent_session_id,
            .hostKind = "sessiond",
            .engineBuildId = &engine_build_id,
        },
        .provider = "codex",
        .toolSessionId = @as(?[]const u8, null),
        .cwd = root,
        .argv = [_][]const u8{ "/bin/sh", "-c", "while :; do sleep 1; done" },
        .environment = EmptyEnvironment{},
        .expectedExecutable = "/bin/sh",
        .readOnly = false,
        .capabilityEpoch = @as(u64, 0),
        .geometry = .{
            .columns = @as(u16, 80),
            .rows = @as(u16, 24),
            .widthPx = @as(u32, 800),
            .heightPx = @as(u32, 480),
            .cellWidthPx = @as(f64, 10),
            .cellHeightPx = @as(f64, 20),
        },
        .launchGrantId = "dead-parent-launch-grant",
        .launchGrantRevision = @as(u64, 1),
        .visibility = .{
            .workspaceSessionId = "golden-workspace",
            .workspacePid = c.getpid(),
            .workspaceStartToken = workspace_token,
            .openTerminalRevision = "1",
        },
    }, .{});
    defer allocator.free(spec);

    const created_pipe = try std.posix.pipe();
    var pipe_owned = true;
    errdefer if (pipe_owned) {
        std.posix.close(created_pipe[0]);
        std.posix.close(created_pipe[1]);
    };
    try setCloseOnExec(created_pipe[0]);
    try setCloseOnExec(created_pipe[1]);
    const create_broker_pid = try std.posix.fork();
    if (create_broker_pid == 0) {
        std.posix.close(created_pipe[0]);
        const created_writer: std.fs.File = .{ .handle = created_pipe[1] };
        runCreateBroker(allocator, root, spec, locator, created_writer) catch |err| {
            std.debug.print("dead-parent create broker failed: {s}\n", .{@errorName(err)});
            created_writer.close();
            std.posix.exit(125);
        };
        created_writer.close();
        std.posix.exit(0);
    }
    std.posix.close(created_pipe[1]);
    pipe_owned = false;
    const created_reader: std.fs.File = .{ .handle = created_pipe[0] };
    defer created_reader.close();
    var create_status: c_int = 0;
    if (c.waitpid(create_broker_pid, &create_status, 0) != create_broker_pid)
        return error.CreateBrokerWaitFailed;
    const create_status_bits: u32 = @bitCast(create_status);
    if (!std.posix.W.IFEXITED(create_status_bits) or
        std.posix.W.EXITSTATUS(create_status_bits) != 0)
        return error.CreateBrokerFailed;
    const created = try created_reader.readToEndAlloc(
        allocator,
        generated.limits.control_json_bytes,
    );
    defer allocator.free(created);
    const CreatedProjection = struct {
        created: bool,
        inspection: struct { hostPid: i32, providerRoot: struct { pid: i32 } },
    };
    var parsed = try std.json.parseFromSlice(CreatedProjection, allocator, created, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    if (!parsed.value.created) return error.DeadParentCreateFailed;
    const host_pid = parsed.value.inspection.hostPid;
    const provider_pid = parsed.value.inspection.providerRoot.pid;
    // A failure anywhere below would otherwise strand a host and a provider that
    // nothing else can wait. `host_killed` keeps this from signalling a pid the
    // drill already reaped and the system may have handed to someone else.
    var host_killed = false;
    errdefer {
        if (!host_killed) std.posix.kill(host_pid, std.posix.SIG.KILL) catch {};
        std.posix.kill(provider_pid, std.posix.SIG.KILL) catch {};
    }

    var runtime = try broker.Runtime.open(allocator, root);
    defer runtime.deinit();
    const self_executable = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(self_executable);
    const build_id = try executableBuildHash(allocator, self_executable);
    defer allocator.free(build_id);

    // Live leg: this exact recovery, against this exact record, adopts.
    {
        var recovered = broker.RecoveredRegistry.init(allocator);
        defer recovered.deinit();
        var connector = broker.WireRecoveryConnector.init(allocator, runtime.canonical_home, build_id);
        defer connector.deinit();
        try recovered.recover(&runtime, 3, connector.connector());
        switch (recovered.registry.lookup(locator) orelse return error.DeadParentControlMissing) {
            .entry => {},
            .failure => |failure| {
                std.debug.print(
                    "real-host-golden: live recovery control failed with {s}\n",
                    .{@tagName(failure.code)},
                );
                return error.DeadParentControlFailed;
            },
        }
    }

    // Kill the durable parent for real and prove it is gone before recovering.
    std.posix.kill(host_pid, std.posix.SIG.KILL) catch return error.DeadParentKillFailed;
    host_killed = true;
    try waitForProcessAbsence(host_pid);

    var recovered = broker.RecoveredRegistry.init(allocator);
    defer recovered.deinit();
    var connector = broker.WireRecoveryConnector.init(allocator, runtime.canonical_home, build_id);
    defer connector.deinit();
    try recovered.recover(&runtime, 4, connector.connector());
    switch (recovered.registry.lookup(locator) orelse return error.DeadParentRecoveryMissing) {
        .entry => return error.DeadParentRecoveryFabricated,
        .failure => |failure| if (failure.code != .verification_unknown) {
            std.debug.print(
                "real-host-golden: dead-parent recovery reported {s}, not verification_unknown\n",
                .{@tagName(failure.code)},
            );
            return error.DeadParentRecoveryFabricated;
        },
    }

    // `verification_unknown` alone is a weak claim — several unrelated setup
    // faults reach the same code. The specific obligation is that recovery
    // invented no ending: no terminal evidence file exists for this session and
    // the durable record still says live, so the unknown really is an unknown
    // and not a quietly recorded exit.
    var host_directory = try runtime.openHostDirectory(dead_parent_session_id, false);
    defer host_directory.close();
    if (host_directory.statFile("final.json")) |_| {
        return error.DeadParentRecoveryFabricated;
    } else |err| if (err != error.FileNotFound) return err;
    const record_after = try host_directory.readFileAlloc(
        allocator,
        "record.json",
        generated.limits.control_json_bytes,
    );
    defer allocator.free(record_after);
    const RecordState = struct { state: []const u8 };
    var parsed_record = try std.json.parseFromSlice(RecordState, allocator, record_after, .{
        .ignore_unknown_fields = true,
    });
    defer parsed_record.deinit();
    if (!std.mem.eql(u8, parsed_record.value.state, "live"))
        return error.DeadParentRecoveryFabricated;

    // The orphaned provider outlived its wait authority, which is precisely why
    // recovery may not claim an exit. Clean it up: the drill owns the process it
    // stranded, and nothing else can wait it.
    std.posix.kill(provider_pid, std.posix.SIG.KILL) catch {};
    waitForProcessAbsence(provider_pid) catch {};
}

fn writeViewerRequest(
    stream: std.net.Stream,
    type_code: u16,
    request_id: u64,
    flags: u16,
    payload: []const u8,
) !void {
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = type_code,
        .flags = flags,
        .payload_length = @intCast(payload.len),
        .request_id = request_id,
        .stream_seq = 0,
    }, payload);
}

fn waitForProcessAbsence(pid: i32) !void {
    var timer = try std.time.Timer.start();
    while (timer.read() < generated.limits.control_rpc_timeout_ms * std.time.ns_per_ms) {
        switch (process_inspector.observeProcess(pid)) {
            .absent => return,
            .present, .unobservable => std.Thread.sleep(5 * std.time.ns_per_ms),
        }
    }
    return error.ProcessStillPresent;
}

/// Viewer-side reader that accumulates unsolicited ordered OUTPUT frames while
/// waiting for correlated responses, asserting §20 contiguity: every OUTPUT
/// frame's stream_seq must equal the accumulated exclusive high-water.
const ViewerReader = struct {
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    next_seq: u64,
    output: std.ArrayList(u8) = .{},

    fn deinit(self: *ViewerReader) void {
        self.output.deinit(self.allocator);
    }

    fn readWireFrame(self: *ViewerReader) !protocol.Frame {
        const file: std.fs.File = .{ .handle = self.stream.handle };
        return switch (try protocol.readFrame(self.allocator, file.deprecatedReader())) {
            .frame => |frame| frame,
            else => error.InvalidViewerResponse,
        };
    }

    /// Consumes an OUTPUT frame into the accumulator; false when the frame is
    /// not OUTPUT and belongs to the caller.
    fn consumeOutput(self: *ViewerReader, frame: *const protocol.Frame) !bool {
        if (frame.header.type_code != generated.frame_type.output) return false;
        if (frame.header.flags != 0 or frame.header.request_id != 0)
            return error.InvalidOutputFrame;
        if (frame.header.stream_seq != self.next_seq) return error.OutputSequenceGap;
        if (frame.payload.len == 0) return error.EmptyOutputFrame;
        try self.output.appendSlice(self.allocator, frame.payload);
        self.next_seq += frame.payload.len;
        return true;
    }

    /// Next non-OUTPUT frame; interleaved ordered OUTPUT accumulates.
    fn readControlFrame(self: *ViewerReader) !protocol.Frame {
        while (true) {
            var frame = try self.readWireFrame();
            const consumed = self.consumeOutput(&frame) catch |err| {
                frame.deinit(self.allocator);
                return err;
            };
            if (!consumed) return frame;
            frame.deinit(self.allocator);
        }
    }

    /// Blocks until the accumulated ordered output contains `needle`.
    fn collectOutputUntilContains(self: *ViewerReader, needle: []const u8) !void {
        while (std.mem.indexOf(u8, self.output.items, needle) == null) {
            var frame = try self.readWireFrame();
            defer frame.deinit(self.allocator);
            if (!try self.consumeOutput(&frame)) return error.UnexpectedControlFrame;
        }
    }

    /// Blocks until the accumulated ordered output reaches `total` bytes.
    fn collectOutputUntilLength(self: *ViewerReader, total: usize) !void {
        while (self.output.items.len < total) {
            var frame = try self.readWireFrame();
            defer frame.deinit(self.allocator);
            if (!try self.consumeOutput(&frame)) return error.UnexpectedControlFrame;
        }
        if (self.output.items.len != total) return error.OutputOverrun;
    }
};

fn readViewerResponse(
    reader: *ViewerReader,
    type_code: u16,
    request_id: u64,
    schema: []const u8,
) !protocol.Frame {
    const allocator = reader.allocator;
    const frame = try reader.readControlFrame();
    errdefer frame.deinit(allocator);
    if (frame.header.type_code != type_code or
        frame.header.request_id != request_id or
        frame.header.flags != (generated.frame_flag.response | generated.frame_flag.final) or
        !protocol.validateControlPayload(allocator, schema, frame.payload))
    {
        // stderr only — names the mismatched frame; without this a refusal is
        // one opaque error for four independent checks.
        std.debug.print(
            "real-host-golden: expected frame type=0x{x} req={d}; got type=0x{x} req={d} flags=0x{x} payload: {s}\n",
            .{ type_code, request_id, frame.header.type_code, frame.header.request_id, frame.header.flags, frame.payload },
        );
        return error.InvalidViewerResponse;
    }
    return frame;
}

fn readViewerError(
    reader: *ViewerReader,
    request_id: u64,
    expected_code: []const u8,
) !void {
    const allocator = reader.allocator;
    var frame = try reader.readControlFrame();
    defer frame.deinit(allocator);
    if (frame.header.type_code != generated.frame_type.@"error" or
        frame.header.request_id != request_id or
        frame.header.flags != (generated.frame_flag.response |
            generated.frame_flag.final |
            generated.frame_flag.error_flag) or
        !protocol.validateControlPayload(
            allocator,
            generated.wire_schema.error_payload,
            frame.payload,
        )) return error.InvalidViewerError;
    const ErrorPayload = struct { code: []const u8 };
    var parsed = try std.json.parseFromSlice(ErrorPayload, allocator, frame.payload, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    if (!std.mem.eql(u8, parsed.value.code, expected_code))
        return error.InvalidViewerError;
}

/// Issues the visibility renewal the production daemon sends on the
/// Workspace's behalf every `limits.visibility_renewal_ms` (5 s), through the
/// same broker backend the golden already uses for LIST/INSPECT/TERMINATE.
/// The host's visibility lease is only `limits.visibility_expiry_ms` (15 s)
/// and a granted input claim is clamped to it, so a harness that never renews
/// embeds a wall-clock assumption: under a cold, fully parallel suite the
/// claim lapsed before the §26 replay-supersede, `onViewerDetached` DROPPED
/// it instead of orphaning it (expired arbiter lease), and the final INSPECT
/// reported `inputOwner: null` — the historical `InvalidRealInspection` red
/// (issue #54's trigger). Renewing at the harness's long-phase boundaries
/// keeps the assertions about the protocol, not suite scheduling latency.
fn renewVisibility(
    allocator: std.mem.Allocator,
    backend: broker.BrokerBackend,
    wire_locator: WireLocatorPayload,
    now_ns: u64,
) !void {
    const workspace = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.WorkspaceIdentityUnavailable;
    var token_storage: [64]u8 = undefined;
    const token = try workspace.start_token.format(&token_storage);
    const renew = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .locator = wire_locator,
        .workspaceSessionId = "golden-workspace",
        .workspacePid = c.getpid(),
        .workspaceStartToken = token,
        .openTerminalRevision = "1",
    }, .{});
    defer allocator.free(renew);
    const renewed = switch (backend.call(
        allocator,
        requestHeader(generated.frame_type.visibility_renew, renew.len),
        renew,
        now_ns,
    )) {
        .response => |payload| payload,
        .no_response, .failure => return error.VisibilityRenewalFailed,
    };
    defer allocator.free(renewed);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.renewed_payload,
        renewed,
    )) return error.VisibilityRenewalFailed;
}

fn waitForSingleInputEffect(
    allocator: std.mem.Allocator,
    path: []const u8,
) !void {
    var attempts: usize = 0;
    while (attempts < 100) : (attempts += 1) {
        const file = std.fs.openFileAbsolute(path, .{ .mode = .read_only }) catch |err| switch (err) {
            error.FileNotFound => {
                std.Thread.sleep(10 * std.time.ns_per_ms);
                continue;
            },
            else => return err,
        };
        defer file.close();
        const contents = try file.readToEndAlloc(allocator, 128);
        defer allocator.free(contents);
        if (std.mem.eql(u8, contents, "wire-input\n")) {
            std.Thread.sleep(50 * std.time.ns_per_ms);
            const verify = try std.fs.openFileAbsolute(path, .{ .mode = .read_only });
            defer verify.close();
            const final = try verify.readToEndAlloc(allocator, 128);
            defer allocator.free(final);
            if (!std.mem.eql(u8, final, "wire-input\n"))
                return error.InputAppliedMoreThanOnce;
            return;
        }
        if (contents.len > "wire-input\n".len)
            return error.InputAppliedMoreThanOnce;
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    return error.InputEffectMissing;
}

fn driveViewerWire(
    allocator: std.mem.Allocator,
    root: []const u8,
    registry: *broker.Registry,
    backend: broker.BrokerBackend,
    locator: broker.Locator,
    wire_locator: WireLocatorPayload,
    input_proof_path: []const u8,
    provider_pid: i32,
    replay_grant_token: []const u8,
) !void {
    const grant_token = "golden-viewer-token";
    var grant_hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(grant_token, &grant_hash, .{});
    const operations = [_][]const u8{ "view", "human-input", "resize" };
    if (registry.registerGrant(
        locator,
        grant_hash,
        "golden-viewer",
        &operations,
        .{
            .columns = 80,
            .rows = 24,
            .width_px = 800,
            .height_px = 480,
            .cell_width_px = 10,
            .cell_height_px = 20,
        },
        4,
    ) != null) return error.ViewerGrantRegistrationFailed;

    const socket_path = try std.fs.path.join(allocator, &.{
        root,
        "runtime/sessiond/hosts",
        session_id,
        "host.sock",
    });
    defer allocator.free(socket_path);
    const stream = try std.net.connectUnixSocket(socket_path);
    defer stream.close();
    var reader: ViewerReader = .{ .allocator = allocator, .stream = stream, .next_seq = 0 };
    defer reader.deinit();
    const hello = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .buildId = "golden-viewer-build",
        .instanceId = instance_id,
        .protocol = .{
            .major = generated.protocol_major,
            .minMinor = generated.protocol_min_minor,
            .maxMinor = generated.protocol_max_minor,
        },
        .clientRole = "viewer",
        .grantToken = grant_token,
    }, .{});
    defer allocator.free(hello);
    try writeViewerRequest(stream, generated.frame_type.hello, 10, 0, hello);
    var welcome = try readViewerResponse(
        &reader,
        generated.frame_type.welcome,
        10,
        generated.wire_schema.welcome_payload,
    );
    welcome.deinit(allocator);

    const attach = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .locator = wire_locator,
        .token = grant_token,
        .geometry = .{
            .columns = @as(u16, 80),
            .rows = @as(u16, 24),
            .widthPx = @as(u32, 800),
            .heightPx = @as(u32, 480),
            .cellWidthPx = @as(f64, 10),
            .cellHeightPx = @as(f64, 20),
        },
        .afterSeq = "0",
    }, .{});
    defer allocator.free(attach);
    try writeViewerRequest(stream, generated.frame_type.host_attach, 11, 0, attach);

    // §20 replay: the pre-attach provider banner must arrive as ordered OUTPUT
    // beginning exactly at afterSeq 0.
    try reader.collectOutputUntilContains("GOLDEN-BANNER");

    const wrong_generation_claim = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{ .key = session_id, .incarnation = "2" },
        .writer = "golden-viewer",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 10_000),
        .idempotencyKey = "domain-claim-wrong-generation",
    }, .{});
    defer allocator.free(wrong_generation_claim);
    try writeViewerRequest(
        stream,
        generated.frame_type.claim_acquire,
        19,
        0,
        wrong_generation_claim,
    );
    try readViewerError(&reader, 19, "GENERATION_MISMATCH");

    const claim = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{ .key = session_id, .incarnation = "1" },
        .writer = "golden-viewer",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 10_000),
        .idempotencyKey = "domain-claim-idempotency",
    }, .{});
    defer allocator.free(claim);
    try writeViewerRequest(stream, generated.frame_type.claim_acquire, 20, 0, claim);
    var claim_result = try readViewerResponse(
        &reader,
        generated.frame_type.claim_result,
        20,
        generated.wire_schema.claim_result_payload,
    );
    defer claim_result.deinit(allocator);
    const Granted = struct {
        result: struct {
            state: []const u8,
            claim: struct { token: []const u8, writer: []const u8, kind: []const u8 },
        },
    };
    var parsed_claim = try std.json.parseFromSlice(Granted, allocator, claim_result.payload, .{
        .ignore_unknown_fields = true,
    });
    defer parsed_claim.deinit();
    if (!std.mem.eql(u8, parsed_claim.value.result.state, "granted") or
        !std.mem.eql(u8, parsed_claim.value.result.claim.writer, "golden-viewer") or
        !std.mem.eql(u8, parsed_claim.value.result.claim.kind, "human"))
        return error.InvalidClaimGrant;
    const claim_token = parsed_claim.value.result.claim.token;

    // First long-phase boundary: the wire-drive below is many round trips.
    try renewVisibility(allocator, backend, wire_locator, 22);

    // Positive control for the reverse exact-generation fence: even on this
    // authenticated attached stream with a valid human claim token, a stale
    // session incarnation is a typed refusal and reaches the PTY zero times.
    const wrong_generation_input = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{ .key = session_id, .incarnation = "2" },
        .claimToken = claim_token,
        .transactionId = "domain-input-wrong-generation",
        .idempotencyKey = "domain-input-wrong-generation-idempotency",
        .operation = .{
            .kind = "bytes",
            .encoding = "base64",
            .bytes = "d3JvbmctZ2VuZXJhdGlvbi1pbnB1dAo=",
        },
    }, .{});
    defer allocator.free(wrong_generation_input);
    try writeViewerRequest(
        stream,
        generated.frame_type.input_submit,
        29,
        generated.frame_flag.content_sensitive,
        wrong_generation_input,
    );
    try readViewerError(&reader, 29, "GENERATION_MISMATCH");

    const denied_claim = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{ .key = session_id, .incarnation = "1" },
        .writer = "automation-contender",
        .kind = "automation",
        .leaseMilliseconds = @as(u64, 10_000),
        .idempotencyKey = "domain-claim-denied",
    }, .{});
    defer allocator.free(denied_claim);
    try writeViewerRequest(stream, generated.frame_type.claim_acquire, 21, 0, denied_claim);
    var denied_result = try readViewerResponse(
        &reader,
        generated.frame_type.claim_result,
        21,
        generated.wire_schema.claim_result_payload,
    );
    defer denied_result.deinit(allocator);
    const Denied = struct {
        result: struct { state: []const u8, owner: struct { token: []const u8 } },
    };
    var parsed_denied = try std.json.parseFromSlice(Denied, allocator, denied_result.payload, .{
        .ignore_unknown_fields = true,
    });
    defer parsed_denied.deinit();
    if (!std.mem.eql(u8, parsed_denied.value.result.state, "denied") or
        !std.mem.eql(u8, parsed_denied.value.result.owner.token, claim_token))
        return error.InvalidClaimDenial;

    const input = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{ .key = session_id, .incarnation = "1" },
        .claimToken = claim_token,
        .transactionId = "domain-input-transaction",
        .idempotencyKey = "domain-input-idempotency",
        .operation = .{ .kind = "bytes", .encoding = "base64", .bytes = "d2lyZS1pbnB1dAo=" },
    }, .{});
    defer allocator.free(input);
    try writeViewerRequest(
        stream,
        generated.frame_type.input_submit,
        30,
        generated.frame_flag.content_sensitive,
        input,
    );
    var applied = try readViewerResponse(
        &reader,
        generated.frame_type.applied,
        30,
        generated.wire_schema.applied_payload,
    );
    defer applied.deinit(allocator);
    const AppliedInput = struct {
        resultKind: []const u8,
        receipt: struct { transactionId: []const u8, stage: []const u8, orderedAt: []const u8 },
    };
    var parsed_applied = try std.json.parseFromSlice(AppliedInput, allocator, applied.payload, .{
        .ignore_unknown_fields = true,
    });
    defer parsed_applied.deinit();
    if (!std.mem.eql(u8, parsed_applied.value.resultKind, "input") or
        !std.mem.eql(u8, parsed_applied.value.receipt.transactionId, "domain-input-transaction") or
        !std.mem.eql(u8, parsed_applied.value.receipt.stage, "written-to-terminal"))
        return error.InvalidInputReceipt;

    // Transport correlation changes; domain idempotency stays fixed.
    try writeViewerRequest(
        stream,
        generated.frame_type.input_submit,
        31,
        generated.frame_flag.content_sensitive,
        input,
    );
    var replayed = try readViewerResponse(
        &reader,
        generated.frame_type.applied,
        31,
        generated.wire_schema.applied_payload,
    );
    defer replayed.deinit(allocator);
    if (!std.mem.eql(u8, replayed.payload, applied.payload))
        return error.InputReplayChangedReceipt;
    try waitForSingleInputEffect(allocator, input_proof_path);

    // §20 live push: the provider's stdout echo of the applied input arrives
    // as ordered OUTPUT on the attached viewer, and the idempotent replay
    // produced no duplicate echo.
    try reader.collectOutputUntilContains("OUT:wire-input");
    if (std.mem.count(u8, reader.output.items, "OUT:wire-input") != 1)
        return error.DuplicateLiveOutput;

    // §20 APPLIED output acknowledgement: the frozen output branch advances
    // the host's acknowledged high-water without disturbing the stream.
    var ack_storage: [32]u8 = undefined;
    const ack_through = try std.fmt.bufPrint(&ack_storage, "{d}", .{reader.next_seq});
    const output_ack = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .resultKind = "output",
        .throughSeq = ack_through,
    }, .{});
    defer allocator.free(output_ack);
    try writeViewerRequest(stream, generated.frame_type.applied, 32, 0, output_ack);

    const beta_input = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{ .key = session_id, .incarnation = "1" },
        .claimToken = claim_token,
        .transactionId = "domain-input-beta",
        .idempotencyKey = "domain-input-beta-idempotency",
        .operation = .{ .kind = "bytes", .encoding = "base64", .bytes = "YmV0YS1saW5lCg==" },
    }, .{});
    defer allocator.free(beta_input);
    try writeViewerRequest(
        stream,
        generated.frame_type.input_submit,
        33,
        generated.frame_flag.content_sensitive,
        beta_input,
    );
    var beta_applied = try readViewerResponse(
        &reader,
        generated.frame_type.applied,
        33,
        generated.wire_schema.applied_payload,
    );
    beta_applied.deinit(allocator);
    try reader.collectOutputUntilContains("OUT:beta-line");

    const resize = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{ .key = session_id, .incarnation = "1" },
        .window = .{
            .columns = @as(u16, 111),
            .rows = @as(u16, 37),
            .widthPixels = @as(u32, 1110),
            .heightPixels = @as(u32, 740),
        },
        .revision = "41",
        .idempotencyKey = "domain-resize-idempotency",
    }, .{});
    defer allocator.free(resize);
    try writeViewerRequest(stream, generated.frame_type.resize, 40, 0, resize);
    var resized = try readViewerResponse(
        &reader,
        generated.frame_type.applied,
        40,
        generated.wire_schema.applied_payload,
    );
    defer resized.deinit(allocator);
    const AppliedResize = struct {
        resultKind: []const u8,
        result: struct {
            state: []const u8,
            revision: []const u8,
            readback: struct { columns: u32, rows: u32, widthPixels: u32, heightPixels: u32 },
        },
    };
    var parsed_resize = try std.json.parseFromSlice(AppliedResize, allocator, resized.payload, .{
        .ignore_unknown_fields = true,
    });
    defer parsed_resize.deinit();
    if (!std.mem.eql(u8, parsed_resize.value.resultKind, "resize") or
        !std.mem.eql(u8, parsed_resize.value.result.state, "applied") or
        !std.mem.eql(u8, parsed_resize.value.result.revision, "41") or
        parsed_resize.value.result.readback.columns != 111 or
        parsed_resize.value.result.readback.rows != 37 or
        parsed_resize.value.result.readback.widthPixels != 1110 or
        parsed_resize.value.result.readback.heightPixels != 740)
        return error.InvalidResizeReceipt;

    const stale_resize = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{ .key = session_id, .incarnation = "1" },
        .window = .{
            .columns = @as(u16, 80),
            .rows = @as(u16, 24),
            .widthPixels = @as(u32, 800),
            .heightPixels = @as(u32, 480),
        },
        .revision = "40",
        .idempotencyKey = "domain-resize-stale",
    }, .{});
    defer allocator.free(stale_resize);
    try writeViewerRequest(stream, generated.frame_type.resize, 41, 0, stale_resize);
    var stale_result = try readViewerResponse(
        &reader,
        generated.frame_type.applied,
        41,
        generated.wire_schema.applied_payload,
    );
    defer stale_result.deinit(allocator);
    const StaleResize = struct {
        resultKind: []const u8,
        result: struct { state: []const u8, currentRevision: []const u8 },
    };
    var parsed_stale = try std.json.parseFromSlice(StaleResize, allocator, stale_result.payload, .{
        .ignore_unknown_fields = true,
    });
    defer parsed_stale.deinit();
    if (!std.mem.eql(u8, parsed_stale.value.resultKind, "resize") or
        !std.mem.eql(u8, parsed_stale.value.result.state, "stale") or
        !std.mem.eql(u8, parsed_stale.value.result.currentRevision, "41"))
        return error.InvalidStaleResizeReceipt;

    const eof = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{ .key = session_id, .incarnation = "1" },
        .claimToken = claim_token,
        .transactionId = "domain-eof-transaction",
        .idempotencyKey = "domain-eof-idempotency",
        .operation = .{ .kind = "canonical-end-of-file" },
    }, .{});
    defer allocator.free(eof);
    try writeViewerRequest(
        stream,
        generated.frame_type.input_submit,
        50,
        generated.frame_flag.content_sensitive,
        eof,
    );
    var eof_result = try readViewerResponse(
        &reader,
        generated.frame_type.applied,
        50,
        generated.wire_schema.applied_payload,
    );
    defer eof_result.deinit(allocator);
    const EofResult = struct { receipt: struct { stage: []const u8, diagnostic: []const u8 } };
    var parsed_eof = try std.json.parseFromSlice(EofResult, allocator, eof_result.payload, .{
        .ignore_unknown_fields = true,
    });
    defer parsed_eof.deinit();
    if (!std.mem.eql(u8, parsed_eof.value.receipt.stage, "rejected") or
        std.mem.indexOf(u8, parsed_eof.value.receipt.diagnostic, "canonical") == null)
        return error.InvalidCanonicalEofReceipt;
    switch (process_inspector.observeProcess(provider_pid)) {
        .present => {},
        .absent, .unobservable => return error.CanonicalEofWasHangup,
    }

    // §06/§20 locator fence: a wrong-generation HOST_ATTACH is a typed
    // GENERATION_MISMATCH refusal, receives zero OUTPUT bytes, and the
    // connection closes.
    {
        const wrong_stream = try std.net.connectUnixSocket(socket_path);
        defer wrong_stream.close();
        var wrong_reader: ViewerReader = .{
            .allocator = allocator,
            .stream = wrong_stream,
            .next_seq = 0,
        };
        defer wrong_reader.deinit();
        const wrong_hello = try std.json.Stringify.valueAlloc(allocator, .{
            .schemaVersion = @as(u8, 1),
            .buildId = "golden-viewer-build",
            .instanceId = instance_id,
            .protocol = .{
                .major = generated.protocol_major,
                .minMinor = generated.protocol_min_minor,
                .maxMinor = generated.protocol_max_minor,
            },
            .clientRole = "viewer",
            .grantToken = "wrong-generation-token",
        }, .{});
        defer allocator.free(wrong_hello);
        try writeViewerRequest(wrong_stream, generated.frame_type.hello, 70, 0, wrong_hello);
        var wrong_welcome = try readViewerResponse(
            &wrong_reader,
            generated.frame_type.welcome,
            70,
            generated.wire_schema.welcome_payload,
        );
        wrong_welcome.deinit(allocator);
        var wrong_locator = wire_locator;
        wrong_locator.generation = 2;
        const wrong_attach = try std.json.Stringify.valueAlloc(allocator, .{
            .schemaVersion = @as(u8, 1),
            .locator = wrong_locator,
            .token = "wrong-generation-token",
            .geometry = .{
                .columns = @as(u16, 80),
                .rows = @as(u16, 24),
                .widthPx = @as(u32, 800),
                .heightPx = @as(u32, 480),
                .cellWidthPx = @as(f64, 10),
                .cellHeightPx = @as(f64, 20),
            },
            .afterSeq = "0",
        }, .{});
        defer allocator.free(wrong_attach);
        std.debug.print(
            "expected negative-control (wrong-generation HOST_ATTACH): next host log is AttachLocatorMismatch\n",
            .{},
        );
        try writeViewerRequest(wrong_stream, generated.frame_type.host_attach, 71, 0, wrong_attach);
        try readViewerError(&wrong_reader, 71, "GENERATION_MISMATCH");
        if (wrong_reader.output.items.len != 0) return error.WrongGenerationReceivedOutput;
        try expectViewerClosed(&wrong_reader);
    }

    // The refused wrong-generation attach must not have disturbed the live
    // viewer: a further input still echoes as ordered OUTPUT here.
    const gamma_input = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{ .key = session_id, .incarnation = "1" },
        .claimToken = claim_token,
        .transactionId = "domain-input-gamma",
        .idempotencyKey = "domain-input-gamma-idempotency",
        .operation = .{ .kind = "bytes", .encoding = "base64", .bytes = "Z2FtbWEtbGluZQo=" },
    }, .{});
    defer allocator.free(gamma_input);
    try writeViewerRequest(
        stream,
        generated.frame_type.input_submit,
        72,
        generated.frame_flag.content_sensitive,
        gamma_input,
    );
    var gamma_applied = try readViewerResponse(
        &reader,
        generated.frame_type.applied,
        72,
        generated.wire_schema.applied_payload,
    );
    gamma_applied.deinit(allocator);
    try reader.collectOutputUntilContains("OUT:gamma-line");

    // Second long-phase boundary: the replay-supersede below detaches this
    // viewer, and the control-plane tail (LIST/INSPECT/TERMINATE) follows.
    // The renewal extends both the visibility lease and the active claim, so
    // the supersede orphans the claim (inputOwner stays reported) instead of
    // dropping an expired one.
    try renewVisibility(allocator, backend, wire_locator, 79);

    // §26 retarget + §20 replay determinism: a second grant re-attaches the
    // same exact generation from afterSeq 0, replays the identical retained
    // byte stream, and supersedes this connection (which then closes).
    {
        const replay_stream = try std.net.connectUnixSocket(socket_path);
        defer replay_stream.close();
        var replay_reader: ViewerReader = .{
            .allocator = allocator,
            .stream = replay_stream,
            .next_seq = 0,
        };
        defer replay_reader.deinit();
        const replay_hello = try std.json.Stringify.valueAlloc(allocator, .{
            .schemaVersion = @as(u8, 1),
            .buildId = "golden-viewer-build",
            .instanceId = instance_id,
            .protocol = .{
                .major = generated.protocol_major,
                .minMinor = generated.protocol_min_minor,
                .maxMinor = generated.protocol_max_minor,
            },
            .clientRole = "viewer",
            .grantToken = replay_grant_token,
        }, .{});
        defer allocator.free(replay_hello);
        try writeViewerRequest(replay_stream, generated.frame_type.hello, 80, 0, replay_hello);
        var replay_welcome = try readViewerResponse(
            &replay_reader,
            generated.frame_type.welcome,
            80,
            generated.wire_schema.welcome_payload,
        );
        replay_welcome.deinit(allocator);
        const replay_attach = try std.json.Stringify.valueAlloc(allocator, .{
            .schemaVersion = @as(u8, 1),
            .locator = wire_locator,
            .token = replay_grant_token,
            .geometry = .{
                .columns = @as(u16, 80),
                .rows = @as(u16, 24),
                .widthPx = @as(u32, 800),
                .heightPx = @as(u32, 480),
                .cellWidthPx = @as(f64, 10),
                .cellHeightPx = @as(f64, 20),
            },
            .afterSeq = "0",
        }, .{});
        defer allocator.free(replay_attach);
        try writeViewerRequest(replay_stream, generated.frame_type.host_attach, 81, 0, replay_attach);
        try replay_reader.collectOutputUntilLength(reader.output.items.len);
        if (!std.mem.eql(u8, replay_reader.output.items, reader.output.items))
            return error.ReplayDiverged;
        try expectViewerClosed(&reader);
    }
}

/// Asserts the host closed this viewer connection (EOF or reset on read).
fn expectViewerClosed(reader: *ViewerReader) !void {
    if (reader.readWireFrame()) |frame| {
        frame.deinit(reader.allocator);
        return error.ViewerNotClosed;
    } else |_| {}
}

fn runCreateBroker(
    allocator: std.mem.Allocator,
    root: []const u8,
    spec: []const u8,
    locator: broker.Locator,
    created_writer: std.fs.File,
) !void {
    var runtime = try broker.Runtime.open(allocator, root);
    defer runtime.deinit();
    var registry: broker.Registry = .{};
    var launcher = try session_host.ProductionHostLauncher.init(allocator, root);
    defer launcher.deinit();
    var control_plane: broker.ProductionControlPlane = undefined;
    try control_plane.init(allocator, root);
    defer control_plane.deinit();
    var backend = broker.ProductionBackend.init(
        allocator,
        &runtime,
        &registry,
        &control_plane,
        launcher.launcher(),
    );
    defer backend.deinit();

    const broker_backend = backend.backend();
    switch (broker_backend.call(
        allocator,
        requestHeader(generated.frame_type.create_begin, spec.len),
        spec,
        1,
    )) {
        .no_response => {},
        .response => |payload| {
            allocator.free(payload);
            return error.UnexpectedCreateBeginResponse;
        },
        .failure => return error.CreateBeginFailed,
    }

    const commit =
        \\{"schemaVersion":1,"totalLength":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}
    ;
    const created = switch (broker_backend.call(
        allocator,
        requestHeader(generated.frame_type.create_commit, commit.len),
        commit,
        2,
    )) {
        .response => |payload| payload,
        .no_response => return error.MissingCreatedResponse,
        .failure => return error.CreateCommitFailed,
    };
    defer allocator.free(created);
    errdefer _ = registry.terminate(locator, .{
        .mode = "immediate",
        .reason = "real host golden failed",
        .request_id = "req_018f1e90-7b5a-7cc0-8000-0000000000f5",
    });
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.created_payload,
        created,
    )) return error.InvalidCreatedResponse;
    try created_writer.writeAll(created);
}

fn setCloseOnExec(fd: std.posix.fd_t) !void {
    const flags = c.fcntl(fd, c.F_GETFD);
    if (flags < 0 or c.fcntl(fd, c.F_SETFD, flags | c.FD_CLOEXEC) < 0)
        return error.PipeCloseOnExecFailed;
}

fn requestHeader(type_code: u16, payload_length: usize) protocol.Header {
    return .{
        .minor = generated.protocol_minor,
        .type_code = type_code,
        .flags = 0,
        .payload_length = @intCast(payload_length),
        .request_id = 1,
        .stream_seq = 0,
    };
}

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
