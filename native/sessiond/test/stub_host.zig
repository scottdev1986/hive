const std = @import("std");
const broker = @import("broker");
const c = @cImport({
    @cInclude("sys/stat.h");
    @cInclude("unistd.h");
});

/// TEST DOUBLE ONLY. WP4 owns the shipped PTY/VT host role. This double exists
/// solely to exercise WP3 registration, grants, adoption, lease expiry, and
/// positive exit reporting without ever opening a PTY.
const StubHost = struct {
    secret: [32]u8,
    readback: broker.AdoptionReadback,
    visible: bool = true,
    grant_hash: ?[32]u8 = null,
    grant_viewer_id: ?[]const u8 = null,
    grant_expires_ns: u64 = 0,
    terminated: bool = false,
    termination: broker.TerminationReadback = .{
        .pty_closed = true,
        .host_exited = true,
        .verification_complete = true,
        .survivor_count = 0,
    },

    fn control(self: *StubHost) broker.HostControl {
        return .{
            .context = self,
            .adopt_fn = adopt,
            .register_grant_fn = registerGrant,
            .terminate_fn = terminate,
        };
    }

    fn adopt(context: *anyopaque, locator: broker.Locator, secret: [32]u8, now_ns: u64) ?broker.AdoptionReadback {
        _ = now_ns;
        const self: *StubHost = @ptrCast(@alignCast(context));
        if (!self.visible or !sameLocator(locator, self.readback.locator) or
            !std.crypto.timing_safe.eql([32]u8, self.secret, secret)) return null;
        return self.readback;
    }

    fn registerGrant(context: *anyopaque, locator: broker.Locator, grant: broker.GrantRegistration) bool {
        const self: *StubHost = @ptrCast(@alignCast(context));
        if (!self.visible or !sameLocator(locator, self.readback.locator)) return false;
        self.grant_hash = grant.hash;
        self.grant_viewer_id = grant.viewer_id;
        self.grant_expires_ns = grant.expires_mono_ns;
        return true;
    }

    fn terminate(
        context: *anyopaque,
        locator: broker.Locator,
        command: broker.TerminationCommand,
    ) broker.TerminationReadback {
        _ = command;
        const self: *StubHost = @ptrCast(@alignCast(context));
        if (!sameLocator(locator, self.readback.locator)) return .{
            .pty_closed = false,
            .host_exited = false,
            .verification_complete = false,
            .survivor_count = 0,
        };
        self.terminated = true;
        self.visible = false;
        return self.termination;
    }
};

/// WP4 test double: models the host-owned §21 lease clock by writing immutable
/// final evidence after the broker deliberately starves an unreadable record.
const LeaseStarvationHostDouble = struct {
    fn expire(directory: std.fs.Dir) !void {
        var final = try directory.createFile("final.json", .{
            .mode = 0o600,
            .exclusive = true,
        });
        defer final.close();
        try final.chmod(0o600);
        try final.writeAll("{\"state\":\"terminated\",\"survivors\":[]}");
        try final.sync();
        try std.posix.fsync(directory.fd);
    }
};

fn sameLocator(left: broker.Locator, right: broker.Locator) bool {
    return left.generation == right.generation and
        std.mem.eql(u8, left.instance_id, right.instance_id) and
        std.mem.eql(u8, left.session_id, right.session_id);
}

fn fixtureRecord(expires_ns: u64) broker.HostRecord {
    return .{
        .locator = .{
            .instance_id = "instance-a",
            .session_id = "ses_018f1e90-7b5a-7cc0-8000-000000000001",
            .generation = 3,
            .subject = .{ .agent = "agent-a" },
            .host_kind = .sessiond,
            .engine_build_id = "engine-a",
        },
        .host_pid = 4100,
        .host_start_token = "4100:123456",
        .process_root = .{ .pid = 4101, .start_token = "4101:123457", .process_group_id = 4101 },
        .expected_executable = "/Applications/Hive.app/Contents/Helpers/hive-sessiond",
        .executable_build_hash = "build-a",
        .engine_build_id = "engine-a",
        .protocol_major = 1,
        .protocol_minor = 0,
        .geometry = .{
            .columns = 120,
            .rows = 40,
            .width_px = 1200,
            .height_px = 800,
            .cell_width_px = 10,
            .cell_height_px = 20,
        },
        .state = .live,
        .visibility = .{
            .state = .visible,
            .workspace_session_id = "workspace-a",
            .open_terminal_revision = 7,
            .expires_mono_ns = expires_ns,
        },
        .output_seq = 4096,
        .checkpoint_seq = 2048,
    };
}

fn fixtureReadback(record: broker.HostRecord) broker.AdoptionReadback {
    return .{
        .locator = record.locator,
        .host_pid = record.host_pid,
        .host_start_token = record.host_start_token,
        .executable = record.expected_executable,
        .executable_build_hash = record.executable_build_hash,
        .engine_build_id = record.engine_build_id,
        .protocol_major = record.protocol_major,
        .protocol_minor = record.protocol_minor,
        .process_root = record.process_root,
        .output_seq = record.output_seq,
        .checkpoint_seq = record.checkpoint_seq,
        .visibility = record.visibility,
    };
}

