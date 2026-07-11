import { join } from "node:path";
import { buildScopedBrief } from "../adapters/brief";
import { buildMemoryIndex } from "../adapters/memory";
import { ensureProfile } from "../adapters/profile";
import {
  buildAgentTerminalTitle,
  type TerminalAdapter,
} from "../adapters/terminal";
import { shellJoin } from "../adapters/tmux";
import type { TmuxAdapter } from "../adapters/tmux";
import {
  buildClaudeSpawnCommand,
  resolveWorkingClaudeExecutable,
  seedClaudeWorktreeTrust,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import {
  buildCodexSpawnCommand,
  writeCodexAgentConfig,
} from "../adapters/tools/codex";
import { listInheritedCodexMcpServers } from "../adapters/tools/mcp-scope";
import type { CodexAppServerManager } from "../adapters/tools/codex-app-server";
import { provisionSkills } from "../adapters/skills";
import {
  CLAUDE_BEST_MODEL,
  CLAUDE_OPUS_MODEL,
  modelVendor,
  resolveConcreteModel,
} from "../adapters/tools/models";
import {
  createWorktree,
  removeWorktree,
  slugify,
  type CreatedWorktree,
  assessStrandedWork,
} from "../adapters/worktrees";
import {
  ORCHESTRATOR_NAME,
  isLiveAgent,
  type AgentMessage,
  type AgentRecord,
  type ExecutionIdentity,
  type HiveConfig,
  type Route,
  type RoutingTier,
} from "../schemas";
import type { HiveDatabase } from "./db";
import { readCodexTelemetry } from "./tool-telemetry";
import { watchForProofOfLife } from "./readiness";
import {
  parseProcessTable,
  processCommandName,
  runPs,
  treeRunsCommand,
  type CommandOutput,
} from "./resources";
import type { SpawnRequest, Spawner } from "./spawner";
import type { QuotaRouteCandidate, QuotaService } from "./quota";
import { agentTmuxSession } from "./tmux-sessions";

/**
 * Names an agent can be given. Human first names, because the user's interface
 * is conversation: "tell maya to reuse the middleware" works, "message agent-3"
 * makes the user keep a numbering table the tool should keep for them.
 *
 * Curated so that names are easy to type and hard to confuse: no name is a
 * prefix of another, and no two names are within one edit of each other (no
 * mark/marc, no ana/anna). A test enforces both invariants — add names only if
 * they still hold. Numeric suffixes are never appended to make a name unique;
 * see selectAgentName.
 */
export const NAME_POOL = [
  "maya", "david", "sam", "john", "sarah", "alex",
  "nina", "leo", "anna", "james", "zoe", "omar",
  "lena", "noah", "priya", "liam", "emma", "lucas",
  "ava", "ethan", "mia", "henry", "isla", "jack",
  "chloe", "ryan", "sofia", "adam", "grace", "owen",
  "layla", "theo", "ruby", "caleb", "alice", "felix",
  "clara", "marco", "julia", "ben", "aaron", "abel",
  "abby", "adele", "adrian", "agnes", "ahmed", "aisha",
  "albert", "alma", "amara", "amber", "amos", "amy",
  "andre", "angela", "anton", "april", "arash", "archie",
  "arjun", "arlo", "armand", "arnold", "arthur", "ashley",
  "astrid", "atlas", "aubrey", "august", "aurora", "austin",
  "autumn", "azra", "bailey", "barbara", "basil", "beatrix",
  "becca", "bella", "bernard", "bertha", "bianca", "bilal",
  "birgit", "blake", "bobby", "bonnie", "boris", "bram",
  "brandon", "brenda", "brian", "bridget", "brock", "bruno",
  "burt", "byron", "callum", "calvin", "camila", "candace",
  "carl", "carmen", "casey", "cassie", "cecil", "cedric",
  "celia", "cesar", "chad", "chandra", "charles", "chase",
  "chester", "chiara", "chris", "cindy", "clay", "clifford",
  "clinton", "clyde", "cole", "colin", "conrad", "cooper",
  "cora", "cormac", "cosmo", "craig", "crystal", "curtis",
  "cyrus", "dahlia", "daisy", "dakota", "damian", "dana",
  "daniel", "danny", "daphne", "darius", "darren", "dawn",
  "dean", "deborah", "declan", "denise", "dennis", "derek",
  "desmond", "devon", "dexter", "diego", "dimitri", "dominic",
  "donna", "dorothy", "douglas", "duncan", "dylan", "eamon",
  "edgar", "edith", "edmund", "eduardo", "edwin", "eileen",
  "elaine", "eleanor", "eli", "ellen", "elliot", "elmer",
  "eloise", "elsa", "elton", "elvis", "emil", "emmett",
  "enzo", "erica", "ernest", "esme", "esther", "eugene",
  "evan", "evelyn", "everett", "fabian", "faith", "farid",
  "fatima", "faye", "fenton", "fergus", "fernanda", "fiona",
  "flora", "florence", "floyd", "forrest", "frances", "frank",
  "fraser", "freda", "gabriel", "gail", "gareth", "gavin",
  "gene", "geoff", "george", "gerald", "gilbert", "gloria",
  "gordon", "graham", "greta", "gunnar", "gus", "hadley",
  "hakim", "hannah", "harold", "harper", "harriet", "harvey",
  "hassan", "hattie", "hazel", "heather", "hector", "heidi",
  "helen", "herman", "hilda", "hiro", "holly", "homer",
  "hope", "horace", "howard", "hugo", "hunter", "ian",
  "ibrahim", "ida", "ignacio", "imani", "imogen", "ines",
  "ingrid", "irene", "iris", "irving", "isaac", "isabel",
  "ismael", "ivy", "jacob", "jade", "jamal", "janet",
  "jared", "jasmine", "jasper", "javier", "jeanne", "jeffrey",
  "jenna", "jeremy", "jerome", "jesse", "jewel", "jillian",
  "jimmy", "joel", "jonah", "jordan", "jorge", "josef",
  "joshua", "joyce", "juan", "judith", "juliet", "june",
  "junior", "kalum", "kara", "karim", "kate", "katrina",
  "keith", "kelly", "kelvin", "kendra", "kenneth", "khalid",
  "kieran", "kim", "kirby", "kirsten", "klaus", "kyle",
  "lachlan", "lamar", "lance", "larry", "laura", "laurel",
  "lawrence", "lazlo", "leah", "leandro", "leigh", "leland",
  "leroy", "leslie", "lester", "lewis", "lidia", "lila",
  "lincoln", "lindsay", "linus", "lionel", "logan", "lorenzo",
  "loretta", "lorna", "louis", "lowell", "lucia", "ludwig",
  "luke", "madeline", "magnus", "maisie", "malcolm", "mallory",
  "mandy", "manuel", "marcus", "margaret", "maria", "marilyn",
  "marion", "marnie", "marshall", "martha", "martin", "mason",
  "mateo", "matilda", "matthew", "maude", "maurice", "maxwell",
  "megan", "melissa", "mercy", "meredith", "mervyn", "micah",
  "michelle", "miguel", "mikhail", "mildred", "miles", "millie",
  "milo", "miranda", "miriam", "mitchell", "moira", "monica",
  "morgan", "morris", "moses", "murray", "myra", "nadia",
  "nancy", "naomi", "natalie", "nathan", "neil", "nelson",
  "nestor", "nicholas", "nigel", "nikolai", "nolan", "norman",
  "nova", "octavia", "odette", "olga", "oliver", "olivia",
  "ollie", "opal", "ophelia", "orion", "orlando", "oscar",
  "osman", "oswald", "otis", "otto", "ozzie", "pablo",
  "paloma", "pamela", "pascal", "patrick", "patsy", "paula",
  "pearl", "pedro", "peggy", "penelope", "perry", "peter",
  "petra", "phoebe", "pierce", "piper", "porter", "preston",
  "primo", "prudence", "quentin", "quinn", "rachel", "rafael",
  "raheem", "ralph", "ramona", "randall", "raoul", "raphael",
  "raquel", "rashid", "raymond", "rebecca", "reginald", "reid",
  "remy", "renee", "reuben", "rex", "rhoda", "rhys",
  "ricardo", "richard", "rita", "robert", "robin", "rochelle",
  "roderick", "rodney", "roger", "roland", "rolf", "roman",
  "romeo", "ronald", "rory", "rosalind", "roscoe", "rosemary",
  "roxana", "rudolf", "rufus", "rupert", "russell", "rusty",
  "ruth", "ryder", "sabine", "sadie", "saeed", "salvador",
  "sandra", "sanjay", "santiago", "sasha", "saul", "scarlett",
  "sebastian", "selena", "selma", "sergio", "seth",
  "shane", "shannon", "sharon", "shaun", "sheila", "shelby",
  "sheldon", "shirley", "sidney", "siegfried", "sienna", "sigrid",
  "silas", "simon", "sinclair", "solomon", "sonya", "spencer",
  "stanley", "stella", "stephen", "sterling", "stuart", "sullivan",
  "summer", "susan", "sven", "sybil", "sylvia", "tabitha",
  "tanya", "tariq", "tatiana", "taylor", "teresa", "terrence",
  "tessa", "thaddeus", "thelma", "thomas", "thora", "tiffany",
  "timothy", "tobias", "toby", "todd", "tommy", "tracy",
  "travis", "trent", "trevor", "tristan", "troy", "tucker",
  "tyler", "tyrone", "ulrich", "ulysses", "uma", "umberto",
  "ursula", "valentina", "valerie", "vanessa", "vaughn", "vera",
  "vernon", "veronica", "victor", "vidal", "vijay", "vincent",
  "viola", "virgil", "vivian", "vladimir", "walter", "wanda",
  "wayne", "wendell", "wendy", "wesley", "wilbur", "wilfred",
  "willa", "willow", "winston", "wyatt", "ximena", "yasmin",
  "yolanda", "york", "yusuf", "yvette", "yvonne", "zachary",
  "zaid", "zeke", "zelda", "zenobia",
] as const;

type AgentStore = Pick<
  HiveDatabase,
  | "attachTerminalHandle"
  | "getAgentById"
  | "getLiveAgentByName"
  | "insertAgent"
  | "listAgents"
  | "releaseAgentName"
  | "reserveAgentName"
>;
type RouteResolver = (tier: RoutingTier) => Promise<Route>;
type WorktreeCreator = (
  repoRoot: string,
  agentName: string,
  taskSlug: string,
) => Promise<CreatedWorktree>;
type WorktreeRemover = typeof removeWorktree;
type TmuxSessionManager = Pick<
  TmuxAdapter,
  | "newSession"
  | "hasSession"
  | "capturePane"
  | "killSession"
  // Readiness asks the process tree whether the binary it launched is still
  // running in the pane, because a redrawing screen alone cannot tell an agent
  // from the wrapper shell hive launches it behind (see readiness.ts).
  | "listPanePids"
>;
type Sleep = (milliseconds: number) => Promise<void>;
type ModelResolver = typeof resolveConcreteModel;

/** The binary a launch argv will actually run, as `ps` will report it. */
function launchedCommandName(argv: string[]): string {
  return processCommandName(argv[0] ?? "");
}

/** Mints one agent's capability, writes it to its 0600 credential file, and
 * returns the token. Absent (tests, tooling) the agent is launched with no
 * credential and its daemon calls fail closed rather than fail open. */
export type CredentialIssuer = (
  name: string,
  role: "writer" | "reader",
  epoch: number,
) => string;

export interface HiveSpawnerDependencies {
  db: AgentStore;
  repoRoot: string;
  port: number;
  issueCredential?: CredentialIssuer;
  config: Pick<HiveConfig, "terminal" | "headless"> & {
    codex?: Pick<HiveConfig["codex"], "driver">;
    /** Writer autonomy. Absent (older callers, tests) fails safe to
     * "sandboxed"; the parsed HiveConfig always supplies a value. */
    autonomy?: HiveConfig["autonomy"];
  };
  routing: RouteResolver;
  tmux: TmuxSessionManager;
  terminal: TerminalAdapter;
  createWorktree?: WorktreeCreator;
  removeWorktree?: WorktreeRemover;
  /** Asks whether a worktree holds work worth keeping. Injectable for tests;
   * defaults to the real git probe. */
  assessStrandedWork?: (
    repoRoot: string,
    worktreePath: string | null,
    branch: string | null,
  ) => Promise<{ dirtyFiles: string[]; unmergedCommits: number }>;
  keepWorktreeOnFailure?: boolean;
  sleep?: Sleep;
  resolveModel?: ModelResolver;
  /** Test seam for the daemon-resolved Claude binary. */
  claudeExecutable?: string;
  /** Reads the process table for the readiness probe's process-tree check.
   * Defaults to the real `ps`. */
  ps?: CommandOutput;
  /** Test seam for reading the user's global Codex MCP server names. */
  listCodexMcpServers?: () => Promise<string[]>;
  /** Operator opt-out for the research preview. Agent spawns never launch
   * Channels regardless (see `useChannels`); this still gates the attended
   * orchestrator session. */
  channelsEnabled?: boolean;
  /** Fires after a viewer window is attached so the daemon can re-tile the
   * window wall. */
  onTerminalsChanged?: () => void;
  /** True while the Workspace app holds the viewer lease (`POST /workspace`).
   * While it does, external viewer windows are skipped exactly as if
   * `config.headless` were set — the app's panes are the viewers — but the
   * static config keeps its meaning and behavior reverts when the lease
   * lapses. Checked at open time, never cached. */
  workspacePresent?: () => boolean;
  /** Reports viewer automation failures without treating the detached agent
   * process itself as failed. */
  onTerminalError?: (message: string) => void;
  quota?: QuotaService;
  codexAppServer?: Pick<
    CodexAppServerManager,
    "isAvailable" | "buildHostCommand" | "startAgent" | "disconnect"
  >;
  /** Test seam for codex rollout activity during the readiness watch. Native
   * SessionStart is the primary signal; a fresh rollout mtime remains an
   * independent fallback when hooks are disabled by policy or fail. Defaults
   * to `readCodexTelemetry`. */
  readCodexActivity?: (worktreePath: string) => Promise<string | null>;
}

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,20}$/;

const sleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));


/** When this holder closed, for ordering reuse. Old rows predate closedAt. */
const closureInstant = (agent: AgentRecord): string =>
  agent.closedAt ?? agent.failedAt ?? agent.lastEventAt;

/**
 * Pick the next agent name.
 *
 * A name means exactly one agent at a time, so a name with a live holder is
 * never issued. Beyond that: always prefer a name this Hive has never used, and
 * fall back to the least-recently-closed name only once no fresh name is left.
 * Across a few hundred names reuse is therefore legal but vanishingly rare —
 * which is the point. The user's scrollback still says "maya reported X", and
 * the odds that a *new* maya exists to misreceive "maya, follow up on X" stay
 * near zero, while closure is durably recorded so history can always name the
 * agent that closed.
 *
 * When every pool name has a live holder there is nothing honest to return.
 * Numeric suffixes (maya-2) are never minted, and taking a live agent's name
 * would create exactly the ambiguity this design exists to prevent. Refuse, and
 * say the pool needs expanding.
 */
export function selectAgentName(
  agents: AgentRecord[],
  /** Names already claimed by a spawn in flight; as unavailable as a live one. */
  unavailable: ReadonlySet<string> = new Set(),
): string {
  const live = new Set(agents.filter(isLiveAgent).map((agent) => agent.name));
  const everUsed = new Set(agents.map((agent) => agent.name));
  const taken = (name: string): boolean =>
    live.has(name) || unavailable.has(name);

  const fresh = NAME_POOL.find(
    (candidate) => !everUsed.has(candidate) && !taken(candidate),
  );
  if (fresh !== undefined) return fresh;

  const inPool = new Set<string>(NAME_POOL);
  const closed = agents
    .filter((agent) => inPool.has(agent.name) && !taken(agent.name))
    .sort((a, b) => closureInstant(a).localeCompare(closureInstant(b)));
  if (closed.length > 0) return closed[0]!.name;

  throw new Error(
    `Hive agent name pool exhausted: all ${NAME_POOL.length} names are held by ` +
      "a live or spawning agent. Hive never reuses a live name and never " +
      "appends a numeric suffix, so this spawn is refused. Close an agent, or " +
      "expand NAME_POOL in src/daemon/spawner-impl.ts.",
  );
}

