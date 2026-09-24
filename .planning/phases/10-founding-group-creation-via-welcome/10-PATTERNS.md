# Phase 10: Founding Group Creation via Welcome - Pattern Map

**Mapped:** 2026-09-24
**Files analyzed:** 9 (all modified, none new — per CONTEXT.md/RESEARCH.md, this phase is a seam
modification, not new-file creation)
**Analogs found:** 9 / 9 (every file's analog is itself — this phase extends existing switch
statements, unions, and classes in place; the "closest analog" for each seam is the sibling
case/variant already in the same file)

## File Classification

| Modified File | Role | Data Flow | Closest Analog (in-file sibling) | Match Quality |
|---|---|---|---|---|
| `src/engine/types.ts` | model (discriminated union) | request-response | `SendIntent`/`SendResult` existing `"commit"`/`"selfUpdate"` variants, `PendingState` | exact |
| `src/engine/group-engine.ts` (`send()` new case) | controller/state-machine | request-response, CRUD (state transition) | `case "commit"` (`:1067-1175`), `case "selfUpdate"` (`:1177+`) | exact |
| `src/engine/group-engine.ts` (audit-outcome block) | utility (audit) | event-driven | `send()`'s `send_outcome` emit (`:924-935`), `auditSendResultKind`/`auditSendIntentKind` (`:3582-3606`) | exact |
| `src/client/transport/nostr/welcome-delivery.ts` (`deliverMany()`) | service (transport) | fan-out / batch | `NostrWelcomeDelivery.deliver()` (`:55-84`), `AncillaryEffectOutcome` (`group-effects.ts:30-33`) | exact |
| `src/client/runtime/group-runtime.ts` (`#deliverWelcomes()` → `deliverMany()` caller) | service (runtime) | batch, request-response | itself, current `#deliverWelcomes()` (`:448-503`) and `#publishCommitResult` welcome block (`:293-308`) | exact |
| `src/client/session/group-effects.ts` (`welcomeDelivery` shape) | model | discriminated union | `AncillaryEffectOutcome` (`:30-33`), `GroupPublishResult` (`:36-47`) | exact |
| `src/client/group-factory.ts` (`create()`) | controller/orchestrator | CRUD (create) | its own existing solo-only `create()` (`:116-161`) | exact — extend in place |
| `src/client/groups-manager.ts` (`create()`, `invite()`) | controller (pass-through) | CRUD, request-response | its own `create()` (`:806-816`), `invite()` (`:365-378`) | exact |
| `src/client/group/marmot-group.ts` (`pendingWelcomes`, `retryWelcome()`) | model/store (per-instance state) | CRUD (in-memory) | its own `runtime`/`session` readonly-field pattern (`:364-367`), `NostrWelcomeDelivery` construction (`:735-738`) | exact |
| `src/core/group.ts` (invitees threading) | service (pure factory function) | CRUD | its own `createSimpleGroup()`/`createGroup()` (`:52-165`) | exact |
| Test: FOUND-05 integration | test | request-response (E2E) | `src/__tests__/integration/end-to-end-invite-join-message.test.ts` | exact |
| Test: R-03 migration | test | request-response | `src/client/runtime/__tests__/group-runtime.test.ts` (`makeRuntime`, "GroupRuntime Welcome delivery" describe block, `:361-415`) | exact |

## Pattern Assignments

### `src/engine/types.ts` (model, discriminated union)

**Analog:** itself — extend `SendIntent`, `SendResult`, and (optionally) `PendingState.kind`.

**Current `PendingState`** (`:82-102`):
```typescript
export type PendingState = {
  kind: "proposal" | "commit" | "selfUpdate";
  newState: ClientState;
  parentState?: ClientState;
  commitMessage?: MlsMessage;
  ownCommitStamp?: OwnCommitConvergenceStamp;
  terminalEvidence?: DisbandCandidateEvidence;
};
```
Per RESEARCH.md Open Question #1 / Assumption A1: reuse `"commit"` as `PendingState.kind` for the
founding Add's pending record unless the plan wants an independently diagnostic `"foundingAdd"`
value — either way `confirmPublished()`'s `pending.kind === "commit" || pending.kind ===
"selfUpdate"` guard must be updated only if a new literal is added.

**Current `SendIntent`/`SendResult`** (`:114-140`):
```typescript
export type SendIntent =
  | { kind: "applicationMessage"; payload: Uint8Array }
  | { kind: "proposal"; proposal: Proposal }
  | {
      kind: "commit";
      actorPubkey: string;
      extraProposals?: (...)[];
      proposalRefs?: string[];
    }
  | { kind: "selfUpdate" };