fn fixtureHost(record: broker.HostRecord) StubHost {
    return .{ .secret = @splat(0x5a), .readback = fixtureReadback(record) };
}

fn corpusPayload(allocator: std.mem.Allocator, schema_name: []const u8) ![]u8 {
    var corpus = try std.json.parseFromSlice(std.json.Value, allocator, broker.generated.wire_corpus_fixture, .{});
    defer corpus.deinit();
    const valid = corpus.value.object.get("valid") orelse return error.MissingCorpus;
    for (valid.array.items) |item| {
        const schema = item.object.get("schema") orelse continue;
        if (schema != .string or !std.mem.eql(u8, schema.string, schema_name)) continue;
        const value = item.object.get("value") orelse return error.MissingCorpus;
        return std.json.Stringify.valueAlloc(allocator, value, .{});
    }
    return error.MissingCorpus;
}

const LaunchDouble = struct {
    record: broker.HostRecord,
    record_json: []const u8,
    created_payload: []const u8,
    host: broker.HostControl,
    called: bool = false,
    executable_was_absolute: bool = false,
    secret_was_nonzero: bool = false,

    fn launcher(self: *LaunchDouble) broker.HostLauncher {
        return .{ .context = self, .launch_fn = launch };
    }

    fn launch(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        executable: []const u8,
        spec_json: []const u8,
        initial_input: []const u8,
        secret: [32]u8,
    ) ?broker.HostLaunchReadback {
        const self: *LaunchDouble = @ptrCast(@alignCast(context));
        self.called = true;
        self.executable_was_absolute = std.fs.path.isAbsolute(executable);
        self.secret_was_nonzero = !std.mem.allEqual(u8, &secret, 0);
        if (spec_json.len == 0 or initial_input.len != 0) return null;
        return .{
            .record = self.record,
            .record_json = self.record_json,
            .created_payload = allocator.dupe(u8, self.created_payload) catch return null,
            .host = self.host,
        };
    }
};

const RecoveryDouble = struct {
    host: StubHost,
    socket: broker.SocketEvidence,

    fn connector(self: *RecoveryDouble) broker.RecoveryConnector {
        return .{ .context = self, .connect_fn = connect };
    }

    fn connect(
        context: *anyopaque,
        directory: std.fs.Dir,
        record: broker.HostRecord,
        expected_socket: broker.SocketEvidence,
    ) ?broker.RecoveryChannel {
        _ = directory;
        _ = record;
        _ = expected_socket;
        const self: *RecoveryDouble = @ptrCast(@alignCast(context));
        return .{ .host = self.host.control(), .observed_socket = self.socket };
    }
};

fn wireLocatorValue(allocator: std.mem.Allocator, locator: broker.Locator) !std.json.Value {
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
    try value.put("engineBuildId", if (locator.engine_build_id) |build|
        .{ .string = build }
    else
        .null);
    return .{ .object = value };
}

fn recordJsonForTest(
    allocator: std.mem.Allocator,
    record: broker.HostRecord,
    expires_at: []const u8,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    var output_storage: [32]u8 = undefined;
    var checkpoint_storage: [32]u8 = undefined;
    var revision_storage: [32]u8 = undefined;
    return std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .locator = try wireLocatorValue(arena.allocator(), record.locator),
        .hostPid = record.host_pid,
        .hostStartToken = record.host_start_token,
        .processRoot = .{
            .pid = record.process_root.pid,
            .startToken = record.process_root.start_token,
            .processGroupId = record.process_root.process_group_id,
        },
        .expectedExecutable = record.expected_executable,
        .executableBuildHash = record.executable_build_hash,
        .engineBuildId = record.engine_build_id,
        .protocol = .{ .major = record.protocol_major, .minor = record.protocol_minor },
        .socketRelativePath = "host.sock",
        .geometry = .{
            .columns = record.geometry.columns,
            .rows = record.geometry.rows,
            .widthPx = record.geometry.width_px,
            .heightPx = record.geometry.height_px,
            .cellWidthPx = record.geometry.cell_width_px,
            .cellHeightPx = record.geometry.cell_height_px,
        },
        .createdAt = "2026-07-16T12:00:00.000Z",
        .state = @tagName(record.state),
        .visibility = .{
            .state = @tagName(record.visibility.state),
            .workspaceSessionId = record.visibility.workspace_session_id,
            .openTerminalRevision = try std.fmt.bufPrint(
                &revision_storage,
                "{d}",
                .{record.visibility.open_terminal_revision},
            ),
            .expiresAt = expires_at,
        },
        .outputSeq = try std.fmt.bufPrint(&output_storage, "{d}", .{record.output_seq}),
        .checkpointSeq = try std.fmt.bufPrint(&checkpoint_storage, "{d}", .{record.checkpoint_seq}),
    }, .{});
}

