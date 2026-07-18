const std = @import("std");
const neutral_host = @import("neutral_host");
const protocol = @import("protocol");
const generated = @import("session_protocol_generated");

pub fn main() !void {
    var debug_allocator: std.heap.DebugAllocator(.{}) = .init;
    defer _ = debug_allocator.deinit();
    const allocator = debug_allocator.allocator();
    try neutral_host.proveLiveLifecycle(allocator);

    // Bind the two suites. neutral_host stays project-neutral and cannot see
    // the Hive wire schema; this layer imports both, so the create results the
    // host actually commits are validated against the schema generated from
    // src/schemas/session-protocol.ts. Without this the native side can be
    // green against its own shapes while disagreeing with the wire.
    const documents = try neutral_host.proveCreateResultDocuments(allocator);
    defer documents.deinit(allocator);
    for ([_][]const u8{ documents.running, documents.refused }) |document| {
        if (!protocol.validateControlPayload(
            allocator,
            generated.wire_schema.terminal_host_create_result,
            document,
        )) return error.CreateResultViolatesWireSchema;
    }
}
