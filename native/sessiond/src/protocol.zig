const std = @import("std");
const generated = @import("session_protocol_generated");

test {
    std.testing.refAllDecls(@This());
}

pub const WireError = generated.wire_error;

pub const Failure = struct {
    code: WireError,
    close_connection: bool,
    request_id: u64 = 0,
};

pub const Header = struct {
    minor: u8,
    type_code: u16,
    flags: u16,
    payload_length: u32,
    request_id: u64,
    stream_seq: u64,
};

pub const HeaderResult = union(enum) {
    header: Header,
    ignored_optional: Header,
    failure: Failure,
};

pub const Frame = struct {
    header: Header,
    payload: []u8,

    pub fn deinit(self: Frame, allocator: std.mem.Allocator) void {
        allocator.free(self.payload);
    }
};

pub const ReadResult = union(enum) {
    frame: Frame,
    ignored_optional: Header,
    failure: Failure,
};

const major_offset = generated.frame_magic.len;
const minor_offset = major_offset + @sizeOf(u8);
const type_offset = minor_offset + @sizeOf(u8);
const flags_offset = type_offset + @sizeOf(u16);
const reserved_offset = flags_offset + @sizeOf(u16);
const payload_length_offset = reserved_offset + @sizeOf(u16);
const request_id_offset = payload_length_offset + @sizeOf(u32);
const stream_seq_offset = request_id_offset + @sizeOf(u64);

comptime {
    if (stream_seq_offset + @sizeOf(u64) != generated.frame_header_bytes)
        @compileError("generated frame header width is inconsistent");
}

fn malformed(request_id: u64) HeaderResult {
    return .{ .failure = .{
        .code = .malformed_frame,
        .close_connection = true,
        .request_id = request_id,
    } };
}

fn knownType(type_code: u16) bool {
    return switch (type_code) {
        generated.frame_type.hello,
        generated.frame_type.welcome,
        generated.frame_type.@"error",
        generated.frame_type.ping,
        generated.frame_type.pong,
        generated.frame_type.create_begin,
        generated.frame_type.create_input,
        generated.frame_type.create_commit,
        generated.frame_type.created,
        generated.frame_type.list,
        generated.frame_type.listed,
        generated.frame_type.inspect,
        generated.frame_type.inspected,
        generated.frame_type.terminate,
        generated.frame_type.terminated,
        generated.frame_type.visibility_renew,
        generated.frame_type.renewed,
        generated.frame_type.input_orphan_discard,
        generated.frame_type.orphan_discarded,
        generated.frame_type.attach_request,
        generated.frame_type.attach_grant,
        generated.frame_type.host_attach,
        generated.frame_type.snapshot_begin,
        generated.frame_type.snapshot_bytes,
        generated.frame_type.output,
        generated.frame_type.applied,
        generated.frame_type.resize,
        generated.frame_type.detach,
        generated.frame_type.event,
        generated.frame_type.claim_acquire,
        generated.frame_type.claim_result,
        generated.frame_type.human_input,
        generated.frame_type.claim_release,
        generated.frame_type.gesture_input,
        generated.frame_type.input_submit,
        generated.frame_type.automation_begin,
        generated.frame_type.automation_chunk,
        generated.frame_type.automation_commit,
        generated.frame_type.automation_result,
        generated.frame_type.automation_cancel,
        generated.frame_type.host_register,
        generated.frame_type.host_adopt,
        generated.frame_type.grant_register,
        => true,
        else => false,
    };
}

fn rawByteType(type_code: u16) bool {
    return switch (type_code) {
        generated.frame_type.create_input,
        generated.frame_type.snapshot_bytes,
        generated.frame_type.output,
        generated.frame_type.human_input,
        generated.frame_type.automation_chunk,
        => true,
        else => false,
    };
}

fn unsolicitedType(type_code: u16) bool {
    return type_code == generated.frame_type.event or type_code == generated.frame_type.output;
}

pub fn validateHeaderForRange(
    bytes: *const [generated.frame_header_bytes]u8,
    min_minor: u8,
    max_minor: u8,
) HeaderResult {
    if (!std.mem.eql(u8, bytes[0..generated.frame_magic.len], generated.frame_magic))
        return malformed(0);

    const type_code = std.mem.readInt(u16, bytes[type_offset..flags_offset], .big);
    const flags = std.mem.readInt(u16, bytes[flags_offset..reserved_offset], .big);
    const reserved = std.mem.readInt(u16, bytes[reserved_offset..payload_length_offset], .big);
    const payload_length = std.mem.readInt(u32, bytes[payload_length_offset..request_id_offset], .big);
    const request_id = std.mem.readInt(u64, bytes[request_id_offset..stream_seq_offset], .big);
    const stream_seq = std.mem.readInt(u64, bytes[stream_seq_offset..generated.frame_header_bytes], .big);

    if (bytes[major_offset] != generated.protocol_major) {
        return .{ .failure = .{
            .code = .protocol_mismatch,
            .close_connection = true,
            .request_id = request_id,
        } };
    }
    if (bytes[minor_offset] < min_minor or bytes[minor_offset] > max_minor) {
        return .{ .failure = .{
            .code = .protocol_mismatch,
            .close_connection = true,
            .request_id = request_id,
        } };
    }

    if (reserved != 0 or flags & ~generated.frame_allowed_flags != 0) return malformed(request_id);

    const header: Header = .{
        .minor = bytes[minor_offset],
        .type_code = type_code,
        .flags = flags,
        .payload_length = payload_length,
        .request_id = request_id,
        .stream_seq = stream_seq,
    };

    if (!knownType(type_code)) {
        if (payload_length > generated.limits.control_json_bytes) {
            return .{ .failure = .{
                .code = .frame_too_large,
                .close_connection = true,
                .request_id = request_id,
            } };
        }
        if (stream_seq != 0) return malformed(request_id);
        if (type_code & generated.frame_optional_type_bit != 0)
            return .{ .ignored_optional = header };
        if (request_id == 0) return malformed(request_id);
        return .{ .failure = .{
            .code = .unsupported_frame,
            .close_connection = false,
            .request_id = request_id,
        } };
    }

    const cap: usize = if (rawByteType(type_code))
        generated.limits.stream_chunk_bytes
    else
        generated.limits.control_json_bytes;
    if (payload_length > cap) {
        return .{ .failure = .{
            .code = .frame_too_large,
            .close_connection = true,
            .request_id = request_id,
        } };
    }

    if (!rawByteType(type_code) and stream_seq != 0) return malformed(request_id);
    if (flags & generated.frame_flag.response != 0 and request_id == 0) return malformed(request_id);
    if (unsolicitedType(type_code)) {
        if (request_id != 0) return malformed(request_id);
    } else if (request_id == 0) return malformed(request_id);

    return .{ .header = header };
}