const WireStubServer = struct {
    server: *std.net.Server,
    record: *const broker.HostRecord,
    secret: [32]u8,
    expiry_storage: [24]u8 = undefined,
    failed: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

    fn threadMain(self: *WireStubServer) void {
        self.run() catch |err| {
            std.log.err("wire stub failure: {s}", .{@errorName(err)});
            self.failed.store(true, .release);
        };
    }

    fn run(self: *WireStubServer) !void {
        for ([_]u16{
            broker.generated.frame_type.host_adopt,
            broker.generated.frame_type.grant_register,
            broker.generated.frame_type.terminate,
        }) |expected_type| try self.serveOne(expected_type);
    }

    fn serveOne(self: *WireStubServer, expected_type: u16) !void {
        const allocator = std.heap.page_allocator;
        const accepted = try self.server.accept();
        defer accepted.stream.close();
        const observed = try broker.inspectPeer(accepted.stream.handle);
        if (observed.uid != std.posix.getuid() or observed.pid != c.getpid())
            return error.InvalidBrokerPeer;
        const file: std.fs.File = .{ .handle = accepted.stream.handle };
        const reader = file.deprecatedReader();

        const hello_read = try broker.protocol.readFrame(allocator, reader);
        const hello = switch (hello_read) {
            .frame => |frame| frame,
            else => return error.InvalidHello,
        };
        defer hello.deinit(allocator);
        if (hello.header.type_code != broker.generated.frame_type.hello or
            !broker.protocol.validateControlPayload(
                allocator,
                broker.generated.wire_schema.hello_payload,
                hello.payload,
            ))
            return error.InvalidHello;
        const BrokerHello = struct {
            schemaVersion: u8,
            buildId: []const u8,
            instanceId: []const u8,
            clientRole: []const u8,
        };
        var parsed_hello = try std.json.parseFromSlice(BrokerHello, allocator, hello.payload, .{
            .ignore_unknown_fields = true,
        });
        defer parsed_hello.deinit();
        if (parsed_hello.value.schemaVersion != 1 or
            !std.mem.eql(u8, parsed_hello.value.clientRole, "broker") or
            !std.mem.eql(u8, parsed_hello.value.instanceId, self.record.locator.instance_id) or
            !std.mem.eql(u8, parsed_hello.value.buildId, "broker-build"))
            return error.InvalidHello;

        const welcome = try std.json.Stringify.valueAlloc(allocator, .{
            .schemaVersion = @as(u8, 1),
            .protocol = .{
                .major = broker.generated.protocol_major,
                .minor = broker.generated.protocol_minor,
            },
            .instanceId = self.record.locator.instance_id,
            .endpointRole = "host",
            .buildId = self.record.executable_build_hash,
            .engineBuildId = self.record.locator.engine_build_id,
            .connectionId = "1",
            .serverEpoch = "1",
            .limits = .{
                .controlFrameMaxBytes = broker.generated.limits.control_json_bytes,
                .streamChunkMaxBytes = broker.generated.limits.stream_chunk_bytes,
                .automatedMessageMaxBytes = broker.generated.limits.automated_message_bytes,
                .viewerQueueMaxBytes = broker.generated.limits.viewer_queue_bytes,
            },
        }, .{});
        defer allocator.free(welcome);
        if (!broker.protocol.validateControlPayload(
            allocator,
            broker.generated.wire_schema.welcome_payload,
            welcome,
        )) return error.InvalidWelcome;
        try broker.protocol.writeFrame(accepted.stream, .{
            .minor = broker.generated.protocol_minor,
            .type_code = broker.generated.frame_type.welcome,
            .flags = broker.generated.frame_flag.response | broker.generated.frame_flag.final,
            .payload_length = @intCast(welcome.len),
            .request_id = hello.header.request_id,
            .stream_seq = 0,
        }, welcome);

        const request_read = try broker.protocol.readFrame(allocator, reader);
        const request = switch (request_read) {
            .frame => |frame| frame,
            else => return error.InvalidRequest,
        };
        defer request.deinit(allocator);
        if (request.header.type_code != expected_type) return error.InvalidRequest;

        var payload_arena = std.heap.ArenaAllocator.init(allocator);
        defer payload_arena.deinit();
        const payload_allocator = payload_arena.allocator();
        const response_type: u16 = if (expected_type == broker.generated.frame_type.terminate)
            broker.generated.frame_type.terminated
        else
            expected_type;
        const response_schema: []const u8 = if (expected_type == broker.generated.frame_type.host_adopt)
            broker.generated.wire_schema.host_adopt_payload
        else if (expected_type == broker.generated.frame_type.grant_register)
            broker.generated.wire_schema.grant_register_payload
        else
            broker.generated.wire_schema.terminated_payload;
        const request_schema: []const u8 = if (expected_type == broker.generated.frame_type.host_adopt)
            broker.generated.wire_schema.host_adopt_payload
        else if (expected_type == broker.generated.frame_type.grant_register)
            broker.generated.wire_schema.grant_register_payload
        else
            broker.generated.wire_schema.terminate_payload;
        if (!broker.protocol.validateControlPayload(allocator, request_schema, request.payload))
            return error.InvalidRequest;

        const response = if (expected_type == broker.generated.frame_type.host_adopt) blk: {
            const Challenge = struct { adoptionSecretHex: []const u8, brokerBuildId: []const u8 };
            var challenge = try std.json.parseFromSlice(Challenge, allocator, request.payload, .{
                .ignore_unknown_fields = true,
            });
            defer challenge.deinit();
            const expected_secret = std.fmt.bytesToHex(self.secret, .lower);
            if (!std.mem.eql(u8, challenge.value.adoptionSecretHex, &expected_secret) or
                !std.mem.eql(u8, challenge.value.brokerBuildId, "broker-build"))
                return error.InvalidChallenge;
            break :blk try std.json.Stringify.valueAlloc(payload_allocator, .{
                .schemaVersion = @as(u8, 1),
                .locator = try wireLocatorValue(payload_allocator, self.record.locator),
                .hostPid = self.record.host_pid,
                .hostStartToken = self.record.host_start_token,
                .executable = self.record.expected_executable,
                .executableBuildHash = self.record.executable_build_hash,
                .engineBuildId = self.record.engine_build_id,
                .protocol = .{
                    .major = self.record.protocol_major,
                    .minor = self.record.protocol_minor,
                },
                .processRoot = .{
                    .pid = self.record.process_root.pid,
                    .startToken = self.record.process_root.start_token,
                    .processGroupId = self.record.process_root.process_group_id,
                },
                .outputSeq = "4096",
                .checkpointSeq = "2048",
                .visibility = .{
                    .state = "visible",
                    .workspaceSessionId = self.record.visibility.workspace_session_id,
                    .openTerminalRevision = "7",
                    .expiresAt = try broker.wallDeadline(
                        &self.expiry_storage,
                        broker.generated.limits.visibility_expiry_ms,
                    ),
                },
            }, .{});
        } else if (expected_type == broker.generated.frame_type.grant_register)
            try std.json.Stringify.valueAlloc(payload_allocator, .{
                .schemaVersion = @as(u8, 1),
                .registered = true,
            }, .{})
        else
            try std.json.Stringify.valueAlloc(payload_allocator, .{
                .schemaVersion = @as(u8, 1),
                .locator = try wireLocatorValue(payload_allocator, self.record.locator),
                .state = "terminated",
                .exit = @as(?u8, null),
                .survivors = &[_]std.json.Value{},
                .errors = &[_]std.json.Value{},
            }, .{});
        if (!broker.protocol.validateControlPayload(allocator, response_schema, response))
            return error.InvalidResponse;
        try broker.protocol.writeFrame(accepted.stream, .{
            .minor = broker.generated.protocol_minor,
            .type_code = response_type,
            .flags = broker.generated.frame_flag.response | broker.generated.frame_flag.final,
            .payload_length = @intCast(response.len),
            .request_id = request.header.request_id,
            .stream_seq = 0,
        }, response);
    }
};

