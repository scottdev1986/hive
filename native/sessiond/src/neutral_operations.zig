const std = @import("std");
const generated = @import("session_protocol_generated");
const neutral_host = @import("neutral_host");
const process_inspector = @import("process_inspector");
const neutral_evidence = @import("neutral_evidence");

const ListRequest = neutral_evidence.ListRequest;
const InspectRequest = neutral_evidence.InspectRequest;
const ResizeRequest = neutral_evidence.ResizeRequest;
const HostInspectRequest = neutral_evidence.HostInspectRequest;
const TerminateRequest = neutral_evidence.TerminateRequest;
const WireAppliedResizePayload = neutral_evidence.WireAppliedResizePayload;
const WireUnknownResizePayload = neutral_evidence.WireUnknownResizePayload;
const WireInspectionPayload = neutral_evidence.WireInspectionPayload;
const WireTerminationResult = neutral_evidence.WireTerminationResult;
const WireTerminationPayload = neutral_evidence.WireTerminationPayload;
const TerminalProvider = neutral_evidence.TerminalProvider;
const EvidenceProvider = neutral_evidence.EvidenceProvider;
const EvidenceClock = neutral_evidence.EvidenceClock;
const RootReapPlatform = neutral_evidence.RootReapPlatform;
const staleResize = neutral_evidence.staleResize;
const unknownResize = neutral_evidence.unknownResize;
const decimal = neutral_evidence.decimal;
const positiveProcessId = neutral_evidence.positiveProcessId;
const wireWindow = neutral_evidence.wireWindow;
const validProcessIdentity = neutral_evidence.validProcessIdentity;
const monotonicDeadline = neutral_evidence.monotonicDeadline;
const buildInspection = neutral_evidence.buildInspection;
const inspectionPayload = neutral_evidence.inspectionPayload;
const terminationPayload = neutral_evidence.terminationPayload;
const canonicalTermination = neutral_evidence.canonicalTermination;
const durableTermination = neutral_evidence.durableTermination;
const terminationFromTree = neutral_evidence.terminationFromTree;
const measureDirectChildReap = neutral_evidence.measureDirectChildReap;

