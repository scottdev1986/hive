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
        "while IFS= read -r line; do printf '%s\\n' \"$line\" >> {s}; done",
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
    try driveViewerWire(
        allocator,
        root,
        &recovered.registry,
        locator,
        wire_locator,
        input_proof_path,
        parsed_created.value.inspection.providerRoot.pid,
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
        child: ?struct { processId: i32 },
        diagnostics: []const []const u8,
    };
    var parsed_inspected = try std.json.parseFromSlice(
        InspectedProjection,
        allocator,
        inspected,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed_inspected.deinit();
    if (!std.mem.eql(u8, parsed_inspected.value.lifecycle, "running") or
        parsed_inspected.value.child == null or
        parsed_inspected.value.child.?.processId != parsed_created.value.inspection.providerRoot.pid or
        std.mem.indexOf(u8, inspected, "neutral-host-control-unavailable") == null)
        return error.InvalidRealInspection;

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
    ) or std.mem.indexOf(u8, terminated, "\"state\":\"unknown\"") == null or
        std.mem.indexOf(
            u8,
            terminated,
            "neutral-host-control-unavailable-during-termination",
        ) == null)
        return error.HostTerminationFailed;
    // The neutral HostOperations endpoint is a later increment. Until it is
    // served by the host process, Controller truthfully returns UNKNOWN and
    // this golden uses the legacy locator-bound control only for cleanup.
    if (recovered.registry.terminate(locator, .{
        .mode = "immediate",
        .reason = "real-host-golden cleanup after neutral fallback",
        .request_id = "req_018f1e90-7b5a-7cc0-8000-0000000000f6",
    }) != .terminated) return error.HostCleanupFailed;
    switch (process_inspector.observeProcess(parsed_created.value.inspection.providerRoot.pid)) {
        .absent => {},
        .present, .unobservable => return error.ProviderStillPresent,
    }
    switch (process_inspector.observeProcess(parsed_created.value.inspection.hostPid)) {
        .absent => {},
        .present, .unobservable => return error.HostStillPresent,
    }

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

fn readViewerResponse(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    type_code: u16,
    request_id: u64,
    schema: []const u8,
) !protocol.Frame {
    const file: std.fs.File = .{ .handle = stream.handle };
    const frame = switch (try protocol.readFrame(allocator, file.deprecatedReader())) {
        .frame => |frame| frame,
        else => return error.InvalidViewerResponse,
    };
    errdefer frame.deinit(allocator);
    if (frame.header.type_code != type_code or
        frame.header.request_id != request_id or
        frame.header.flags != (generated.frame_flag.response | generated.frame_flag.final) or
        !protocol.validateControlPayload(allocator, schema, frame.payload))
        return error.InvalidViewerResponse;
    return frame;
}

fn readViewerError(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    request_id: u64,
    expected_code: []const u8,
) !void {
    const file: std.fs.File = .{ .handle = stream.handle };
    var frame = switch (try protocol.readFrame(allocator, file.deprecatedReader())) {
        .frame => |frame| frame,
        else => return error.InvalidViewerError,
    };
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
    locator: broker.Locator,
    wire_locator: WireLocatorPayload,
    input_proof_path: []const u8,
    provider_pid: i32,
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
        allocator,
        stream,
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
    try readViewerError(allocator, stream, 19, "GENERATION_MISMATCH");

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
        allocator,
        stream,
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
        allocator,
        stream,
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
        allocator,
        stream,
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
        allocator,
        stream,
        generated.frame_type.applied,
        31,
        generated.wire_schema.applied_payload,
    );
    defer replayed.deinit(allocator);
    if (!std.mem.eql(u8, replayed.payload, applied.payload))
        return error.InputReplayChangedReceipt;
    try waitForSingleInputEffect(allocator, input_proof_path);

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
        allocator,
        stream,
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
        allocator,
        stream,
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
        allocator,
        stream,
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