test "security corpus rejects replay stale generation and foreign instance" {
    const now: u64 = 1_000_000;
    const record = fixtureRecord(now + 30 * std.time.ns_per_s);
    var host = fixtureHost(record);
    var registry: broker.Registry = .{};
    var grant_hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("raw-token", &grant_hash, .{});
    const operations = [_][]const u8{ "view", "human-input", "resize" };
    try std.testing.expect(registry.register(record, host.control()) == null);
    try std.testing.expect(registry.registerGrant(
        record.locator,
        grant_hash,
        "viewer-a",
        &operations,
        record.geometry,
        now,
    ) == null);
    try std.testing.expectEqualDeep(grant_hash, host.grant_hash.?);
    try std.testing.expectEqualStrings("viewer-a", host.grant_viewer_id.?);
    try std.testing.expectEqual(broker.protocol.WireError.already_exists, registry.registerGrant(
        record.locator,
        grant_hash,
        "viewer-a",
        &operations,
        record.geometry,
        now,
    ).?.code);
    try std.testing.expect(registry.consumeGrant(record.locator, "raw-token", now) == null);
    try std.testing.expectEqual(broker.protocol.WireError.unauthenticated, registry.consumeGrant(record.locator, "raw-token", now).?.code);

    var stale = record.locator;
    stale.generation -= 1;
    try std.testing.expectEqual(broker.protocol.WireError.generation_mismatch, registry.lookup(stale).?.failure.code);
    var foreign = record.locator;
    foreign.instance_id = "instance-b";
    try std.testing.expectEqual(broker.protocol.WireError.instance_mismatch, registry.lookup(foreign).?.failure.code);
    var wrong_subject = record.locator;
    wrong_subject.subject = .{ .agent = "agent-b" };
    try std.testing.expectEqual(broker.protocol.WireError.generation_mismatch, registry.lookup(wrong_subject).?.failure.code);
    try std.testing.expectEqual(broker.protocol.WireError.generation_mismatch, registry.renewVisibility(record.locator, "workspace-a", 6, now).?.code);

    var starting = record;
    starting.locator.session_id = "ses_018f1e90-7b5a-7cc0-8000-000000000011";
    starting.state = .starting;
    var starting_host = fixtureHost(starting);
    try std.testing.expectEqual(
        broker.protocol.WireError.not_ready,
        registry.register(starting, starting_host.control()).?.code,
    );
}