export type SendResult<TEnvelope> =
  | { kind: "applicationMessage"; envelope: TEnvelope; newState: ClientState }
  | { kind: "proposal"; envelope: TEnvelope; pending: PendingState }
  | { kind: "groupEvolution"; envelope: TEnvelope; welcome: MlsWelcomeMessage | undefined; pending: PendingState }
  | { kind: "selfUpdate"; envelope: TEnvelope; pending: PendingState };
```
D-02: add `{ kind: "foundingAdd"; extraProposals: (Proposal | ProposalAction<Proposal>)[] }` to
`SendIntent`, and `{ kind: "foundingGroupCreated"; welcome: MlsWelcomeMessage; pending: PendingState }`
to `SendResult` — note it has **no `envelope` field**, which is the deliberate FOUND-01 shape and
also the compile-time forcing function for the audit-wrapper fix below.

---

### `src/engine/group-engine.ts` — new `send()` case (controller/state-machine)

**Analog:** `case "commit"` (`:1067-1175`), reused almost verbatim minus two steps.

```typescript
// Source: src/engine/group-engine.ts case "commit" (lines 1067-1175)
case "commit": {
  const groupData = getMarmotGroupView(this.state);
  if (!groupData) throw new Error("MarmotGroupData not found in ClientState.");
  if (!mayPrepareLocalCommit(this.#lifecycle)) {
    throw new Error(`Cannot prepare a commit while the group is ${this.#lifecycle}`);
  }
  // ... proposal resolution from intent.extraProposals / intent.proposalRefs ...
  const prepared = this.#prepareOutboundCommitProposals(
    this.state, groupData.adminPubkeys, newProposals,
  );
  const parentState = this.state;
  const { commit, newState, welcome } = await createCommit({
    context: { cipherSuite: this.ciphersuite, authService: marmotAuthService },
    state: prepared.commitState,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    ...(prepared.extraProposals.length > 0 ? { extraProposals: prepared.extraProposals } : {}),
  });

  // FOUND-02 gate — same call the founding Add must make:
  this.#assertStagedCommitLegal(
    parentState, newState, prepared.committedWithSenders,
    Number(parentState.privatePath.leafIndex),
  );

  const envelope = await this.peeler.wrapGroupMessage(commit, this.state); // <-- SKIP for founding Add (FOUND-01)

  this.#transitionLifecycle(groupLifecycleStates.pendingPublish, "begin_pending", "commit");
  this.#stagedCommitParentEpoch = Number(parentState.groupContext.epoch);
  this.#sentContentIds.add(contentDedupId(commit));

  return {
    kind: "groupEvolution",
    envelope, // <-- founding Add's result has no envelope at all
    welcome,
    pending: {
      kind: "commit",
      newState, parentState, commitMessage: commit,
      ownCommitStamp: this.#ownCommitStamp(commit, prepared),
    },
  };
}
```

**Two steps the founding-Add case must skip** (per RESEARCH.md "Pattern: reuse the case commit
staging skeleton, minus two steps" and CONTEXT.md Integration Points):
1. `await this.peeler.wrapGroupMessage(commit, this.state)` — never call it; no envelope is ever
   constructed, not merely unpublished.
2. The runtime publish step does not apply here at all (there is nothing to publish) — but that is
   a `GroupFactory`-level distinction, not something in this `send()` case itself, since `send()`
   never publishes.

**D-01: immediately after the founding-Add case returns**, the caller in `GroupFactory.create()`
must call `engine.confirmPublished(result.pending)` in the same uninterrupted sequence — see
`confirmPublished()` below, reused verbatim.

**FOUND-02 gate — identical to `case "commit"`, no new/earlier check needed** (Priority Finding #2):
```typescript
// Source: src/engine/group-engine.ts (lines 1141-1152), the exact call to copy
this.#assertStagedCommitLegal(
  parentState,
  newState,
  prepared.committedWithSenders,
  Number(parentState.privatePath.leafIndex),
);
```

---

### `src/engine/group-engine.ts` — `confirmPublished()` (reused verbatim, D-01)

**Analog:** itself; not modified, only called from the new founding path.

```typescript
// Source: src/engine/group-engine.ts:1553-1648 (excerpted, commit-producing branch)
confirmPublished(pending: PendingState): StateNotification[] {
  if (pending.kind === "commit" || pending.kind === "selfUpdate") {
    if (!pending.parentState || !pending.commitMessage) {
      throw new Error("Commit pending state requires parentState and commitMessage");
    }
    const fromEpoch = Number(pending.parentState.groupContext.epoch);
    const toEpoch = Number(pending.newState.groupContext.epoch);
    this.#transitionLifecycle(groupLifecycleStates.merging, "publish_confirmed", pending.kind);
    // ... terminalEvidence branch (not relevant to founding Add) ...
    try {
      this.#setState(pending.newState);
      this.#recordCommitNode(               // <-- CR-09 fix: retained store + history tree
        pending.parentState, pending.commitMessage, pending.newState, pending.ownCommitStamp,
      );
      const digest = commitDigest(encode(mlsMessageEncoder, pending.commitMessage));
      let notifications: StateNotification[];
      try {
        notifications = deriveStateNotifications({
          parentState: pending.parentState, resultingState: pending.newState, commitDigest: digest,
        });
      } catch (error) { notifications = []; }
      this.#stateNotifications.record(digest, toEpoch, notifications);
      this.#emitAudit({ type: "epoch_confirmed", from_epoch: fromEpoch, to_epoch: toEpoch, pending_kind: pending.kind });
      return notifications;
    } finally {
      this.#transitionLifecycle(groupLifecycleStates.stable, "merge_complete", pending.kind);
      this.#stagedCommitParentEpoch = undefined;
      this.#scheduleRetainedContinuation();
    }
  }
  // ... proposal-kind branch, not relevant ...
}
```
Note (RESEARCH.md "D-01's window, precisely enumerated"): this method contains **zero internal
`await`s** — it is fully synchronous. This is what makes D-01's "transit `PendingPublish`, never
yield" claim structurally sound, modulo the one microtask-tick gap on `await engine.send(...)`
itself (see Shared Patterns below).

---

### `src/engine/group-engine.ts` — audit-outcome block (compile-blocking seam, new finding)

**Analog:** the existing unconditional block that must gain a per-kind branch.

```typescript
// Source: src/engine/group-engine.ts:914-946 (send()'s outer wrapper)
async send(intent: SendIntent): Promise<SendResult<TEnvelope>> {
  ...
  const intentKind = auditSendIntentKind(intent);
  this.#emitAudit({ type: "send_entry", intent_kind: intentKind });
  try {
    const result = await this.#sendInner(intent);
    this.#emitAudit({
      type: "send_outcome",
      intent_kind: intentKind,
      result_kind: auditSendResultKind(result),
      outbound_messages: [
        {
          msg_id: this.peeler.idOf(result.envelope),               // <-- unconditional .envelope access
          artifact_kind: this.#artifactKind(result.envelope, result.kind),
          transport: this.#transportEnvelope(result.envelope),
        },
      ],
    });
    return result;
  } catch (error) { ... }
}
```
**Required fix (RESEARCH.md Pitfall 1):** add an explicit branch —
```typescript
this.#emitAudit({
  type: "send_outcome",
  intent_kind: intentKind,
  result_kind: auditSendResultKind(result),
  outbound_messages:
    result.kind === "foundingGroupCreated" ? [] : [
      {
        msg_id: this.peeler.idOf(result.envelope),
        artifact_kind: this.#artifactKind(result.envelope, result.kind),
        transport: this.#transportEnvelope(result.envelope),
      },
    ],
});
```
Also extend the two exhaustive switches near `:3582-3606`:
```typescript
// Source: src/engine/group-engine.ts:3582-3606
function auditSendIntentKind(intent: SendIntent): string {
  switch (intent.kind) {
    case "commit": return "commit";
    case "selfUpdate": return "self_update";
    // ADD: case "foundingAdd": return "founding_add";
    ...
  }
}
function auditSendResultKind<TEnvelope>(result: SendResult<TEnvelope>): string {
  switch (result.kind) {
    case "selfUpdate": ...
    // ADD: case "foundingGroupCreated": return "founding_group_created";
  }
}
```
Do **not** widen `foundingGroupCreated`'s type with a dummy `envelope: undefined` field — that
reintroduces a runtime crash risk in `#transportEnvelope` (see RESEARCH.md Pitfall 1 warning).

