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
  wrapCodexSpawnWithCapabilityEnv,
  writeCodexAgentConfig,
} from "../adapters/tools/codex";
import { listInheritedCodexMcpServers } from "../adapters/tools/mcp-scope";
import type { CodexAppServerManager } from "../adapters/tools/codex-app-server";
import { provisionSkills } from "../adapters/skills";
import {
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
  type CapabilityRecord,
  type HiveConfig,
  type Route,
  type RoutingPins,
  type RoutingTier,
  splitVariant,
} from "../schemas";
import type { HiveDatabase } from "./db";
import { readCodexTelemetry } from "./tool-telemetry";
import { readinessFailureLayer } from "./launch-failure";
import type { LaunchFailureLayer } from "./launch-failure";
import { promptArgument, writeLaunchPrompt } from "./launch-prompt";
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
import { validateEffort } from "./effort";
import type { CapabilityDiscoveryResult } from "./capability-discovery";
import type { GoverningRoute, RoutingIo } from "./routing-resolve";
import {
  poolAvailability,
  spendRisk,
  type AccountBilling,
} from "./usage-credits";
import { readCostConsent, requestCostConsent } from "./cost-consent";

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
  // The spend guard asks through the approvals queue Hive already has, rather
  // than inventing a second way to ask the user for permission.
  | "getApproval"
  | "insertApproval"
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
type CapabilityDiscoverer = (
  provider: "claude" | "codex",
) => Promise<CapabilityDiscoveryResult>;

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
  /**
   * A static route table, for embedders and tests that construct their own.
   * Production does not wire this: there is no shipped table to resolve from,
   * so a live spawn is governed by `governingRoute` or refused.
   */
  routing?: RouteResolver;
  /**
   * The derivation engine's answer for this spawn: per-column cells whose
   * `model: null` means REFUSE with the cell's reason. There is no table to
   * fall back to — a cell nothing could author fails the spawn, loudly.
   */
  governingRoute?: (
    tier: RoutingTier,
    io: RoutingIo,
  ) => Promise<GoverningRoute | null>;
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
  /** Live account capability records used only after the final model is chosen. */
  discoverCapabilities?: CapabilityDiscoverer;
  /** User pins before the shipped table is merged underneath them. */
  routingPins?: () => Promise<RoutingPins>;
  /**
   * The account's live pool readings. The release valve is derived from these —
   * from the pools the provider actually meters — rather than from a model name.
   */
  readBilling?: (
    provider: "claude" | "codex",
  ) => Promise<AccountBilling | null>;
  /**
   * The per-repo graphify MCP server's URL, or null when there is nothing
   * healthy to attach (docs/architecture/graphify-integration.md). Read
   * synchronously at spawn time and never awaited: a broken graph means the
   * agent spawns without graph tools, noted, never a slower or failed spawn.
   * Absent (tests, unwired embedders), spawning is bit-identical.
   */
  graphifyUrl?: () => string | null;
  /**
   * The layer-1 graph digest for a task, or null for repos that never opted
   * in. Hard-bounded inside (query token budget + time-box), so awaiting it
   * beside the scoped brief adds at most the time-box to a spawn; a throw
   * degrades to no digest, never a failed spawn.
   */
  graphifyBrief?: (task: string) => Promise<string | null>;
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

/** The karpathy guidelines' rules, carried in the prompt rather than left to the
 * `karpathy-guidelines` skill to be self-invoked.
 *
 * Skills are progressively disclosed: an agent sees a name and a description and
 * chooses whether to open the body. Measured over every agent spawned on
 * 2026-07-11 that was actually offered the skill, 5 of 23 opened it — 21% of
 * claude agents, 22% of codex. So four agents in five never read a rule Hive
 * believed it had given them, and nothing failed loudly when they didn't. A
 * behavioural guarantee that depends on the agent electing to receive it is not
 * a guarantee, which is why these rules travel with the prompt: every agent has
 * them before its first turn, on both vendors, at a cost of ~560 tokens a spawn.
 *
 * Like the concise landing protocol, this is a rewrite rather than a subset — no
 * rule is dropped, only the narration and worked examples, which stay in the
 * skill for the agent that wants the long form. */
export const CODING_GUIDELINES = [
  "Coding guidelines (these are not optional; the karpathy-guidelines skill holds the long form):",
  "1. Think before coding. State your assumptions; if you are uncertain, ask. If a request has several readings, present them — never pick one silently. If a simpler approach exists, say so and push back. If something is unclear, stop and name it.",
  "2. Simplicity first. Write the minimum code that solves the problem and nothing speculative: no features beyond what was asked, no abstractions for single-use code, no unrequested flexibility or configurability, no error handling for impossible cases. If it is 200 lines and could be 50, rewrite it. Ask: would a senior engineer call this overcomplicated?",
  "3. Surgical changes. Touch only what you must. Do not 'improve' adjacent code, comments, or formatting; do not refactor what is not broken; match the existing style even where yours differs. Unrelated dead code gets mentioned, not deleted. Remove only the orphans your own change created. Every changed line must trace to the request.",
  "4. Goal-driven execution. Turn the task into a verifiable goal before you start ('fix the bug' → 'write a test that reproduces it, then make it pass'), and state a brief plan whose every step names its check. Loop until verified.",
  "These bias toward caution over speed; on a trivial task, use judgment.",
].join("\n");

