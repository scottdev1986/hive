# Status service

`StatusService` is Hive's only public status boundary. Producers report facts
through it, and consumers request current status or projections from it.

- `service.ts` owns the public API and provider/hook status semantics.
- `../status/store.ts` persists the event stream and assignments; it is a
  pinned SQL owner and stays outside this directory.
- `fusion.ts` reduces competing evidence into canonical dimensions.
- `events.ts` defines event-stream reduction and transport helpers.
- `canonical.ts` provides deterministic event and request serialization.
- `generation.ts` resolves incarnation fences.
- `activity-snapshot.ts` and `orchestrator.ts` own status projections.
- `provider-client.ts` reports the Agent UI's source-of-truth stream.
- `tools.ts` exposes the service through Hive's MCP tools.

Code outside this directory should import from `status-service/status-service.ts` and
should not read the store or invoke the fusion reducer directly. Direct
internal imports are reserved for focused unit tests.
