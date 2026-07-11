# Router vendor surfaces

Hive can learn which models an account can use, and which effort values each model accepts, without waiting for a Hive release and without buying an inference. Both installed CLIs already expose that much. They do not expose the judgment a router ultimately needs: which model is best for a task, what one subscription turn will cost, or whether an API price is a faithful proxy for subscription capacity. Dynamic discovery can remove stale names and invalid effort flags. It cannot replace routing policy.

This document records wire behavior verified on July 11, 2026 against Claude Code 2.1.207 and Codex CLI 0.144.1 on the signed-in accounts on this machine. “Free” below means no user message, thread turn, model response, or inference request. It does not mean the surface is stable or universally available.

## The discovery surfaces

| Surface | What it tells Hive | Status | Probe cost and risk |
|---|---|---|---|
| Claude control `initialize` | Account identity/provider and an account-specific model menu: `value`, `resolvedModel`, `displayName`, `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode`, and `supportsAutoMode` where applicable | **Verified, free, incomplete namespace** | One short-lived CLI process and one control frame. No prompt. The menu omits accepted values such as `best` and bare `claude-opus-4-8`, so absence is not proof that a model cannot launch. |
| Claude control `get_usage` | Subscription type, general and model-scoped rate-limit windows, and extra-usage state | **Verified elsewhere in-tree, free, experimental** | No prompt, but Claude labels the request experimental and its schema may change. It reports display names, not stable model ids. See [provider-quota-surfaces.md](provider-quota-surfaces.md). |
| Claude Platform Models API | API-account model ids, `max_input_tokens`, `max_tokens`, and a capability object | **Documented; not a Claude Code subscription entitlement surface** | A metadata request rather than inference, but it requires Claude API credentials and describes that API account. Hive cannot assume the CLI's OAuth subscription has the same catalog or expose its token for this use. |
| Claude public model and pricing pages | Current ids, API aliases, prices, context/output limits, thinking mode, and vendor positioning | **Verified public metadata, not account-specific** | Free HTTP fetch. It can seed or annotate policy, but a web page changing or failing must not make spawning impossible. API prices do not state Claude Max quota burn. |
| Codex app-server `model/list` | Available models plus `id`, `model`, display name/description, hidden/default state, per-model default and supported reasoning efforts, input modalities, service tiers, personality support, and upgrade hints | **Verified, free, officially documented** | Mandatory `initialize`/`initialized`, then a metadata RPC. No `thread/start` or `turn/start`. Paginate and request `includeHidden: true` for the full account-visible list. |
| Codex app-server `config/read` | Effective layered config, including the model and reasoning effort Codex will use when Hive passes no override | **Verified, free, configuration only** | Local metadata RPC. It establishes the effective default, not whether an arbitrary model is entitled. |
| Codex app-server `account/read` | Auth mode, ChatGPT plan type, and whether OpenAI auth is required | **Verified, free, coarse entitlement context** | Metadata RPC. The live account reported `chatgpt` / `prolite`; no per-model grants are returned. Avoid logging the accompanying email. |
| Codex app-server `account/rateLimits/read` | General and named sub-limit windows, plan type, and reset credits | **Verified, free, authoritative** | Metadata RPC. Named sub-pools can be joined to `model/list` display names, but a rename that reaches the two surfaces at different times temporarily breaks the join. |
| Codex app-server `modelProvider/capabilities/read` | Provider-wide booleans for namespace tools, image generation, and web search | **Verified, free, not per-model** | Metadata RPC. The 0.144.1 request takes `{}` and returned all three `true`; it cannot distinguish two models. |
| Codex generated protocol schemas | The exact request/response types implemented by the installed binary | **Verified, free, version-local** | `codex app-server generate-json-schema --experimental --out DIR` writes schemas only. Useful for compatibility tests, not runtime account facts. The generator flag is experimental even when an individual RPC is documented. |
| Codex public API model catalog | Current API model ids, API reasoning levels, prices, token limits, modalities, endpoints, and tool support | **Verified fresh, public, not Codex entitlement** | Free HTTP fetch. The API catalog and the CLI catalog overlap but are not the same contract; routing a ChatGPT-backed CLI from API availability alone is unsafe. |
| OpenAI `GET /v1/models` | Models visible to an API credential | **Possible without inference, wrong account plane for ChatGPT Codex** | Requires an API key and returns identity metadata, not the rich Codex effort catalog. It cannot prove ChatGPT-plan CLI entitlement. |
| Trial launch or tiny prompt | Whether a named model actually answers on the current account | **Possible, but not a discovery primitive** | A prompt is billable and spends quota. A thread-only validation may also create durable local state and is unnecessary where `model/list` exists. Never probe by guessing a CLI subcommand: both CLIs may treat the unknown word as a prompt. |