test "disk recovery uses real host wire and publishes the challenged lease" {
    var root_storage: [48]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/h{x}", .{std.crypto.random.int(u32)});
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var runtime = try broker.Runtime.open(std.testing.allocator, root);
    defer runtime.deinit();
    const session_id = "ses_018f1e90-7b5a-7cc0-8000-000000000001";
    var host_directory = try runtime.openHostDirectory(session_id, true);
    defer host_directory.close();
    const socket_path = try std.fs.path.join(std.testing.allocator, &.{
        root, "runtime/sessiond/hosts", session_id, "host.sock",
    });
    defer std.testing.allocator.free(socket_path);
    const address = try std.net.Address.initUnix(socket_path);
    var listener = try address.listen(.{});
    defer listener.deinit();
    const socket_path_z = try std.testing.allocator.dupeZ(u8, socket_path);
    defer std.testing.allocator.free(socket_path_z);
    if (c.chmod(socket_path_z.ptr, 0o600) != 0) return error.SocketModeFailed;
    const stat = try std.posix.fstatat(host_directory.fd, "host.sock", std.posix.AT.SYMLINK_NOFOLLOW);
    _ = stat;

    const process = try broker.inspectProcess(c.getpid());
    var start_token_storage: [64]u8 = undefined;
    const start_token = try broker.formatStartToken(process.start_token, &start_token_storage);
    const now: u64 = 10 * std.time.ns_per_s;
    var record = fixtureRecord(now + 15 * std.time.ns_per_s);
    record.host_pid = c.getpid();
    record.host_start_token = start_token;
    record.expected_executable = process.executablePath();
    record.executable_build_hash = "host-build";
    record.engine_build_id = "engine-a";
    record.locator.engine_build_id = "engine-a";
    const secret = try broker.createAdoptionSecret(host_directory);
    var expiry_storage: [24]u8 = undefined;
    const expires_at = try broker.wallDeadline(
        &expiry_storage,
        broker.generated.limits.visibility_expiry_ms,
    );
    const record_json = try recordJsonForTest(std.testing.allocator, record, expires_at);
    defer std.testing.allocator.free(record_json);
    try broker.writeRecordAtomic(std.testing.allocator, host_directory, record_json);
    var server: WireStubServer = .{
        .server = &listener,
        .record = &record,
        .secret = secret,
    };
    const thread = try std.Thread.spawn(.{}, WireStubServer.threadMain, .{&server});

    var wire = broker.WireRecoveryConnector.init(
        std.testing.allocator,
        runtime.canonical_home,
        "broker-build",
    );
    defer wire.deinit();
    var recovered = broker.RecoveredRegistry.init(std.testing.allocator);
    defer recovered.deinit();
    try recovered.recover(&runtime, now, wire.connector());
    try std.testing.expect(recovered.registry.renewVisibility(
        record.locator,
        record.visibility.workspace_session_id,
        record.visibility.open_terminal_revision + 1,
        now + std.time.ns_per_ms,
    ) == null);

    var grant_hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("wire-token", &grant_hash, .{});
    const operations = [_][]const u8{ "view", "human-input", "resize" };
    try std.testing.expect(recovered.registry.registerGrant(
        record.locator,
        grant_hash,
        "viewer-wire",
        &operations,
        record.geometry,
        now,
    ) == null);
    try std.testing.expectEqual(broker.TerminationState.terminated, recovered.registry.terminate(
        record.locator,
        .{
            .mode = "graceful",
            .reason = "terminal closed",
            .request_id = "req_018f1e90-7b5a-7cc0-8000-000000000004",
        },
    ));
    thread.join();
    try std.testing.expect(!server.failed.load(.acquire));
}

test "wire host control rejects a locator before connecting" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const record = fixtureRecord(30 * std.time.ns_per_s);
    var client = try broker.WireHostClient.init(
        std.testing.allocator,
        temporary.dir,
        "/tmp/nonexistent-hive-host.sock",
        .{ .device = 1, .inode = 2, .owner_uid = std.posix.getuid(), .mode = 0o600 },
        record,
        "broker-build",
    );
    defer client.deinit();
    var wrong = record.locator;
    wrong.generation += 1;
    const operations = [_][]const u8{"view"};
    try std.testing.expect(!client.control().registerGrant(wrong, .{
        .hash = @splat(0x11),
        .viewer_id = "viewer",
        .operations = &operations,
        .geometry = record.geometry,
        .registered_mono_ns = 1,
        .expires_mono_ns = 2,
    }));
    try std.testing.expect(!client.control().terminate(wrong, .{
        .mode = "immediate",
        .reason = "wrong locator",
        .request_id = "req_018f1e90-7b5a-7cc0-8000-000000000004",
    }).verification_complete);
}

