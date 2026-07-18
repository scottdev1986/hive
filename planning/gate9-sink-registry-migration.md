# Gate 9 → Gate 3 sink migration (pre-drafted; apply at douglas's integration turn)

Written 2026-07-18 against dominic's reviewed pin e6d5413c, BEFORE Gate 3
landed. Verify line-level details against the LANDED code at apply time;
the shapes below were read from the pin, not guessed.

Goal (queen-endorsed): one routing path — my Gate-9 notification sink
rides `GhosttySurfaceCallbackRegistry` + `BridgeCallbackContext`'s
`acceptingCallbacks` execution-time gate, replacing my private
`actionRegistry` one-for-one. Public API `GhosttyManualSurface.
onActionNotification` and all Gate-9 test semantics stay unchanged
(duncan's Gate 10 code needs no edits).

Observed shapes at e6d5413c:
- `GhosttySurfaceCallbackRegistry` (private, ManualSurface.swift:726):
  `shared`, `register(_:context:)` (factory, :930), `unregister(_:)`
  (free, :421), `enqueueRendererHealth(_:for:)` — resolves the weak
  CONTEXT under a short NSLock at enqueue, then calls
  `context.enqueueRendererHealth(health)`.
- `BridgeCallbackContext`: `acceptingCallbacks` under `condition`
  (NSCondition); handler setters nil-out when closed (:67/:80/:93);
  `enqueueX` = main.async + recheck `acceptingCallbacks` before invoking
  the handler (:172-201); `beginTeardown()` closes admission (:158).

## Migration steps

1. CallbackContext.swift — add an action-notification channel mirroring
   `onRendererHealth`/`enqueueRendererHealth` EXACTLY (same setter gating,
   same main.async + recheck body):
   - `private var actionNotificationHandler: ((HiveGhosttyActionNotification) -> Void)?`
   - `public var onActionNotification: ((HiveGhosttyActionNotification) -> Void)?`
     (gated setter/getter like :85-93)
   - `func enqueueActionNotification(_ note: HiveGhosttyActionNotification)`
     (body copied from enqueueRendererHealth :194-201, handler type swapped)

2. GhosttySurfaceCallbackRegistry — add, mirroring enqueueRendererHealth:
   `func enqueueActionNotification(_ note: HiveGhosttyActionNotification, for surface: ghostty_surface_t?)`

3. ManualSurface.swift — DELETE my private plumbing:
   `actionRegistry`, `actionRegistryLock`, `WeakSurfaceBox`,
   `deliverActionNotification`, the init registration block, and the free()
   deregistration block (dominic's factory/free already
   register/unregister the context: :930/:421).
   `HiveGhosttyActionPolicy.notifySurface` becomes:
   `GhosttySurfaceCallbackRegistry.shared.enqueueActionNotification(note, for: target.target.surface)`
   (keep the `target.tag == GHOSTTY_TARGET_SURFACE` guard).

4. GhosttyManualSurface.onActionNotification — keep the public name as a
   forwarding computed property over `callbackContext.onActionNotification`
   so duncan's `surface.onActionNotification = { ... }` is source-stable.

5. Safety equivalences to re-verify with the EXISTING tests (no rewrites
   expected):
   - queued-before-free ordering test: free() must reach beginTeardown()
     (admission false) before the drained closure runs → note dropped.
     If dominic's free() orders unregister/beginTeardown differently than
     assumed, the test tells us — do not weaken the test to fit.
   - after-free test: registry unregistered → context lookup nil → drop.
   - handle-value reuse: his pattern resolves the CONTEXT at enqueue and
     rechecks THAT context's admission — a reused handle maps to the NEW
     context only for NEW enqueues; old notes hold the OLD (torn-down)
     context. Equivalent to my identity compare; no extra code needed.

6. Run: full workspace suite + the Gate-9 mutation replays (registration
   disabled → carrier tests RED; forbiddenOpeners emptied → scan RED).
