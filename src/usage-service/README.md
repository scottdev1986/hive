# Usage service

The one owner of everything Hive knows about usage.

Every usage fact in the system — token counts and their attribution,
context-window occupancy, provider rate limits (5-hour and weekly windows),
plan pools and paid credits, delegation token budgets, and the chars→tokens
estimate used where nothing was measured — is computed, stored, or transported
by a module in this directory. Code elsewhere consumes these numbers; it does
not derive its own. If a new usage fact appears (a vendor starts reporting
occupancy, a new limit window shows up), it lands here first and everything
else reads it from here.

- `token-usage.ts` — `TokenUsageStore`: sessions, subjects, provider-reported
  readings, and the Usage screen's snapshot.
- `token-usage-client.ts` — user HTTP client for the daemon's
  `/token-usage` endpoints.
- `token-estimate.ts` — the chars/4 estimation convention for budget fitters;
  never applied to measured readings.
- `context-occupancy.ts` — context-percent arithmetic, display formatting, and
  the Grok signals.json occupancy probe.
- `protocol-session-facts.ts` — protocol events → agent-row facts (context %,
  window, live model) + token readings.
- `protocol-facts-report.ts` — pane-side transport posting those facts through
  `/token-usage/protocol-session-facts`.
- `quota.ts` — `QuotaService`: refreshes probes, books and settles
  reservations, raises quota alerts.
- `quota-pools.ts` — which pools meter a candidate: the manual/discovered fold
  and the model-catalog binding.
- `quota-pool-status.ts` — a pool's published numbers, and whether it is
  measured enough to constrain a spawn or drained enough to stop one.
- `quota-windows.ts` — when a window starts and ends, including timezone and
  daylight-saving resolution for calendar weeks.
- `quota-ledger.ts` — durable quota observations/reservations store, and the
  only module here that issues SQL against `quota.db`.
- `quota-ledger-records.ts` — the row shapes that store holds and returns.
- `quota-observation-merge.ts` — folding a new reading into the stored one,
  window by window.
- `quota-sources.ts` — per-vendor limit probes (Codex, Claude, Grok, Kimi)
  returning measured windows or unknown, and the wire shapes they parse.
- `quota-tools.ts` — the MCP capacity-and-spend tool surface.
- `kimi-usage.ts` — Kimi's `/usages` plan+rate-window reader.
- `usage-credits/` — provider billing readers, memory, and spend policy.

There is no barrel here: consumers import the module that owns the fact they
need, so an import names its dependency instead of the whole service.

Wire shapes for these facts stay in `src/schemas` (the schema home). This
service owns its own persistence: `quota-ledger.ts` and `token-usage.ts` are
named SQL owners, and they are the only modules here that issue statements.