test "broker launch passes the exact executable and secret then publishes only validated readback" {
    var path_storage: [96]u8 = undefined;
    const root = try std.fmt.bufPrint(&path_storage, "/tmp/hive-sessiond-{x}", .{std.crypto.random.int(u64)});
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var runtime = try broker.Runtime.open(std.testing.allocator, root);
    defer runtime.deinit();

    const spec = try corpusPayload(std.testing.allocator, broker.generated.wire_schema.create_begin_payload);
    defer std.testing.allocator.free(spec);
    try std.testing.expect(broker.protocol.validateControlPayload(
        std.testing.allocator,
        broker.generated.wire_schema.create_begin_payload,
        spec,
    ));
    const record_json = try corpusPayload(std.testing.allocator, broker.generated.wire_schema.host_record_v1);
    defer std.testing.allocator.free(record_json);
    const created = try corpusPayload(std.testing.allocator, broker.generated.wire_schema.created_payload);
    defer std.testing.allocator.free(created);
    try std.testing.expect(broker.protocol.validateControlPayload(
        std.testing.allocator,
        broker.generated.wire_schema.created_payload,
        created,
    ));

    var record = fixtureRecord(30 * std.time.ns_per_s);
    record.locator.instance_id = "hive-fixture";
    record.locator.subject = .{ .agent = "agent-fixture" };
    record.locator.engine_build_id = "engine-fixture";
    record.expected_executable = "/usr/local/bin/codex";
    record.executable_build_hash = "executable-build-fixture";
    record.engine_build_id = "engine-fixture";
    record.visibility.state = .attaching;
    record.visibility.workspace_session_id = "workspace-fixture";
    record.visibility.expires_mono_ns = 31 * std.time.ns_per_s;
    try std.testing.expect(broker.recordJsonMatches(std.testing.allocator, record, record_json));
    var launch_host = fixtureHost(record);
    var launcher: LaunchDouble = .{
        .record = record,
        .record_json = record_json,
        .created_payload = created,
        .host = launch_host.control(),
    };
    var registry: broker.Registry = .{};
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("", &digest, .{});
    const launched = try broker.launchHost(
        std.testing.allocator,
        &runtime,
        &registry,
        record.locator.session_id,
        spec,
        "",
        digest,
        1 * std.time.ns_per_s,
        launcher.launcher(),
    );
    try std.testing.expect(launcher.called);
    try std.testing.expect(launched.failure == null);
    const created_payload = launched.created_payload orelse return error.MissingCreatedPayload;
    defer std.testing.allocator.free(created_payload);
    try std.testing.expect(launcher.executable_was_absolute);
    try std.testing.expect(launcher.secret_was_nonzero);
    try std.testing.expect(registry.lookup(record.locator).?.entry.record.state == .live);
}

test "visibility expiry terminates through the host double with positive readback" {
    const expiry: u64 = 15 * std.time.ns_per_s;
    const record = fixtureRecord(expiry);
    var host = fixtureHost(record);
    var registry: broker.Registry = .{};
    try std.testing.expect(registry.register(record, host.control()) == null);
    try std.testing.expectEqual(@as(usize, 1), registry.expireVisibility(expiry));
    try std.testing.expect(host.terminated);

    var inspections: [2]broker.Inspection = undefined;
    const list = registry.list("instance-a", &inspections);
    try std.testing.expect(list.complete);
    try std.testing.expectEqual(@as(usize, 1), list.entries.len);
    try std.testing.expectEqual(.exited, list.entries[0].presence);
}

test "registry routes each grant and expiry to its locator-bound host" {
    const expiry: u64 = 15 * std.time.ns_per_s;
    const first_record = fixtureRecord(expiry);
    var second_record = fixtureRecord(expiry);
    second_record.locator.session_id = "ses_018f1e90-7b5a-7cc0-8000-000000000011";
    var first_host = fixtureHost(first_record);
    var second_host = fixtureHost(second_record);
    var registry: broker.Registry = .{};
    try std.testing.expect(registry.register(first_record, first_host.control()) == null);
    try std.testing.expect(registry.register(second_record, second_host.control()) == null);
    var grant_hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("second-host-token", &grant_hash, .{});
    const operations = [_][]const u8{"view"};
    try std.testing.expect(registry.registerGrant(
        second_record.locator,
        grant_hash,
        "viewer-b",
        &operations,
        second_record.geometry,
        1,
    ) == null);
    try std.testing.expect(first_host.grant_hash == null);
    try std.testing.expectEqualDeep(grant_hash, second_host.grant_hash.?);
    try std.testing.expectEqual(@as(usize, 2), registry.expireVisibility(expiry));
    try std.testing.expect(first_host.terminated and second_host.terminated);
}

test "restart adoption publishes only challenge verified visible hosts" {
    const now: u64 = 10 * std.time.ns_per_s;
    const record = fixtureRecord(now + 15 * std.time.ns_per_s);
    const socket: broker.SocketEvidence = .{
        .device = 1,
        .inode = 2,
        .owner_uid = std.posix.getuid(),
        .mode = 0o600,
    };

    var verified_host = fixtureHost(record);
    var adopted: broker.Registry = .{};
    try std.testing.expect(adopted.recoverCandidate(record, verified_host.secret, socket, socket, now, verified_host.control()) == null);
    var adopted_list_storage: [2]broker.Inspection = undefined;
    const adopted_list = adopted.list("instance-a", &adopted_list_storage);
    try std.testing.expect(adopted_list.complete);
    try std.testing.expectEqual(.present, adopted_list.entries[0].presence);

    var unknown_host = fixtureHost(record);
    var wrong_secret = unknown_host.secret;
    wrong_secret[0] ^= 0xff;
    var quarantined: broker.Registry = .{};
    try std.testing.expectEqual(broker.protocol.WireError.unauthenticated, quarantined.recoverCandidate(record, wrong_secret, socket, socket, now, unknown_host.control()).?.code);
    var unknown_list_storage: [2]broker.Inspection = undefined;
    const unknown_list = quarantined.list("instance-a", &unknown_list_storage);
    try std.testing.expect(!unknown_list.complete);
    try std.testing.expectEqual(.unknown, unknown_list.entries[0].presence);

    var stale_record = record;
    stale_record.visibility.expires_mono_ns = now;
    var stale_host = fixtureHost(stale_record);
    var stale_registry: broker.Registry = .{};
    try std.testing.expectEqual(broker.protocol.WireError.verification_unknown, stale_registry.recoverCandidate(stale_record, stale_host.secret, socket, socket, now, stale_host.control()).?.code);

    var wrong_protocol_host = fixtureHost(record);
    wrong_protocol_host.readback.protocol_minor +%= 1;
    var wrong_protocol_registry: broker.Registry = .{};
    try std.testing.expectEqual(
        broker.protocol.WireError.verification_unknown,
        wrong_protocol_registry.recoverCandidate(
            record,
            wrong_protocol_host.secret,
            socket,
            socket,
            now,
            wrong_protocol_host.control(),
        ).?.code,
    );
}