---

### `src/client/transport/nostr/welcome-delivery.ts` (`deliverMany()`, D-07)

**Analog:** `NostrWelcomeDelivery.deliver()` (`:55-84`), generalized per `AncillaryEffectOutcome`'s
three-state shape.

```typescript
// Source: src/client/transport/nostr/welcome-delivery.ts:55-84 (deliver(), reused as-is per recipient)
async deliver(options: DeliverWelcomeOptions): Promise<Record<string, PublishResponse>> {
  const welcomeRumor = this.createRumor(options);
  const giftWrapEvent = await createGiftWrap({
    rumor: welcomeRumor, recipient: options.recipient.pubkey, signer: this.signer,
  });
  let inboxRelays: string[];
  try {
    inboxRelays = await this.network.getUserInboxRelays(options.recipient.pubkey);
  } catch {
    inboxRelays = options.groupRelays;
  }
  if (inboxRelays.length === 0) {
    throw new Error(`No relays available to send Welcome to recipient ${options.recipient.pubkey.slice(0, 16)}...`);
  }
  return this.network.publish(inboxRelays, giftWrapEvent);
}
```

**`AncillaryEffectOutcome` — the three-state shape to mirror per-recipient** (`group-effects.ts:30-33`):
```typescript
export type AncillaryEffectOutcome =
  | { kind: "notRequired" }
  | { kind: "succeeded" }
  | { kind: "failed"; error: string };
```