export function resolveAgentName(
  requestedName: string | undefined,
  agents: AgentRecord[],
): string {
  if (requestedName === undefined) {
    return selectAgentName(agents);
  }

  const normalizedName = requestedName.toLowerCase();
  if (normalizedName === ORCHESTRATOR_NAME) {
    throw new Error(
      `Agent name "${ORCHESTRATOR_NAME}" is reserved for the Hive orchestrator`,
    );
  }
  if (!AGENT_NAME_PATTERN.test(normalizedName)) {
    throw new Error(
      `Invalid agent name "${normalizedName}": after lowercasing, the name must match /^[a-z][a-z0-9-]{1,20}$/`,
    );
  }
  if (
    agents.some((agent) =>
      isLiveAgent(agent) && agent.name === normalizedName
    )
  ) {
    throw new Error(
      `Agent name collision: "${normalizedName}" is already assigned to a live agent`,
    );
  }
  return normalizedName;
}

export const LANDING_MAX_ATTEMPTS = 3;

/** Tiers whose prompt is trimmed to essentials. A `cheap` agent runs mechanical
 * work on a small model: it needs every *rule* the full prompt carries, but
 * none of the narration that justifies them. The trimmed text below is a
 * rewrite, not a subset — no step, bound, or prohibition is dropped, because
 * the landing protocol is Hive's safety stack and a cheap model is exactly the
 * one that must not have to infer a missing step. */
const CONCISE_TIERS: readonly RoutingTier[] = ["cheap"];

/** Reporting a landing is not finishing. Agents were observed idling at their
 * prompt while still holding authorized work, needing a nudge per stage — the
 * mirror image of the escalate-don't-grind tripwire (grind → escalate;
 * idle-with-work → continue). A live session is also the cheapest place to do
 * the next piece: a respawn re-reads everything from zero. */
const CONTINUOUS_EXECUTION =
  `After reporting a landing or milestone, immediately continue with the next authorized piece of your assignment in this same session. Stop only for a genuine blocker, an escalation, or an explicit hold from "${ORCHESTRATOR_NAME}".`;

/** The concrete verify commands the landing gate names, from the repo profile
 * (SPEC §14: "the landing gate's 're-run the tests' resolves to the profile's
 * concrete command"). Null means the profile could not discover it; the gate
 * then falls back to generic wording rather than inventing a command. */
export interface LandingCommands {
  test: string | null;
  typecheck: string | null;
}

/** Render "re-run the tests"/"typecheck it" against the profile's commands so an
 * agent in an arbitrary repo is told the exact command, not hive's own. */
function verifyPhrases(commands: LandingCommands | undefined): {
  test: string;
  typecheck: string;
  typecheckBackstop: string;
} {
  const test = commands?.test != null
    ? `Re-run the tests (\`${commands.test}\`)`
    : "Re-run the tests";
  const typecheck = commands?.typecheck != null
    ? `\`${commands.typecheck}\``
    : "your typechecker";
  // The "a green suite does not typecheck" backstop names the test command when
  // the profile knows it, so the agent sees exactly which run is insufficient.
  const typecheckBackstop = commands?.typecheck != null && commands.test != null
    ? `\`${commands.test}\` does not typecheck`
    : "a passing test run does not typecheck";
  return { test, typecheck, typecheckBackstop };
}

export function buildLandingProtocol(
  branch: string,
  repoRoot: string,
  mainBranch = "main",
  agentName = branch.split("/")[1]?.split("-")[0] ?? "agent",
  capabilityEpoch = 0,
  concise = false,
  commands?: LandingCommands,
): string {
  const verify = verifyPhrases(commands);
  if (concise) {
    return [
      `When your task is done and tests are green, land it on ${mainBranch} — unlanded work is lost work:`,
      `1. Commit everything on \`${branch}\`.`,
      `2. \`git rebase ${mainBranch}\` in your worktree. On conflict: \`git rebase --abort\`, message "${ORCHESTRATOR_NAME}" with the conflicting file names, stop. Never force, never resolve another agent's code.`,
      `3. ${verify.test} and typecheck with ${verify.typecheck}; ${verify.typecheckBackstop}, so a green suite alone can carry a type error onto ${mainBranch}. Skip both only if \`git diff --name-only ORIG_HEAD..HEAD\` lists \`.md\` files alone. Red tests never merge, and neither do type errors: fix them, or commit and report the failure.`,
      `4. Call \`hive_land\` with agent \`${agentName}\`, capabilityEpoch \`${capabilityEpoch}\`. Never merge into the primary checkout yourself.`,
      `5. Rejected because ${mainBranch} moved? Back to step 2, at most ${LANDING_MAX_ATTEMPTS} attempts, then message "${ORCHESTRATOR_NAME}".`,
      `6. Report the merge commit hash. Leave your branch and worktree in place.`,
    ].join("\n");
  }
  return [
    `When your task is complete and the tests are green, land your work on ${mainBranch} immediately — finished work left on your branch is lost work:`,
    `1. Commit everything on your branch (${branch}); never leave work uncommitted.`,
    `2. Rebase onto the latest ${mainBranch}: run \`git rebase ${mainBranch}\` in your worktree. If the rebase hits conflicts, run \`git rebase --abort\` and message "${ORCHESTRATOR_NAME}" naming the conflicting files — never force anything and never resolve another agent's code alone.`,
    `3. ${verify.test} on the rebased branch, and typecheck it with ${verify.typecheck}. Both must pass. ${verify.typecheckBackstop}, so a green suite alone will carry a type error onto ${mainBranch}: two agents whose work was separately green merge into a duplicate symbol that no test can see. You may skip both checks only when \`git diff --name-only ORIG_HEAD..HEAD\` — what the rebase pulled in — lists nothing but \`.md\` files that no test reads: your pre-rebase green run still holds, so go straight to step 4. Red tests never merge, and neither do type errors: fix them on your branch, or commit what you have and report the failure instead.`,
    `4. Land through Hive's capability gate: call \`hive_land\` with agent \`${agentName}\` and capabilityEpoch \`${capabilityEpoch}\`. The daemon performs the fast-forward-only merge of \`${branch}\` into \`${mainBranch}\`; never merge into the primary checkout directly.`,
    `5. If that merge is rejected because ${mainBranch} moved, return to step 2. After ${LANDING_MAX_ATTEMPTS} failed attempts, stop and message "${ORCHESTRATOR_NAME}".`,
    `6. Include the merge commit hash in your completion report. Do not delete your branch or worktree; hive cleans up landed branches.`,
  ].join("\n");
}