pub fn validateHeader(bytes: *const [generated.frame_header_bytes]u8) HeaderResult {
    return validateHeaderForRange(bytes, generated.protocol_min_minor, generated.protocol_max_minor);
}

pub fn minorSupported(minor: u8) bool {
    return minor >= generated.protocol_min_minor and minor <= generated.protocol_max_minor;
}

pub fn encodeHeader(header: Header) ?[generated.frame_header_bytes]u8 {
    var bytes: [generated.frame_header_bytes]u8 = @splat(0);
    @memcpy(bytes[0..generated.frame_magic.len], generated.frame_magic);
    bytes[major_offset] = generated.protocol_major;
    bytes[minor_offset] = header.minor;
    std.mem.writeInt(u16, bytes[type_offset..flags_offset], header.type_code, .big);
    std.mem.writeInt(u16, bytes[flags_offset..reserved_offset], header.flags, .big);
    std.mem.writeInt(u32, bytes[payload_length_offset..request_id_offset], header.payload_length, .big);
    std.mem.writeInt(u64, bytes[request_id_offset..stream_seq_offset], header.request_id, .big);
    std.mem.writeInt(u64, bytes[stream_seq_offset..generated.frame_header_bytes], header.stream_seq, .big);
    return switch (validateHeader(&bytes)) {
        .header => bytes,
        else => null,
    };
}

fn discard(reader: anytype, count: usize) !void {
    var remaining = count;
    var scratch: [4096]u8 = undefined;
    while (remaining != 0) {
        const amount = @min(remaining, scratch.len);
        try reader.readNoEof(scratch[0..amount]);
        remaining -= amount;
    }
}

/// Reads exactly one fixed header, validates it, and only then allocates.
/// Validation failures consume no payload and never scan for a later magic.
pub fn readFrameForRange(
    allocator: std.mem.Allocator,
    reader: anytype,
    min_minor: u8,
    max_minor: u8,
) !ReadResult {
    var storage: [generated.frame_header_bytes]u8 = undefined;
    reader.readNoEof(&storage) catch {
        return .{ .failure = .{ .code = .malformed_frame, .close_connection = true } };
    };

    return switch (validateHeaderForRange(&storage, min_minor, max_minor)) {
        .failure => |failure| blk: {
            if (!failure.close_connection and failure.request_id != 0) {
                discard(reader, std.mem.readInt(
                    u32,
                    storage[payload_length_offset..request_id_offset],
                    .big,
                )) catch {
                    break :blk .{ .failure = .{ .code = .malformed_frame, .close_connection = true } };
                };
            }
            break :blk .{ .failure = failure };
        },
        .ignored_optional => |header| blk: {
            discard(reader, header.payload_length) catch {
                break :blk .{ .failure = .{ .code = .malformed_frame, .close_connection = true } };
            };
            break :blk .{ .ignored_optional = header };
        },
        .header => |header| blk: {
            const payload = try allocator.alloc(u8, header.payload_length);
            errdefer allocator.free(payload);
            reader.readNoEof(payload) catch {
                allocator.free(payload);
                break :blk .{ .failure = .{ .code = .malformed_frame, .close_connection = true } };
            };
            break :blk .{ .frame = .{ .header = header, .payload = payload } };
        },
    };
}

pub fn readFrame(allocator: std.mem.Allocator, reader: anytype) !ReadResult {
    return readFrameForRange(
        allocator,
        reader,
        generated.protocol_min_minor,
        generated.protocol_max_minor,
    );
}

pub fn writeFrame(writer: anytype, header: Header, payload: []const u8) !void {
    if (payload.len != header.payload_length) return error.PayloadLengthMismatch;
    const encoded = encodeHeader(header) orelse return error.InvalidHeader;
    try writer.writeAll(&encoded);
    try writer.writeAll(payload);
}