**Proposed `deliverMany()` (RESEARCH.md Code Examples, illustrative signature):**
```typescript
export type WelcomeDeliveryOutcome =
  | { recipient: WelcomeRecipient; kind: "succeeded"; response: Record<string, PublishResponse> }
  | { recipient: WelcomeRecipient; kind: "failed"; error: string };

async deliverMany(options: {
  welcome: Welcome;
  author: string;
  groupRelays: string[];
  recipients: WelcomeRecipient[];
}): Promise<WelcomeDeliveryOutcome[]> {
  // Move the Promise.allSettled loop currently private inside
  // GroupRuntime.#deliverWelcomes() here (see below); never throw, never
  // aggregate — map each settled result to one outcome entry.
}
```
Internally this should be the exact `Promise.allSettled` loop below, moved and de-throw'd.

---

### `src/client/runtime/group-runtime.ts` — `#deliverWelcomes()` → `deliverMany()` caller (D-06)

**Analog:** its own current implementation, being replaced in place.

**Current aggregate-throw loop, to move/adapt** (`:448-503`):
```typescript
// Source: src/client/runtime/group-runtime.ts:448-503
async #deliverWelcomes(
  welcome: import("ts-mls").Welcome,
  actorPubkey: string,
  recipients: WelcomeRecipient[],
): Promise<void> {
  const groupData = this.#getGroupData();
  if (!groupData) throw new Error("MarmotGroupData not found in ClientState.");
  const welcomeResults = await Promise.allSettled(
    recipients.map((recipient) =>
      this.welcomeDelivery.deliver({
        welcome, author: actorPubkey, groupRelays: groupData.relays, recipient,
      }),
    ),
  );
  const failureDetails = welcomeResults
    .map((result, i) => ({ result, recipient: recipients[i] }))
    .filter((item): item is { result: PromiseRejectedResult; recipient: WelcomeRecipient } =>
      item.result.status === "rejected")
    .map((item) => {
      const msg = item.result.reason instanceof Error ? item.result.reason.message : String(item.result.reason);
      return `${item.recipient.pubkey.slice(0, 16)}...: ${msg}`;
    });
  if (failureDetails.length > 0) {
    throw new Error(
      `Failed to deliver ${failureDetails.length}/${recipients.length} Welcome message(s): ${failureDetails.join("; ")}`,
    );
  }
}
```
Under D-06/D-07, this body's loop moves to `NostrWelcomeDelivery.deliverMany()` (never throwing);
`GroupRuntime` becomes a thin caller: `const outcomes = await this.welcomeDelivery.deliverMany({...})`,
then reduce `outcomes` into the new `GroupPublishResult.welcomeDelivery` shape (Claude's discretion:
array vs. record keyed by pubkey).

