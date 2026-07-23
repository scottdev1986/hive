const std = @import("std");
const builtin = @import("builtin");

// Build-time enforcement of the declared toolchain constraint (the exact pin
// lives in native/toolchain-lock.json: zig.version = 0.15.2; the floor is
// this package's minimum_zig_version). The ceiling is real, not preference:
// the vendored Ghostty tree (vendor/ghostty) does not build on Zig 0.16 —
// 0.16 removed std.Build APIs it uses (Step.Compile.linkLibrary/linkLibC as
// methods, Io.Dir.readFileAlloc signature, third-party pkg build scripts).
// Fail here with instructions instead of surfacing those as inscrutable
// errors. This must stay `comptime`: a runtime check would never execute on
// an incompatible zig because build() itself fails semantic analysis first.
comptime {
    const v = builtin.zig_version;
    if (v.major != 0 or v.minor != 15) @compileError(std.fmt.comptimePrint(
        "hive-sessiond requires Zig 0.15.x (pinned: 0.15.2 in native/toolchain-lock.json); " ++
            "this is Zig {d}.{d}.{d}. The vendored Ghostty tree does not build on other Zig " ++
            "versions. Install it with: brew install zig@0.15 && brew link --force zig@0.15",
        .{ v.major, v.minor, v.patch },
    ));
}