What is genuinely unavailable from a free provider surface today is just as important. Neither vendor returns a task-quality score, a common cross-vendor capability scale, expected tokens or subscription percentage for a future task, or a trustworthy mapping from API dollars to subscription quota. Claude's menu does not enumerate every launchable alias. Codex does not publish per-model token pricing or context size in `model/list`, and its provider-capability RPC is not per-model. Neither account surface promises that tomorrow's display-name rename will be synchronized atomically with a named quota pool. Those facts must remain unknown, user-configured, or learned from explicit evals; inventing them would only make the router confidently wrong.

## What the binaries returned

The Claude probe was the documented control handshake, run with no user message:

```sh
echo '{"type":"control_request","request_id":"1","request":{"subtype":"initialize"}}' \
  | claude -p --verbose --input-format stream-json --output-format stream-json
```

The 2.1.207 response exposed five menu entries:

- `default` resolved to `claude-opus-4-8[1m]`; effort levels were `low`, `medium`, `high`, `xhigh`, `max`; fast and auto modes were supported.
- `opus[1m]` resolved to the same id and reported the same capabilities.
- `claude-fable-5[1m]` resolved to `claude-fable-5`; it reported the same five effort levels and auto mode, but no `supportsFastMode` field.
- `sonnet` resolved to `claude-sonnet-5`; it reported the same five effort levels and auto mode, but no `supportsFastMode` field.
- `haiku` resolved to `claude-haiku-4-5-20251001` and reported none of the effort, adaptive, fast, or auto fields.

Missing booleans must remain missing rather than being silently promoted to `false`: omission may mean unsupported, rollout-dependent, or simply absent from this protocol version. The response also included account email and organization; a production probe should retain only the minimum account key it needs and never put the raw frame in logs.

The Codex probe performed `initialize`, sent `initialized`, and then called `model/list` with `{ "includeHidden": true }`, `config/read`, `account/read`, `account/rateLimits/read`, and `modelProvider/capabilities/read`. It never started a thread or turn. The account-visible 0.144.1 catalog was:

| Model | Default | Supported reasoning efforts | Other discovered facts |
|---|---:|---|---|
| `gpt-5.5` | yes | low, medium, high, xhigh | text+image; Fast service tier |
| `gpt-5.6-sol` | no | low, medium, high, xhigh, max, ultra | text+image; Fast service tier |
| `gpt-5.6-terra` | no | low, medium, high, xhigh, max, ultra | text+image; Fast service tier |
| `gpt-5.6-luna` | no | low, medium, high, xhigh, max | text+image; Fast service tier |
| `gpt-5.4` | no | low, medium, high, xhigh | text+image; Fast service tier |
| `gpt-5.4-mini` | no | low, medium, high, xhigh | text+image |
| `gpt-5.3-codex-spark` | no | low, medium, high, xhigh | text only; separately metered on this account |
| `codex-auto-review` | no, hidden | low, medium, high, xhigh | internal picker entry; text+image |

Every entry recommended `medium` except Spark, which recommended `high`. `config/read` independently reported the user's effective default as `gpt-5.6-sol` at `xhigh`. This distinction matters: `isDefault` is the vendor's catalog recommendation, while effective config is what an unflagged launch on this machine actually uses.