**Current caller site to update** (`#publishCommitResult`, `:293-308`):
```typescript
// Source: src/client/runtime/group-runtime.ts:293-308
const innerWelcome = options.welcome?.welcome;
let welcomeDelivery: GroupPublishResult["welcomeDelivery"] = { kind: "notRequired" };
if (innerWelcome && options.welcomeRecipients?.length) {
  try {
    await this.#deliverWelcomes(innerWelcome, options.actorPubkey, options.welcomeRecipients);
    welcomeDelivery = { kind: "succeeded" };
  } catch (error) {
    welcomeDelivery = { kind: "failed", error: errorDetail(error) };
  }
}
```
This whole try/catch collapses once `deliverMany()` never throws — replace with a direct call and
per-recipient reduction into the new shape.

---

### `src/client/session/group-effects.ts` — `GroupPublishResult.welcomeDelivery` shape (D-06)

**Analog:** its own `AncillaryEffectOutcome` and `GroupPublishResult` (`:30-47`), extended in place.

```typescript
// Source: src/client/session/group-effects.ts:29-47 (current shape)
export type AncillaryEffectOutcome =
  | { kind: "notRequired" }
  | { kind: "succeeded" }
  | { kind: "failed"; error: string };

export type GroupPublishResult = {
  work: GroupPublishWork;
  response: Record<string, PublishResponse>;
  notifications: StateNotification[];
  persistence: AncillaryEffectOutcome;
  welcomeDelivery: AncillaryEffectOutcome;   // <-- D-06: becomes per-recipient
  retryPublication: boolean;
};
```
`persistence` stays a single `AncillaryEffectOutcome` (unchanged — persistence is one write, not
per-recipient). Only `welcomeDelivery`'s type changes to carry `WelcomeDeliveryOutcome[]` (or a
record), sourced directly from `NostrWelcomeDelivery.deliverMany()`'s return.

---

### `src/client/group-factory.ts` — `create()` founding orchestration (all D-01/02/03/05/07/11/13)

**Analog:** its own existing solo-only `create()` (`:116-161`), extended with an invitees branch.

```typescript
// Source: src/client/group-factory.ts:116-161 (current solo-only create())
async create(
  name: string,
  options?: CreateGroupOptions,
): Promise<MarmotGroup<THistory, TMedia>> {
  const ciphersuiteImpl = await this.#getCiphersuiteImpl(options?.ciphersuite);
  const pubkey = await this.#signer.getPublicKey();
  const credential = await createCredential(pubkey);
  const keyPackage = await generateKeyPackage({ credential, ciphersuiteImpl, signer: this.#signer });

  const { clientState } = await createSimpleGroup(keyPackage, ciphersuiteImpl, name, {
    ...options,
    adminPubkeys: [...new Set([pubkey, ...(options?.adminPubkeys || [])])],
  });

  const group = new MarmotGroup<THistory, TMedia>(clientState, { /* ...factory-held stores/services... */ });
  await group.save(true);   // <-- D-03: the ONE durable write; founding path must still be exactly one save()

  return group;
}
```
**New founding branch (per RESEARCH.md Architecture Patterns diagram):** after `createSimpleGroup`
produces epoch-0 `clientState`, construct a `MarmotGroupEngine` in-memory (not yet saved), loop
`options.invitees` through `createInviteIntent()` (see below) to collect `extraProposals`/
`welcomeRecipients`, call `engine.send({kind:"foundingAdd", extraProposals})`, then
`engine.confirmPublished(result.pending)` in the same synchronous continuation (D-01 — no `await`
between these two calls), then D-13's assertion, then construct `MarmotGroup`/`save(true)` once,
then `group.runtime.welcomeDelivery.deliverMany({...})` (D-05/D-07, bypassing `GroupRuntime`).
**Do not** construct `MarmotGroup`/wire `GroupSession`/subscribe to events before
`confirmPublished()` returns (RESEARCH.md Anti-Patterns).