export interface AgentPromptOptions {
  /** Drives the prompt diet. Absent (tests, older callers) keeps the full text. */
  tier?: RoutingTier;
  /** Doc sections the task named, extracted at spawn. See adapters/brief.ts. */
  brief?: string;
  /** The repo profile's verify commands, so the landing gate names this repo's
   * concrete test/typecheck commands instead of a hardcoded guess (SPEC §14). */
  landingCommands?: LandingCommands;
}

export function buildAgentPrompt(
  name: string,
  task: string,
  worktree: CreatedWorktree,
  repoRoot: string,
  memoryIndex = "",
  options: AgentPromptOptions = {},
): string {
  const concise = options.tier !== undefined &&
    CONCISE_TIERS.includes(options.tier);
  const preamble = concise
    ? [
        `You are ${name}, a Hive writer agent.`,
        `Your task: ${task}`,
        `Work only inside your worktree at ${worktree.path}.`,
        `Report completion, blockers, and findings to "${ORCHESTRATOR_NAME}" with hive_send (hive_inbox and hive_status are also available). Reference artifacts by path; never paste them.`,
        `Read only what the task names. Search for the lines that matter rather than reading files whole. If the task is substantially bigger than briefed, stop and report rather than grinding.`,
        CONTINUOUS_EXECUTION,
      ]
    : [
        `You are ${name}, a Hive writer agent.`,
        `Your task: ${task}`,
        `Your file scope is your worktree at ${worktree.path}; do all code and file work there.`,
        "Use the Hive MCP tools hive_send, hive_inbox, and hive_status to message and coordinate with other named agents.",
        `Send concise completion reports, blockers, and important findings to "${ORCHESTRATOR_NAME}" with hive_send; reference large artifacts instead of pasting them.`,
        `Read only what the task needs: search for the lines that matter instead of reading large files whole, and reuse artifacts other agents already wrote instead of re-deriving them. If the task proves substantially larger than briefed, stop and report to "${ORCHESTRATOR_NAME}" rather than grinding.`,
        CONTINUOUS_EXECUTION,
      ];
  return [
    ...preamble,
    buildLandingProtocol(
      worktree.branch, repoRoot, "main", name, 0, concise, options.landingCommands,
    ),
    ...(options.brief === undefined || options.brief === ""
      ? []
      : [options.brief]),
    ...(memoryIndex === "" ? [] : [memoryIndex]),
  ].join("\n\n");
}

/** The worktree's own `.mcp.json`, written by `writeClaudeAgentConfig`. Naming
 * it explicitly is what lets `--strict-mcp-config` drop everything else. */
export function claudeMcpConfigPath(worktreePath: string): string {
  return join(worktreePath, ".mcp.json");
}

export class HiveSpawner implements Spawner {
  private readonly makeWorktree: WorktreeCreator;
  private readonly cleanupWorktree: WorktreeRemover;
  private readonly assessStranded: NonNullable<
    HiveSpawnerDependencies["assessStrandedWork"]
  >;
  private readonly wait: Sleep;
  private readonly modelResolver: ModelResolver;
  private readonly claudeExecutable: string;
  private readonly readCodexActivity: (
    worktreePath: string,
  ) => Promise<string | null>;

  constructor(private readonly dependencies: HiveSpawnerDependencies) {
    this.makeWorktree = dependencies.createWorktree ?? createWorktree;
    this.cleanupWorktree = dependencies.removeWorktree ?? removeWorktree;
    this.assessStranded = dependencies.assessStrandedWork ?? assessStrandedWork;
    this.wait = dependencies.sleep ?? sleep;
    this.modelResolver = dependencies.resolveModel ?? resolveConcreteModel;
    this.claudeExecutable = dependencies.claudeExecutable ??
      resolveWorkingClaudeExecutable().path;
    this.readCodexActivity = dependencies.readCodexActivity ??
      (async (worktreePath) =>
        (await readCodexTelemetry(worktreePath)).lastActivityAt);
  }