/** Hive's non-negotiable protocol rules.
 *
 * These lived only in `.hive/memory`, which is committed to *this* repo and so
 * travels with it — but a user installing Hive into their own repo starts with
 * zero memories, and every one of these rules was therefore invisible to them.
 * A rule that exists only as a memory is a note, not a behaviour. They ship in
 * the prompt for the same reason the coding guidelines do: no agent should have
 * to elect to receive them.
 *
 * Rules 1 and 2 are additionally enforced where they are *decided* rather than
 * merely stated — `hive_send`'s tool description carries them, so an agent meets
 * them at the moment it picks a priority, not as something it had to remember.
 * Rules 3 and 4 are epistemic and have no such choke point: they are prose, and
 * prose is the weaker guarantee. */
export const HIVE_PROTOCOL_RULES = [
  "Hive protocol (non-negotiable):",
  "1. Urgent is a turn kill, not a fast lane. An urgent or critical message CANCELS the recipient's in-flight turn, which is never resumed — the reasoning so far is discarded. Send ordinary guidance as normal; reserve urgent for genuine preemption.",
  "2. Sent is not stopped. There is no preemption inside a running tool call: the boundary arrives only when the call returns, so an agent inside a 60-minute command holds your urgent — or your critical stop — for up to 60 minutes. Never report an agent as stopped or informed until it has acknowledged.",
  '3. An absent field is unknown, never false. A missing or misspelled key does not raise — it reads back as "no". Before trusting a negative, prove your reader can see a positive (a positive control): an all-empty result is usually a bad key, not an empty world.',
  '4. Measure, do not infer. Never accept an ACT as proof of a STATE: "the command exited 0" is not "the message was received"; "the skill shipped" is not "the agent read it"; "the screen redrew" is not "the agent is alive". Read the thing that records the state.',
].join("\n");

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
      `3. ${verify.test} and typecheck with ${verify.typecheck}; ${verify.typecheckBackstop}, so a green suite alone can carry a type error onto ${mainBranch}. Skip both only if \`git diff --name-only ORIG_HEAD..HEAD\` lists \`.md\` files alone. Red tests never merge, and neither do type errors: fix them, or commit and report the failure. Exception: a red proven identical on unmodified ${mainBranch} is pre-existing and does not block — note it and proceed; any other red still blocks.`,
      `4. Call \`hive_land\` with agent \`${agentName}\`, capabilityEpoch \`${capabilityEpoch}\`. Never merge into the primary checkout yourself.`,
      `5. Rejected because ${mainBranch} moved? Back to step 2, at most ${LANDING_MAX_ATTEMPTS} attempts, then message "${ORCHESTRATOR_NAME}".`,
      `6. Report the merge commit hash. Leave your branch and worktree in place.`,
    ].join("\n");
  }
  return [
    `When your task is complete and the tests are green, land your work on ${mainBranch} immediately — finished work left on your branch is lost work:`,
    `1. Commit everything on your branch (${branch}); never leave work uncommitted.`,
    `2. Rebase onto the latest ${mainBranch}: run \`git rebase ${mainBranch}\` in your worktree. If the rebase hits conflicts, run \`git rebase --abort\` and message "${ORCHESTRATOR_NAME}" naming the conflicting files — never force anything and never resolve another agent's code alone.`,
    `3. ${verify.test} on the rebased branch, and typecheck it with ${verify.typecheck}. Both must pass. ${verify.typecheckBackstop}, so a green suite alone will carry a type error onto ${mainBranch}: two agents whose work was separately green merge into a duplicate symbol that no test can see. You may skip both checks only when \`git diff --name-only ORIG_HEAD..HEAD\` — what the rebase pulled in — lists nothing but \`.md\` files that no test reads: your pre-rebase green run still holds, so go straight to step 4. Red tests never merge, and neither do type errors: fix them on your branch, or commit what you have and report the failure instead. The one exception: a red test proven identical on unmodified ${mainBranch} — checkout ${mainBranch} in a scratch copy, run it, same failure, unrelated to your change — is pre-existing, not yours to fix, and does not block; name it in your report and proceed. Any other red — one that passes on ${mainBranch}, or one you have not actually checked there — blocks like any other.`,
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
  /** Task-scoped knowledge-graph digest, injected by the daemon so the graph
   * pays out with zero agent compliance (integration doc, layer 1). Either
   * the digest or its one-line unavailability note; absent for repos that
   * never opted in. */
  graphBrief?: string;
  /** True only when the graphify MCP server is being attached to this spawn,
   * so the one-sentence directive (layer 2) never advertises tools the agent
   * does not have. */
  graphifyTools?: boolean;
  /** The repo profile's verify commands, so the landing gate names this repo's
   * concrete test/typecheck commands instead of a hardcoded guess (SPEC §14). */
  landingCommands?: LandingCommands;
}

/** Layer 2 of the integration doc's adoption strategy: exactly one directive,
 * in the spawn prompt — the channel agents demonstrably read — not a skill.
 * Graph-first is the product decision; the concrete fallback criteria are
 * what keep it honest — a mandate agents catch being wrong is a mandate they
 * learn to skip (measured: 22% skill adoption). */