pub const Handshake = struct {
    state: enum { expect_hello, established, closed } = .expect_hello,

    pub fn accept(self: *Handshake, header: Header) ?Failure {
        if (self.state == .closed) return .{ .code = .malformed_frame, .close_connection = true };
        if (self.state == .expect_hello) {
            if (header.type_code != generated.frame_type.hello or
                header.flags & generated.frame_flag.response != 0)
            {
                self.state = .closed;
                return .{ .code = .malformed_frame, .close_connection = true };
            }
            self.state = .established;
        }
        return null;
    }
};

pub const Liveness = struct {
    last_activity_ns: u64,
    unanswered_pings: u8 = 0,

    pub fn pingDue(self: Liveness, now_ns: u64) bool {
        const interval = generated.limits.connection_ping_interval_ms * std.time.ns_per_ms;
        return now_ns >= self.last_activity_ns and now_ns - self.last_activity_ns >= interval;
    }

    pub fn sentPing(self: *Liveness, now_ns: u64) void {
        self.last_activity_ns = now_ns;
        self.unanswered_pings +|= 1;
    }

    pub fn receivedPong(self: *Liveness, now_ns: u64) void {
        self.last_activity_ns = now_ns;
        self.unanswered_pings = 0;
    }

    pub fn shouldDetach(self: Liveness) bool {
        return self.unanswered_pings >= generated.limits.missed_pong_intervals;
    }
};

pub fn encodePingPong(storage: []u8, mono_nanos: u64) ![]const u8 {
    return std.fmt.bufPrint(storage, "{{\"schemaVersion\":1,\"monoNanos\":\"{d}\"}}", .{mono_nanos});
}

pub fn decodePingPong(allocator: std.mem.Allocator, payload: []const u8) ?u64 {
    if (!validateControlPayload(allocator, generated.wire_schema.ping_pong_payload, payload)) return null;
    const PingPongPayload = struct { schemaVersion: u8, monoNanos: []const u8 };
    var parsed = std.json.parseFromSlice(PingPongPayload, allocator, payload, .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value.schemaVersion != 1) return null;
    return std.fmt.parseInt(u64, parsed.value.monoNanos, 10) catch null;
}

/// The ~325 KB schema fixture parses ONCE per process (broker and host are
/// separate processes — each caches its own tree) instead of on every frame
/// validation. The tree is read-only after parse; page_allocator is deliberate
/// because the cache is process-lifetime and never freed.
var schema_document: ?std.json.Parsed(std.json.Value) = null;
var schema_document_once = std.once(parseSchemaFixtureOnce);

fn parseSchemaFixtureOnce() void {
    schema_document = std.json.parseFromSlice(
        std.json.Value,
        std.heap.page_allocator,
        generated.schema_fixture,
        .{},
    ) catch null;
}

pub fn validateControlPayload(
    allocator: std.mem.Allocator,
    schema_name: []const u8,
    payload: []const u8,
) bool {
    if (payload.len > generated.limits.control_json_bytes or !std.unicode.utf8ValidateSlice(payload))
        return false;

    schema_document_once.call();
    const document = &(schema_document orelse return false);
    var value = std.json.parseFromSlice(std.json.Value, allocator, payload, .{}) catch return false;
    defer value.deinit();

    const schemas = objectField(document.value, "schemas") orelse return false;
    const schema = objectField(schemas, schema_name) orelse return false;
    return validateSchema(value.value, schema);
}

fn objectField(value: std.json.Value, name: []const u8) ?std.json.Value {
    return switch (value) {
        .object => |object| object.get(name),
        else => null,
    };
}

