# Phase 2: Inbound Trust & Wire Boundary - Pattern Map

**Mapped:** 2026-07-22
**Files analyzed:** 9 (new + modified)
**Analogs found:** 9 / 9

## File Classification

| New/Modified File                                                            | Role                      | Data Flow                     | Closest Analog                                                                                                                 | Match Quality                             |
| ---------------------------------------------------------------------------- | ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `src/client/verify.ts` (NEW)                                                 | utility/types             | request-response (trust gate) | `src/utils/nostr.ts` (`getTagValue`) + applesauce `VerifyEventMethod`                                                          | new-wiring, applesauce is the real analog |
| `src/utils/tag-cardinality.ts` (NEW)                                         | utility/validator         | transform                     | `src/utils/nostr.ts` (`getTagValue`)                                                                                           | role-match (sibling helper)               |
| `src/utils/nostr.ts` (MODIFIED — add getters)                                | utility                   | transform                     | itself (`getTagValue`, lines 10-15)                                                                                            | exact                                     |
| `src/utils/timestamp.ts` (MODIFIED — `createThreeMonthLifetime`)             | utility                   | transform                     | itself (lines 37-64, `isLifetimeValid` + the function being fixed)                                                             | exact                                     |
| `src/client/groups-manager.ts` (`#connectGroup` drain, MODIFIED)             | controller (event drain)  | event-driven                  | itself (lines 428-474)                                                                                                         | exact                                     |
| `src/client/invite-manager.ts` (`ingestEvent`, MODIFIED)                     | controller (event ingest) | event-driven                  | itself (lines 181-203) + `groups-manager.ts` drain (reject-emit pattern)                                                       | exact + shared-pattern                    |
| `src/client/key-package-store.ts` (`addPublished`, MODIFIED)                 | service (CRUD/store)      | CRUD                          | itself (lines 191-219)                                                                                                         | exact                                     |
| `src/client/key-package-manager.ts` (`track`, MODIFIED)                      | service                   | CRUD                          | `key-package-store.ts addPublished` (its sole delegate)                                                                        | exact                                     |
| `src/client/group/invite.ts` (`createInviteIntent`, MODIFIED)                | service (pure validation) | request-response              | itself (lines 34-67)                                                                                                           | exact                                     |
| `src/core/key-package-event-decode.ts` (MODIFIED — Lifetime read)            | utility/decode            | transform                     | itself (`getKeyPackageMLSVersion` etc., lines 27-56)                                                                           | exact                                     |
| `src/core/key-package-eligibility.ts` (MODIFIED — Lifetime check)            | service (pure evaluator)  | transform                     | itself (`evaluateKeyPackageForGroup`, lines 81-161, `reasons.push` pattern)                                                    | exact                                     |
| `src/core/key-package.ts` (`generateKeyPackage`, MODIFIED — cap enforcement) | service                   | CRUD (produce)                | itself (lines 86-114)                                                                                                          | exact                                     |
| `src/client/marmot-client.ts` (MODIFIED — inject `verifyEvent` option)       | config/wiring             | request-response              | itself (`MarmotClientOptions`, lines 85-156)                                                                                   | exact                                     |
| Tests: `*.test.ts` for the above                                             | test                      | —                             | `src/__tests__/groups-manager.test.ts`, `src/client/__tests__/invite-manager.test.ts`, `src/__tests__/helpers/mock-network.ts` | exact                                     |

## Pattern Assignments

### `src/client/verify.ts` (NEW — utility/types)

**Analog:** applesauce `VerifyEventMethod`/`verifyEvent`/`fakeVerifyEvent` (installed dependency, no local analog exists — this is genuinely new wiring per D-02/D-03/D-04). Style/shape analog for the `RejectReason` union type: `src/engine/types.ts` discriminated unions (`kind: "..."` pattern) and `SkippedIngestResult.reason` string-literal union.

**Import convention** (from `node_modules/.pnpm/applesauce-core.../dist/helpers/event.d.ts`, confirmed by RESEARCH.md):