The fresh [OpenAI API catalog](https://developers.openai.com/api/docs/models) recommends `gpt-5.6-sol` for complex reasoning and coding, `gpt-5.6-terra` for balance, and `gpt-5.6-luna` for cost-sensitive volume. It currently lists their input/output prices as $5/$30, $2.50/$15, and $1/$6 per million tokens. It lists API reasoning values `none`, `low`, `medium`, `high`, `xhigh`, and `max`. That vocabulary is not the Codex CLI vocabulary above: the CLI omitted `none`, added `ultra` to Sol and Terra, and exposed different effort sets for older models. The live app-server catalog must therefore govern CLI validation; the public API page may annotate price and vendor positioning only. OpenAI's [app-server documentation](https://developers.openai.com/codex/app-server#list-models-model-list) explicitly directs clients to call `model/list` to discover available models and capabilities before rendering selectors.

Anthropic's fresh [model comparison](https://platform.claude.com/docs/en/about-claude/models/overview) similarly supplies useful metadata absent from the CLI handshake: API pricing, context and output limits, thinking mode, and comparative latency. It also documents a Models API with capability and token-limit fields. That is valuable enrichment, but it describes the Claude API plane, not proof of a Claude Code subscription entitlement. The CLI handshake remains the authority for what the signed-in CLI offers.

## Where the current router freezes vendor facts

The routing configuration is permissive about model strings and rigid everywhere around them.

`src/schemas/routing.ts` ships the four tier names, preferred vendors, Claude aliases, and Codex efforts. It also ships a calendar event: `FABLE_AUTO_ROUTING_CUTOFF`, plus a duplicated post-cutoff `claude-opus-4-8` literal. A new model tomorrow changes none of these choices. A newly introduced effort tomorrow can make a user's otherwise valid `routing.toml` fail schema parsing; this already happened in principle, because the live Codex catalog advertises `max` and `ultra` while `CodexRouteSchema` accepts only `minimal|low|medium|high|xhigh`.

The same stale effort enum is duplicated in `src/schemas/agent.ts` for immutable execution identities. Even if routing accepted a new value, persistence and critical-control restart would reject it. Defaults fall back to `medium` in several spawner and recovery paths, so “missing” is silently converted into a shipped judgment rather than the model's reported `defaultReasoningEffort`.

`src/adapters/tools/models.ts` hardcodes `CLAUDE_BEST_MODEL = "claude-fable-5"`. The current control catalog cannot establish that claim: the 2.1.207 menu's `default` is Opus 4.8, while `best` is not enumerated at all. The binding may still launch Fable, but Hive can prove it only with a model-running probe—the dated constant is not vendor-surface truth. The function also classifies vendors by prefixes and five Claude aliases. A vendor that introduces a new family name can be unclassifiable until Hive ships; a model whose name happens to match the other vendor's regex can be rejected as a contradiction. Reading `~/.codex/config.toml` and `~/.claude/settings.json` directly also misses layered, managed, project, profile, or built-in defaults; Codex already offers `config/read` for the effective value.

`src/daemon/spawner-impl.ts` turns those constants into policy. It recognizes one special model, Fable, and injects one special fallback, Opus 4.8. A renamed Fable stops receiving the fallback. A new premium pool or a better successor is invisible. The comparison uses the resolved hardcoded id, so a changed `best` mapping can book quota for one model while launching another.

The quota catalog parsers in `src/daemon/quota-sources.ts` read the vendor catalogs but deliberately discard nearly all capability metadata, retaining only model id and display name for pool binding. That is sufficient for quota joins and insufficient for routing. The display-name join itself fails safely to “unbound” when a vendor renames one surface before the other, but that safe failure also removes the model-specific gate exactly when a rollout is changing.

Finally, the tier table and quota estimates are shipped policy constants. `DEFAULT_ROUTING` decides that cheap means Codex/low and deep means Claude; `DEFAULT_PERCENT_ESTIMATES` assigns fixed five-hour and weekly percentages per tier. These are legitimate fallback policy, not discoverable facts, but they must be named as such. A dynamic catalog should not disguise them as vendor truth.

Three adversarial release cases make the failure modes concrete:

1. **A vendor adds a model.** Claude may expose it immediately, Codex will expose it through `model/list`, and Hive's quota join may even learn its pool. The routing table will never select it, the vendor regex may not recognize it, and new effort values can be rejected before launch.
2. **A vendor renames or retargets a model.** Claude's shipped `best` resolution and Fable special case become wrong. Display-name quota joins can temporarily unbind. Immutable launch records remain reproducible only if the old id stays launchable; otherwise recovery correctly fails closed, but no dynamic successor policy exists.
3. **A vendor changes effort levels.** Hive can send an invalid effort because defaults are model-independent, or reject a valid one because two schemas freeze the vocabulary. Codex 0.144.1 already demonstrates both sides: no listed model advertises Hive's `minimal`, while several advertise Hive-unknown `max` or `ultra`.

## A safe source hierarchy

Runtime selection should start from the signed-in CLI catalog because it is closest to the thing Hive will launch. For Claude that means the initialize menu, accepting that it is not exhaustive. For Codex it means paginated `model/list`, plus `config/read` for the effective unflagged default and `account/read` for account-plane diagnostics. Cache the last successful catalog with its CLI version and observation time; a transient discovery failure should degrade to that snapshot or the vendor default, not reinterpret an empty list as “no models.”

Public provider catalogs are enrichment. They can supply price, context, modalities, tool support, vendor descriptions, and migration hints. The alternative—using public API availability as CLI entitlement—loses because the credentials and product planes differ. Join enrichment only on stable provider ids, preserve unknown fields, and tolerate a missing match.

Pricing is useful as an ordering hint, not as a capability score or quota conversion. Lower API price often identifies the vendor's throughput-oriented tier, and the vendor's own descriptions support that interpretation. It does not prove lower subscription consumption, lower latency under load, or enough quality for a repository-specific task. Cross-vendor dollar ratios are especially misleading because Hive spends bundled subscriptions, not API invoices.

Self-reported entitlement probes should stop at metadata surfaces. A catalog entry is positive evidence that the current CLI offers a model. Claude menu absence is unknown because the menu is known to omit valid aliases; Codex documents its list as available models, but hidden entries still need policy filtering. Launching a prompt to settle uncertainty spends the scarce resource the router is trying to protect. If Hive ever offers an explicit user-triggered validation, it should state the cost and never run during automatic route resolution.

Dynamic routing still needs a small, explicit policy layer: tier intent, minimum capabilities, cost preference, cross-vendor review preference, and failover rules. The provider supplies candidates and constraints; Hive ranks them. Keeping that boundary visible gives new models immediate eligibility without pretending that a vendor's catalog description is an eval.

## Risks and open questions

The largest risk is confusing discovery with judgment. `isDefault`, a price, or the adjective “frontier” is not enough to decide that a model should write security-sensitive code. Hive needs repository-specific eval evidence or a deliberately modest heuristic whose uncertainty is visible.

The second risk is schema coupling. Capability payloads evolve faster than Hive releases; strict enums at the ingestion boundary recreate the release dependency the overhaul is meant to remove. Raw vendor strings should survive ingestion, while launch validation checks the selected model's advertised set. Persistence must retain unknown future strings so a critical restart can replay them.

The third risk is split authority. CLI catalogs, public API docs, account config, and quota payloads answer different questions. Merging them into one undifferentiated “model record” invites a public API model to masquerade as a CLI entitlement or an API price to masquerade as subscription burn. Every field needs provenance and an observation time.

The remaining open design questions are policy questions rather than discovery gaps: how long a cached catalog remains usable, whether unlisted explicit Claude ids are allowed with a warning, how an operator overrides a bad vendor description, and what eval evidence is sufficient to promote a newly discovered model into automatic routing. None should be answered by another hardcoded model name.
