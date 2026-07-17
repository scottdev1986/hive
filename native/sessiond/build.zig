const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const generated = b.createModule(.{
        .root_source_file = b.path("../../workspace/Tests/WorkspaceCoreTests/Fixtures/session_protocol.generated.zig"),
        .target = target,
        .optimize = optimize,
    });

    const test_module = b.createModule(.{
        .root_source_file = b.path("src/protocol.zig"),
        .target = target,
        .optimize = optimize,
    });
    test_module.addImport("session_protocol_generated", generated);

    const test_step = b.step("test", "Run hive-sessiond tests");
    const protocol_tests = b.addTest(.{ .root_module = test_module });
    const run_protocol_tests = b.addRunArtifact(protocol_tests);
    test_step.dependOn(&run_protocol_tests.step);

    const broker_module = b.createModule(.{
        .root_source_file = b.path("src/broker.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    broker_module.addImport("session_protocol_generated", generated);
    broker_module.addImport("protocol", test_module);
    const broker_tests = b.addTest(.{ .root_module = broker_module });
    const run_broker_tests = b.addRunArtifact(broker_tests);
    test_step.dependOn(&run_broker_tests.step);

    const stub_module = b.createModule(.{
        .root_source_file = b.path("test/stub_host.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    stub_module.addImport("broker", broker_module);
    const stub_tests = b.addTest(.{ .root_module = stub_module });
    const run_stub_tests = b.addRunArtifact(stub_tests);
    test_step.dependOn(&run_stub_tests.step);

    const probe_module = b.createModule(.{
        .root_source_file = b.path("src/identity_probe.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    probe_module.addImport("broker", broker_module);
    const probe = b.addExecutable(.{
        .name = "sessiond-identity-probe",
        .root_module = probe_module,
    });
    const install_probe = b.addInstallArtifact(probe, .{});
    const probe_step = b.step("identity-probe", "Build the daemon identity parity probe");
    probe_step.dependOn(&install_probe.step);

    const executable_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    executable_module.addImport("broker", broker_module);
    const executable = b.addExecutable(.{
        .name = "hive-sessiond",
        .root_module = executable_module,
    });
    b.installArtifact(executable);
}