const GRAPHIFY_DIRECTIVE =
  "This repo serves a graphify knowledge graph over MCP, and the Graph locate " +
  "section of your brief was built from it for your task. Work graph-first: start " +
  "from those NODE lines (each cites file:line) and walk outward with the graph " +
  "tools — get_neighbors for what calls, imports, or contains a symbol; " +
  "shortest_path for how two files connect; query_graph with token_budget: 16000 " +
  "for broad sweeps (its default of 2000 cuts the output off before the cited " +
  "EDGE lines). For a new locate-question mid-task (\"where does X happen\"), " +
  "call the hive tool graph_locate with the question before reaching for search — " +
  "it runs the same locate that built your brief, and it says so honestly when it " +
  "has no strong leads. Fall back to grep/rg/Glob only when the graph genuinely " +
  "cannot answer: hunting an exact string or error message, files the graph does " +
  "not index (docs, config, generated code), a graph_locate answer that reported " +
  "no strong leads, or a graph lead that turned out empty when you verified it. " +
  "Every graph answer is a lead — confirm it in source before building on it.";

/** Measured 2026-07-12: an agent's three repo-wide searches allocated 13-14 GB
 * each and were killed by the watchdog; it read each opaque death as "too
 * narrow" and widened the pattern, walking back into the wall twice. The
 * allocation lives in the CLI's own bundled search binary, so Hive cannot patch
 * it — the only lever is telling every agent the rule before it searches, in
 * the prompt they demonstrably read rather than a skill (22% adoption). */