test "restart walks private records then publishes only challenged hosts" {
    var path_storage: [96]u8 = undefined;
    const root = try std.fmt.bufPrint(&path_storage, "/tmp/hr-{x}", .{std.crypto.random.int(u64)});
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var runtime = try broker.Runtime.open(std.testing.allocator, root);
    defer runtime.deinit();

    const record_json = try corpusPayload(std.testing.allocator, broker.generated.wire_schema.host_record_v1);
    defer std.testing.allocator.free(record_json);
    const session_id = "ses_018f1e90-7b5a-7cc0-8000-000000000001";
    var directory = try runtime.openHostDirectory(session_id, true);
    defer directory.close();
    try broker.writeRecordAtomic(std.testing.allocator, directory, record_json);
    const secret = try broker.createAdoptionSecret(directory);

    const socket_path = try std.fs.path.join(std.testing.allocator, &.{
        root, "runtime/sessiond/hosts", session_id, "host.sock",
    });
    defer std.testing.allocator.free(socket_path);
    const address = try std.net.Address.initUnix(socket_path);
    var server = try address.listen(.{});
    defer server.deinit();
    const socket_path_z = try std.testing.allocator.dupeZ(u8, socket_path);
    defer std.testing.allocator.free(socket_path_z);
    if (c.chmod(socket_path_z.ptr, 0o600) != 0) return error.SocketModeFailed;
    const stat = try std.posix.fstatat(directory.fd, "host.sock", std.posix.AT.SYMLINK_NOFOLLOW);
    const socket: broker.SocketEvidence = .{
        .device = @intCast(stat.dev),
        .inode = @intCast(stat.ino),
        .owner_uid = @intCast(stat.uid),
        .mode = @intCast(stat.mode & 0o777),
    };

    var record = fixtureRecord(31 * std.time.ns_per_s);
    record.locator.instance_id = "hive-fixture";
    record.locator.subject = .{ .agent = "agent-fixture" };
    record.locator.engine_build_id = "engine-fixture";
    record.expected_executable = "/usr/local/bin/codex";
    record.executable_build_hash = "executable-build-fixture";
    record.engine_build_id = "engine-fixture";
    record.visibility.state = .attaching;
    record.visibility.workspace_session_id = "workspace-fixture";
    var connector: RecoveryDouble = .{ .host = fixtureHost(record), .socket = socket };
    connector.host.secret = secret;
    var recovered = broker.RecoveredRegistry.init(std.testing.allocator);
    defer recovered.deinit();
    try recovered.recover(&runtime, 1 * std.time.ns_per_s, connector.connector());
    var inspections: [2]broker.Inspection = undefined;
    const list = recovered.registry.list("hive-fixture", &inspections);
    try std.testing.expect(list.complete);
    try std.testing.expectEqual(@as(usize, 1), list.entries.len);
    try std.testing.expectEqual(.present, list.entries[0].presence);
}