  /** Servers a Codex spawn would inherit from the user's global config. Read
   * once per spawn, never written. A read failure means "inherit nothing to
   * exclude" — the agent keeps today's surface rather than failing to launch. */
  private async inheritedCodexMcpServers(): Promise<string[]> {
    const list = this.dependencies.listCodexMcpServers ??
      listInheritedCodexMcpServers;
    try {
      return await list();
    } catch (error) {
      console.error(
        `Hive could not read the user's Codex MCP server list; the spawned agent inherits all of them: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      return [];
    }
  }

  /**
   * Spawned agents never launch with Channels, and the reason is structural
   * rather than a version gate.
   *
   * Hive's bridge is a `server:` channel, and the CLI only accepts those behind
   * `--dangerously-load-development-channels`. That flag always raises a
   * blocking "WARNING: Loading development channels" dialog whose only exits
   * are "I am using this for local development" and "Exit" — and, unlike the
   * bypass-permissions disclaimer, accepting it persists nothing, so there is
   * no state Hive can pre-seed. An unattended agent would sit on that dialog
   * forever. Passing plain `--channels server:hive-channel` skips the dialog
   * but the CLI then refuses to register the channel ("server: entries need
   * --dangerously-load-development-channels"), which is a silent no-op.
   *
   * So an agent gets Channels or it gets an unattended launch, never both.
   * Messages reach agents through the maintained tmux pane fallback in
   * src/daemon/delivery.ts. The orchestrator keeps Channels: a human is sitting
   * at that session and can answer the dialog once.
   *
   * Measured against claude 2.1.206; see SPEC "Spawn wiring".
   */
  private async useChannels(_tool: "claude" | "codex"): Promise<boolean> {
    return false;
  }

  async restartForControl(
    agent: AgentRecord,
    message: AgentMessage,
  ): Promise<AgentRecord> {
    if (agent.worktreePath === null) {
      throw new Error(`Cannot restart ${agent.name}: worktree is unavailable`);
    }
    const identity = agent.executionIdentity;
    if (
      identity === undefined || identity.model === "default" ||
      identity.tool !== agent.tool || identity.model !== agent.model
    ) {
      await this.failClosedControlRestart(
        agent,
        message,
        "no complete immutable execution identity is recorded (legacy or unresolved-default agent row)",
      );
      throw new Error(
        `Cannot restart ${agent.name} for critical control: no complete immutable execution identity is recorded. ` +
          "This legacy/unresolved row cannot be restarted safely without risking a model switch; capability remains revoked.",
      );
    }
    if (this.dependencies.quota === undefined) {
      await this.failClosedControlRestart(
        agent,
        message,
        "quota accounting is unavailable for the acknowledgement process",
      );
      throw new Error(
        `Cannot restart ${agent.name} for critical control: quota accounting is unavailable; capability remains revoked`,
      );
    }

    let reservationId: string;
    try {
      const reservation = await this.dependencies.quota.reserveControlRun({
        agentName: agent.name,
        tier: agent.tier,
        tool: identity.tool,
        model: identity.model,
        controlMessageId: message.id,
      });
      reservationId = reservation.id;
    } catch (error) {
      await this.failClosedControlRestart(
        agent,
        message,
        error instanceof Error ? error.message : "control quota reservation failed",
      );
      throw error;
    }

    // From here to markStarted the reservation must settle on every failure
    // path; prepare touches the DB and the terminal layer, either of which
    // can throw before the cancel-guarded launch block below begins.
    let prepared: { record: AgentRecord; viewersChanged: boolean };
    try {
      prepared = await this.prepareControlRestart(agent, message, reservationId);
    } catch (error) {
      await this.dependencies.quota.cancel(reservationId).catch(() => undefined);
      throw error;
    }
    const readOnly = true;
    // The read-only control process carries its instruction in argv and needs
    // no message channel. A safety interruption must not depend on a research
    // preview, so the replacement never launches Channels — ordinary traffic
    // to a control-paused agent queues exactly as it did before.
    const channels = false;
    let argv: string[];
    // The restarted process is read-only, so it re-mints as a reader at the
    // freshly advanced epoch: the critical control that paused it has already
    // revoked its write and landing rights, and its old token is now stale.
    const capabilityToken = this.dependencies.issueCredential?.(
      agent.name,
      "reader",
      prepared.record.capabilityEpoch,
    );
    // The replacement process only has to read the control message and
    // acknowledge it through Hive's own server; the human's servers would be
    // pure context cost on a process that must not act.
    const excludeMcpServers = identity.tool === "codex"
      ? await this.inheritedCodexMcpServers()
      : [];
    try {
      await provisionSkills(agent.worktreePath, identity.tool);
      if (identity.tool === "claude") {
        // A revoked agent's replacement is read-only, and its deny list is a
        // project-scoped permission rule: untrusted, the CLI drops it.
        await seedClaudeWorktreeTrust(agent.worktreePath);
        await writeClaudeAgentConfig(agent.worktreePath, {
          daemonPort: this.dependencies.port,
          name: agent.name,
          readOnly,
          channels,
        });
        argv = buildClaudeSpawnCommand({
          daemonPort: this.dependencies.port,
          model: identity.model,
          name: agent.name,
          readOnly,
          worktreePath: agent.worktreePath,
          channels,
          executable: this.claudeExecutable,
          scopedMcpConfigPath: claudeMcpConfigPath(agent.worktreePath),
        });
      } else {
        await writeCodexAgentConfig(agent.worktreePath, {
          daemonPort: this.dependencies.port,
          name: agent.name,
          readOnly,
          ...(capabilityToken === undefined ? {} : { capabilityToken }),
        });
        const useAppServer =
          this.dependencies.config.codex?.driver === "app-server" &&
          (await this.dependencies.codexAppServer?.isAvailable() ?? false);
        if (useAppServer) {
          argv = this.dependencies.codexAppServer!.buildHostCommand(
            prepared.record,
            this.dependencies.port,
          );
        } else {
          argv = buildCodexSpawnCommand({
            daemonPort: this.dependencies.port,
            effort: identity.effort,
            model: identity.model,
            name: agent.name,
            readOnly,
            worktreePath: agent.worktreePath,
            excludeMcpServers,
          });
        }
      }
      const controlPrompt = [
        `CRITICAL HIVE CONTROL ${message.id} (capability epoch ${message.capabilityEpoch}).`,
        message.body,
        "Your prior process was stopped and its worktree was preserved.",
        "This process is read-only. Do not resume implementation or landing.",
        `Acknowledge with hive_ack_message using agent=${JSON.stringify(agent.name)}, messageId=${JSON.stringify(message.id)}, capabilityEpoch=${message.capabilityEpoch}.`,
        `Previous assignment for context only: ${agent.taskDescription}`,
      ].join("\n\n");
      const nativeCodex = identity.tool === "codex" &&
        this.dependencies.codexAppServer !== undefined &&
        argv[1] === "codex-app-server-host";
      if (!nativeCodex) argv.push(controlPrompt);
      // The binary that will actually be running in the pane. Reassigned below
      // if the app-server handshake fails and the TUI takes over the session,
      // because readiness looks for *this* process and nothing else.
      let launchedCommand = launchedCommandName(argv);
      await this.dependencies.tmux.newSession(
        agent.tmuxSession,
        agent.worktreePath,
        shellJoin(argv),
      );
      if (nativeCodex) {
        try {
          await this.dependencies.codexAppServer!.startAgent(
            prepared.record,
            controlPrompt,
            readOnly,
            identity.tool === "codex" ? identity.effort : "medium",
          );
        } catch (error) {
          console.error(
            `Hive codex app-server handshake failed for ${agent.name}; falling back to the TUI launch: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
          this.dependencies.codexAppServer!.disconnect(agent.name);
          await this.dependencies.tmux.killSession(agent.tmuxSession, {
            ignoreMissing: true,
          });
          const fallback = buildCodexSpawnCommand({
            daemonPort: this.dependencies.port,
            effort: identity.tool === "codex" ? identity.effort : "medium",
            model: identity.model,
            name: agent.name,
            readOnly,
            worktreePath: agent.worktreePath,
            excludeMcpServers,
          });
          fallback.push(controlPrompt);
          launchedCommand = launchedCommandName(fallback);
          await this.dependencies.tmux.newSession(
            agent.tmuxSession,
            agent.worktreePath,
            shellJoin(fallback),
          );
        }
      }
      const failureReason = await this.monitorControlReadiness(
        prepared.record,
        launchedCommand,
      );
      if (failureReason !== null) throw new Error(failureReason);
      this.dependencies.quota.markStarted(reservationId);
    } catch (error) {
      // The cancel must not preempt the rest of this cleanup: the session
      // kill and the control-paused record are what keep a failed restart
      // from leaving a live process around a revoked agent.
      await this.dependencies.quota.cancel(reservationId).catch(
        (cancelError: unknown) => {
          console.error(
            `Hive failed to cancel control reservation ${reservationId}: ${
              cancelError instanceof Error ? cancelError.message : "unknown error"
            }`,
          );
        },
      );
      await this.dependencies.tmux.killSession(agent.tmuxSession, {
        ignoreMissing: true,
      }).catch(() => undefined);
      const reason = error instanceof Error
        ? error.message
        : "control acknowledgement process failed to launch";
      this.dependencies.db.insertAgent({
        ...prepared.record,
        status: "control-paused",
        writeRevoked: true,
        failureReason: `Critical control ${message.id} restart failed: ${reason}`,
        lastEventAt: new Date().toISOString(),
      });
      if (prepared.viewersChanged) this.dependencies.onTerminalsChanged?.();
      throw new Error(
        `Recorded ${identity.tool}/${identity.model} could not be launched for ${agent.name}: ${reason}`,
      );
    }