---

### `src/client/group/invite.ts` — `createInviteIntent()` (reused per invitee, D-11)

**Analog:** itself, called once per invitee, its non-`kind`/non-`actorPubkey` fields destructured out.

```typescript
// Source: src/client/group/invite.ts:62-127 (full function, reused verbatim per invitee)
export function createInviteIntent(
  options: CreateInviteIntentOptions,
): Extract<GroupSessionSendIntent, { kind: "commit" }> {
  const { keyPackageEvent, actorPubkey } = options;
  if (keyPackageEvent.kind !== ADDRESSABLE_KEY_PACKAGE_KIND) throw new Error(...);
  const verify = options.verifyEvent ?? defaultVerifyEvent;
  if (!safeVerifyEvent(verify, keyPackageEvent)) throw new Error(...);          // SEC-01
  if (getSingletonTagValue(keyPackageEvent, "d") === undefined || ...) throw new Error(...); // WIRE-02
  const lifetime = getKeyPackageLifetime(keyPackageEvent);
  if (!lifetime || !isLifetimeWithinCap(lifetime) || !isLifetimeCurrentWithGrace(lifetime))
    throw new Error(...);                                                        // WIRE-01
  const keyPackage = getKeyPackage(keyPackageEvent);
  const credentialIdentity = getCredentialPubkey(keyPackage.leafNode.credential);
  if (credentialIdentity !== keyPackageEvent.pubkey) throw new Error(...);        // identity gate
  return {
    kind: "commit",
    actorPubkey,
    extraProposals: [proposeInviteUser(keyPackageEvent)],
    welcomeRecipients: [{ pubkey: keyPackageEvent.pubkey, keyPackageEventId: keyPackageEvent.id, keyPackageEvent }],
  };
}
```
D-11: `GroupFactory.create()`'s founding path calls this once per invitee and picks out
`intent.extraProposals[0]` and `intent.welcomeRecipients[0]`, discarding the rest of the returned
`commit`-kind intent (accepted awkwardness, do not refactor this function to avoid it).

---

### `src/client/groups-manager.ts` — `create()`/`invite()` (D-08 pass-through, D-06 blast radius)

**Analog:** its own existing thin pass-through methods.

```typescript
// Source: src/client/groups-manager.ts create() (~:806-816)
async create(
  name: string,
  options?: CreateGroupOptions,
): Promise<MarmotGroup<THistory, TMedia>> {
  log("creating group %o", name);
  const group = await this.#factory.create(name, options);
  await this.#registry.track(group);
  this.emit("created", group);
  return group;
}
```
D-08: `CreateGroupOptions` gains `invitees?: NostrEvent[]`; this method needs **no changes** —
it already forwards `options` verbatim to `#factory.create()`.

```typescript
// Source: src/client/groups-manager.ts invite() (~:365-378), the D-06 blast-radius caller
async invite(
  groupId: Uint8Array | string,
  keyPackageEvent: NostrEvent,
): Promise<Record<string, PublishResponse>> {
  const actorPubkey = await this.signer.getPublicKey();
  const [result] = await this.send(groupId, createInviteIntent({ keyPackageEvent, actorPubkey, verifyEvent: this.#verifyEvent }));
  return result.response;
}
```
This method itself is unaffected in signature — but the `GroupPublishResult` it receives from
`this.send()` now carries the D-06 per-recipient `welcomeDelivery` shape instead of the old
aggregate `AncillaryEffectOutcome`. No code change needed here since it only reads `.response`,
but any caller inspecting `.welcomeDelivery` downstream is in the R-03 blast radius.

---

### `src/client/group/marmot-group.ts` — `pendingWelcomes` + `retryWelcome()` (D-10)

**Analog:** its own readonly-field construction pattern for `runtime`/`session`.