```typescript
import type { VerifyEventMethod, VerifiedEvent } from "applesauce-core/helpers";
import { verifyEvent, fakeVerifyEvent } from "applesauce-core/helpers";
```

**Reason taxonomy shape** — mirror `SkippedIngestResult.reason` string-literal union (`src/engine/types.ts:101-109`):

```typescript
export type SkippedIngestResult<TEnvelope> = {
  kind: "skipped";
  envelope: TEnvelope;
  message: MlsMessage;
  reason: "past-epoch" | "wrong-wireformat" | "self-echo" | "duplicate";
  // ... etc
};
```

Model the new `RejectReason` as: `'invalid-signature' | 'lifetime-cap' | 'tag-cardinality'` (per D-05), a bare string-literal union (not nested in a result object — it is a manager emit payload field, not an IngestResult variant). Do NOT add a `kind` discriminant unless the emit payload itself needs to be a discriminated union — check exact shape decision against D-06 (manager emits `emit('rejected', ..., reason)`, a positional string, mirroring `unreadable`'s shape below).

**Named exports only** — module convention per CLAUDE.md; no default exports.

---

### `src/utils/tag-cardinality.ts` (NEW — validator)

**Analog:** `src/utils/nostr.ts` `getTagValue` (lines 1-15) — sibling helper, same file conventions (module doc comment, `NostrEvent` import from `applesauce-core/helpers/event`).

**Existing pattern to sit beside** (`src/utils/nostr.ts:1-15`):

```typescript
/** @module @category Utilities */
import { NostrEvent } from "applesauce-core/helpers/event";

/** Returns the value of a name / value tag */
export function getTagValue(
  event: NostrEvent,
  name: string,
): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}
```

**Table-driven design** (from RESEARCH.md Pattern 2, cited against `refs/marmot/transports/nostr.md` lines 63-80): encode `(kind, tagName) → "singleton" | "list"` as a data map (object literal, matching the project's convention of exported enum-like object namespaces — e.g. `groupLifecycleStates`, `convergenceStatuses` in `src/core/group-lifecycle.ts`/`src/core/inbound.ts`).

New strict getters signature convention (mirrors `getTagValue`'s `event, name` param order and `T | undefined` return-on-absent style, but must additionally reject "present-but-invalid" cardinality violations — CONTEXT D-10):

```typescript
export function getSingletonTagValue(
  event: NostrEvent,
  name: string,
): string | undefined;
export function getListTag(
  event: NostrEvent,
  name: string,
): string[] | undefined;
```

**Error-handling convention to follow:** never throw from deep inside decode helpers — return typed `undefined`/reject, matching `evaluateKeyPackageForGroup`'s `reasons.push(...)` try/catch pattern (`src/core/key-package-eligibility.ts:149-153`) and the project-wide rule "reject-via-typed-result (not throw) for inbound multi-outcome flows" (CLAUDE.md Error Handling).

---

### `src/utils/nostr.ts` (MODIFIED — add strict getters beside `getTagValue`)

**Analog:** itself. `getTagValue` (lines 10-15) stays byte-for-byte untouched per D-10; add new exports below it in the same file, same import/doc-comment style. Alternative: put the getters in the new `tag-cardinality.ts` module instead (Claude's Discretion per RESEARCH.md Open Question 3) — either is consistent with this pattern map; RESEARCH.md's "Recommended Project Structure" leans toward putting the getters in `nostr.ts` and the table/validator in the new `tag-cardinality.ts`.

---

### `src/utils/timestamp.ts` (MODIFIED — `createThreeMonthLifetime`)

**Analog:** itself, current implementation (lines 53-64):

```typescript
export function createThreeMonthLifetime(): Lifetime {
  const currentTime = BigInt(Math.floor(Date.now() / 1000));
  const threeMonthsInSeconds = 90n * 24n * 60n * 60n; // 90 days — OVER cap
  const notAfter = currentTime + threeMonthsInSeconds;
  return { notBefore: currentTime, notAfter };
}
```

**Sibling function to reuse pattern from** — `isLifetimeValid` (lines 37-46), showing the project's `defaultLifetime()` special-case handling convention:

```typescript
export function isLifetimeValid(lifetime: Lifetime): boolean {
  const currentTime = BigInt(Math.floor(Date.now() / 1000));
  const defaultLt = defaultLifetime();
  return (
    currentTime >= lifetime.notBefore &&
    (lifetime.notAfter === defaultLt.notAfter ||
      currentTime <= lifetime.notAfter)
  );
}
```

**Change required (D-07/D-09):** 84-day cap (7,257,600 s) instead of 90 days; `notBefore` backdated by 3600 s. Per CONTEXT's Claude's Discretion, keep `createThreeMonthLifetime` as a deprecated alias re-export if renaming (e.g. to `createDefaultKeyPackageLifetime`) — mirror how deprecated re-exports would be documented (no existing local example of a deprecated alias in this codebase; use a `/** @deprecated Use {@link createDefaultKeyPackageLifetime} instead. */` JSDoc tag, consistent with the `@param`/`@returns`/`@throws` comment convention already used throughout `src/utils/`).

A new `isLifetimeCurrentWithGrace`/inbound current-check helper (D-08, ~1h symmetric grace) should follow the same pattern as `isLifetimeValid` above — same file, same `BigInt` Unix-seconds arithmetic style.

---

### `src/client/groups-manager.ts` — `#connectGroup` drain (MODIFIED, 445 boundary)

**Analog:** itself, current shape (lines 428-474):

```typescript
async #connectGroup(
  group: MarmotGroup<THistory, TMedia>,
  options?: ConnectOptions,
): Promise<Unsubscribable> {
  const noop: Unsubscribable = { unsubscribe: () => {} };
  const relays = (group.relays?.length ? group.relays : options?.fallbackRelays) ?? [];
  if (!relays.length) { log(...); return noop; }

  let h: string;
  try { h = getNostrGroupIdHex(group.state); }
  catch { log(...); return noop; }

  const filter = { kinds: [GROUP_EVENT_KIND], "#h": [h] };
  const seen = new Set<string>();
  const drain = async (events: NostrEvent[]): Promise<void> => {
    const fresh = events.filter((event) => !seen.has(event.id));
    for (const event of fresh) seen.add(event.id);
    if (!fresh.length) return;
    try {
      for await (const result of group.ingest(fresh)) {
        if (result.kind === "unreadable")
          this.emit("unreadable", group.id, result.event);
      }
    } catch (err) {
      log("connect: ingest failed for group %s: %o", group.idStr, err);
    }
  };

  await drain(await this.network.request(relays, filter));
  const sub = this.network.subscription(relays, filter)
    .subscribe({ next: (event) => void drain([event]) });
  return { unsubscribe: () => sub.unsubscribe() };
}
```

**Emit pattern to mirror for the new `rejected` emit** — the existing `this.emit("unreadable", group.id, result.event)` call is the exact analog for `this.emit("rejected", group.id, event, reason)` (D-06). Insertion point: filter `fresh` through `verify(event)` BEFORE it reaches `group.ingest(fresh)`, splitting fresh into verified vs rejected, emitting `rejected` for each failure with `reason: 'invalid-signature'` (and, if the `h` strict-getter check is added per Pitfall 2, `reason: 'tag-cardinality'` for cardinality failures on `h`).

**Imports pattern** (lines 1-55) — path-alias-free relative imports with `.js` extensions, grouped: external packages, then `../core/*`, then `../utils/*`, then `./` (sibling client modules). New imports (`verify.ts`, `tag-cardinality.ts`) should slot into the `../utils/*` / `./` groups respectively.

---

### `src/client/invite-manager.ts` — `ingestEvent` (MODIFIED, 1059 boundary)

**Analog:** itself, current shape (lines 181-203):

```typescript
async ingestEvent(event: NostrEvent): Promise<boolean> {
  if (!isGiftWrap(event)) {
    throw new Error(`Expected kind 1059 gift wrap, got kind ${event.kind}`);
  }
  const seen = await this.getSeenSet();
  if (seen.has(event.id)) return false;
  this.#log("ingesting gift wrap %s", event.id);
  await this.store.setItem(`${RECEIVED_PREFIX}${event.id}`, {
    type: "received",
    giftwrap: event,
  });
  seen.add(event.id);
  await this.persistSeen();
  this.emit("received", event);
  return true;
}
```

**Batch-error pattern to reuse** — `ingestEvents` (lines 211-223) already shows the established "catch per-item, emit typed error, continue" loop convention:

```typescript
async ingestEvents(events: NostrEvent[]): Promise<number> {
  let newCount = 0;
  for (const event of events) {
    try {
      const isNew = await this.ingestEvent(event);
      if (isNew) newCount++;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit("error", err, event.id);
    }
  }
  return newCount;
}
```

Insertion point for the verify gate: at the very top of `ingestEvent`, before the `isGiftWrap` type-check and before store write — reject on invalid signature with `emit('rejected', event, 'invalid-signature')` at client/manager scope (no group context, per D-06). The `p` tag cardinality check (subscription-level per RESEARCH.md diagram) slots in alongside.

**Imports pattern** (lines 1-18): same relative-import/`.js`-extension convention; `unlockGiftWrap` from `applesauce-common/helpers/gift-wrap` is the existing seal-verification import to keep — add the new outer-event verify call using the same `applesauce-core/helpers` surface as `verify.ts`.

---

### `src/client/key-package-store.ts` — `addPublished` (MODIFIED, 30443 boundary #1)

**Analog:** itself, current shape (lines 191-219) — already documented in its own doc comment as "the single chokepoint for both tracked (untrusted) and self-published events":

```typescript
async addPublished(ref: string | Uint8Array, event: NostrEvent): Promise<void> {
  const key = this.#resolveKey(ref);
  const publicPackage = getKeyPackage(event);
  const computedRefBytes = await calculateKeyPackageRef(publicPackage, this.#cryptoProvider);
  const computedRef = bytesToHex(computedRefBytes);
  if (computedRef !== key.toLowerCase()) {
    throw new Error(
      `KeyPackage event ${event.id} carries i tag ${key} but its body's KeyPackageRef is ${computedRef}`,
    );
  }
  const existing = await this.#store.getItem(key);
  const identifier = getKeyPackageIdentifier(event);
  // ... persist ...
}
```

**Error-handling convention here is throw, not typed-reject** (unlike `evaluateKeyPackageForGroup`) — this method already throws `Error` on `i`-tag/body mismatch. The new `d`/`i`/`mls_protocol_version` cardinality checks and Lifetime cap/current checks should follow this same throw-on-invalid convention (consistent with existing behavior in this method), OR emit a `rejected` event upstream at the `KeyPackageManager.track()` caller if a non-throwing typed-reject is preferred for the async discovery path — planner's call, but match the existing throw style within this specific function for consistency with its sibling check.

**Imports pattern** (lines 1-19): `bytesToHex` from `@noble/hashes/utils.js`, ts-mls types, `../core/key-package-event.js` (`getKeyPackage`, `getKeyPackageIdentifier`), `../core/key-package.js` (`calculateKeyPackageRef`). New strict-getter/Lifetime-check imports slot into the `../core/*` and `../utils/*` groups.

---

### `src/client/group/invite.ts` — `createInviteIntent` (MODIFIED, 30443 boundary #2)

**Analog:** itself, current shape (lines 34-67):

```typescript
export function createInviteIntent(
  options: CreateInviteIntentOptions,
): Extract<GroupSessionSendIntent, { kind: "commit" }> {
  const { keyPackageEvent, actorPubkey } = options;
  if (keyPackageEvent.kind !== ADDRESSABLE_KEY_PACKAGE_KIND) {
    throw new Error(
      `createInviteIntent: Expected KeyPackage event kind ${ADDRESSABLE_KEY_PACKAGE_KIND}, got ${keyPackageEvent.kind}`,
    );
  }
  const keyPackage = getKeyPackage(keyPackageEvent);
  const credentialIdentity = getCredentialPubkey(keyPackage.leafNode.credential);
  if (credentialIdentity !== keyPackageEvent.pubkey) {
    throw new Error(
      `createInviteIntent: Credential identity ${credentialIdentity} does not match event pubkey ${keyPackageEvent.pubkey}`,
    );
  }
  return { kind: "commit", actorPubkey, extraProposals: [...], welcomeRecipients: [...] };
}
```

**Pattern to reuse:** `throw new Error(\`createInviteIntent: ...\`)`— a function-name-prefixed error message convention specific to this file; extend with the same prefix style for new verify/lifetime/cardinality failures (e.g.`createInviteIntent: KeyPackage event failed signature verification`/`createInviteIntent: KeyPackage lifetime exceeds cap`). This is a pure synchronous function (no I/O) — the verify call must be threaded in as a parameter (no network access here), likely via a new `verifyEvent`option added to`CreateInviteIntentOptions`.

---

### `src/core/key-package-event-decode.ts` — Lifetime read (MODIFIED)

**Analog:** itself — `getKeyPackageMLSVersion` (lines 51-56) is the sibling getter pattern:

```typescript
export function getKeyPackageMLSVersion(
  event: NostrEvent,
): MLS_VERSIONS | undefined {
  const version = getTagValue(event, KEY_PACKAGE_MLS_VERSION_TAG);
  return version as MLS_VERSIONS | undefined;
}
```

New Lifetime-read helper should read `Lifetime` off the decoded `KeyPackage` body (via `getKeyPackage(event).leafNode` — ts-mls `Lifetime` extension), not a tag — different shape than the tag getters, but same file/module placement and `/** doc comment */` + named-export convention. Per RESEARCH.md Pitfall 1, `mls_protocol_version` (`getKeyPackageMLSVersion`) has zero internal call sites today — wiring its cardinality/value check into the KeyPackage inbound boundary is genuinely new code, not a migration.

---

### `src/core/key-package-eligibility.ts` — `evaluateKeyPackageForGroup` (MODIFIED, Lifetime check)

**Analog:** itself, lines 81-161 — the `reasons.push(...)` soft-reject pattern:

```typescript
try {
  const keyPackage = getKeyPackage(keyPackageEvent);
  // ...
  if (keyPackage.cipherSuite !== groupCipherSuite) {
    reasons.push(
      `cipher suite ${codePointHex(keyPackage.cipherSuite)} ≠ group ${codePointHex(groupCipherSuite)}`,
    );
  }
  // ... capability checks push more reasons ...
} catch (err) {
  reasons.push(
    `undecodable: ${err instanceof Error ? err.message : String(err)}`,
  );
}
return { eligible: reasons.length === 0, alreadyMember, cipherSuite, reasons };
```

New Lifetime check slots in as another `reasons.push(...)` inside the existing `try` block, following the exact same `reasons.push(\`<short description>\`)`message-string convention as the cipher-suite/capability checks (never throws — returns`eligible: false` with a reason string per the function's established contract).

---

### `src/core/key-package.ts` — `generateKeyPackage` (MODIFIED, produce-side cap)

**Analog:** itself, lines 86-114 — `resolvedLifetime = lifetime ?? createThreeMonthLifetime()` (line 105) is the sole call site. Since `createThreeMonthLifetime()` itself is being fixed at the source (D-09), this file needs no change unless RESEARCH.md's Open Question 2 (guarding an explicit `lifetime` override against exceeding the cap) is adopted — if so, add a cap-check similar to the existing guard pattern at line 96-97:

```typescript
if (credential.credentialType !== defaultCredentialTypes.basic)
  throw new Error("Marmot key packages must use a basic credential");
```

---

### `src/client/marmot-client.ts` — inject `verifyEvent` option (MODIFIED)

**Analog:** itself, `MarmotClientOptions` (lines 85-156) — existing optional-field-with-JSDoc pattern to copy exactly:

```typescript
/** Optional forensic audit sink inherited by groups. Omitted by default. */
audit?: AuditSink;
/** Required when `audit` is set; contains stable engine/account/session metadata. */
auditContext?: AuditContextOptions;
```

New field: `verifyEvent?: VerifyEventMethod;` with a JSDoc comment following the same "what it defaults to, why it's pluggable" style as `convergencePolicy`/`ingestionPool` docs (lines 111-125), then threaded down into `GroupsManagerOptions`, `InviteManagerOptions`, `KeyPackageManagerOptions` (RESEARCH.md architecture diagram) the same way `audit`/`auditContext`/`cryptoProvider` are already threaded to sub-managers today (`network`, `cryptoProvider` fields, lines 130-133).

---

## Shared Patterns

### Reject-via-typed-result / manager emit (not throw), for inbound multi-outcome flows

**Source:** `src/client/groups-manager.ts:456-458` (`this.emit("unreadable", group.id, result.event)`)
**Apply to:** `groups-manager.ts` (445), `invite-manager.ts` (1059), `key-package-manager.ts`/`key-package-store.ts` (30443) — all three managers already own an `EventEmitter`-based typed-event surface (`eventemitter3`); the new `rejected` emit is a sibling to `unreadable`/`error`, not a replacement.

```typescript
if (result.kind === "unreadable")
  this.emit("unreadable", group.id, result.event);
```

### Discriminated-union / string-literal reason taxonomies

**Source:** `src/engine/types.ts:100-110` (`SkippedIngestResult.reason` union)
**Apply to:** the new `RejectReason` type in `src/client/verify.ts`

```typescript
reason:
  | "past-epoch"
  | "wrong-wireformat"
  | "self-echo"
  | "duplicate"
```

### Try/catch → typed reasons array (never throw on malformed input)

**Source:** `src/core/key-package-eligibility.ts:149-153`
**Apply to:** `key-package-eligibility.ts` Lifetime check, and any new cardinality/decode helper that must not throw

```typescript
} catch (err) {
  reasons.push(`undecodable: ${err instanceof Error ? err.message : String(err)}`);
}
```

### Sibling-helper-not-replacement (leave `getTagValue` untouched)

**Source:** `src/utils/nostr.ts:10-15`
**Apply to:** `getSingletonTagValue`/`getListTag` in the same or a new file — same `NostrEvent, name: string` signature, same `applesauce-core/helpers/event` import.

### applesauce injectable synchronous verifier

**Source:** `node_modules/.pnpm/applesauce-core@6.2.0.../dist/helpers/event.d.ts` (cited in RESEARCH.md, lines 260-283)
**Apply to:** all three entry points, plus `MarmotClientOptions`

```typescript
export type VerifyEventMethod = (event: NostrEvent) => event is VerifiedEvent;
// default: verifyEvent (cached via event[verifiedSymbol]); trust-upstream: fakeVerifyEvent
```

## No Analog Found

None — every file in scope has an exact same-file analog (modifying its own current implementation) or a clear installed-dependency analog (applesauce verification surface). The only genuinely _new_ code with no prior internal pattern is the `mls_protocol_version` cardinality/value check and the 30443 `d`/`i` cardinality checks (RESEARCH.md Pitfall 1) — these are new wiring, not migrations, but they still follow the `getTagValue`-sibling-getter shape documented above.

## Metadata

**Analog search scope:** `src/client/`, `src/core/`, `src/utils/`, `src/engine/types.ts`, `node_modules/.pnpm/applesauce-core`, `src/__tests__/`
**Files scanned:** 13 direct reads (groups-manager.ts, invite-manager.ts, key-package-store.ts, group/invite.ts, nostr.ts, timestamp.ts, key-package.ts, key-package-event-decode.ts, key-package-eligibility.ts, engine/types.ts, marmot-client.ts, plus RESEARCH.md-cited applesauce/nostr-tools sources)
**Pattern extraction date:** 2026-07-22