fn validateSchema(value: std.json.Value, schema: std.json.Value) bool {
    const object = switch (schema) {
        .object => |object| object,
        else => return false,
    };

    if (object.get("anyOf")) |branches| {
        if (!someBranch(value, branches, false)) return false;
    }
    if (object.get("oneOf")) |branches| {
        if (!someBranch(value, branches, true)) return false;
    }
    if (object.get("allOf")) |branches| switch (branches) {
        .array => |array| for (array.items) |branch| {
            if (!validateSchema(value, branch)) return false;
        },
        else => return false,
    };
    if (object.get("const")) |constant| {
        if (!jsonEqual(value, constant)) return false;
    }
    if (object.get("enum")) |choices| {
        const array = switch (choices) {
            .array => |array| array,
            else => return false,
        };
        var found = false;
        for (array.items) |choice| found = found or jsonEqual(value, choice);
        if (!found) return false;
    }

    if (object.get("type")) |kind_value| {
        const kind = switch (kind_value) {
            .string => |string| string,
            else => return false,
        };
        if (!matchesType(value, kind)) return false;
    }

    switch (value) {
        .string => |string| if (!validateString(string, object)) return false,
        .integer, .float, .number_string => if (!validateNumber(value, object)) return false,
        .array => |array| {
            var prefix_len: usize = 0;
            if (object.get("prefixItems")) |prefix_value| {
                const prefix = switch (prefix_value) {
                    .array => |items| items,
                    else => return false,
                };
                if (array.items.len < prefix.items.len) return false;
                prefix_len = prefix.items.len;
                for (prefix.items, 0..) |item_schema, index| {
                    if (!validateSchema(array.items[index], item_schema)) return false;
                }
            }
            if (object.get("items")) |item_schema| switch (item_schema) {
                .bool => |allowed| if (!allowed and array.items.len > prefix_len) return false,
                .object => for (array.items[prefix_len..]) |item| {
                    if (!validateSchema(item, item_schema)) return false;
                },
                else => return false,
            };
            if (object.get("minItems")) |minimum|
                if (array.items.len < (numberAsUsize(minimum) orelse return false)) return false;
            if (object.get("maxItems")) |maximum|
                if (array.items.len > (numberAsUsize(maximum) orelse return false)) return false;
        },
        .object => |value_object| {
            const properties = object.get("properties");
            const required = object.get("required");
            if (required) |required_value| switch (required_value) {
                .array => |array| for (array.items) |item| switch (item) {
                    .string => |name| if (!value_object.contains(name)) return false,
                    else => return false,
                },
                else => return false,
            };
            if (properties) |property_value| {
                const property_map = switch (property_value) {
                    .object => |map| map,
                    else => return false,
                };
                var iterator = value_object.iterator();
                while (iterator.next()) |entry| {
                    if (property_map.get(entry.key_ptr.*)) |property_schema| {
                        if (!validateSchema(entry.value_ptr.*, property_schema)) return false;
                    } else if (object.get("additionalProperties")) |additional| switch (additional) {
                        .bool => |allowed| if (!allowed) return false,
                        .object => if (!validateSchema(entry.value_ptr.*, additional)) return false,
                        else => return false,
                    };
                }
            }
            if (object.get("x-hive-ordered-minor-range")) |ordered| if (ordered == .bool and ordered.bool) {
                const minimum = value_object.get("minMinor") orelse return false;
                const maximum = value_object.get("maxMinor") orelse return false;
                if ((numberAsF64(minimum) orelse return false) > (numberAsF64(maximum) orelse return false))
                    return false;
            };
            if (object.get("x-hive-max-active-cells")) |maximum| {
                const columns = numberAsUsize(value_object.get("columns") orelse return false) orelse return false;
                const rows = numberAsUsize(value_object.get("rows") orelse return false) orelse return false;
                const cells = std.math.mul(usize, columns, rows) catch return false;
                if (cells > (numberAsUsize(maximum) orelse return false)) return false;
            }
            if (object.get("x-hive-exactly-one-of")) |field_names| {
                const names = switch (field_names) {
                    .array => |items| items,
                    else => return false,
                };
                var present: usize = 0;
                for (names.items) |name_value| {
                    const name = switch (name_value) {
                        .string => |item| item,
                        else => return false,
                    };
                    if (value_object.get(name)) |field| if (field != .null) {
                        present += 1;
                    };
                }
                if (present != 1) return false;
            }
            if (object.get("x-hive-positive-open-terminal-revision")) |field_name| {
                const name = switch (field_name) {
                    .string => |item| item,
                    else => return false,
                };
                const binding = value_object.get(name) orelse return false;
                const binding_object = switch (binding) {
                    .object => |item| item,
                    else => return false,
                };
                const revision = binding_object.get("openTerminalRevision") orelse return false;
                const revision_text = switch (revision) {
                    .string => |item| item,
                    else => return false,
                };
                if ((std.fmt.parseInt(u64, revision_text, 10) catch return false) == 0) return false;
            }
        },
        else => {},
    }
    return true;
}

fn someBranch(value: std.json.Value, branches: std.json.Value, exactly_one: bool) bool {
    const array = switch (branches) {
        .array => |array| array,
        else => return false,
    };
    var matches: usize = 0;
    for (array.items) |branch| if (validateSchema(value, branch)) {
        matches += 1;
    };
    return if (exactly_one) matches == 1 else matches != 0;
}

fn matchesType(value: std.json.Value, kind: []const u8) bool {
    if (std.mem.eql(u8, kind, "null")) return value == .null;
    if (std.mem.eql(u8, kind, "boolean")) return value == .bool;
    if (std.mem.eql(u8, kind, "string")) return value == .string;
    if (std.mem.eql(u8, kind, "array")) return value == .array;
    if (std.mem.eql(u8, kind, "object")) return value == .object;
    if (std.mem.eql(u8, kind, "integer")) return value == .integer;
    if (std.mem.eql(u8, kind, "number")) return value == .integer or value == .float;
    return false;
}

fn validateString(string: []const u8, schema: std.json.ObjectMap) bool {
    const codepoints = std.unicode.utf8CountCodepoints(string) catch return false;
    if (schema.get("minLength")) |minimum| if (codepoints < (numberAsUsize(minimum) orelse return false)) return false;
    if (schema.get("maxLength")) |maximum| if (codepoints > (numberAsUsize(maximum) orelse return false)) return false;
    // date-time is the only format whose check is a strict subset of its Zod patterns;
    // only it may skip an unknown pattern. hive-uint64-decimal is weaker than its patterns
    // (parseInt accepts "0"/"007"), so an unknown uint64 pattern must never skip.
    var date_time_format = false;
    if (schema.get("format")) |format_value| switch (format_value) {
        .string => |format| {
            if (!knownStringFormat(format)) return false;
            if (std.mem.eql(u8, format, "hive-uint64-decimal")) {
                _ = std.fmt.parseInt(u64, string, 10) catch return false;
            } else if (std.mem.eql(u8, format, "date-time")) {
                if (!rfc3339Milliseconds(string)) return false;
                date_time_format = true;
            } else if (std.mem.eql(u8, format, "uuid")) {
                if (!standardUuid(string)) return false;
            } else return false;
        },
        else => return false,
    };
    if (schema.get("pattern")) |pattern_value| {
        const pattern = switch (pattern_value) {
            .string => |pattern| pattern,
            else => return false,
        };
        if (matchesKnownPattern(string, pattern)) |matched| {
            if (!matched) return false;
        } else if (!date_time_format) return false;
    }
    return true;
}