```typescript
// Source: src/client/group/marmot-group.ts:364-367 (existing readonly field pattern to mirror)
readonly session: GroupSession<THistory>;
readonly runtime: GroupRuntime;
readonly mediaService: GroupMediaService<TMedia>;
```
New: add a mutable (not readonly) `pendingWelcomes: WelcomeDeliveryOutcome[]` populated once by
`GroupFactory.create()`'s founding path, plus a `retryWelcome(pubkey: string): Promise<void>`
method that re-resolves the failed recipient and calls `this.runtime.welcomeDelivery.deliverMany()`
(or `.deliver()`) again for just that one recipient, updating `this.pendingWelcomes` in place.

```typescript
// Source: src/client/group/marmot-group.ts:735-738 (NostrWelcomeDelivery construction site)
this.runtime = new GroupRuntime({
  welcomeDelivery: new NostrWelcomeDelivery({ signer: this.signer, network: this.network }),
  ...
});
```
`retryWelcome()` reaches this same instance via `this.runtime.welcomeDelivery` — no new
construction needed, matching D-07's "no new plumbing" framing.

---

### `src/core/group.ts` — invitees parameter threading (D-08 discretion)

**Analog:** its own `createSimpleGroup()`/`createGroup()` (`:52-165`), the D-09 footgun site.

```typescript
// Source: src/core/group.ts:146-151 (the exact D-09 footgun — relay-gated routing component)
const relays = options?.relays ?? [];
if (relays.length > 0) {
  components.push(nostrRoutingEntry({ nostrGroupId: randomBytes(32), relays }));
}
```
Note: `createGroup()`/`createSimpleGroup()` themselves need **no invitees parameter** under the
recommended design — D-11 handles invitee admission entirely at the `GroupFactory`/engine layer via
`createInviteIntent()` + `engine.send({kind:"foundingAdd"})`, operating on the epoch-0
`ClientState` these functions already return. Only add a parameter here if the plan's chosen
design pushes invitee proposals in at group-creation time rather than as a follow-up founding
Add — RESEARCH.md's recommended architecture (see Shared Patterns diagram) does **not** require
this file to change beyond what `CreateGroupOptions`/`SimpleGroupOptions` already expose.

---

### Test: FOUND-05 integration (analog: `end-to-end-invite-join-message.test.ts`)

**Analog:** `src/__tests__/integration/end-to-end-invite-join-message.test.ts` — read in full per
RESEARCH.md Priority Finding #3. Reuse its exact scaffolding:
- `MockNetwork` (`src/__tests__/helpers/mock-network.ts`)
- `InMemoryKeyValueStore` for both clients' `groupStateStore`/`keyPackageStore`
- `PrivateKeyAccount.generateNew()` (applesauce-accounts) for admin + each invitee
- `MarmotClient` as the top-level facade (not raw `GroupsManager`), so `options.invitees` threads
  through `CreateGroupOptions` exactly as an app would use it
- gift-wrap fetch pattern: `mockNetwork.request(["wss://mock-inbox.test"], {kinds:[1059], "#p":[inviteePubkey]})` + `unlockGiftWrap`
- `client.joinGroupFromWelcome({ welcomeRumor })`, epoch assertion, KeyPackage-consumed assertion
- manual `group.ingest(groupEvents)` catch-up, application-message send/receive