pub const HostOperations = struct {
    allocator: std.mem.Allocator,
    registry: *neutral_host.Registry,
    session: neutral_host.SessionRef,
    platform: process_inspector.Platform,
    evidence: EvidenceProvider,
    clock: EvidenceClock,
    scratch: std.heap.ArenaAllocator,
    /// Only `resize` mutates the terminal, so operations assembled purely to
    /// inspect or terminate may legitimately carry none -- which is why this
    /// stays optional. It is a REQUIRED init parameter rather than a defaulted
    /// field because a defaulted one is silently forgettable: the production
    /// host omitted it once and every resize it served answered `unknown` with
    /// nothing red to show for it.
    ///
    /// A required OPTIONAL parameter only prevents omission, not an explicit
    /// null. A host that must serve resize therefore builds through
    /// `initServingTerminal`, whose terminal is not optional, so null cannot
    /// reach it without changing which constructor is called.
    terminal: ?TerminalProvider,

    pub fn init(
        allocator: std.mem.Allocator,
        registry: *neutral_host.Registry,
        session: neutral_host.SessionRef,
        platform: process_inspector.Platform,
        evidence: EvidenceProvider,
        clock: EvidenceClock,
        terminal: ?TerminalProvider,
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
            .terminal = terminal,
        };
    }

    /// Construction for a host that MUST serve resize. The terminal is not
    /// optional here, so the mistake this guards -- a resize-serving host
    /// answering `unknown` because nothing was bound -- cannot be made by
    /// passing null at the call site.
    pub fn initServingTerminal(
        allocator: std.mem.Allocator,
        registry: *neutral_host.Registry,
        session: neutral_host.SessionRef,
        platform: process_inspector.Platform,
        evidence: EvidenceProvider,
        clock: EvidenceClock,
        terminal: TerminalProvider,
    ) !HostOperations {
        return init(allocator, registry, session, platform, evidence, clock, terminal);
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
            .resize => self.resize(request.payload),
            else => .{ .accepted = false, .payload = "operation-not-implemented" },
        };
    }

    /// Frozen `resize`. §5 is an ordered mutation, not a setter: the revision
    /// must advance, the geometry returned is what the terminal reported AFTER
    /// the set rather than what was asked for, and a superseded revision names
    /// the revision that superseded it instead of failing opaquely. The
    /// revision floor is the durable record's, so a resize is fenced by the
    /// same evidence a later inspection reports.
    fn resize(self: *HostOperations, payload: []const u8) !neutral_host.OperationResponse {
        _ = self.scratch.reset(.retain_capacity);
        const allocator = self.scratch.allocator();
        const request = try std.json.parseFromSliceLeaky(ResizeRequest, allocator, payload, .{});
        if (request.schemaVersion != 1) return error.InvalidResizeRequest;
        if (!request.session.eql(self.session)) return error.StaleSessionRef;

        const record = self.registry.get(self.session) orelse return error.SessionNotFound;
        // Copied out as a scalar: nothing below may read through a Record that
        // borrows registry storage across a registry mutation.
        const current_revision = record.windowRevision;
        const revision = std.fmt.parseInt(u64, request.revision, 10) catch
            return error.InvalidResizeRequest;
        if (revision == 0 or revision <= current_revision) return staleResize(allocator, current_revision);

        const terminal = self.terminal orelse return unknownResize(
            allocator,
            "neutral-terminal-provider-unavailable",
        );
        const outcome = terminal.resize(.{
            .columns = request.window.columns,
            .rows = request.window.rows,
            .widthPixels = request.window.widthPixels,
            .heightPixels = request.window.heightPixels,
        }, revision) catch |err| switch (err) {
            error.OutOfMemory => return err,
            // A terminal that cannot be set is `unknown`: never a silent
            // success, and never a fabricated readback.
            else => return unknownResize(allocator, @errorName(err)),
        };
        const applied = switch (outcome) {
            .applied => |value| value,
            // The set landed but its commit did not, so the record fell behind
            // the terminal. The terminal is the authority on its own order, so
            // answer from IT: if the revision the caller is retrying is the one
            // the terminal already holds, that resize DID apply and the caller
            // is owed the receipt it missed, not a refusal. Repairing the
            // record below makes the retry idempotent rather than permanently
            // stuck behind a floor that never advances.
            .superseded => |current| blk: {
                // Either way the record is behind the terminal, so repair it
                // first: inspection answers from the record, and leaving it
                // behind would keep reporting a geometry the terminal stopped
                // holding and keep admitting revisions the terminal refuses.
                _ = try self.registry.update(self.session, .{
                    .window = current.readback,
                    .windowRevision = current.revision,
                });
                if (current.revision != revision) return staleResize(allocator, current.revision);
                break :blk current;
            },
        };

        // Commit the READBACK, not the request: a later inspection must report
        // the geometry the terminal actually holds.
        _ = try self.registry.update(self.session, .{
            .window = applied.readback,
            .windowRevision = applied.revision,
        });
        const response = try std.json.Stringify.valueAlloc(allocator, WireAppliedResizePayload{
            .revision = try decimal(allocator, applied.revision),
            .readback = wireWindow(applied.readback),
            .orderedAt = try decimal(allocator, applied.orderedAt),
        }, .{});
        if (response.len > generated.limits.control_json_bytes) return error.ResizeResponseTooLarge;
        return .{ .payload = response };
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
        // A .pending reservation means an earlier attempt reserved this key
        // and died before committing, so the kill sequence below RE-EXECUTES
        // against the recorded child identity. That is safe against PID reuse
        // only because process_inspector re-verifies the recorded start token
        // before any signal leaves this process (collectTree's root check,
        // rootEvidence, and revalidate): a reused PID fails the token check,
        // narrows the verified tree to empty, and is never signaled. The
        // "pending termination re-execution" test below pins that guard.
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
        const child_start_token = process_inspector.StartToken.parse(child.startToken) catch {
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
                .output = .{
                    .retainedStart = record.output.retainedStart,
                    .retainedEndExclusive = record.output.retainedEndExclusive,
                    .closed = true,
                },
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
                    .output = .{
                        .retainedStart = record.output.retainedStart,
                        .retainedEndExclusive = record.output.retainedEndExclusive,
                        .closed = true,
                    },
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
    /// Only `create` launches, so a controller assembled purely to inspect,
    /// list or terminate is not obliged to carry a host it cannot use.
    host: ?neutral_host.Host = null,

    /// Frozen `create`. The request payload is exactly the neutral create
    /// request shape, so it parses directly and an unrecognised field is a
    /// rejection rather than a silently dropped one. The response is the
    /// document the ledger committed, which is what keeps a first create and
    /// its replay from differing.
    pub fn create(self: *Controller, payload: []const u8) ![]u8 {
        const host = self.host orelse return error.CreateHostUnavailable;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        var parsed = try std.json.parseFromSlice(
            neutral_host.CreateRequest,
            allocator,
            payload,
            .{},
        );
        defer parsed.deinit();
        const response = try neutral_host.createDocument(
            self.allocator,
            allocator,
            self.registry,
            host,
            parsed.value,
        );
        if (response.len > generated.limits.control_json_bytes) {
            self.allocator.free(response);
            return error.CreateResponseTooLarge;
        }
        return response;
    }

    /// Frozen `resize`. The controller does not decide the outcome — it carries
    /// the request to the host that owns the terminal and returns what the host
    /// committed. An unreachable host is `unknown`: the caller learns the
    /// resize was not evidenced, never that it was applied or refused.
    pub fn resize(self: *Controller, payload: []const u8) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        const request = try std.json.parseFromSliceLeaky(ResizeRequest, allocator, payload, .{});
        if (request.schemaVersion != 1) return error.InvalidResizeRequest;
        _ = self.registry.get(request.session) orelse return error.SessionNotFound;

        const committed = blk: {
            var client = self.registry.connect(request.session) catch |err| {
                // Local allocation failure is not host evidence. Reporting it
                // as an unreachable host would tell the caller something about
                // the SESSION that only happened inside this process --
                // the same distinction Controller.inspect makes.
                if (err == error.OutOfMemory) return err;
                break :blk null;
            };
            defer client.deinit();
            var response = client.call(
                self.allocator,
                .resize,
                request.idempotencyKey,
                payload,
            ) catch |err| {
                if (err == error.OutOfMemory) return err;
                break :blk null;
            };
            defer response.deinit();
            if (!response.accepted) break :blk null;
            break :blk try self.allocator.dupe(u8, response.payload);
        };
        if (committed) |response| {
            if (response.len > generated.limits.control_json_bytes) {
                self.allocator.free(response);
                return error.ResizeResponseTooLarge;
            }
            return response;
        }
        return std.json.Stringify.valueAlloc(self.allocator, WireUnknownResizePayload{
            .diagnostic = "neutral-host-control-unavailable",
        }, .{});
    }

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
        return self.callInspect(self.allocator, record, true) catch |err| {
            // A degraded fallback is evidence that the HOST could not be
            // reached. Local allocation failure is not host evidence:
            // propagate it rather than committing a degraded inspection as if
            // the host were gone.
            if (err == error.OutOfMemory) return err;
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
        // A .pending reservation here must NOT re-execute the kill sequence:
        // the unreachable host may already have signaled the recorded child,
        // and the recorded PID may since have been reused by an unrelated
        // process. The controller commits durable evidence instead; the only
        // re-execution path is the host-side one above, which is guarded by
        // process_inspector's start-token revalidation before any signal.
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
