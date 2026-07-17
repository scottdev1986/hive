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
        .argv = [_][]const u8{"/bin/cat"},
        .environment = EmptyEnvironment{},
        .expectedExecutable = "/bin/cat",
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
    var lifecycle_backend = broker.ProductionBackend.init(
        allocator,
        &runtime,
        &recovered.registry,
        lifecycle_launcher.launcher(),
    );
    defer lifecycle_backend.deinit();
    const backend = lifecycle_backend.backend();
    const wire_locator = .{
        .schemaVersion = @as(u8, 1),
        .instanceId = instance_id,
        .subject = .{ .kind = "agent", .agentId = "aaron" },
        .generation = @as(u64, 1),
        .sessionId = session_id,
        .hostKind = "sessiond",
        .engineBuildId = &engine_build_id,
    };

    const list_payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .instanceId = instance_id,
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

    const inspect_payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .locator = wire_locator,
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
        presence: []const u8,
        providerRoot: struct { pid: i32 },
    };
    var parsed_inspected = try std.json.parseFromSlice(
        InspectedProjection,
        allocator,
        inspected,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed_inspected.deinit();
    if (!std.mem.eql(u8, parsed_inspected.value.presence, "present") or
        parsed_inspected.value.providerRoot.pid != parsed_created.value.inspection.providerRoot.pid)
        return error.InvalidRealInspection;

    const terminate_payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .locator = wire_locator,
        .mode = "immediate",
        .reason = "real host golden completed",
        .requestId = "req_018f1e90-7b5a-7cc0-8000-0000000000f4",
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
    ) or std.mem.indexOf(u8, terminated, "\"state\":\"terminated\"") == null)
        return error.HostTerminationFailed;
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
    var backend = broker.ProductionBackend.init(
        allocator,
        &runtime,
        &registry,
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