fn knownStringFormat(format: []const u8) bool {
    return std.mem.eql(u8, format, "hive-uint64-decimal") or
        std.mem.eql(u8, format, "date-time") or
        std.mem.eql(u8, format, "uuid");
}

/// Whether the validator recognizes this pattern (whitelist hit), or may skip it
/// only under format date-time (narrow skip rule).
fn stringConstraintRecognized(format: ?[]const u8, pattern: ?[]const u8) bool {
    if (format) |name| if (!knownStringFormat(name)) return false;
    if (pattern) |value| {
        if (matchesKnownPattern("", value) != null) return true;
        if (format) |name| if (std.mem.eql(u8, name, "date-time")) return true;
        return false;
    }
    return true;
}

fn validateNumber(value: std.json.Value, schema: std.json.ObjectMap) bool {
    const number = numberAsF64(value) orelse return false;
    if (schema.get("minimum")) |minimum| if (number < (numberAsF64(minimum) orelse return false)) return false;
    if (schema.get("maximum")) |maximum| if (number > (numberAsF64(maximum) orelse return false)) return false;
    if (schema.get("exclusiveMinimum")) |minimum| if (number <= (numberAsF64(minimum) orelse return false)) return false;
    if (schema.get("exclusiveMaximum")) |maximum| if (number >= (numberAsF64(maximum) orelse return false)) return false;
    return true;
}

fn numberAsF64(value: std.json.Value) ?f64 {
    return switch (value) {
        .integer => |integer| @floatFromInt(integer),
        .float => |float| float,
        .number_string => |string| std.fmt.parseFloat(f64, string) catch null,
        else => null,
    };
}

fn numberAsUsize(value: std.json.Value) ?usize {
    return switch (value) {
        .integer => |integer| if (integer >= 0) @intCast(integer) else null,
        else => null,
    };
}

fn jsonEqual(left: std.json.Value, right: std.json.Value) bool {
    if (std.meta.activeTag(left) != std.meta.activeTag(right)) return false;
    return switch (left) {
        .null => true,
        .bool => |value| value == right.bool,
        .integer => |value| value == right.integer,
        .float => |value| value == right.float,
        .number_string => |value| std.mem.eql(u8, value, right.number_string),
        .string => |value| std.mem.eql(u8, value, right.string),
        .array => |array| blk: {
            if (array.items.len != right.array.items.len) break :blk false;
            for (array.items, right.array.items) |a, b| if (!jsonEqual(a, b)) break :blk false;
            break :blk true;
        },
        .object => |object| blk: {
            if (object.count() != right.object.count()) break :blk false;
            var iterator = object.iterator();
            while (iterator.next()) |entry| {
                const other = right.object.get(entry.key_ptr.*) orelse break :blk false;
                if (!jsonEqual(entry.value_ptr.*, other)) break :blk false;
            }
            break :blk true;
        },
    };
}

/// Returns null when the pattern is not in the native whitelist.
fn matchesKnownPattern(string: []const u8, pattern: []const u8) ?bool {
    if (std.mem.eql(u8, pattern, "^[0-9a-f]{64}$")) return lowercaseHex(string, 64);
    if (std.mem.eql(u8, pattern, "^sha256:[0-9a-f]{64}$"))
        return std.mem.startsWith(u8, string, "sha256:") and lowercaseHex(string[7..], 64);
    if (std.mem.eql(u8, pattern, "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"))
        return standardBase64(string);
    if (std.mem.indexOf(u8, pattern, "[0-9a-f]{8}-[0-9a-f]{4}-7") != null) {
        const separator = std.mem.indexOfScalar(u8, pattern, '_') orelse return false;
        if (separator <= 1) return false;
        const prefix = pattern[1 .. separator + 1];
        return taggedUuidV7(string, prefix);
    }
    // Zod z.string().uuid() pattern (unprefixed, versions 1-8 plus nil/max).
    if (std.mem.indexOf(u8, pattern, "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8]") != null)
        return standardUuid(string);
    if (std.mem.eql(u8, pattern, "^\\/.*")) return std.mem.startsWith(u8, string, "/");
    // Non-negative decimal uint64 (allows 0). From DecimalUint64Schema.
    if (std.mem.startsWith(u8, pattern, "^(?:0|[1-9]")) return std.fmt.parseInt(u64, string, 10) catch null != null;
    // Positive decimal uint64 (rejects 0 / leading zeros). From PositiveDecimalUint64Schema (status spine).
    if (std.mem.eql(u8, pattern, "^(?:[1-9][0-9]{0,19})$")) {
        if (string.len == 0 or string[0] == '0') return false;
        return std.fmt.parseInt(u64, string, 10) catch null != null;
    }
    if (std.mem.indexOf(u8, pattern, "\\d{3}(?:Z))$") != null) return rfc3339Milliseconds(string);
    return null;
}

