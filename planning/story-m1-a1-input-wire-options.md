# M1-A1 input wire projection options

Status: adopted — Option 1, queen-adjudicated 2026-07-17. This is the normative wire projection.

## Fixed constraints

- The frozen terminal-host operation is transactional and idempotent. Its request carries a session reference, claim token, transaction ID, idempotency key, and one of bytes, canonical end-of-file, or hangup. It returns the frozen input receipt.
- JSON control payloads are strict. Raw `HUMAN_INPUT` and `AUTOMATION_CHUNK` payloads contain bytes only.
- A control frame uses `streamSeq = 0`. Its nonzero header `requestId` is transport correlation only and never substitutes for the domain transaction or idempotency IDs.
- An authenticated `HOST_ATTACH` connection selects one exact generation. That transport binding can reject a wrong target, but it does not automatically preserve the session field in the frozen method request.
- `RESIZE` needs a correlated `APPLIED` response carrying the frozen resize result. Any other use of `APPLIED` must be a strict discriminated union.

## Common claim establishment

This part is independent of the input-body choice.

`CLAIM_ACQUIRE` is a strict JSON request with `schemaVersion: 1`, the frozen `session`, `writer`, `kind`, `leaseMilliseconds`, and `idempotencyKey`. `CLAIM_RESULT` is a correlated strict JSON response with `schemaVersion: 1` and the frozen `ClaimResult` union. The host cross-checks the request session against the exact attached generation. A granted claim returns the frozen token, writer, kind, and lease expiry; a denied or unknown result preserves its owner/diagnostic evidence without inventing ownership.

## Option 1 — one general control request plus shared `APPLIED`

Add one control type in the unused claim/input range, `INPUT_SUBMIT = 0x0305`.

The request has `streamSeq = 0`, the content-sensitive flag, and this strict JSON payload:

```text
{
  schemaVersion: 1,
  session: { key, incarnation },
  claimToken,
  transactionId,
  idempotencyKey,
  operation:
    | { kind: "bytes", encoding: "base64", bytes }
    | { kind: "canonical-end-of-file" }
    | { kind: "hangup" }
}
```

The response uses the same header `requestId`, response/final flags, and an `APPLIED` payload branch:

```text
{ schemaVersion: 1, resultKind: "input", receipt: InputReceipt }
```

`RESIZE` remains a strict JSON request containing `schemaVersion: 1` and the frozen `session`, `window`, `revision`, and `idempotencyKey`. Its correlated response is the other `APPLIED` branch:

```text
{ schemaVersion: 1, resultKind: "resize", result: ResizeResult }
```

Identity is explicit: both request payloads carry the frozen `SessionRef`, and the host cross-checks it against the authenticated attached locator. Raw low-level `HUMAN_INPUT` remains available only for keystroke streaming inside an already-established claim; it is not the frozen transactional operation and cannot produce a frozen receipt by itself.

Tradeoffs: this is the smallest semantically honest addition. It adds one justified request type, reuses `APPLIED` for results, keeps transport and domain IDs distinct, and makes retries self-contained. JSON base64 expands bytes and is bounded by the control-frame cap. The v1 `WELCOME` advertises `maxInputTransactionBytes = 131072` decoded bytes (128 KiB); request metadata and base64 encoding must still fit the 256 KiB control frame. Larger automation bodies continue to use the separately defined chunked automation transaction rather than this operation.

## Option 2 — no new type; make `APPLIED` bidirectional

Use an `APPLIED` request branch for the frozen operation. The request has no response flag, has the content-sensitive flag, and carries:

```text
{
  schemaVersion: 1,
  operationKind: "input-submit",
  session: { key, incarnation },
  claimToken,
  transactionId,
  idempotencyKey,
  operation:
    | { kind: "bytes", encoding: "base64", bytes }
    | { kind: "canonical-end-of-file" }
    | { kind: "hangup" }
}
```

The host returns the Option 1 `APPLIED` input-receipt branch with the same header `requestId`. `RESIZE` and its `APPLIED` resize-result branch are unchanged. Header response flags and the JSON discriminants distinguish request, input receipt, and resize receipt.

Identity is explicit as in Option 1. Relying only on the attached locator would save a small field but would turn a required frozen request field into hidden connection state and weaken independent replay/ABA checks.

Tradeoffs: this mints no frame type and follows the strongest possible reading of the reuse rule. It also makes a frame named `APPLIED` carry an operation that has not yet been applied and may return rejected or unknown. That semantic inversion complicates authorization and protocol review, and it consumes `APPLIED`'s bidirectional surface before the later output-acknowledgement projection. It has the same base64/control-cap bound as Option 1.

## Option 3 — a general chunked input transaction with a separate result

Add three control types in the unused claim/input range:

- `INPUT_BEGIN = 0x0305`
- `INPUT_COMMIT = 0x0306`
- `INPUT_RESULT = 0x0307`

`INPUT_BEGIN` is strict JSON and carries the frozen session, claim token, transaction ID, idempotency key, and either `{ kind: "bytes", totalLength, sha256 }`, `{ kind: "canonical-end-of-file" }`, or `{ kind: "hangup" }`. For bytes, raw chunks reuse `HUMAN_INPUT` for a human claim and `AUTOMATION_CHUNK` for an automation claim. Every chunk has the begin frame's `requestId`; `streamSeq` is its zero-based byte offset. `INPUT_COMMIT` is strict JSON with the transaction ID, total length, and digest, using the same `requestId`. The host returns a strict JSON `INPUT_RESULT` containing the frozen receipt with that `requestId` and response/final flags. EOF and hangup have no raw chunks and commit a zero-length transaction.

`RESIZE` keeps a dedicated `APPLIED` resize-result schema; input never uses `APPLIED` in this option.

Identity is explicit once in `INPUT_BEGIN` and cross-checked against the attached generation. Chunks and commit inherit both that transaction binding and the authenticated connection; a reconnect must restart or query the domain-idempotent transaction rather than sending orphan chunks.

Tradeoffs: this preserves the full advertised input-transaction size without base64 expansion and gives the cleanest names and receipt type. It adds three types, more partial-transaction state, digest/offset validation, disconnect cleanup, and recovery behavior. It duplicates the shape of the existing automation transaction and is therefore the weakest fit with the no-new-frames rule unless large transactional human input is a required product behavior.

## Adopted decision

Option 1 is adopted.

No existing strict-JSON request type truthfully names the frozen operation: `HUMAN_INPUT` is byte-only, `GESTURE_INPUT` is explicitly non-authoring, and the automation frames name a different lane. One new `INPUT_SUBMIT` type is therefore justified. Reusing a discriminated `APPLIED` result avoids minting a second type and lets resize coexist without shape ambiguity. Carrying the frozen `SessionRef` and cross-checking it against `HOST_ATTACH` preserves both method fidelity and generation fencing. The 128 KiB decoded-byte cap is the known v1 limitation. If measured product behavior requires larger frozen transactions, adopt the Option 3 chunked upgrade rather than expanding the JSON control frame or silently reinterpreting raw `HUMAN_INPUT`.