export const SEARCH_HYGIENE =
  "Search hygiene: a repo-wide search with an unanchored pattern — one leading " +
  "with `.*` or `.{0,N}` — can allocate tens of GB on a large tree, and Hive's " +
  "memory watchdog will kill it. Anchor patterns on a real literal, scope the " +
  "search to the directory that can hold the answer (src/, not the repo root), " +
  "and stay out of build, vendor, and dependency trees. If a search is killed " +
  "for memory, never re-run it wider: a wider pattern is a bigger allocation, " +
  "not a better search.";

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
        `If the task exceeds your model — a genuine capability wall after at least two distinct failed approaches, not a scope surprise — commit your WIP, then call hive_escalate once with the evidence and a handoff. Keep working until the orchestrator answers. Never grind on under-powered, and never quietly lower the quality bar instead.`,
        CONTINUOUS_EXECUTION,
      ]
    : [
        `You are ${name}, a Hive writer agent.`,
        `Your task: ${task}`,
        `Your file scope is your worktree at ${worktree.path}; do all code and file work there.`,
        "Use the Hive MCP tools hive_send, hive_inbox, and hive_status to message and coordinate with other named agents.",
        `Send concise completion reports, blockers, and important findings to "${ORCHESTRATOR_NAME}" with hive_send; reference large artifacts instead of pasting them.`,
        `Read only what the task needs: search for the lines that matter instead of reading large files whole, and reuse artifacts other agents already wrote instead of re-deriving them. If the task proves substantially larger than briefed, stop and report to "${ORCHESTRATOR_NAME}" rather than grinding.`,
        `If the task exceeds your model — a genuine capability wall after at least two distinct failed approaches, not a scope surprise (that is a stop-and-report) — commit your WIP to your branch, then call hive_escalate once with the evidence (why, and what you tried) and a handoff (goal, done, remaining, decisions). Keep working until the orchestrator answers; it may respawn the task on a stronger model with your handoff or tell you to continue. Never grind on under-powered, and never quietly lower the quality bar instead. Escalations are recorded and measured.`,
        CONTINUOUS_EXECUTION,
      ];
  return [
    ...preamble,
    // Every tier, including `cheap`: the trimmed prompt drops narration, never a
    // rule, and a small model is the one that can least afford to infer these.
    CODING_GUIDELINES,
    HIVE_PROTOCOL_RULES,
    SEARCH_HYGIENE,
    buildLandingProtocol(
      worktree.branch, repoRoot, "main", name, 0, concise, options.landingCommands,
    ),
    ...(options.brief === undefined || options.brief === ""
      ? []
      : [options.brief]),
    ...(options.graphBrief === undefined || options.graphBrief === ""
      ? []
      : [options.graphBrief]),
    ...(options.graphifyTools === true ? [GRAPHIFY_DIRECTIVE] : []),
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
   * Discovery, at most once per provider per minute.
   *
   * Both the effort resolver and the release valve need the same catalog, and a
   * probe spawns a CLI. It is free in money but not in time, and asking the same
   * question twice per launch is just slow.
   */
  private readonly capabilityCache = new Map<
    string,
    { at: number; result: CapabilityDiscoveryResult }
  >();

  private async discoverOnce(
    provider: "claude" | "codex",
  ): Promise<CapabilityDiscoveryResult | undefined> {
    const discover = this.dependencies.discoverCapabilities;
    if (discover === undefined) return undefined;
    const cached = this.capabilityCache.get(provider);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < 60_000) return cached.result;
    const result = await discover(provider);
    this.capabilityCache.set(provider, { at: now, result });
    return result;
  }

  /**
   * The same-vendor model to offer beside a heavy primary, or `null` for none.
   *
   * This used to be `if (claudeModel === CLAUDE_BEST_MODEL)` — a model NAME
   * standing in for a claim about capacity, in the same comment as (and written
   * on the same non-evidence as) the billing claim that turned out to be false and
   * quietly misrouted the deep tier for forty minutes. The claim itself is TRUE;
   * what was wrong was that nobody had checked it, and a constant cannot notice
   * when the vendor changes the arrangement underneath it.
   *
   * MEASURED 2026-07-12 against claude 2.1.207, surface `get_usage`
   * (`rate_limits`), with the user's own Fable agents plus a controlled burst:
   *
   *   baseline                 five_hour 20%   seven_day 11%   Fable pool 15%
   *   after 8 Fable prompts    five_hour 22%   seven_day 11%   Fable pool 15%
   *   after 8 Opus prompts     five_hour 23%   seven_day 11%   Fable pool 15%
   *
   * No Opus generation ran during the Fable window, so the +2% on the SHARED
   * five-hour pool is Fable's. Fable therefore draws on shared capacity AND is
   * capped separately (`model_scoped`) — both, not either, exactly as the user
   * said. The valve's rationale is real. (Its own weekly pool did not move at the
   * surface's 1% resolution in a 90-second window; across the night's real work it
   * climbed 12% → 15%. The RELATIVE size of the two draws is therefore not
   * measurable from this surface, and nothing here pretends it is.)
   *
   * So the trigger is now the vendor's own metering: a model the provider gives a
   * dedicated pool is a model the provider itself considers heavy. Read live, it
   * follows the vendor automatically — if Fable's cap disappears tomorrow the
   * valve stops firing for it, and if some future model gains one, the valve
   * applies to that model without anyone editing a constant. The alternative is
   * the account's *discovered* default rather than a hardcoded Opus, for the same
   * reason.
   */
  private async releaseValveAlternative(
    claudeModel: string,
  ): Promise<string | null> {
    const [discovery, billing] = await Promise.all([
      this.discoverOnce("claude"),
      this.dependencies.readBilling?.("claude"),
    ]);

    // Without a live reading there is no valve: the compiled-in name pair that
    // used to answer here was predetermined model knowledge, and it is gone.
    // Degrading to "no alternative offered" costs one downshift opportunity;
    // inventing one from a constant costs the design.
    if (
      discovery === undefined || discovery.status !== "ok" ||
      billing === undefined || billing === null
    ) {
      return null;
    }

    const base = splitVariant(claudeModel).base;
    const record = discovery.records.find((candidate) =>
      candidate.canonicalId === base || candidate.launchToken === base ||
      candidate.aliases.includes(claudeModel)
    );
    // The billing surface names a model only by its display name. Without one we
    // cannot ask whether it is separately metered — unknown, and unknown offers
    // no valve rather than a name Hive was never told.
    if (record?.displayName == null) {
      return null;
    }

    const separatelyMetered =
      billing.modelUtilization[record.displayName.toLowerCase()] !== undefined;
    if (!separatelyMetered) return null;

    const fallbackModel = discovery.effectiveDefault.model;
    if (fallbackModel.state !== "known") return null;
    // A valve that offers the model it is relieving is not a valve.
    return fallbackModel.value === base ? null : fallbackModel.value;
  }

  /**
   * Would this AUTOMATIC route spend the user's real money? Returns the refusal,
   * or `null` to proceed.
   *
   * This is the live spawn path's copy of the rule — and the point of it being
   * here at all. The guard already governed the derived table and `hive routing`,
   * and neither of those launches anything: a guard that is correct, tested,
   * green and never consulted is indistinguishable from one that works, right up
   * until the day it matters. The launch path consults it now.
   *
   *   plan headroom            -> go; the plan already covers it
   *   pool spent + credits ON  -> ASK, through the approvals queue
   *   pool spent + credits OFF -> nothing can pay for it
   *   not measurable           -> do not AUTO-route; a pin still works
   *
   * Claude proves when credits are off. Codex does not: its credits snapshot says
   * whether a balance exists now, while the server-side auto-top-up switch is not
   * exposed. The shared rule therefore remains unchanged — headroom goes, an
   * exhausted pool that might be paid asks — while the Codex reader reports that
   * unobservable switch honestly instead of turning `balance: "0"` into false
   * confidence that nothing can pay.
   */
  private async spendRefusal(
    tool: "claude" | "codex",
    model: string,
  ): Promise<string | null> {
    const readBilling = this.dependencies.readBilling;
    // Older embedders that do not install a billing reader retain their previous
    // behavior. The real daemon always installs one for both providers.
    if (readBilling === undefined) return null;
    const billing = await readBilling(tool);

    const discovery = await this.discoverOnce(tool);
    const base = splitVariant(model).base;
    const record = discovery?.status === "ok"
      ? discovery.records.find((candidate) =>
        candidate.canonicalId === base || candidate.launchToken === base ||
        candidate.aliases.includes(model)
      )
      : undefined;

    // AVAILABILITY FIRST, and it is not a money question. A model whose own pool
    // is spent when nothing can pay for the overflow is refused by the vendor, not
    // billed — so it cannot run, and it must not win a spawn just because it is
    // free. No consent is requested: there is nothing to consent to.
    if (billing !== null && record?.displayName != null) {
      const availability = poolAvailability(billing, record.displayName);
      if (availability.state === "exhausted") {
        return `${model} cannot run: ${availability.detail}`;
      }
    }

    // The billing surface names a model only by its display name, so without one
    // the spawn cannot be joined to a pool: unknown, and unknown never authorises
    // a charge.
    const risk = billing === null
      ? {
        state: "unknown" as const,
        detail: `Hive could not read ${tool} plan or billing state, so it cannot ` +
          "rule out a charge",
      }
      : record?.displayName == null
      ? {
        state: "unknown" as const,
        detail: `Hive cannot join ${model} to a plan pool, so it cannot rule out ` +
          "a charge",
      }
      : spendRisk(billing, record.displayName);
    if (risk.state === "no-spend") return null;

    const canonicalId = record?.canonicalId ?? base;
    if (readCostConsent(this.dependencies.db, canonicalId) === "approved") {
      return null;
    }
    // Ask once, through the queue he already answers. Pending is not a yes.
    requestCostConsent(this.dependencies.db, canonicalId, risk.detail);
    return `${model} would spend your money: ${risk.detail}. Choosing this model ` +
      "is not the same as agreeing to be charged for it, so Hive asks once and " +
      "remembers — approve the request in the approvals queue (hive_approvals) " +
      "and it will not ask again";
  }

  private async resolveSpawnEffort(
    request: SpawnRequest,
    route: Route | undefined,
    tool: "claude" | "codex",
    model: string,
    observed?: {
      pins: RoutingPins;
      discovery: CapabilityDiscoveryResult | undefined;
      /** The derivation engine governs, so the cell's effort is the engine's
       * own ladder result rather than a table column. */
      routeAuthoritative?: boolean;
      /** The governed cell's effort, verbatim from the engine. */
      routedEffort?: string;
    },
  ): Promise<string | undefined> {
    const pins = observed?.pins ?? await this.dependencies.routingPins?.() ?? {};
    const pinned = pins[request.tier]?.[tool]?.effort;
    const discoveryConfigured = this.dependencies.discoverCapabilities !== undefined;
    const discovery = observed?.discovery ?? await this.discoverOnce(tool);
    const records = discovery?.status === "ok" ? discovery.records : [];
    const base = splitVariant(model).base;
    const record: CapabilityRecord | undefined = records.find((candidate) =>
      candidate.launchToken === base || candidate.canonicalId === base ||
      candidate.aliases.includes(model) || candidate.aliases.includes(base)
    );

    const requested = request.effort ?? pinned;
    if (requested !== undefined) {
      const validated = validateEffort(record, model, requested);
      if (discoveryConfigured && validated.warning !== undefined) {
        console.warn(validated.warning);
      }
      return validated.effort;
    }
    // Under the derivation engine the CELL's effort is authoritative. The
    // engine already walked the effort ladder for the model it resolved (pin →
    // tier effort policy, grounded in the live record → the pairing rungs) and
    // its answer arrived with the cell. Re-deriving it here from the raw
    // catalog would let `hive routing` print one effort while the argv carried
    // another. Validation still runs: the router proposes, the model's own
    // record disposes.
    if (observed?.routeAuthoritative === true) {
      const routed = observed.routedEffort;
      if (routed === undefined) return undefined;
      const validated = validateEffort(record, model, routed);
      if (discoveryConfigured && validated.warning !== undefined) {
        console.warn(validated.warning);
      }
      return validated.effort;
    }

    if (tool === "claude") return undefined;

    const discoveredDefault = record?.defaultEffort.state === "known"
      ? record.defaultEffort.value
      : undefined;
    const fallback = discoveredDefault ?? route?.codex.effort ?? "medium";
    const validated = validateEffort(record, model, fallback);
    if (discoveryConfigured && validated.warning !== undefined) {
      console.warn(validated.warning);
    }
    return validated.effort;
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
      identity.tool !== agent.tool || identity.model !== agent.model ||
      (identity.tool === "claude" && identity.effort === undefined)
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
          effort: identity.effort,
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
            withCapabilityToken: capabilityToken !== undefined,
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
      // The control order enters through the launch shell, never an argv: it
      // carries the agent's whole prior assignment and is bounded by nothing.
      const promptSuffix = ` ${
        promptArgument(await writeLaunchPrompt(agent.tmuxSession, controlPrompt))
      }`;
      // The token value enters through the launch shell, never an argv.
      const restartWorktreePath = agent.worktreePath;
      const withCapabilityEnv = (command: string): string =>
        identity.tool === "codex" && !nativeCodex &&
          capabilityToken !== undefined
          ? wrapCodexSpawnWithCapabilityEnv(command, restartWorktreePath)
          : command;
      // The binary that will actually be running in the pane. Reassigned below
      // if the app-server handshake fails and the TUI takes over the session,
      // because readiness looks for *this* process and nothing else.
      let launchedCommand = launchedCommandName(argv);
      await this.dependencies.tmux.newSession(
        agent.tmuxSession,
        agent.worktreePath,
        withCapabilityEnv(shellJoin(argv) + (nativeCodex ? "" : promptSuffix)),
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
            withCapabilityToken: capabilityToken !== undefined,
          });
          launchedCommand = launchedCommandName(fallback);
          const fallbackCommand = shellJoin(fallback) + promptSuffix;
          const fallbackShell = capabilityToken !== undefined
            ? wrapCodexSpawnWithCapabilityEnv(
              fallbackCommand,
              agent.worktreePath,
            )
            : fallbackCommand;
          await this.dependencies.tmux.newSession(
            agent.tmuxSession,
            agent.worktreePath,
            fallbackShell,
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
    } catch (error) {
      await this.settleStrandedReservation(name);
      throw error;
    } finally {
      this.dependencies.db.releaseAgentName(name);
    }
  }

  /**
   * A spawn that threw may not walk away still holding capacity.
   *
   * The booking is made before the agent row is written, and every throw in
   * between stranded it: with no row, the dead-agent sweep reads the
   * reservation as a spawn still in flight and skips it, so nothing reclaimed
   * it until its six-hour TTL — long enough for a phantom to refuse a spawn
   * Hive had room for. The old defence was a cancel at each throw site we had
   * thought of, which is a defence that only ever covers the sites we had
   * thought of: a `buildMemoryIndex` that rejected on a bad worktree, and an
   * `insertAgent` that hit the database, both walked straight past it.
   *
   * So the guard is asked at the one place every failure must pass — and it
   * asks the LEDGER what the name is still holding rather than trusting a
   * pointer the caller threaded down, which is the same question
   * `settleReservationsOfDeadAgents` asks, and for the same reason. A statement
   * added to that window later cannot reintroduce the leak.
   *
   * `cancel` is the honest settle either way: a booking that never started is
   * released, and one that had already proved life is reconciled at its
   * estimate rather than silently refunded.
   */
  private async settleStrandedReservation(name: string): Promise<void> {
    const quota = this.dependencies.quota;
    if (quota === undefined) return;
    const held = quota.ledger.getActiveReservationForAgent(name);
    if (held === null) return;
    await quota.cancel(held.id).catch((error: unknown) => {
      console.error(
        `Hive failed to settle the stranded quota reservation for ${name}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
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
    // What governs this spawn: the derivation engine (live discovery + pins +
    // last-known-good), and nothing else. There is no shipped table — a cell
    // the engine could not author arrives as `model: null` with its refusal
    // reason, and this spawn fails on it rather than launching a baked-in
    // guess. The static `routing` dependency survives only for embedders and
    // tests that construct their own table.
    const governing = (await this.dependencies.governingRoute?.(request.tier, {
      discover: (provider) => this.discoverOnce(provider),
      readBilling: async (provider) =>
        (await this.dependencies.readBilling?.(provider)) ?? null,
    })) ?? null;
    // A conflict the router resolved silently is a lie: a pin it could not vouch
    // for, a model it refused to pay for. Said out loud, on the launch it governs.
    for (const note of governing?.notes ?? []) {
      console.warn(`Routing ${request.tier}: ${note}`);
    }
    const configuredRoute = governing === null
      ? await this.dependencies.routing?.(request.tier)
      : undefined;
    if (governing === null && configuredRoute === undefined) {
      throw new Error(
        `Cannot spawn ${name}: no routing source is configured (no derivation ` +
          "engine and no static table)",
      );
    }
    const preferredTool = governing?.tool ?? configuredRoute!.tool;
    // Resolves one column's launch token. A governed cell carries the engine's
    // value verbatim (`null` = refuse, with the cell's reason); the legacy path
    // resolves a table entry through the tool's own config. `resolveConcreteModel`
    // reads only `route[tool].model`, so the synthetic Route below is just an
    // adapter around a single concrete string.
    const columnModel = async (
      candidateTool: "claude" | "codex",
    ): Promise<string | null> => {
      if (governing !== null) {
        const cell = governing.cells[candidateTool];
        if (cell.model === null) return null;
        return await this.modelResolver(candidateTool, {
          tool: candidateTool,
          claude: { model: cell.model },
          codex: { model: cell.model },
        });
      }
      return await this.modelResolver(candidateTool, configuredRoute!);
    };
    let tool = request.tool ?? preferredTool;
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
    let model: string;
    if (request.model !== undefined) {
      model = request.model;
    } else {
      const resolved = await columnModel(tool);
      if (resolved === null) {
        // THE REFUSAL. Nothing could author this cell and nothing is invented:
        // the engine's reason names what Hive needs (a vendor CLI to discover
        // from, or a pin), and the spawn fails with it instead of launching a
        // model no source vouched for.
        throw new Error(
          `Cannot spawn ${name}: no ${tool} route for ${request.tier} — ` +
            `${governing!.cells[tool].reason}`,
        );
      }
      model = resolved;
    }
    let executionIdentity: ExecutionIdentity | undefined;
    let quotaReservationId: string | undefined;
    let effort: string | undefined;
    let effortResolved = false;
    const effortPins = await this.dependencies.routingPins?.() ?? {};
    const discoveries = new Map<
      "claude" | "codex",
      Promise<CapabilityDiscoveryResult | undefined>
    >();
    const resolveEffort = async (
      candidateTool: "claude" | "codex",
      candidateModel: string,
    ): Promise<string | undefined> => {
      let discovery = discoveries.get(candidateTool);
      if (discovery === undefined) {
        // One cache for every consumer of the catalog — the effort resolver and
        // the release valve ask the same question, and a probe spawns a CLI.
        discovery = this.discoverOnce(candidateTool);
        discoveries.set(candidateTool, discovery);
      }
      const routedEffort = governing?.cells[candidateTool].effort;
      return await this.resolveSpawnEffort(
        request,
        configuredRoute,
        candidateTool,
        candidateModel,
        {
          pins: effortPins,
          discovery: await discovery,
          routeAuthoritative: governing !== null,
          ...(routedEffort === undefined ? {} : { routedEffort }),
        },
      );
    };
    // An explicit model is the sole candidate, so its capability eligibility is
    // knowable before quota. Reject it before reserving any capacity.
    if (request.model !== undefined) {
      effort = await resolveEffort(tool, model);
      effortResolved = true;
    }
    if (this.dependencies.quota?.config.enabled === true) {
      let candidates: QuotaRouteCandidate[];
      if (request.model !== undefined) {
        // The pinned model is the only candidate, and the spawn is bound to
        // its vendor: switching vendors away from a user-named model would
        // launch something other than what was asked for, and the Fable→Opus
        // release valve is equally a substitution, so neither applies here.
        // Unsafe quota still fails the spawn with the capacity report.
        candidates = [{
          tool,
          model: request.model,
          ...(effort === undefined ? {} : { effort }),
        }];
      } else {
        const [claudeModel, codexModel] = await Promise.all([
          columnModel("claude"),
          columnModel("codex"),
        ]);
        if (governing !== null) {
          // A refused column contributes NO candidate — quota must never rank a
          // cell whose own engine said "nothing vouches for this". The chain
          // remainders ride after their primary, same shape as ever, so ties
          // and the no-quota case still prefer the primary while real pressure
          // lets quota pick on headroom. (The chain is empty until the
          // benchmark surface or user policy supplies an ordered list.)
          candidates = [
            ...(claudeModel === null ? [] : [
              { tool: "claude" as const, model: claudeModel },
              ...governing.chain.claude.map((model) => ({
                tool: "claude" as const,
                model,
              })),
            ]),
            ...(codexModel === null ? [] : [
              { tool: "codex" as const, model: codexModel },
              ...governing.chain.codex.map((model) => ({
                tool: "codex" as const,
                model,
              })),
            ]),
          ];
          if (candidates.length === 0) {
            throw new Error(
              `Cannot spawn ${name}: no route for ${request.tier} — ` +
                `claude: ${governing.cells.claude.reason}; ` +
                `codex: ${governing.cells.codex.reason}`,
            );
          }
        } else {
          // The legacy static-table path: both columns always resolve.
          candidates = [
            { tool: "claude", model: claudeModel! },
            { tool: "codex", model: codexModel! },
          ];
          // The same-vendor release valve, derived from the pools the provider
          // actually meters rather than from a model's name. When the primary
          // Claude candidate is one the vendor caps separately, offer the account's
          // own default alongside it — listed *after* the primary, so ties (and the
          // no-quota-configured case) still prefer the primary, while real pressure
          // on its pool lets quota pick the alternative on headroom.
          const alternative = await this.releaseValveAlternative(claudeModel!);
          if (alternative !== null) {
            candidates.splice(1, 0, { tool: "claude", model: alternative });
          }
        }
        const eligible: QuotaRouteCandidate[] = [];
        const excluded: string[] = [];
        for (const candidate of candidates) {
          try {
            // Money is an eligibility filter, like capability: it runs BEFORE
            // quota, so an affordable candidate can still win the spawn rather
            // than the whole launch dying on the priciest one.
            const refusal = await this.spendRefusal(
              candidate.tool,
              candidate.model,
            );
            if (refusal !== null) {
              excluded.push(refusal);
              continue;
            }
            const candidateEffort = await resolveEffort(
              candidate.tool,
              candidate.model,
            );
            eligible.push({
              ...candidate,
              ...(candidateEffort === undefined
                ? {}
                : { effort: candidateEffort }),
            });
          } catch (error) {
            excluded.push(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        if (eligible.length === 0) {
          throw new Error(
            `No eligible route remains for ${request.tier}: ${excluded.join("; ")}`,
          );
        }
        candidates = eligible;
      }
      const explicitTool = request.model !== undefined ? tool : request.tool;
      const decision = await this.dependencies.quota.routeAndReserve({
        agentName: name,
        tier: request.tier,
        preferredTool,
        ...(explicitTool === undefined ? {} : { explicitTool }),
        ...(request.model === undefined ? {} : { explicitCandidate: true }),
        ...(request.reviewOfTool === undefined
          ? {}
          : { reviewOfTool: request.reviewOfTool }),
        candidates,
      });
      tool = decision.tool;
      model = decision.model;
      effort = decision.effort;
      effortResolved = true;
      quotaReservationId = decision.reservation.id;
    }
    // The gate EVERY launch passes through, whatever route it took to get here —
    // automatic, tier-pinned, or explicitly named; quota enabled or not.
    //
    // CONSENT TO ROUTE IS NOT CONSENT TO SPEND. This used to exempt an explicit
    // model on the grounds that naming a model is an instruction — and it is, but
    // it is an instruction about WHICH MODEL, not an agreement to be charged for
    // it. Choosing the model and agreeing to pay for it are different permissions,
    // and Hive had been conflating them in one direction (an explicit model was
    // never asked about) while the derivation engine conflated them in the other
    // (a routing.toml pin skipped the guard, so `hive routing` could show a pinned
    // model as fine while a real spawn on it refused).
    //
    // So the route and the money are now settled separately: the pin or the
    // explicit name WINS THE ROUTE, always, and the guard asks about the MONEY —
    // once, remembering the answer. When nothing can be charged (credits off, or
    // the pool has headroom) it asks nobody, which is every spawn today.
    {
      const refusal = await this.spendRefusal(tool, model);
      if (refusal !== null) {
        throw new Error(`Cannot spawn ${name}: ${refusal}`);
      }
    }
    if (!effortResolved) {
      effort = await resolveEffort(tool, model);
    }
    if (model !== "default") {
      executionIdentity = tool === "claude"
        ? {
            tool,
            model,
            ...(effort === undefined ? {} : { effort }),
          }
        : {
            tool,
            model,
            effort: effort ?? "medium",
          };
    }
    const worktree: CreatedWorktree = await this.makeWorktree(
      this.dependencies.repoRoot,
      name,
      slugify(request.task),
    );
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
    // Read once, before the prompt: the directive, the digest, and the MCP
    // config below must all describe the same server observation.
    const graphifyUrl = this.dependencies.graphifyUrl?.() ?? null;
    const [memoryIndex, brief, graphBrief] = await Promise.all([
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
      this.dependencies.graphifyBrief === undefined
        ? Promise.resolve(null)
        : this.dependencies.graphifyBrief(request.task).catch(
          (error: unknown) => {
            console.error(
              `Hive could not build a graph brief for ${name}; spawning without one: ${
                error instanceof Error ? error.message : "unknown error"
              }`,
            );
            return null;
          },
        ),
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
        ...(graphBrief === null ? {} : { graphBrief }),
        ...(graphifyUrl === null ? {} : { graphifyTools: true }),
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
          ...(graphifyUrl === null ? {} : { graphifyUrl }),
        });
        argv = buildClaudeSpawnCommand({
          daemonPort: this.dependencies.port,
          model,
          ...(effort === undefined ? {} : { effort }),
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
          ...(graphifyUrl === null ? {} : { graphifyUrl }),
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
              effort: effort ?? "medium",
              model,
              name,
              readOnly: false,
              dangerous,
              worktreePath: worktree.path,
              excludeMcpServers,
              withCapabilityToken: capabilityToken !== undefined,
              ...(graphifyUrl === null ? {} : { graphifyUrl }),
            });
      }
      const nativeCodex = tool === "codex" &&
        this.dependencies.codexAppServer !== undefined &&
        argv[1] === "codex-app-server-host";
      // The brief enters through the launch shell, never an argv: tmux caps a
      // command well below ARG_MAX and Hive's briefs outgrow that cap by design.
      // Written even for the app-server, whose TUI fallback below needs it.
      const promptSuffix = ` ${
        promptArgument(await writeLaunchPrompt(record.tmuxSession, prompt))
      }`;
      // The token value enters through the launch shell, never an argv.
      const withCapabilityEnv = (command: string): string =>
        tool === "codex" && !nativeCodex && capabilityToken !== undefined
          ? wrapCodexSpawnWithCapabilityEnv(command, worktree.path)
          : command;

      // See the control-restart path: readiness looks for the process hive
      // actually launched, so this must follow the session that wins.
      let launchedCommand = launchedCommandName(argv);
      await this.dependencies.tmux.newSession(
        record.tmuxSession,
        worktree.path,
        withCapabilityEnv(shellJoin(argv) + (nativeCodex ? "" : promptSuffix)),
      );
      if (nativeCodex) {
        try {
          await this.dependencies.codexAppServer!.startAgent(
            record,
            prompt,
            false,
            effort ?? "medium",
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
            effort: effort ?? "medium",
            model,
            name,
            readOnly: false,
            dangerous,
            worktreePath: worktree.path,
            excludeMcpServers,
            withCapabilityToken: capabilityToken !== undefined,
          });
          launchedCommand = launchedCommandName(fallback);
          const fallbackCommand = shellJoin(fallback) + promptSuffix;
          const fallbackShell = capabilityToken !== undefined
            ? wrapCodexSpawnWithCapabilityEnv(
              fallbackCommand,
              worktree.path,
            )
            : fallbackCommand;
          await this.dependencies.tmux.newSession(
            record.tmuxSession,
            worktree.path,
            fallbackShell,
          );
        }
      }
      const failureReason = await this.monitorReadiness(record, launchedCommand);
      if (failureReason !== null) {
        // The command ran, so this is the model's answer — unless the pane shows
        // the binary never executed at all.
        return await this.failSpawnIfStillSpawning(
          record,
          worktree,
          failureReason,
          readinessFailureLayer(failureReason),
        );
      }
      if (quotaReservationId !== undefined) {
        this.dependencies.quota?.markStarted(quotaReservationId);
      }
    } catch (error) {
      // Nothing thrown here has been past the transport. Building the argv,
      // writing the config, and handing the command to tmux all happen on this
      // machine, before the model is contacted — so a throw is never evidence
      // about the route, and must never be recorded against it.
      const reason = error instanceof Error
        ? error.message
        : "Agent launch failed";
      return await this.failSpawnIfStillSpawning(
        record,
        worktree,
        reason,
        "transport",
      );
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
    layer: LaunchFailureLayer,
  ): Promise<AgentRecord> {
    const current = this.dependencies.db.getAgentById(record.id);
    if (current !== null && current.status !== "spawning") {
      return current;
    }
    return await this.failSpawn(record, worktree, failureReason, layer);
  }

  private async failSpawn(
    record: AgentRecord,
    worktree: CreatedWorktree,
    failureReason: string,
    layer: LaunchFailureLayer,
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
      // Only a model-layer failure is evidence about the route: the CLI came up
      // and the model refused, or never answered. Quota then passes that route
      // over until it proves itself again — headroom alone was never enough to
      // call a route eligible.
      //
      // A transport failure is not that. tmux, the shell, the filesystem, a
      // binary that would not exec — none of them reached the model, and
      // quarantining a model Hive never contacted is how a single over-long
      // brief benched Opus for half an hour and quietly downgraded every spawn
      // that followed. The reservation is still released; only the health signal
      // is withheld.
      await this.dependencies.quota?.cancel(
        record.quotaReservationId,
        failedAt,
        layer === "model" ? failureReason : undefined,
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
