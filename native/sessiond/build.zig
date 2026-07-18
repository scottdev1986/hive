const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const ghostty = b.dependency("ghostty", .{
        .target = target,
        .optimize = optimize,
        .@"emit-lib-vt" = true,
        .@"emit-xcframework" = false,
    });
    const ghostty_vt = ghostty.artifact("ghostty-vt-static");

    const generated = b.createModule(.{
        .root_source_file = b.path("../../workspace/Tests/WorkspaceCoreTests/Fixtures/session_protocol.generated.zig"),
        .target = target,
        .optimize = optimize,
    });

    const boot_envelope_module = b.createModule(.{
        .root_source_file = b.path("src/boot_envelope.zig"),
        .target = target,
        .optimize = optimize,
    });
    boot_envelope_module.addImport("session_protocol_generated", generated);

    const test_module = b.createModule(.{
        .root_source_file = b.path("src/protocol.zig"),
        .target = target,
        .optimize = optimize,
    });
    test_module.addImport("session_protocol_generated", generated);

    const test_step = b.step("test", "Run hive-sessiond tests");
    const boot_envelope_tests = b.addTest(.{ .root_module = boot_envelope_module });
    const run_boot_envelope_tests = b.addRunArtifact(boot_envelope_tests);
    test_step.dependOn(&run_boot_envelope_tests.step);
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
    broker_module.addImport("boot_envelope", boot_envelope_module);
    const broker_tests = b.addTest(.{ .root_module = broker_module });
    const run_broker_tests = b.addRunArtifact(broker_tests);
    test_step.dependOn(&run_broker_tests.step);

    // WP4 Part A: standalone input arbiter + process inspector (no broker/PTY).
    const input_arbiter_module = b.createModule(.{
        .root_source_file = b.path("src/input_arbiter.zig"),
        .target = target,
        .optimize = optimize,
    });
    const input_arbiter_tests = b.addTest(.{ .root_module = input_arbiter_module });
    const run_input_arbiter_tests = b.addRunArtifact(input_arbiter_tests);
    test_step.dependOn(&run_input_arbiter_tests.step);

    const process_inspector_module = b.createModule(.{
        .root_source_file = b.path("src/process_inspector.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    const process_inspector_tests = b.addTest(.{ .root_module = process_inspector_module });
    const run_process_inspector_tests = b.addRunArtifact(process_inspector_tests);
    test_step.dependOn(&run_process_inspector_tests.step);

    // WP4-B Track γ: headless VT + journal/checkpoint (export-double testable pre-TG2).
    // Shared HVTCP001 fixture lives under native/tests/abi (C + Zig dual-source lock).
    const hvtcp001_fixture = b.createModule(.{
        .root_source_file = b.path("../tests/abi/hvtcp001_header.zig"),
        .target = target,
        .optimize = optimize,
    });
    const terminal_state_module = b.createModule(.{
        .root_source_file = b.path("src/terminal_state.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    terminal_state_module.addImport("session_protocol_generated", generated);
    terminal_state_module.addImport("hvtcp001_header", hvtcp001_fixture);
    const terminal_state_tests = b.addTest(.{ .root_module = terminal_state_module });
    const run_terminal_state_tests = b.addRunArtifact(terminal_state_tests);
    test_step.dependOn(&run_terminal_state_tests.step);

    // WP4-B Track β: PTY host leaf (integrates process_inspector for spawn snapshot).
    const pty_host_module = b.createModule(.{
        .root_source_file = b.path("src/pty_host.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    pty_host_module.addImport("process_inspector", process_inspector_module);
    const pty_host_tests = b.addTest(.{ .root_module = pty_host_module });
    // util (openpty) needs -lutil on some platforms; on macOS it's in libSystem.
    const run_pty_host_tests = b.addRunArtifact(pty_host_tests);
    test_step.dependOn(&run_pty_host_tests.step);

    const neutral_host_module = b.createModule(.{
        .root_source_file = b.path("src/neutral_host.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    neutral_host_module.addImport("pty_host", pty_host_module);
    neutral_host_module.addImport("process_inspector", process_inspector_module);
    const neutral_host_tests = b.addTest(.{ .root_module = neutral_host_module });
    const run_neutral_host_tests = b.addRunArtifact(neutral_host_tests);
    test_step.dependOn(&run_neutral_host_tests.step);
    const neutral_host_golden_module = b.createModule(.{
        .root_source_file = b.path("test/neutral-host-golden.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    neutral_host_golden_module.addImport("neutral_host", neutral_host_module);
    // The golden layer validates committed create results against the frozen
    // wire schema; the neutral module itself must not depend on either.
    neutral_host_golden_module.addImport("protocol", test_module);
    neutral_host_golden_module.addImport("session_protocol_generated", generated);
    const neutral_host_golden = b.addExecutable(.{
        .name = "sessiond-neutral-host-golden",
        .root_module = neutral_host_golden_module,
    });
    const run_neutral_host_golden = b.addRunArtifact(neutral_host_golden);
    test_step.dependOn(&run_neutral_host_golden.step);
    const neutral_host_proof_step = b.step(
        "neutral-host-proof",
        "Run the live neutral lifecycle/recovery proof",
    );
    neutral_host_proof_step.dependOn(&run_neutral_host_golden.step);

    const neutral_control_plane_module = b.createModule(.{
        .root_source_file = b.path("src/neutral_control_plane.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    neutral_control_plane_module.addImport("neutral_host", neutral_host_module);
    neutral_control_plane_module.addImport("process_inspector", process_inspector_module);
    neutral_control_plane_module.addImport("session_protocol_generated", generated);
    broker_module.addImport("neutral_control_plane", neutral_control_plane_module);
    broker_module.addImport("neutral_host", neutral_host_module);
    broker_module.addImport("process_inspector", process_inspector_module);
    const neutral_control_plane_tests = b.addTest(.{ .root_module = neutral_control_plane_module });
    const run_neutral_control_plane_tests = b.addRunArtifact(neutral_control_plane_tests);
    test_step.dependOn(&run_neutral_control_plane_tests.step);
    const neutral_control_plane_step = b.step(
        "neutral-control-plane",
        "Run frozen neutral LIST/INSPECT/TERMINATE operation tests",
    );
    neutral_control_plane_step.dependOn(&run_neutral_control_plane_tests.step);

    // A1 contract-freeze-facing real-host discriminators. Keep the named step
    // for focused qualification and include it in the ordinary native suite.
    const pending_a1_module = b.createModule(.{
        .root_source_file = b.path("test/pending-a1-contract.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    pending_a1_module.addImport("pty_host", pty_host_module);
    const pending_a1_tests = b.addTest(.{ .root_module = pending_a1_module });
    const run_pending_a1_tests = b.addRunArtifact(pending_a1_tests);
    const pending_a1_step = b.step(
        "pending-a1-contract",
        "Run real-sessiond contract discriminators",
    );
    pending_a1_step.dependOn(&run_pending_a1_tests.step);
    test_step.dependOn(&run_pending_a1_tests.step);

    const input_arbiter_pty_host_module = b.createModule(.{
        .root_source_file = b.path("test/input-arbiter-pty-host.zig"),
        .target = target,
        .optimize = optimize,
    });
    input_arbiter_pty_host_module.addImport("input_arbiter", input_arbiter_module);
    input_arbiter_pty_host_module.addImport("pty_host", pty_host_module);
    const input_arbiter_pty_host_tests = b.addTest(.{ .root_module = input_arbiter_pty_host_module });
    const run_input_arbiter_pty_host_tests = b.addRunArtifact(input_arbiter_pty_host_tests);
    test_step.dependOn(&run_input_arbiter_pty_host_tests.step);

    const session_host_module = b.createModule(.{
        .root_source_file = b.path("src/session_host.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    session_host_module.addImport("broker", broker_module);
    session_host_module.addImport("boot_envelope", boot_envelope_module);
    session_host_module.addImport("session_protocol_generated", generated);
    session_host_module.addImport("protocol", test_module);
    session_host_module.addImport("input_arbiter", input_arbiter_module);
    session_host_module.addImport("process_inspector", process_inspector_module);
    session_host_module.addImport("pty_host", pty_host_module);
    session_host_module.addImport("neutral_host", neutral_host_module);
    session_host_module.addImport("neutral_control_plane", neutral_control_plane_module);
    session_host_module.addImport("terminal_state", terminal_state_module);
    session_host_module.addIncludePath(ghostty.path("include"));
    session_host_module.addIncludePath(b.path("../include"));
    const session_host_tests = b.addTest(.{ .root_module = session_host_module });
    session_host_tests.linkLibrary(ghostty_vt);
    const run_session_host_tests = b.addRunArtifact(session_host_tests);
    test_step.dependOn(&run_session_host_tests.step);

    const real_host_golden_module = b.createModule(.{
        .root_source_file = b.path("test/real-host-golden.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    real_host_golden_module.addImport("broker", broker_module);
    real_host_golden_module.addImport("session_protocol_generated", generated);
    real_host_golden_module.addImport("process_inspector", process_inspector_module);
    real_host_golden_module.addImport("protocol", test_module);
    real_host_golden_module.addImport("session_host", session_host_module);
    const real_host_golden = b.addExecutable(.{
        .name = "sessiond-real-host-golden",
        .root_module = real_host_golden_module,
    });
    real_host_golden.linkLibrary(ghostty_vt);
    const run_real_host_golden = b.addRunArtifact(real_host_golden);
    test_step.dependOn(&run_real_host_golden.step);

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
    executable_module.addImport("session_host", session_host_module);
    const executable = b.addExecutable(.{
        .name = "hive-sessiond",
        .root_module = executable_module,
    });
    executable.linkLibrary(ghostty_vt);
    b.installArtifact(executable);
}