**Concrete shape (RESEARCH.md Priority Finding #3, steps 1-7):**
1. N invitees publish KeyPackages.
2. `adminClient.groups.create("Founding Group", { adminPubkeys: [adminPubkey], relays: [...], invitees: [...] })` — relays are **mandatory** (R-05).
3. **FOUND-01 negative assertion:** immediately after `create()` resolves, filter `mockNetwork.events` for `kind === GROUP_EVENT_KIND` and assert length `0`.
4. **FOUND-03 positive assertion:** synchronously (no intervening `await`) assert `epoch === 1` and lifecycle `Stable`.
5. Assert exactly N gift-wrap (1059) events, one per invitee.
6. Each invitee calls `joinGroupFromWelcome`; assert both land at epoch 1 and see each other as members (proves one shared founding commit, not N sequential ones).
7. Bidirectional messaging: invitee → admin and admin → invitee (positive control per CONTEXT.md `<specifics>`).

---

### Test: R-03 migration (`group-runtime.test.ts`)

**Analog:** its own current fixture and assertions — must be migrated, not patched green.

**Fixture to update** (`:55-77`):
```typescript
// Source: src/client/runtime/__tests__/group-runtime.test.ts:55-77
const deliver = vi.fn(async () => ackResponse());
...
const options: GroupRuntimeOptions = {
  welcomeDelivery: { deliver } as unknown as NostrWelcomeDelivery,  // <-- stub is missing deliverMany
  ...
};
```
Once `GroupRuntime` calls `this.welcomeDelivery.deliverMany(...)`, this stub must expose
`deliverMany` (mocking the same per-recipient semantics) or every Welcome-bearing test throws
`TypeError: ...deliverMany is not a function`.

**Assertion to migrate, not weaken** (`:405-410`):
```typescript
// Source: src/client/runtime/__tests__/group-runtime.test.ts:405-410 (current, must change under D-06)
expect(result.welcomeDelivery).toEqual({
  kind: "failed",
  error: expect.stringMatching(
    /Failed to deliver 1\/2 Welcome message\(s\).*inbox unreachable/,
  ),
});
```
Rewrite to assert the new per-recipient array/record shape directly (e.g. one entry `{kind:
"succeeded", ...}` for `recipient`, one `{kind: "failed", error: "...inbox unreachable"}` for
`second`), preserving the original test's intent per Pitfall 3 — do not replace with
`toBeDefined()` or similar loosening.

Also check (per RESEARCH.md): the "executes the pinned invite-publish-fail rollback before Welcome
delivery" test (`:250`) still short-circuits correctly (never reaches delivery) under the new code
path.

## Shared Patterns

### D-01 "never yield" — enforced by sequencing, not by type (R-01)

**Source:** `src/engine/group-engine.ts` `send()` + `confirmPublished()`.
**Apply to:** `src/client/group-factory.ts`'s new founding branch.
```typescript
const result = await engine.send({ kind: "foundingAdd", extraProposals });
if (result.kind !== "foundingGroupCreated") throw new Error("unexpected send() result kind");
// D-01: confirm in the SAME synchronous continuation — no await, no logging,
// no persistence between these two lines.
const notifications = engine.confirmPublished(result.pending);
```
**Obligation (R-01):** write a test that fails if a caller inserts an `await` between these two
lines (e.g. assert lifecycle is never observably `PendingPublish` to any concurrent `ingest()` or
persisted artifact) — see RESEARCH.md Pitfall 2.

### `AncillaryEffectOutcome`'s three-state shape

**Source:** `src/client/session/group-effects.ts:30-33`.
**Apply to:** the per-recipient element type of `deliverMany()`'s return and the new
`GroupPublishResult.welcomeDelivery`/`MarmotGroup.pendingWelcomes` shapes — every per-recipient or
per-operation fallible outcome in this phase should be a `{kind: "succeeded"} | {kind: "failed";
error: string}`-shaped literal union (adding `recipient` where per-recipient identity matters),
never `null | result`.

### D-13 placement — after `confirmPublished()`, before `save()`

**Source:** RESEARCH.md "D-13's placement" + CONTEXT.md Integration Points ordering.
**Apply to:** `src/client/group-factory.ts`'s founding branch — the assertion needs
`result.welcome`'s per-recipient `secrets` entries, which only exist after `send()` returns; running
it post-`confirmPublished()` does not introduce a new yield point (it's synchronous) and keeps a
failure clean (nothing persisted yet, per D-03).

## No Analog Found

None — every file in scope already exists and has an in-file sibling pattern to extend (see table
above). This phase introduces no new architectural shape.

## Metadata

**Analog search scope:** `src/engine/`, `src/client/`, `src/core/group.ts`, `src/__tests__/`
**Files scanned:** `src/engine/types.ts`, `src/engine/group-engine.ts`, `src/client/transport/nostr/welcome-delivery.ts`, `src/client/runtime/group-runtime.ts`, `src/client/session/group-effects.ts`, `src/client/group-factory.ts`, `src/client/groups-manager.ts`, `src/client/group/marmot-group.ts`, `src/client/group/invite.ts`, `src/core/group.ts`, `src/client/runtime/__tests__/group-runtime.test.ts`, `src/__tests__/integration/end-to-end-invite-join-message.test.ts`
**Pattern extraction date:** 2026-09-24