fn standardBase64(string: []const u8) bool {
    if (string.len % 4 != 0) return false;
    var index: usize = 0;
    while (index < string.len) : (index += 4) {
        const final = index + 4 == string.len;
        const block = string[index .. index + 4];
        if (!base64Byte(block[0]) or !base64Byte(block[1])) return false;
        if (block[2] == '=') {
            if (!final or block[3] != '=') return false;
        } else if (!base64Byte(block[2])) return false;
        if (block[3] == '=') {
            if (!final) return false;
        } else if (!base64Byte(block[3])) return false;
    }
    return true;
}

fn base64Byte(byte: u8) bool {
    return std.ascii.isAlphanumeric(byte) or byte == '+' or byte == '/';
}

fn standardUuid(string: []const u8) bool {
    if (std.mem.eql(u8, string, "00000000-0000-0000-0000-000000000000")) return true;
    if (std.mem.eql(u8, string, "ffffffff-ffff-ffff-ffff-ffffffffffff")) return true;
    if (string.len != 36) return false;
    for (string, 0..) |byte, index| {
        if (index == 8 or index == 13 or index == 18 or index == 23) {
            if (byte != '-') return false;
        } else if (!std.ascii.isHex(byte)) return false;
    }
    const version = string[14];
    if (version < '1' or version > '8') return false;
    const variant = string[19];
    const variant_lower = std.ascii.toLower(variant);
    return variant_lower == '8' or variant_lower == '9' or variant_lower == 'a' or variant_lower == 'b';
}

fn lowercaseHex(string: []const u8, expected: usize) bool {
    if (string.len != expected) return false;
    for (string) |byte| if (!std.ascii.isDigit(byte) and !(byte >= 'a' and byte <= 'f')) return false;
    return true;
}

fn sessionId(string: []const u8) bool {
    return taggedUuidV7(string, "ses_");
}

fn taggedUuidV7(string: []const u8, prefix: []const u8) bool {
    if (string.len != prefix.len + 36 or !std.mem.startsWith(u8, string, prefix)) return false;
    const uuid = string[prefix.len..];
    for (uuid, 0..) |byte, index| {
        if (index == 8 or index == 13 or index == 18 or index == 23) {
            if (byte != '-') return false;
        } else if (!std.ascii.isDigit(byte) and !(byte >= 'a' and byte <= 'f')) return false;
    }
    return uuid[14] == '7' and std.mem.indexOfScalar(u8, "89ab", uuid[19]) != null;
}

pub fn validSessionId(string: []const u8) bool {
    return sessionId(string);
}

fn rfc3339Milliseconds(string: []const u8) bool {
    if (string.len != 24) return false;
    for (string, 0..) |byte, index| switch (index) {
        4, 7 => if (byte != '-') return false,
        10 => if (byte != 'T') return false,
        13, 16 => if (byte != ':') return false,
        19 => if (byte != '.') return false,
        23 => if (byte != 'Z') return false,
        else => if (!std.ascii.isDigit(byte)) return false,
    };
    const year = std.fmt.parseInt(u16, string[0..4], 10) catch return false;
    const month = std.fmt.parseInt(u8, string[5..7], 10) catch return false;
    const day = std.fmt.parseInt(u8, string[8..10], 10) catch return false;
    const hour = std.fmt.parseInt(u8, string[11..13], 10) catch return false;
    const minute = std.fmt.parseInt(u8, string[14..16], 10) catch return false;
    const second = std.fmt.parseInt(u8, string[17..19], 10) catch return false;
    if (month == 0 or month > 12 or day == 0 or hour > 23 or minute > 59 or second > 59)
        return false;
    const leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0);
    const days_in_month = [_]u8{ 31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    return day <= days_in_month[month - 1];
}

fn headerFor(type_code: u16, payload_length: u32, request_id: u64, stream_seq: u64) Header {
    return .{
        .minor = generated.protocol_minor,
        .type_code = type_code,
        .flags = 0,
        .payload_length = payload_length,
        .request_id = request_id,
        .stream_seq = stream_seq,
    };
}

test "fixed header round trip and strict semantics" {
    const hello = headerFor(generated.frame_type.hello, 12, 42, 0);
    const bytes = encodeHeader(hello) orelse return error.TestUnexpectedResult;
    const result = validateHeader(&bytes);
    try std.testing.expectEqualDeep(hello, result.header);

    var bad = bytes;
    bad[reserved_offset] = 1;
    try std.testing.expectEqual(WireError.malformed_frame, validateHeader(&bad).failure.code);
    bad = bytes;
    bad[flags_offset] = 0x10;
    try std.testing.expectEqual(WireError.malformed_frame, validateHeader(&bad).failure.code);

    bad = bytes;
    bad[major_offset] +%= 1;
    try std.testing.expectEqual(WireError.protocol_mismatch, validateHeader(&bad).failure.code);
    try std.testing.expectEqual(@as(u64, 42), validateHeader(&bad).failure.request_id);

    bad = bytes;
    std.mem.writeInt(
        u32,
        bad[payload_length_offset..request_id_offset],
        generated.limits.control_json_bytes + 1,
        .big,
    );
    try std.testing.expectEqual(WireError.frame_too_large, validateHeader(&bad).failure.code);
    try std.testing.expectEqual(@as(u64, 42), validateHeader(&bad).failure.request_id);
}

test "orphan discard request and response headers are supported" {
    for ([_]u16{
        generated.frame_type.input_orphan_discard,
        generated.frame_type.orphan_discarded,
    }) |type_code| {
        const header = headerFor(type_code, 0, 42, 0);
        const bytes = encodeHeader(header) orelse return error.TestUnexpectedResult;
        try std.testing.expectEqualDeep(header, validateHeader(&bytes).header);
    }
}