fn addTest(
    b: *std.Build,
    test_step: *std.Build.Step,
    module: *std.Build.Module,
) *std.Build.Step.Compile {
    const artifact = b.addTest(.{ .root_module = module });
    test_step.dependOn(&b.addRunArtifact(artifact).step);
    return artifact;
}

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
    const wall_clock_module = b.createModule(.{
        .root_source_file = b.path("src/wall_clock.zig"),
        .target = target,
        .optimize = optimize,
    });
    const visibility_lease_module = b.createModule(.{
        .root_source_file = b.path("src/visibility_lease.zig"),
        .target = target,
        .optimize = optimize,
    });
    visibility_lease_module.addImport("session_protocol_generated", generated);
    const visibility_lease_test_module = b.createModule(.{
        .root_source_file = b.path("test/visibility-lease.zig"),
        .target = target,
        .optimize = optimize,
    });
    visibility_lease_test_module.addImport("visibility_lease", visibility_lease_module);
    visibility_lease_test_module.addImport("session_protocol_generated", generated);
    const final_evidence_module = b.createModule(.{
        .root_source_file = b.path("src/final_evidence.zig"),
        .target = target,
        .optimize = optimize,
    });
    const final_evidence_test_module = b.createModule(.{
        .root_source_file = b.path("test/final-evidence.zig"),
        .target = target,
        .optimize = optimize,
    });
    final_evidence_test_module.addImport("final_evidence", final_evidence_module);
    const executable_identity_module = b.createModule(.{
        .root_source_file = b.path("src/executable_identity.zig"),
        .target = target,
        .optimize = optimize,
    });
    const executable_identity_test_module = b.createModule(.{
        .root_source_file = b.path("test/executable-identity.zig"),
        .target = target,
        .optimize = optimize,
    });
    executable_identity_test_module.addImport("executable_identity", executable_identity_module);

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
    _ = addTest(b, test_step, visibility_lease_test_module);
    _ = addTest(b, test_step, final_evidence_test_module);
    _ = addTest(b, test_step, executable_identity_test_module);
    _ = addTest(b, test_step, boot_envelope_module);
    _ = addTest(b, test_step, test_module);
    const protocol_api_module = b.createModule(.{
        .root_source_file = b.path("test/protocol-api.zig"),
        .target = target,
        .optimize = optimize,
    });
    protocol_api_module.addImport("protocol", test_module);
    protocol_api_module.addImport("session_protocol_generated", generated);
    _ = addTest(b, test_step, protocol_api_module);

    const daemon_identity_module = b.createModule(.{
        .root_source_file = b.path("src/daemon_identity.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    daemon_identity_module.addImport("session_protocol_generated", generated);
    daemon_identity_module.addImport("protocol", test_module);
    const broker_transport_module = b.createModule(.{
        .root_source_file = b.path("src/broker_transport.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    broker_transport_module.addImport("session_protocol_generated", generated);
    const broker_record_module = b.createModule(.{
        .root_source_file = b.path("src/broker_record.zig"),
        .target = target,
        .optimize = optimize,
    });
    broker_record_module.addImport("daemon_identity", daemon_identity_module);
    broker_record_module.addImport("session_protocol_generated", generated);
    broker_record_module.addImport("protocol", test_module);
    const broker_module = b.createModule(.{
        .root_source_file = b.path("src/broker.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    broker_module.addImport("session_protocol_generated", generated);
    broker_module.addImport("protocol", test_module);
    broker_module.addImport("boot_envelope", boot_envelope_module);
    broker_module.addImport("daemon_identity", daemon_identity_module);
    broker_module.addImport("broker_transport", broker_transport_module);
    broker_module.addImport("broker_record", broker_record_module);
    broker_module.addImport("wall_clock", wall_clock_module);
    const broker_tests = addTest(b, test_step, broker_module);
    broker_tests.linkLibrary(ghostty_vt);
    const broker_api_module = b.createModule(.{
        .root_source_file = b.path("test/broker-api.zig"),
        .target = target,
        .optimize = optimize,
    });
    broker_api_module.addImport("broker", broker_module);
    const broker_api_tests = addTest(b, test_step, broker_api_module);
    broker_api_tests.linkLibrary(ghostty_vt);

    // WP4 Part A: standalone input arbiter + process inspector (no broker/PTY).
    const input_arbiter_module = b.createModule(.{
        .root_source_file = b.path("src/input_arbiter.zig"),
        .target = target,
        .optimize = optimize,
    });
    _ = addTest(b, test_step, input_arbiter_module);

    const process_inspector_module = b.createModule(.{
        .root_source_file = b.path("src/process_inspector.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    _ = addTest(b, test_step, process_inspector_module);
    const process_inspector_api_module = b.createModule(.{
        .root_source_file = b.path("test/process-inspector-api.zig"),
        .target = target,
        .optimize = optimize,
    });
    process_inspector_api_module.addImport("process_inspector", process_inspector_module);
    _ = addTest(b, test_step, process_inspector_api_module);

    // WP4-B Track γ: headless VT + journal/checkpoint (export-double testable pre-TG2).
    // Shared HVTCP001 fixture lives under native/tests/abi (C + Zig dual-source lock).
    const hvtcp001_fixture = b.createModule(.{
        .root_source_file = b.path("../tests/abi/hvtcp001_header.zig"),
        .target = target,
        .optimize = optimize,
    });
    const checkpoint_format_module = b.createModule(.{
        .root_source_file = b.path("src/checkpoint_format.zig"),
        .target = target,
        .optimize = optimize,
    });
    checkpoint_format_module.addImport("session_protocol_generated", generated);
    const terminal_state_module = b.createModule(.{
        .root_source_file = b.path("src/terminal_state.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    terminal_state_module.addImport("session_protocol_generated", generated);
    terminal_state_module.addImport("hvtcp001_header", hvtcp001_fixture);
    terminal_state_module.addImport("checkpoint_format", checkpoint_format_module);
    _ = addTest(b, test_step, terminal_state_module);

    // WP4-B Track β: PTY host leaf (integrates process_inspector for spawn snapshot).
    const pty_host_module = b.createModule(.{
        .root_source_file = b.path("src/pty_host.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    pty_host_module.addImport("process_inspector", process_inspector_module);
    _ = addTest(b, test_step, pty_host_module);

    const terminal_adapter_module = b.createModule(.{
        .root_source_file = b.path("src/terminal_adapter.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    terminal_adapter_module.addImport("input_arbiter", input_arbiter_module);
    terminal_adapter_module.addImport("pty_host", pty_host_module);
    terminal_adapter_module.addImport("terminal_state", terminal_state_module);
    terminal_adapter_module.addIncludePath(ghostty.path("include"));
    terminal_adapter_module.addIncludePath(b.path("../include"));

    const neutral_contract_module = b.createModule(.{
        .root_source_file = b.path("src/neutral_contract.zig"),
        .target = target,
        .optimize = optimize,
    });
    neutral_contract_module.addImport("pty_host", pty_host_module);
    const neutral_runtime_module = b.createModule(.{
        .root_source_file = b.path("src/neutral_runtime.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    neutral_runtime_module.addImport("neutral_contract", neutral_contract_module);
    const neutral_host_module = b.createModule(.{
        .root_source_file = b.path("src/neutral_host.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    neutral_host_module.addImport("pty_host", pty_host_module);
    neutral_host_module.addImport("process_inspector", process_inspector_module);
    neutral_host_module.addImport("neutral_contract", neutral_contract_module);
    neutral_host_module.addImport("neutral_runtime", neutral_runtime_module);
    _ = addTest(b, test_step, neutral_host_module);
    const broker_host_client_module = b.createModule(.{
        .root_source_file = b.path("src/broker_host_client.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    broker_host_client_module.addImport("broker_record", broker_record_module);
    broker_host_client_module.addImport("broker_transport", broker_transport_module);
    broker_host_client_module.addImport("daemon_identity", daemon_identity_module);
    broker_host_client_module.addImport("neutral_host", neutral_host_module);
    broker_host_client_module.addImport("process_inspector", process_inspector_module);
    broker_host_client_module.addImport("session_protocol_generated", generated);
    broker_host_client_module.addImport("protocol", test_module);
    broker_host_client_module.addImport("wall_clock", wall_clock_module);
    broker_module.addImport("broker_host_client", broker_host_client_module);
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
    neutral_host_golden_module.addImport("pty_host", pty_host_module);
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

    const neutral_evidence_module = b.createModule(.{
        .root_source_file = b.path("src/neutral_evidence.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    neutral_evidence_module.addImport("neutral_host", neutral_host_module);
    neutral_evidence_module.addImport("process_inspector", process_inspector_module);
    neutral_evidence_module.addImport("session_protocol_generated", generated);
    neutral_evidence_module.addImport("wall_clock", wall_clock_module);
    const neutral_operations_module = b.createModule(.{
        .root_source_file = b.path("src/neutral_operations.zig"),
        .target = target,
        .optimize = optimize,
    });
    neutral_operations_module.addImport("neutral_evidence", neutral_evidence_module);
    neutral_operations_module.addImport("neutral_host", neutral_host_module);
    neutral_operations_module.addImport("process_inspector", process_inspector_module);
    neutral_operations_module.addImport("session_protocol_generated", generated);
    const neutral_control_plane_module = b.createModule(.{
        .root_source_file = b.path("src/neutral_control_plane.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    neutral_control_plane_module.addImport("neutral_host", neutral_host_module);
    neutral_control_plane_module.addImport("process_inspector", process_inspector_module);
    neutral_control_plane_module.addImport("session_protocol_generated", generated);
    neutral_control_plane_module.addImport("wall_clock", wall_clock_module);
    neutral_control_plane_module.addImport("neutral_evidence", neutral_evidence_module);
    neutral_control_plane_module.addImport("neutral_operations", neutral_operations_module);
    broker_host_client_module.addImport("neutral_control_plane", neutral_control_plane_module);
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
    // Declared here because the golden module is created before this one: the
    // golden binds the frozen create handler to the wire schema, which neither
    // the control plane nor the neutral host may see for itself.
    neutral_host_golden_module.addImport("neutral_control_plane", neutral_control_plane_module);
    neutral_host_golden_module.addImport("process_inspector", process_inspector_module);

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
    _ = addTest(b, test_step, input_arbiter_pty_host_module);

    const host_record_module = b.createModule(.{
        .root_source_file = b.path("src/host_record.zig"),
        .target = target,
        .optimize = optimize,
    });
    host_record_module.addImport("broker", broker_module);
    host_record_module.addImport("protocol", test_module);
    host_record_module.addImport("session_protocol_generated", generated);
    const host_wire_module = b.createModule(.{
        .root_source_file = b.path("src/host_wire.zig"),
        .target = target,
        .optimize = optimize,
    });
    host_wire_module.addImport("protocol", test_module);
    host_wire_module.addImport("session_protocol_generated", generated);
    const host_registration_module = b.createModule(.{
        .root_source_file = b.path("src/host_registration.zig"),
        .target = target,
        .optimize = optimize,
    });
    host_registration_module.addImport("boot_envelope", boot_envelope_module);
    host_registration_module.addImport("broker", broker_module);
    host_registration_module.addImport("executable_identity", executable_identity_module);
    host_registration_module.addImport("host_record", host_record_module);
    host_registration_module.addImport("host_wire", host_wire_module);
    host_registration_module.addImport("protocol", test_module);
    host_registration_module.addImport("session_protocol_generated", generated);
    host_registration_module.addImport("wall_clock", wall_clock_module);
    const host_runtime_module = b.createModule(.{
        .root_source_file = b.path("src/host_runtime.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    host_runtime_module.addImport("boot_envelope", boot_envelope_module);
    host_runtime_module.addImport("broker", broker_module);
    host_runtime_module.addImport("host_record", host_record_module);
    host_runtime_module.addImport("host_registration", host_registration_module);
    host_runtime_module.addImport("host_wire", host_wire_module);
    host_runtime_module.addImport("protocol", test_module);
    host_runtime_module.addImport("session_protocol_generated", generated);
    host_runtime_module.addImport("visibility_lease", visibility_lease_module);
    const host_core_module = b.createModule(.{
        .root_source_file = b.path("src/host_core.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    host_core_module.addImport("broker", broker_module);
    host_core_module.addImport("final_evidence", final_evidence_module);
    host_core_module.addImport("host_record", host_record_module);
    host_core_module.addImport("host_registration", host_registration_module);
    host_core_module.addImport("input_arbiter", input_arbiter_module);
    host_core_module.addImport("neutral_control_plane", neutral_control_plane_module);
    host_core_module.addImport("neutral_host", neutral_host_module);
    host_core_module.addImport("process_inspector", process_inspector_module);
    host_core_module.addImport("protocol", test_module);
    host_core_module.addImport("pty_host", pty_host_module);
    host_core_module.addImport("session_protocol_generated", generated);
    host_core_module.addImport("terminal_state", terminal_state_module);
    host_core_module.addImport("visibility_lease", visibility_lease_module);
    host_core_module.addImport("wall_clock", wall_clock_module);

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
    session_host_module.addImport("terminal_adapter", terminal_adapter_module);
    session_host_module.addImport("wall_clock", wall_clock_module);
    session_host_module.addImport("visibility_lease", visibility_lease_module);
    session_host_module.addImport("final_evidence", final_evidence_module);
    session_host_module.addImport("host_record", host_record_module);
    session_host_module.addImport("host_wire", host_wire_module);
    session_host_module.addImport("executable_identity", executable_identity_module);
    session_host_module.addImport("host_registration", host_registration_module);
    session_host_module.addImport("host_runtime", host_runtime_module);
    session_host_module.addImport("host_core", host_core_module);
    session_host_module.addIncludePath(ghostty.path("include"));
    session_host_module.addIncludePath(b.path("../include"));
    const session_host_tests = addTest(b, test_step, session_host_module);
    session_host_tests.linkLibrary(ghostty_vt);

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
    const stub_tests = addTest(b, test_step, stub_module);
    stub_tests.linkLibrary(ghostty_vt);

    const wall_clock_test_module = b.createModule(.{
        .root_source_file = b.path("test/wall-clock.zig"),
        .target = target,
        .optimize = optimize,
    });
    wall_clock_test_module.addImport("wall_clock", wall_clock_module);
    _ = addTest(b, test_step, wall_clock_test_module);

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