test "unparseable directories stay routed off and verify only host final evidence" {
    var root_storage: [48]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/uq{x}", .{std.crypto.random.int(u32)});
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var runtime = try broker.Runtime.open(std.testing.allocator, root);
    defer runtime.deinit();
    const exited_id = "ses_018f1e90-7b5a-7cc0-8000-000000000001";
    const unknown_id = "ses_018f1e90-7b5a-7cc0-8000-000000000011";
    var exited_directory = try runtime.openHostDirectory(exited_id, true);
    defer exited_directory.close();
    var unknown_directory = try runtime.openHostDirectory(unknown_id, true);
    defer unknown_directory.close();
    for ([_]std.fs.Dir{ exited_directory, unknown_directory }) |directory| {
        var record = try directory.createFile("record.json", .{ .mode = 0o600 });
        defer record.close();
        try record.chmod(0o600);
        try record.writeAll("{\"schemaVersion\":1}");
        try record.sync();
    }

    const connector_host = fixtureHost(fixtureRecord(1));
    var connector: RecoveryDouble = .{
        .host = connector_host,
        .socket = .{ .device = 1, .inode = 1, .owner_uid = std.posix.getuid(), .mode = 0o600 },
    };
    var recovered = broker.RecoveredRegistry.init(std.testing.allocator);
    defer recovered.deinit();
    const now: u64 = 1 * std.time.ns_per_s;
    try recovered.recover(&runtime, now, connector.connector());
    var before_storage: [4]broker.Inspection = undefined;
    const before = recovered.registry.list("instance-a", &before_storage);
    try std.testing.expect(!before.complete);
    try std.testing.expectEqual(@as(usize, 2), before.entries.len);
    for (before.entries) |entry| {
        try std.testing.expect(entry.locator == null);
        try std.testing.expectEqual(.unknown, entry.presence);
        try std.testing.expect(entry.operator_attention);
    }

    try LeaseStarvationHostDouble.expire(exited_directory);
    const verify_at = now + broker.quarantineVerificationDelayNs();
    recovered.verifyDirectoryQuarantines(&runtime, verify_at);
    var after_storage: [4]broker.Inspection = undefined;
    const after = recovered.registry.list("instance-a", &after_storage);
    try std.testing.expect(!after.complete);
    var saw_exited = false;
    var saw_unknown = false;
    for (after.entries) |entry| {
        if (std.mem.eql(u8, entry.session_id, exited_id)) {
            try std.testing.expectEqual(.exited, entry.presence);
            try std.testing.expect(!entry.operator_attention);
            saw_exited = true;
        } else if (std.mem.eql(u8, entry.session_id, unknown_id)) {
            try std.testing.expectEqual(.unknown, entry.presence);
            try std.testing.expect(entry.operator_attention);
            saw_unknown = true;
        }
    }
    try std.testing.expect(saw_exited and saw_unknown);
}

test "unknown terminate readback never reports success" {
    const record = fixtureRecord(30 * std.time.ns_per_s);
    var host = fixtureHost(record);
    host.termination.verification_complete = false;
    var registry: broker.Registry = .{};
    try std.testing.expect(registry.register(record, host.control()) == null);
    try std.testing.expectEqual(broker.TerminationState.unknown, registry.terminate(record.locator, .{
        .mode = "immediate",
        .reason = "test",
        .request_id = "req_018f1e90-7b5a-7cc0-8000-000000000004",
    }));
}

test "runtime refuses a substituted broker socket" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    try temporary.dir.makePath("runtime/sessiond/hosts");
    var substituted = try temporary.dir.createFile("runtime/sessiond/broker.sock", .{ .mode = 0o600 });
    substituted.close();
    const root = try temporary.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);
    try std.testing.expectError(error.SocketSubstitution, broker.Runtime.open(std.testing.allocator, root));
}

test "running broker detects replacement of its published socket" {
    var path_storage: [96]u8 = undefined;
    const root = try std.fmt.bufPrint(&path_storage, "/tmp/hive-socket-{x}", .{std.crypto.random.int(u64)});
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var runtime = try broker.Runtime.open(std.testing.allocator, root);
    defer runtime.deinit();
    try runtime.directory.deleteFile("broker.sock");
    var substituted = try runtime.directory.createFile("broker.sock", .{ .mode = 0o600 });
    substituted.close();
    try std.testing.expectError(error.SocketSubstitution, runtime.acceptAuthenticatedPeer());
}

test "runtime refuses a symlinked private directory" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    try temporary.dir.makePath("runtime/elsewhere");
    try temporary.dir.symLink("elsewhere", "runtime/sessiond", .{});
    const root = try temporary.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);
    try std.testing.expectError(error.DirectorySubstitution, broker.Runtime.open(std.testing.allocator, root));
}

test "broker refuses a legacy daemon lock without PID reuse evidence" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var lock = try temporary.dir.createFile("daemon.lock", .{ .mode = 0o600 });
    try lock.writeAll("{\"pid\":42,\"instanceId\":\"instance-a\",\"startedAt\":\"2026-07-16T12:00:00.000Z\"}\n");
    lock.close();
    const root = try temporary.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);
    try std.testing.expectError(error.DaemonIdentityUnavailable, broker.loadDaemonLock(std.testing.allocator, root));
}

test "host records validate canonically and replace atomically at mode 0600" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const record = try corpusPayload(std.testing.allocator, broker.generated.wire_schema.host_record_v1);
    defer std.testing.allocator.free(record);
    try broker.writeRecordAtomic(std.testing.allocator, temporary.dir, record);
    var stale_temporary = try temporary.dir.createFile("record.json.new", .{
        .mode = 0o600,
        .exclusive = true,
    });
    stale_temporary.close();
    try broker.writeRecordAtomic(std.testing.allocator, temporary.dir, record);
    const stat = try std.posix.fstatat(temporary.dir.fd, "record.json", std.posix.AT.SYMLINK_NOFOLLOW);
    try std.testing.expectEqual(@as(std.posix.mode_t, 0o600), stat.mode & 0o777);
    try std.testing.expectError(error.InvalidHostRecord, broker.writeRecordAtomic(std.testing.allocator, temporary.dir, "{\"schemaVersion\":1}"));
    const stored = try temporary.dir.readFileAlloc(std.testing.allocator, "record.json", record.len);
    defer std.testing.allocator.free(stored);
    try std.testing.expectEqualStrings(record, stored);
}