test "generated header corpus matches valid ignored and invalid outcomes" {
    const allocator = std.testing.allocator;
    var corpus = try std.json.parseFromSlice(std.json.Value, allocator, generated.wire_corpus_fixture, .{});
    defer corpus.deinit();
    const headers = objectField(corpus.value, "frameHeaders") orelse return error.TestUnexpectedResult;
    const valid = objectField(headers, "valid") orelse return error.TestUnexpectedResult;
    for (valid.array.items) |item| {
        const hex = objectField(item, "hex") orelse return error.TestUnexpectedResult;
        var storage: [generated.frame_header_bytes]u8 = undefined;
        _ = try std.fmt.hexToBytes(&storage, hex.string);
        try std.testing.expect(validateHeader(&storage) == .header);
    }
    const ignored = objectField(headers, "ignored") orelse return error.TestUnexpectedResult;
    for (ignored.array.items) |item| {
        const hex = objectField(item, "hex") orelse return error.TestUnexpectedResult;
        var storage: [generated.frame_header_bytes]u8 = undefined;
        _ = try std.fmt.hexToBytes(&storage, hex.string);
        try std.testing.expect(validateHeader(&storage) == .ignored_optional);
    }
    const invalid = objectField(headers, "invalid") orelse return error.TestUnexpectedResult;
    for (invalid.array.items) |item| {
        const hex = objectField(item, "hex") orelse return error.TestUnexpectedResult;
        const expected = objectField(item, "error") orelse return error.TestUnexpectedResult;
        var storage: [generated.frame_header_bytes]u8 = undefined;
        _ = try std.fmt.hexToBytes(&storage, hex.string);
        const result = validateHeader(&storage);
        const actual = @tagName(result.failure.code);
        var expected_lower: [64]u8 = undefined;
        const lowered = std.ascii.lowerString(&expected_lower, expected.string);
        try std.testing.expectEqualStrings(lowered, actual);
        try std.testing.expect(result.failure.close_connection or result.failure.code == .unsupported_frame);
    }
}

test "malformed input is not scanned for a later magic" {
    const valid = encodeHeader(headerFor(generated.frame_type.hello, 0, 7, 0)).?;
    var input: [generated.frame_header_bytes * 2]u8 = undefined;
    @memset(input[0..generated.frame_header_bytes], 0xff);
    @memcpy(input[generated.frame_header_bytes..], &valid);
    var stream = std.io.fixedBufferStream(&input);
    const result = try readFrame(std.testing.allocator, stream.reader());
    try std.testing.expectEqual(WireError.malformed_frame, result.failure.code);
    try std.testing.expectEqual(generated.frame_header_bytes, stream.pos);
}

test "unsupported required frame is consumed once and remains correlated" {
    var unknown = encodeHeader(headerFor(generated.frame_type.hello, 3, 33, 0)).?;
    std.mem.writeInt(u16, unknown[type_offset..flags_offset], 0x7ffe, .big);
    const following = encodeHeader(headerFor(generated.frame_type.ping, 0, 34, 0)).?;
    var input: [generated.frame_header_bytes * 2 + 3]u8 = undefined;
    @memcpy(input[0..generated.frame_header_bytes], &unknown);
    @memcpy(input[generated.frame_header_bytes .. generated.frame_header_bytes + 3], "abc");
    @memcpy(input[generated.frame_header_bytes + 3 ..], &following);
    var stream = std.io.fixedBufferStream(&input);
    const unsupported = try readFrame(std.testing.allocator, stream.reader());
    try std.testing.expectEqual(WireError.unsupported_frame, unsupported.failure.code);
    try std.testing.expectEqual(@as(u64, 33), unsupported.failure.request_id);
    try std.testing.expectEqual(generated.frame_header_bytes + 3, stream.pos);
    const next = try readFrame(std.testing.allocator, stream.reader());
    defer next.frame.deinit(std.testing.allocator);
    try std.testing.expectEqual(generated.frame_type.ping, next.frame.header.type_code);
}

test "header mutation failures never allocate before validation" {
    const valid = encodeHeader(headerFor(generated.frame_type.hello, 0, 1, 0)).?;
    var byte_index: usize = 0;
    while (byte_index < valid.len) : (byte_index += 1) {
        var mutated = valid;
        mutated[byte_index] ^= 0xff;
        const validation = validateHeader(&mutated);
        if (validation != .failure) continue;
        var stream = std.io.fixedBufferStream(&mutated);
        const read = try readFrame(std.testing.failing_allocator, stream.reader());
        try std.testing.expectEqual(validation.failure.code, read.failure.code);
        try std.testing.expectEqual(generated.frame_header_bytes, stream.pos);
    }
}

test "control JSON uses generated strict schemas" {
    const hello =
        \\{"schemaVersion":1,"clientRole":"viewer","buildId":"build","instanceId":"hive","protocol":{"major":1,"minMinor":0,"maxMinor":0},"grantToken":"token"}
    ;
    const claimed =
        \\{"schemaVersion":1,"clientRole":"viewer","buildId":"build","instanceId":"hive","protocol":{"major":1,"minMinor":0,"maxMinor":0},"grantToken":"token","authority":true}
    ;
    try std.testing.expect(validateControlPayload(std.testing.allocator, generated.wire_schema.hello_payload, hello));
    try std.testing.expect(!validateControlPayload(std.testing.allocator, generated.wire_schema.hello_payload, claimed));
}