    const record = prepared.record;
    let viewersChanged = prepared.viewersChanged;
    if (this.viewersEnabled()) {
      let handle: Awaited<ReturnType<TerminalAdapter["openWindow"]>> | null =
        null;
      try {
        handle = await this.dependencies.terminal.openWindow(
          record.tmuxSession,
          buildAgentTerminalTitle(record.name, record.model),
        );
        const attached = this.dependencies.db.attachTerminalHandle(
          record.id,
          handle,
        );
        if (attached === null) {
          const orphanedHandle = handle;
          handle = null;
          await this.dependencies.terminal.closeWindow(orphanedHandle);
        } else {
          handle = null;
          viewersChanged = true;
        }
      } catch (error) {
        // Opening a viewer is cosmetic and does not affect the restart.
        this.dependencies.onTerminalError?.(
          `hive terminal: could not open viewer for ${record.name}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
        if (handle !== null) {
          try {
            await this.dependencies.terminal.closeWindow(handle);
          } catch {
            // A viewer that vanished during launch needs no further cleanup.
          }
        }
      }
    }
    if (viewersChanged) {
      this.dependencies.onTerminalsChanged?.();
    }
    return this.dependencies.db.getAgentById(record.id) ?? record;
  }

  /** External viewer windows open only when the daemon is not headless *and*
   * no Workspace app currently holds the viewer lease. */
  private viewersEnabled(): boolean {
    return !this.dependencies.config.headless &&
      this.dependencies.workspacePresent?.() !== true;
  }

  private async prepareControlRestart(
    agent: AgentRecord,
    message: AgentMessage,
    reservationId?: string,
    failureReason?: string,
  ): Promise<{ record: AgentRecord; viewersChanged: boolean }> {
    const current = this.dependencies.db.getAgentById(agent.id) ?? agent;
    const previousHandle = current.terminalHandle;
    const record = this.dependencies.db.insertAgent({
      ...current,
      status: "control-paused",
      writeRevoked: true,
      terminalHandle: undefined,
      controlMessageId: message.id,
      controlQuotaReservationId: reservationId,
      failureReason,
      lastEventAt: new Date().toISOString(),
      // The replacement process launches without Channels; the record must
      // agree so the registry never accepts a bridge for this session.
      channelsEnabled: false,
    });
    if (previousHandle !== undefined) {
      try {
        await this.dependencies.terminal.closeWindow(previousHandle);
      } catch {
        // Closing a killed session's viewer is cosmetic; revocation persists.
      }
    }
    return { record, viewersChanged: previousHandle !== undefined };
  }

  private async failClosedControlRestart(
    agent: AgentRecord,
    message: AgentMessage,
    reason: string,
  ): Promise<void> {
    const prepared = await this.prepareControlRestart(
      agent,
      message,
      undefined,
      `Critical control ${message.id} is pending: ${reason}`,
    );
    if (prepared.viewersChanged) this.dependencies.onTerminalsChanged?.();
  }

  private async monitorControlReadiness(
    record: AgentRecord,
    launchedCommand: string,
  ): Promise<string | null> {
    const proof = await watchForProofOfLife(record.tmuxSession, record.lastEventAt, {
      hasSession: (session) => this.dependencies.tmux.hasSession(session),
      capturePane: (session) => this.dependencies.tmux.capturePane(session),
      lastEventAt: () =>
        this.dependencies.db.getAgentById(record.id)?.lastEventAt ?? null,
      codexActivity: () => this.readCodexActivityFor(record),
      launchedProcessAlive: () =>
        this.launchedProcessAlive(record.tmuxSession, launchedCommand),
      launchedCommand,
      wait: (ms) => this.wait(ms),
    });
    return proof.alive ? null : proof.reason;
  }

  /**
   * Is the binary we launched still running inside that pane?
   *
   * Null means we could not tell — no pane, or a `ps` we could not read — and
   * readiness treats that as no evidence rather than as life. The command is the
   * one hive actually launched, never a provider name inferred from the record:
   * the Codex app-server path runs `hive codex-app-server-host`, so looking for
   * a process called "codex" would report every app-server agent as dead.
   */
  private async launchedProcessAlive(
    session: string,
    command: string,
  ): Promise<boolean | null> {
    try {
      const rootPids = await this.dependencies.tmux.listPanePids(session);
      if (rootPids.length === 0) return null;
      const samples = parseProcessTable(
        await (this.dependencies.ps ?? runPs)(),
      );
      if (samples.length === 0) return null;
      return treeRunsCommand(samples, rootPids, command);
    } catch {
      return null;
    }
  }

  /** A codex agent's rollout mtime, or null when there is none to read.
   * Still a positive signal — it just cannot be the only one, because the
   * rollout stays silent for the whole reasoning phase (see readiness.ts). */
  private async readCodexActivityFor(record: AgentRecord): Promise<string | null> {
    const tool = record.executionIdentity?.tool ?? record.tool;
    if (tool !== "codex" || record.worktreePath === null) return null;
    try {
      return await this.readCodexActivity(record.worktreePath);
    } catch {
      return null;
    }
  }

  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    const name = this.claimAgentName(request.name);
    try {
      return await this.spawnReserved(request, name);
    } finally {
      this.dependencies.db.releaseAgentName(name);
    }
  }

  /**
   * Take exclusive hold of a name for the duration of this spawn.
   *
   * The reservation row is the arbiter, not the liveness scan: two spawns that
   * both read an empty agents table still cannot both claim `maya`, because
   * only one `INSERT OR IGNORE` reports a change. Concurrent spawns therefore
   * walk on to different names instead of colliding. A reservation is held for
   * exactly as long as a spawn is in flight, so an in-flight name is as
   * unavailable as a live one — reuse can never race a spawning or recovering
   * agent.
   */
  private claimAgentName(requestedName: string | undefined): string {
    const db = this.dependencies.db;
    if (requestedName !== undefined) {
      const name = resolveAgentName(requestedName, db.listAgents());
      if (!db.reserveAgentName(name)) {
        throw new Error(
          `Agent name collision: "${name}" is already being assigned to a spawning agent`,
        );
      }
      return name;
    }

    // Each pass either claims a name or rules one out, so this terminates:
    // `blocked` only grows, and selectAgentName throws once the pool is spent.
    const blocked = new Set<string>();
    for (;;) {
      const candidate = selectAgentName(db.listAgents(), blocked);
      if (!db.reserveAgentName(candidate)) {
        blocked.add(candidate);
        continue;
      }
      // Holding the reservation, no concurrent spawn can create a live holder
      // for this name, so this check is authoritative rather than racy.
      if (db.getLiveAgentByName(candidate) === null) return candidate;
      db.releaseAgentName(candidate);
      blocked.add(candidate);
    }
  }

  private async spawnReserved(
    request: SpawnRequest,
    name: string,
  ): Promise<AgentRecord> {
    const configuredRoute = await this.dependencies.routing(request.tier);
    let tool = request.tool ?? configuredRoute.tool;
    // An explicit model is bound to its vendor before anything launches: the
    // tier route must never carry a user-named model onto the other vendor's
    // CLI (tier=standard once routed tool=codex under an explicit
    // "claude-opus-4-8" and opened a TUI on a model it can never run). A
    // recognized model forces the matching tool when the caller pinned none,
    // and a caller-pinned conflicting tool refuses the spawn outright. An
    // unrecognizable name stays on the routed tool — it cannot be validated.
    if (request.model !== undefined) {
      const vendor = modelVendor(request.model);
      if (vendor !== null) {
        if (request.tool !== undefined && request.tool !== vendor) {
          throw new Error(
            `Cannot spawn ${name}: model ${JSON.stringify(request.model)} is a ${vendor} model, ` +
              `but tool=${JSON.stringify(request.tool)} was explicitly requested. ` +
              `Drop the tool to run it on ${vendor}, or name a ${request.tool} model.`,
          );
        }
        tool = vendor;
      }
    }
    // The process, durable identity, terminal title, and hive_status all use
    // the same concrete model. A later control restart can therefore replay
    // the launch without consulting aliases or mutable tool defaults.
    // An explicit request model is a user directive: it launches verbatim
    // (no alias resolution) on the spawn's tool and is never substituted.
    let model = request.model ?? await this.modelResolver(tool, configuredRoute);
    let executionIdentity: ExecutionIdentity | undefined;
    let quotaReservationId: string | undefined;
    if (this.dependencies.quota?.config.enabled === true) {
      let candidates: QuotaRouteCandidate[];
      if (request.model !== undefined) {
        // The pinned model is the only candidate, and the spawn is bound to
        // its vendor: switching vendors away from a user-named model would
        // launch something other than what was asked for, and the Fable→Opus
        // release valve is equally a substitution, so neither applies here.
        // Unsafe quota still fails the spawn with the capacity report.
        candidates = [{ tool, model: request.model }];
      } else {
        const [claudeModel, codexModel] = await Promise.all([
          this.modelResolver("claude", configuredRoute),
          this.modelResolver("codex", configuredRoute),
        ]);
        candidates = [
          { tool: "claude", model: claudeModel },
          { tool: "codex", model: codexModel },
        ];
        // Fable draws heavy shared capacity. When a route resolves to it,
        // offer Opus 4.8 as a same-vendor release valve: listed after Fable so
        // ties (including the no-quota-configured default) keep preferring
        // Fable, but real quota pressure on Fable's pool can still pick Opus
        // when it has the better headroom. This does not require the
        // 2026-07-12 default-routing cutover — it applies whenever a route
        // resolves to Fable, explicitly or otherwise.
        if (claudeModel === CLAUDE_BEST_MODEL) {
          candidates.splice(1, 0, { tool: "claude", model: CLAUDE_OPUS_MODEL });
        }
      }
      const explicitTool = request.model !== undefined ? tool : request.tool;
      const decision = await this.dependencies.quota.routeAndReserve({
        agentName: name,
        tier: request.tier,
        preferredTool: configuredRoute.tool,
        ...(explicitTool === undefined ? {} : { explicitTool }),
        ...(request.reviewOfTool === undefined
          ? {}
          : { reviewOfTool: request.reviewOfTool }),
        candidates,
      });
      tool = decision.tool;
      model = decision.model;
      quotaReservationId = decision.reservation.id;
    }
    if (model !== "default") {
      executionIdentity = tool === "claude"
        ? { tool, model }
        : {
            tool,
            model,
            effort: configuredRoute.codex.effort ?? "medium",
          };
    }
    let worktree: CreatedWorktree;
    try {
      worktree = await this.makeWorktree(
        this.dependencies.repoRoot,
        name,
        slugify(request.task),
      );
    } catch (error) {
      if (quotaReservationId !== undefined) {
        await this.dependencies.quota?.cancel(quotaReservationId);
      }
      throw error;
    }
    // The profile is a property of the *project*, not of the branch an agent
    // happens to be on, so it is read from the repo root and generated on demand
    // (SPEC §14) — a fresh clone's first spawn is briefed like any other. A repo
    // whose profile cannot be built degrades to no brief and generic landing
    // wording rather than assuming hive's own doc names or commands.
    const profile = await ensureProfile(this.dependencies.repoRoot).catch((error: unknown) => {
      console.error(
        `Hive could not load the repo profile for ${name}'s worktree; spawning with generic landing wording: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      return null;
    });
    const briefConfig = profile === null ? undefined : {
      briefableDocs: profile.docs.briefable,
      briefableDirectories: profile.docs.briefableDirectories,
      primaryDoc: profile.docs.primary,
    };
    const [memoryIndex, brief] = await Promise.all([
      buildMemoryIndex(worktree.path),
      buildScopedBrief(
        worktree.path,
        request.task,
        briefConfig === undefined ? {} : { config: briefConfig },
      ).catch((error: unknown) => {
        console.error(
          `Hive could not build a scoped brief for ${name}; spawning without one: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
        return "";
      }),
    ]);
    const prompt = buildAgentPrompt(
      name,
      request.task,
      worktree,
      this.dependencies.repoRoot,
      memoryIndex,
      {
        tier: request.tier,
        brief,
        ...(profile === null ? {} : {
          landingCommands: {
            test: profile.commands.test,
            typecheck: profile.commands.typecheck,
          },
        }),
      },
    );
    const channels = await this.useChannels(tool);
    const timestamp = new Date().toISOString();
    const record = this.dependencies.db.insertAgent({
      // A fresh AgentUUID, always. Reusing a closed holder's id would overwrite
      // its row — erasing the very closure record that lets history tell the
      // two agents apart.
      id: crypto.randomUUID(),
      name,
      tool,
      model,
      tier: request.tier,
      status: "spawning",
      taskDescription: request.task,
      worktreePath: worktree.path,
      branch: worktree.branch,
      tmuxSession: agentTmuxSession(name),
      // Unknown, not empty. A fresh agent has not been observed yet, and 0 was a
      // claim we had no basis for — one that survived, unchallenged, for the whole
      // life of any agent whose telemetry we could never read.
      contextPct: null,
      createdAt: timestamp,
      lastEventAt: timestamp,
      ...(quotaReservationId === undefined ? {} : { quotaReservationId }),
      ...(executionIdentity === undefined ? {} : { executionIdentity }),
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      writeRevoked: false,
      channelsEnabled: channels,
    });

    const dangerous = this.dependencies.config.autonomy === "dangerous";
    // Servers the human attached to their own Codex sessions. This agent did
    // not ask for them and pays for them on every message it sends, so the
    // spawn detaches them for its process only.
    const excludeMcpServers = tool === "codex"
      ? await this.inheritedCodexMcpServers()
      : [];
    let argv: string[];
    // A fresh writer is minted at epoch 0 with exactly one landing right, for
    // its own branch. It cannot spawn, approve, kill, or name another agent.
    const capabilityToken = this.dependencies.issueCredential?.(
      name,
      "writer",
      record.capabilityEpoch,
    );
    try {
      await provisionSkills(worktree.path, tool);
      if (tool === "claude") {
        // Before the config, because an untrusted workspace makes the CLI
        // discard the hooks and permissions we are about to write.
        await seedClaudeWorktreeTrust(worktree.path);
        await writeClaudeAgentConfig(worktree.path, {
          daemonPort: this.dependencies.port,
          name,
          readOnly: false,
          dangerous,
          channels,
        });
        argv = buildClaudeSpawnCommand({
          daemonPort: this.dependencies.port,
          model,
          name,
          readOnly: false,
          dangerous,
          worktreePath: worktree.path,
          channels,
          executable: this.claudeExecutable,
          scopedMcpConfigPath: claudeMcpConfigPath(worktree.path),
        });
      } else {
        await writeCodexAgentConfig(worktree.path, {
          daemonPort: this.dependencies.port,
          name,
          readOnly: false,
          ...(capabilityToken === undefined ? {} : { capabilityToken }),
        });
        const useAppServer =
          this.dependencies.config.codex?.driver === "app-server" &&
          (await this.dependencies.codexAppServer?.isAvailable() ?? false);
        argv = useAppServer
          ? this.dependencies.codexAppServer!.buildHostCommand(
              record,
              this.dependencies.port,
            )
          : buildCodexSpawnCommand({
              daemonPort: this.dependencies.port,
              effort: configuredRoute.codex.effort ?? "medium",
              model,
              name,
              readOnly: false,
              dangerous,
              worktreePath: worktree.path,
              excludeMcpServers,
            });
      }
      const nativeCodex = tool === "codex" &&
        this.dependencies.codexAppServer !== undefined &&
        argv[1] === "codex-app-server-host";
      if (!nativeCodex) argv.push(prompt);

      // See the control-restart path: readiness looks for the process hive
      // actually launched, so this must follow the session that wins.
      let launchedCommand = launchedCommandName(argv);
      await this.dependencies.tmux.newSession(
        record.tmuxSession,
        worktree.path,
        shellJoin(argv),
      );
      if (nativeCodex) {
        try {
          await this.dependencies.codexAppServer!.startAgent(
            record,
            prompt,
            false,
            configuredRoute.codex.effort ?? "medium",
          );
        } catch (error) {
          // The binary advertised app-server support but the control process
          // could not complete its handshake. Replace it immediately with the
          // maintained TUI path; tmux paste remains the automatic fallback.
          console.error(
            `Hive codex app-server handshake failed for ${name}; falling back to the TUI launch: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
          this.dependencies.codexAppServer!.disconnect(name);
          await this.dependencies.tmux.killSession(record.tmuxSession, {
            ignoreMissing: true,
          });
          this.dependencies.db.insertAgent({
            ...record,
            status: "spawning",
            lastEventAt: new Date().toISOString(),
          });
          const fallback = buildCodexSpawnCommand({
            daemonPort: this.dependencies.port,
            effort: configuredRoute.codex.effort ?? "medium",
            model,
            name,
            readOnly: false,
            dangerous,
            worktreePath: worktree.path,
            excludeMcpServers,
          });
          fallback.push(prompt);
          launchedCommand = launchedCommandName(fallback);
          await this.dependencies.tmux.newSession(
            record.tmuxSession,
            worktree.path,
            shellJoin(fallback),
          );
        }
      }
      const failureReason = await this.monitorReadiness(record, launchedCommand);
      if (failureReason !== null) {
        return await this.failSpawnIfStillSpawning(
          record,
          worktree,
          failureReason,
        );
      }
      if (quotaReservationId !== undefined) {
        this.dependencies.quota?.markStarted(quotaReservationId);
      }
    } catch (error) {
      const reason = error instanceof Error
        ? error.message
        : "Agent launch failed";
      return await this.failSpawnIfStillSpawning(record, worktree, reason);
    }

    if (this.viewersEnabled()) {
      let handle: Awaited<ReturnType<TerminalAdapter["openWindow"]>> | null =
        null;
      try {
        handle = await this.dependencies.terminal.openWindow(
          record.tmuxSession,
          buildAgentTerminalTitle(record.name, record.model),
        );
        const attached = this.dependencies.db.attachTerminalHandle(
          record.id,
          handle,
        );
        if (attached === null) {
          const orphanedHandle = handle;
          handle = null;
          await this.dependencies.terminal.closeWindow(orphanedHandle);
        } else {
          handle = null;
          this.dependencies.onTerminalsChanged?.();
        }
      } catch (error) {
        // Opening a viewer is cosmetic and does not affect agent readiness.
        this.dependencies.onTerminalError?.(
          `hive terminal: could not open viewer for ${record.name}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
        if (handle !== null) {
          try {
            await this.dependencies.terminal.closeWindow(handle);
          } catch {
            // A viewer that vanished during launch needs no further cleanup.
          }
        }
      }
    }
    return this.dependencies.db.getAgentById(record.id) ?? record;
  }

  private async monitorReadiness(
    record: AgentRecord,
    launchedCommand: string,
  ): Promise<string | null> {
    // Baseline from the live row, not the caller's copy: the app-server
    // fallback re-inserts the record with a fresh lastEventAt, and comparing
    // against a stale snapshot would count that write as a hook event.
    const baselineEventAt =
      this.dependencies.db.getAgentById(record.id)?.lastEventAt ??
        record.lastEventAt;

    const proof = await watchForProofOfLife(record.tmuxSession, baselineEventAt, {
      hasSession: (session) => this.dependencies.tmux.hasSession(session),
      capturePane: (session) => this.dependencies.tmux.capturePane(session),
      lastEventAt: () =>
        this.dependencies.db.getAgentById(record.id)?.lastEventAt ?? null,
      codexActivity: () => this.readCodexActivityFor(record),
      launchedProcessAlive: () =>
        this.launchedProcessAlive(record.tmuxSession, launchedCommand),
      launchedCommand,
      settled: () => !this.isStillSpawning(record.id),
      wait: (ms) => this.wait(ms),
    });
    return proof.alive ? null : proof.reason;
  }

  private isStillSpawning(agentId: string): boolean {
    const current = this.dependencies.db.getAgentById(agentId);
    return current === null || current.status === "spawning";
  }

  private async failSpawnIfStillSpawning(
    record: AgentRecord,
    worktree: CreatedWorktree,
    failureReason: string,
  ): Promise<AgentRecord> {
    const current = this.dependencies.db.getAgentById(record.id);
    if (current !== null && current.status !== "spawning") {
      return current;
    }
    return await this.failSpawn(record, worktree, failureReason);
  }

  private async failSpawn(
    record: AgentRecord,
    worktree: CreatedWorktree,
    failureReason: string,
  ): Promise<AgentRecord> {
    const failedAt = new Date().toISOString();
    let failed = this.dependencies.db.insertAgent({
      ...record,
      status: "failed",
      failureReason,
      failedAt,
      lastEventAt: failedAt,
    });
    if (record.quotaReservationId !== undefined) {
      // This agent never became a working agent, so the route it was launched on
      // is suspect until one does. Quota records it against that route and passes
      // the route over for automatic selection until it proves itself again —
      // headroom alone was never enough to call a route eligible.
      await this.dependencies.quota?.cancel(
        record.quotaReservationId,
        failedAt,
        failureReason,
      );
    }
    const cleanupErrors: string[] = [];
    let preserved: string | null = null;

    try {
      await this.dependencies.tmux.killSession(record.tmuxSession, {
        ignoreMissing: true,
      });
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : "tmux cleanup failed",
      );
    }

    // Never delete work to tidy up after ourselves.
    //
    // This path force-removed the worktree and force-deleted its branch
    // unconditionally, so a launch Hive *believed* had failed destroyed
    // everything the agent had actually written — which is exactly what a false
    // death did to a live agent's worktree. The judgement of whether a spawn
    // succeeded is fallible; the destruction of committed work is not
    // reversible, and those two facts must never be wired together. So we ask
    // first, with the same probe the close and kill paths already use.
    //
    // An empty worktree is still cleaned up: a genuinely dead launch wrote
    // nothing, and leaving debris behind for every failed spawn would be its own
    // bug. Only work survives.
    if (!(this.dependencies.keepWorktreeOnFailure ?? false)) {
      const stranded = await this.assessStranded(
        this.dependencies.repoRoot,
        worktree.path,
        worktree.branch,
      ).catch(() => null);

      // A probe that could not answer is treated as "there might be work".
      // Guessing wrong in that direction costs a stale directory; guessing wrong
      // in the other costs the work itself.
      const hasWork = stranded === null ||
        stranded.dirtyFiles.length > 0 || stranded.unmergedCommits > 0;

      if (hasWork) {
        const detail = stranded === null
          ? "its contents could not be checked"
          : `${stranded.dirtyFiles.length} uncommitted file(s), ` +
            `${stranded.unmergedCommits} unmerged commit(s)`;
        preserved =
          `Kept the worktree at ${worktree.path} (branch ${worktree.branch}): ` +
          `${detail}. Nothing was discarded.`;
      } else {
        try {
          await this.cleanupWorktree(
            this.dependencies.repoRoot,
            worktree.path,
            { deleteBranch: true },
          );
        } catch (error) {
          cleanupErrors.push(
            error instanceof Error ? error.message : "worktree cleanup failed",
          );
        }
      }
    }

    const notes = [
      ...(preserved === null ? [] : [preserved]),
      ...(cleanupErrors.length > 0
        ? [`Cleanup failed: ${cleanupErrors.join("; ")}`]
        : []),
    ];
    if (notes.length > 0) {
      failed = this.dependencies.db.insertAgent({
        ...failed,
        failureReason: `${failureReason}\n${notes.join("\n")}`,
      });
    }
    return failed;
  }
}
