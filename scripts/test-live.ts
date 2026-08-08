import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.env.HIVE_TEST_ROOT;
if (root === undefined) {
  throw new Error("test:live must run through scripts/test-sandbox.ts");
}

const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

interface DeclaredFile {
  inputName: string;
  destination: string;
}

interface LiveVendor {
  id: string;
  label: string;
  testNames: readonly string[];
  files: readonly DeclaredFile[];
}

async function stageDeclaredFile(
  source: string,
  destination: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o600);
}

const vendorHomes = join(root, "live-vendor-homes");
const grokHome = join(vendorHomes, "grok");
const kimiHome = join(vendorHomes, "kimi");
const codexHome = join(vendorHomes, "codex");
const claudeHome = join(root, "home");
const openCodeDataHome = join(root, "data");

const vendors: readonly LiveVendor[] = [
  {
    id: "grok",
    label: "Grok",
    testNames: ["Grok", "grok"],
    files: [
      {
        inputName: "HIVE_LIVE_GROK_AUTH_FILE",
        destination: join(grokHome, "auth.json"),
      },
      {
        inputName: "HIVE_LIVE_GROK_CONFIG_FILE",
        destination: join(grokHome, "config.toml"),
      },
    ],
  },
  {
    id: "kimi",
    label: "Kimi",
    testNames: ["Kimi", "kimi"],
    files: [
      {
        inputName: "HIVE_LIVE_KIMI_AUTH_FILE",
        destination: join(kimiHome, "credentials", "kimi-code.json"),
      },
      {
        inputName: "HIVE_LIVE_KIMI_OAUTH_FILE",
        destination: join(kimiHome, "oauth", "kimi-code"),
      },
      {
        inputName: "HIVE_LIVE_KIMI_CONFIG_FILE",
        destination: join(kimiHome, "config.toml"),
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    testNames: ["Codex", "codex"],
    files: [
      {
        inputName: "HIVE_LIVE_CODEX_AUTH_FILE",
        destination: join(codexHome, "auth.json"),
      },
      {
        inputName: "HIVE_LIVE_CODEX_CONFIG_FILE",
        destination: join(codexHome, "config.toml"),
      },
    ],
  },
  {
    id: "claude",
    label: "Claude",
    testNames: ["Claude", "claude"],
    files: [
      {
        inputName: "HIVE_LIVE_CLAUDE_CREDENTIAL_FILE",
        destination: join(claudeHome, ".claude", ".credentials.json"),
      },
      {
        inputName: "HIVE_LIVE_CLAUDE_CONFIG_FILE",
        destination: join(claudeHome, ".claude.json"),
      },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    testNames: ["OpenCode", "opencode"],
    files: [
      {
        inputName: "HIVE_LIVE_OPENCODE_AUTH_FILE",
        destination: join(openCodeDataHome, "opencode", "auth.json"),
      },
    ],
  },
];

const missingByVendor = vendors.flatMap((vendor) => {
  const missing = vendor.files
    .map((file) => file.inputName)
    .filter((inputName) => !process.env[inputName]);
  return missing.length === 0 ? [] : [{ vendor, missing }];
});
if (missingByVendor.length > 0) {
  console.error("[test:live] declared input preflight failed:");
  for (const { vendor, missing } of missingByVendor) {
    console.error(
      `[test:live] ${vendor.label} FAILED (not run): missing ${missing.join(", ")}`,
    );
  }
}

const unavailable = new Set(missingByVendor.map(({ vendor }) => vendor.id));
let preflightFailed = missingByVendor.length > 0;
for (const vendor of vendors) {
  if (unavailable.has(vendor.id)) continue;
  try {
    for (const file of vendor.files) {
      const source = process.env[file.inputName];
      if (source === undefined) {
        throw new Error(`missing declared input ${file.inputName}`);
      }
      await stageDeclaredFile(source, file.destination);
    }
  } catch (error) {
    preflightFailed = true;
    unavailable.add(vendor.id);
    console.error(
      `[test:live] ${vendor.label} FAILED (not run): could not stage declared inputs: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const availableVendors = vendors.filter(
  (vendor) => !unavailable.has(vendor.id),
);

const liveEnvironment = {
  ...inherited,
  GROK_HOME: grokHome,
  KIMI_CODE_HOME: kimiHome,
  KIMI_CODE_CACHE_DIR: join(root, "cache", "kimi"),
  CODEX_HOME: codexHome,
  DISABLE_AUTOUPDATER: "1",
  KIMI_CLI_NO_AUTO_UPDATE: "1",
  GROK_DISABLE_AUTOUPDATER: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
};

function testNamePattern(selected: readonly LiveVendor[]): string {
  const names = selected.flatMap((vendor) => vendor.testNames);
  return names.length === 0 ? "(?!)" : `(?:${names.join("|")})`;
}

async function runLeg(
  name: string,
  files: readonly string[],
  selectedVendors?: readonly LiveVendor[],
): Promise<number> {
  console.log(`[test:live] ${name}`);
  const selection =
    selectedVendors === undefined
      ? []
      : ["--test-name-pattern", testNamePattern(selectedVendors)];
  const child = Bun.spawn(["bun", "test", ...selection, ...files], {
    cwd: process.cwd(),
    env: liveEnvironment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  console.log(`[test:live] ${name} exit ${code}`);
  return code;
}

const vendorCode = await runLeg(
  "vendor protocols",
  [
    "test/protocol-acp-live-conformance.test.ts",
    "test/protocol-claude-live-conformance.test.ts",
    "test/protocol-codex-live-conformance.test.ts",
    "test/protocol-durable-resume-live.test.ts",
    "test/protocol-usage-parity-live.test.ts",
  ],
  availableVendors,
);
const capabilityCode = await runLeg(
  "capability discovery",
  ["test/daemon/capability-discovery.live.test.ts"],
  availableVendors.filter(
    (vendor) => vendor.id === "claude" || vendor.id === "codex",
  ),
);
const memoryCode = await runLeg("memory embeddings", [
  "test/memory-embedding-live.test.ts",
]);

process.exit(
  !preflightFailed &&
    vendorCode === 0 &&
    capabilityCode === 0 &&
    memoryCode === 0
    ? 0
    : 1,
);