test "schema fixture parses once and serves repeated validations" {
    const hello =
        \\{"schemaVersion":1,"clientRole":"viewer","buildId":"build","instanceId":"hive","protocol":{"major":1,"minMinor":0,"maxMinor":0},"grantToken":"token"}
    ;
    // First call populates the process-lifetime cache; later calls reuse it
    // with identical verdicts (the 325 KB fixture is not re-parsed per call).
    try std.testing.expect(validateControlPayload(std.testing.allocator, generated.wire_schema.hello_payload, hello));
    try std.testing.expect(schema_document != null);
    for (0..8) |_| {
        try std.testing.expect(validateControlPayload(std.testing.allocator, generated.wire_schema.hello_payload, hello));
        try std.testing.expect(!validateControlPayload(std.testing.allocator, generated.wire_schema.hello_payload, "{}"));
    }
}

test "common UTC timestamps reject impossible calendar values" {
    try std.testing.expect(rfc3339Milliseconds("2024-02-29T23:59:59.999Z"));
    try std.testing.expect(!rfc3339Milliseconds("2023-02-29T23:59:59.999Z"));
    try std.testing.expect(!rfc3339Milliseconds("2026-13-01T00:00:00.000Z"));
    try std.testing.expect(!rfc3339Milliseconds("2026-01-01T24:00:00.000Z"));
}

test "every generated control payload corpus case agrees with the canonical schema" {
    const allocator = std.testing.allocator;
    var corpus = try std.json.parseFromSlice(std.json.Value, allocator, generated.wire_corpus_fixture, .{});
    defer corpus.deinit();
    for ([_]struct { name: []const u8, expected: bool }{
        .{ .name = "valid", .expected = true },
        .{ .name = "invalid", .expected = false },
    }) |set| {
        const cases = objectField(corpus.value, set.name) orelse return error.TestUnexpectedResult;
        for (cases.array.items) |item| {
            const schema = objectField(item, "schema") orelse return error.TestUnexpectedResult;
            const value = objectField(item, "value") orelse return error.TestUnexpectedResult;
            const payload = try std.json.Stringify.valueAlloc(allocator, value, .{});
            defer allocator.free(payload);
            const actual = validateControlPayload(allocator, schema.string, payload);
            if (actual != set.expected) {
                const name = objectField(item, "name") orelse return error.TestUnexpectedResult;
                std.log.err("canonical payload corpus mismatch: {s}", .{name.string});
                return error.TestUnexpectedResult;
            }
        }
    }
}

test "every schema format and pattern is recognized by the native validator" {
    // Positive control for validator-vs-schema drift: a new Zod pattern that the
    // Zig whitelist does not know must fail here, not silently at corpus time.
    const allocator = std.testing.allocator;
    var document = try std.json.parseFromSlice(std.json.Value, allocator, generated.schema_fixture, .{});
    defer document.deinit();
    const schemas = objectField(document.value, "schemas") orelse return error.TestUnexpectedResult;
    try assertStringConstraintsRecognized(schemas);
}

fn assertStringConstraintsRecognized(value: std.json.Value) !void {
    switch (value) {
        .object => |object| {
            const format = blk: {
                if (object.get("format")) |format_value| switch (format_value) {
                    .string => |name| break :blk name,
                    else => return error.TestUnexpectedResult,
                };
                break :blk null;
            };
            const pattern = blk: {
                if (object.get("pattern")) |pattern_value| switch (pattern_value) {
                    .string => |text| break :blk text,
                    else => return error.TestUnexpectedResult,
                };
                break :blk null;
            };
            if (format != null or pattern != null) {
                if (!stringConstraintRecognized(format, pattern)) {
                    if (format) |name| std.log.err("unrecognized schema format: {s}", .{name});
                    if (pattern) |text| std.log.err("unrecognized schema pattern: {s}", .{text});
                    return error.TestUnexpectedResult;
                }
            }
            var iterator = object.iterator();
            while (iterator.next()) |entry| try assertStringConstraintsRecognized(entry.value_ptr.*);
        },
        .array => |array| for (array.items) |item| try assertStringConstraintsRecognized(item),
        else => {},
    }
}

test "PING PONG liveness detaches after generated missed interval limit" {
    var payload_storage: [96]u8 = undefined;
    const payload = try encodePingPong(&payload_storage, 123);
    try std.testing.expectEqual(@as(?u64, 123), decodePingPong(std.testing.allocator, payload));
    try std.testing.expectEqual(@as(?u64, null), decodePingPong(std.testing.allocator, "{\"schemaVersion\":1,\"monoNanos\":\"123\",\"wallTime\":\"claimed\"}"));
    var liveness: Liveness = .{ .last_activity_ns = 0 };
    const interval = generated.limits.connection_ping_interval_ms * std.time.ns_per_ms;
    try std.testing.expect(liveness.pingDue(interval));
    while (!liveness.shouldDetach()) liveness.sentPing(liveness.last_activity_ns + interval);
    try std.testing.expectEqual(generated.limits.missed_pong_intervals, liveness.unanswered_pings);
    liveness.receivedPong(liveness.last_activity_ns);
    try std.testing.expect(!liveness.shouldDetach());
}
