# Phase 10: Founding Group Creation via Welcome - Research

**Researched:** 2026-09-24
**Domain:** MLS founding-group creation, publish-before-apply lifecycle, Welcome delivery fanout
**Confidence:** HIGH (all findings below are grounded in direct code reads of this repo plus `refs/marmot`/`refs/mdk`; no external libraries are introduced by this phase, so there is no package-ecosystem uncertainty)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**13 decisions. Four carry explicitly-accepted costs (D-02, D-05, D-06, D-10) and two produce unmitigated
risks (R-02, R-04 below). None of the four may be silently "improved" during planning — each was chosen against
a named alternative.**

#### Lifecycle & merge path

- **D-01: Transit `PendingPublish`, never yield.** Stage the founding Add, transition to `PendingPublish`, then
  call `confirmPublished()` **in the same uninterrupted await**. **No FSM change** — `LEGAL_TRANSITIONS` is
  untouched. CR-09 recording, notification derivation, and own-commit stamping are inherited verbatim.
  FOUND-03's "no `PendingPublish` window" is read as **"no *observable* window"**: the state exists in-process
  but no caller and no persisted artifact ever sees it.

  *Rejected:* adding a founding-only `Stable → Merging` edge (a new FSM edge reachable by any caller unless
  guarded); staying `Stable` and extracting a shared recording helper (structurally the CR-09 defect shape — a
  second commit-recording path that can drift).

- **D-02: New `send()` intent + result variant.** Add `{ kind: "foundingAdd" }` to `SendIntent` and
  `{ kind: "foundingGroupCreated", welcome, pending }` to `SendResult`, reusing the `send()` switch's shared
  staging code. This is Pitfall 16's literal advice ("its own `SendResult` variant distinct from `commit`").

  **Accepted cost:** a `PendingState` **does** escape to the caller, so D-01's "never yield" invariant is
  enforced by **convention, not by signature**. See R-01 — this needs a test, not a comment.

  *Rejected:* a dedicated `engine.mergeFoundingAdd()` that self-confirms internally (would have made the
  invariant unbreakable by type); client-layer sequencing in `GroupFactory`.

- **D-03: Only epoch 1 is durable — one write.** Nothing is persisted until the founding Add has merged. The
  first and only durable write is canonical epoch 1 plus its tree/retained records, matching the single
  `save()` `GroupFactory.create()` already performs. A crash before that leaves **no local group at all**, so
  there is nothing to reconcile.

  *Rejected:* MDK's shape (`put_group()` the projected epoch-0 record inside the transaction, then overwrite
  with canonical) — it leaves a loadable solo group whose invitee KeyPackages are already burned.

#### Welcome retry & durability

- **D-04: In-memory per-recipient outcomes + explicit `retryWelcome()`.** No new store, no resume-on-load.
  Justified by spec, not convenience: `publish-lifecycle.md:73-76` states consumed KeyPackage material is
  **not restorable** and the creator **MAY re-invite** an unreachable member with a fresh KeyPackage against
  the now-canonical group. Durable Welcome storage is therefore **not required for conformance**.

  **Accepted cost:** a crash loses the Welcome artifact entirely — the invitee remains a member at epoch 1 with
  no way to be told. Recovery is the spec's re-invite path. Contributes to R-04.

  *Rejected:* a durable outbound-Welcome store mirroring MDK's `put_message(MessageState::Sent)`; handing
  welcomes back to the caller (BYO-network).

- **D-05: Bypass `GroupRuntime` — deliver directly.** `GroupFactory` performs Welcome delivery itself rather
  than emitting `GroupEffects`. `GroupPublishWork`, `GroupEffects`, and `GroupSession` are **untouched**.

  **Accepted cost, named at decision time:** the runtime's audit emitters (`publish_attempt`,
  `publish_outcome`, `publish_failure`) and its error shaping are **not inherited**. This is the concrete
  instance of the CR-09 / Pitfall 16 "special case outside the shared path" shape. See R-02 — the debt was
  **not** repaid by D-12.

  *Rejected:* a welcome-only `{ kind: "foundingWelcomes" }` `GroupPublishWork` variant (would have inherited
  audit, relay resolution, and the `GroupPublishResult` contract).

- **D-06: Replace `#deliverWelcomes()` in place — both paths per-recipient.** The fanout returns per-recipient
  outcomes and **stops throwing**, so ordinary invite gains the same granularity and there is exactly **one**
  implementation that cannot drift.

  **Accepted cost:** this changes **shipped** ordinary-invite behaviour. `GroupPublishResult.welcomeDelivery`'s
  shape and the aggregate-throw contract both change. See R-03 — existing invite tests must be **migrated
  deliberately, not patched to pass**.

  *Rejected:* a parallel founding-only fanout leaving invite untouched (two implementations, only one
  per-invitee retryable).

- **D-07: The shared fanout lives on `NostrWelcomeDelivery` as a public `deliverMany()`.** `GroupRuntime` calls
  it via `this.welcomeDelivery`; `GroupFactory` calls it via `group.runtime.welcomeDelivery`. One
  implementation, no new plumbing, on the class whose whole job is Welcome delivery.

  **This decision is what reconciles D-05 with D-06.** The private `#deliverWelcomes()` could not satisfy both
  — "bypass the runtime" and "one shared fanout" are only simultaneously true if the loop moves somewhere both
  callers reach. Planner: do not re-litigate D-05 or D-06 without re-deciding this one.

  *Rejected:* a free function in the transport module; un-privating `#deliverWelcomes()` on `GroupRuntime`
  (would partly undo D-05).

#### Create API shape & relays

- **D-08: `options.invitees: NostrEvent[]` on the existing `create()`.** Extend `CreateGroupOptions` so
  `GroupsManager.create(name, options)` / `GroupFactory.create` covers both cases. Omitting `invitees` keeps
  today's exact behaviour **and code path**.

  *Rejected:* a separate `createWithInvitees()` entry point.

- **D-09: Allow invitees with no relays — inbox relays only.** Create the group and deliver via each
  recipient's NIP-65 inbox relays with no group-relay fallback. **Not** an error case.

  **Accepted consequence:** a group created without relays has no `transport.nostr.routing` component and
  therefore cannot carry ordinary traffic afterwards — a *successful* founding create can still produce a group
  that is unusable for messaging. See R-05: this directly constrains how FOUND-05 can be tested.

  *Rejected:* throwing at the call site before any KeyPackage material is consumed.

- **D-10: `create()` still returns `MarmotGroup`; per-invitee outcomes are state on the group.** e.g.
  `group.pendingWelcomes` alongside `retryWelcome()`. **No existing caller changes.**

  **Accepted cost:** the delivery report is *discoverable state* rather than a returned value, so a failed
  Welcome can be silently ignored. Contributes to R-04.

  *Rejected:* always returning `{ group, welcomeDeliveries }` (uniform, makes FOUND-04 data impossible to
  overlook, but breaks every existing caller including `examples/`); an overloaded return type.

- **D-11: Admit founding invitees by reusing `createInviteIntent()` per invitee.** Collect each resulting Add
  proposal into the **single** founding commit, taking `intent.extraProposals[0]` and
  `intent.welcomeRecipients[0]`. **Zero new trust-boundary code** — the founding path cannot drift from the
  invite path's SEC-01 (signature), WIRE-02 (`d`/`i`/`mls_protocol_version` cardinality), WIRE-01 (lifetime
  cap), and credential-identity-equals-event-author gates. This is most of FOUND-02.

  **Accepted awkwardness:** `createInviteIntent` returns a whole *commit intent* per invitee and founding
  create discards the rest of it.

  *Rejected:* extracting the shared gate into a helper returning `{ proposal, recipient }` — cleaner fit, but
  refactors a shipped trust boundary that Phase 2 hardened.

#### Partial-failure outcome

- **D-12: Never throw — always return the group.** Partial Welcome failure is a **normal outcome, not an
  error**: the group exists at epoch 1 with all N members regardless, and failures sit in
  `group.pendingWelcomes` for retry. This matches the spec exactly — a Welcome delivery "succeeds or fails
  independently and does not affect canonical group state" (`publish-lifecycle.md:72`).

  **Accepted cost:** the silent-loss path (R-04) is fully live, and the audit-emission debt from D-05 was
  **not** repaid — the log-plus-audit-emit variant was offered and declined. Founding Welcome delivery is
  **audit-silent**.

  *Rejected:* never-throw-but-log-and-audit-emit (would have repaid D-05's debt); throwing when zero of N
  Welcomes land.

- **D-13: Assert exactly one distinct Welcome per invitee, before any delivery attempt.** Mirrors MDK's guard
  ("founding creation did not produce one distinct Welcome per invitee"). Throw if the count or distinctness
  check fails. Catches a ts-mls behaviour change or a duplicate-KeyPackage invitee list at the one point where
  it is cheap — **before KeyPackage material is burned**.

  *Rejected:* trusting ts-mls and skipping the check (a duplicate invitee would go unnoticed).

#### Named risks — carry into planning as acceptance criteria, not comments

- **R-01 (from D-02):** `foundingGroupCreated` hands back a `PendingState`, so D-01's "never yield" invariant is
  convention-only. **Obligation:** a test that fails if a `foundingGroupCreated` result's `pending` is not
  immediately confirmed — the invariant must be caught, not documented.
- **R-02 (from D-05, unmitigated by D-12):** founding Welcome delivery emits **none** of the audit events every
  other publish path emits. Accepted as-is. If the plan wants this repaid, that is a new decision, not an
  executor's discretion.
- **R-03 (from D-06):** shipped ordinary-invite behaviour changes. Existing tests asserting the aggregate throw
  or the single `welcomeDelivery` outcome **must be migrated deliberately**. A test edited only to go green
  here is a regression in disguise.
- **R-04 (compound: D-04 + D-10 + D-12):** Welcome outcomes are non-durable **and** ignorable **and** never
  raised. A crash or an inattentive caller loses an invitee silently — a member sits at epoch 1 never having
  been told, with the Welcome artifact gone. Only recovery is the spec's re-invite with a fresh KeyPackage.
  **Obligation:** an explicit acceptance criterion plus a documented note for downstream apps.
- **R-05 (from D-09):** FOUND-05 ("invitee joins at epoch 1 and can exchange messages with the creator") is
  only satisfiable when relays were supplied. **Obligation:** the FOUND-05 test must supply relays, and the
  relay-less case needs its own documented expectation.

### Claude's Discretion

- Exact literal spellings: the `SendIntent`/`SendResult` variant names (`foundingAdd` / `foundingGroupCreated`
  are illustrative), the per-invitee outcome field name (`pendingWelcomes`), and `deliverMany()`'s exact
  signature and result-element shape.
- Where D-13's count/distinctness assertion physically lives (engine send path vs. `GroupFactory`), provided it
  runs **before** any delivery attempt.
- How `retryWelcome()` resolves relays and whether it needs a guard once the group has advanced past epoch 1
  (flagged but not decided — see unpursued threads).
- Test file layout: whether these extend existing suites or get a new file.
- Whether `createSimpleGroup` gains the invitees parameter or `createGroup` does.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope. No scope-creep candidates arose.

Explicitly declined alternatives (recorded so they are not re-proposed as improvements): a durable
outbound-Welcome store (D-04), a welcome-only `GroupPublishWork` variant (D-05), extracting
`createInviteIntent`'s KeyPackage gate into a helper (D-11), a uniform `{ group, welcomeDeliveries }` return
(D-10).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FOUND-01 | Developer can create a group with initial invitees; the founding Add is merged locally to epoch 1 and no kind-445 group event is published for it | Confirmed the current `case "commit"` staging path always publishes; D-02's new intent must skip `peeler.wrapGroupMessage()` entirely (not just skip runtime publish). See Architecture Patterns/Code Examples. |
| FOUND-02 | The founding Add passes the same proof and group-profile validation as an ordinary commit before it is merged | Confirmed `#assertStagedCommitLegal` → `validateCommitLegality` is the exact FOUND-02 gate, already shared by `commit`/`selfUpdate`; D-11's reuse of `createInviteIntent()` inherits SEC-01/WIRE-01/WIRE-02 for free. See Priority Finding #2 (admin-leaf coupling). |
| FOUND-03 | After founding creation the group is `Stable` immediately, with no `PendingPublish` window | Verified `confirmPublished()` is fully synchronous (zero internal `await`s); the only await on the whole path is the outer `await engine.send(...)`. See Additional Investigation, "D-01's window, precisely enumerated." |
| FOUND-04 | Each invitee's Welcome is delivered independently; a failed delivery is retryable per invitee and never rolls back the group | `NostrWelcomeDelivery.deliver()`'s per-recipient throw behavior confirmed; `deliverMany()` proposed signature in Code Examples; `AncillaryEffectOutcome` confirmed as the 3-state shape to generalize per-recipient. |
| FOUND-05 | Initial invitees join at epoch 1 from their Welcome and can exchange messages with the creator | `end-to-end-invite-join-message.test.ts` identified as the closest analog; concrete test shape specified in Priority Finding #3. |
</phase_requirements>

## Summary

This phase has no new external dependencies and no new architectural layer — it is a wiring problem inside
code this milestone already hardened (Phases 2, 8, 9). The two structural facts that make D-01 and D-02 safe are
both confirmed by direct reads of `src/engine/group-engine.ts`: `confirmPublished()` contains **zero** internal
`await`s (it is a fully synchronous method despite the class being generally async-heavy), and the founding
Add's legality gate (`#assertStagedCommitLegal` → `validateCommitLegality`) is the exact same call the ordinary
`commit`/`selfUpdate` cases already make, with no extra earlier check needed for the founding case specifically
(see Priority Finding #2). The one genuine technical gotcha not previously surfaced in CONTEXT.md is that
`send()`'s outer audit-wrapper (`this.peeler.idOf(result.envelope)`, `#artifactKind(result.envelope, ...)`,
`#transportEnvelope(result.envelope)`) unconditionally dereferences `result.envelope` on every `SendResult`
variant — and D-02's `foundingGroupCreated` variant has no `envelope` field at all. This will fail to
type-check (a forcing function, not a silent bug) but needs an explicit fix, not just a new switch-case.

The four priority research threads resolve cleanly with code evidence: (1) `retryWelcome()` needs no epoch
guard — the existing `GroupsManager.#connectGroup()` backfill has **no `since` filter**, so a late-joining
invitee's unbounded backfill genuinely does "catch up on outstanding Commits" per `joining.md` step 13,
*provided the founding group was created with relays* (the D-09 dependency is doing real work here, confirmed
independently of R-05's messaging concern). (2) MDK's "projected, pre-`add_members`" admin-leaf-coupling
ordering exists to avoid mutating OpenMLS's **stateful** `MlsGroup.pending_commit` on a doomed path; ts-mls's
`createCommit()` is a **pure function** with no such mutable side effect, so marmot-ts's existing
post-`createCommit`/pre-persist check already achieves MDK's actual goal (zero durable side effects from an
invalid admin set) through a different, architecture-appropriate mechanism. No new or earlier check is needed.
(3) `end-to-end-invite-join-message.test.ts` is the closest analog for FOUND-05 and needs only shape changes
(no kind-445 assertion, N invitees, bidirectional messaging). (4) R-02's audit debt is real but narrower than
CONTEXT.md implies: Welcome delivery is **already** audit-silent for ordinary invites too (no emit calls exist
in `#deliverWelcomes()` today) — the founding Add itself *does* get engine-level `send_entry`/`send_outcome`/
`epoch_confirmed` audit coverage "for free" via D-02's routing through `engine.send()`.

**Primary recommendation:** Implement D-01/D-02 exactly as specified (confirmed structurally safe); fix the
`send()` audit-wrapper envelope-access hazard as an explicit task, not an afterthought; place D-13's assertion
in `GroupFactory` immediately after `confirmPublished()` returns (matching CONTEXT's own Integration Points
ordering, which already implies this); budget a deliberate migration pass for the one `group-runtime.test.ts`
test file that encodes R-03's blast radius.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Founding Add construction + local merge (epoch 0→1) | Engine (`src/engine/group-engine.ts`) | — | Must reuse `#prepareOutboundCommitProposals`/`#assertStagedCommitLegal`/`confirmPublished` verbatim; this is pure MLS/protocol state, no I/O. |
| Founding-Add legality (FOUND-02) | Core (`src/core/components/integrity.ts`) | Engine (calls it) | `validateCommitLegality` is a pure function with zero I/O deps; the engine is just the caller. |
| Invitee KeyPackage trust-boundary validation | Client (`src/client/group/invite.ts`) | Engine (validates Adds again pre-apply) | `createInviteIntent()` is the existing trust boundary (SEC-01/WIRE-01/WIRE-02); D-11 reuses it verbatim rather than duplicating in the engine. |
| Welcome gift-wrap + per-recipient delivery | Client/Transport (`src/client/transport/nostr/welcome-delivery.ts`) | — | Nostr-specific (NIP-59 gift wrap, inbox-relay resolution); protocol-core (`joining.md`) deliberately says nothing about transport. |
| Founding orchestration (build N intents, send, confirm, assert, save, fan out) | Client (`src/client/group-factory.ts`) | — | The one seam CONTEXT identifies as needing new code; composes engine + core + transport, no new protocol logic of its own. |
| Per-invitee retry state (`pendingWelcomes`, `retryWelcome()`) | Client (`src/client/group/marmot-group.ts`) | — | In-memory, per-group discoverable state (D-04/D-10); not engine state (the engine has no concept of "a Welcome that didn't arrive"). |
| Backfill/catch-up for a late-joining invitee | Client (`src/client/groups-manager.ts` `#connectGroup`) | — | Already exists, unmodified by this phase; confirmed to already do unbounded `since`-less backfill (Priority Finding #1). |

## Decision Conflicts

**None found.** All 13 locked decisions are implementable as written against the current codebase. The closest
candidate for a conflict — whether D-01's "no observable window" claim actually holds given `send()`'s async
signature — resolves in D-01's favor once `confirmPublished()` is confirmed synchronous (see Additional
Investigation below); it is a *qualification* (the window is technically one microtask tick, and an audit sink
if configured does observe it), not a structural break of the decision. No other decision has a technical
blocker; the discretion items and the four unpursued threads are genuinely open, not blocked.

## Priority Research Findings

### 1. `retryWelcome()` epoch guard — NOT NEEDED, with one dependency

**Question:** Does a late-delivered epoch-1 Welcome strand the joiner behind the current epoch?

**Evidence:** `GroupsManager.#connectGroup()` (`src/client/groups-manager.ts:515-605`) builds its backfill
filter as `{ kinds: [GROUP_EVENT_KIND], "#h": [h] }` with **no `since` bound**, and its own doc comment says:
"Backfill before subscribing (mirrors the proven attach order): the backlog ingests as one batch so out-of-order
commits resolve together." The backlog is drained through `group.ingest(trusted)`, which uses `ingestEnvelopes`'
internal retry loop (`src/engine/ingest.ts`, `maxRetries` defaulting to 5 per call, `IngestionPool` persisting
undecryptable/future-epoch envelopes **across** calls — see `ingestion-pool.ts` doc comment "undecryptable
events held and retried as the tree grows (cross-batch)").

This means: a joiner who processes a stale epoch-1 Welcome and constructs a fresh `MarmotGroupEngine` seeded
with only epoch-1 state (per the engine constructor's documented default — "when omitted [retained/historyTree]
is seeded with only the current tip") is **not** structurally stuck. When they later call `connect()` (or the
app otherwise triggers a backfill) against the group's routing relays, the unbounded backfill fetches **every**
historical kind-445 event for that `h` tag, feeds them as one batch, and the engine's cross-batch retry
machinery resolves the multi-epoch chain — exactly matching `joining.md` step 13's "catches up on outstanding
Commits as best it can."

**The one real dependency:** this only works if `transport.nostr.routing` exists on the group at all — i.e.
the founding group was created **with relays** (D-09's non-footgun branch). `#connectGroup()` bails out
immediately ("connect: group %s has no nostr routing — skipping") if `getNostrGroupIdHex()` throws, which it
does for a relay-less founding group (see `#createSimpleGroup`'s `relays.length > 0` gate). A relay-less
founding create that later has a late Welcome delivered is **permanently stuck at epoch 1** with no code path
to ever discover it — not because of a missing epoch guard, but because there is no transport routing at all.
This is the *same* constraint R-05 already names for messaging, now independently confirmed for catch-up too.

A secondary, lower-severity risk: Nostr relay retention is out of marmot-ts's control. If the routing relays
evicted the historical events before the joiner's backfill runs, the joiner is *also* stuck at epoch 1 — a
general Nostr-transport risk, not specific to founding-Welcome retry, and not something this phase can fix.

**Recommendation:** Do **not** add an engine-level epoch guard to `retryWelcome()`. Instead:
- Document (in code comment + a test) that late Welcome delivery is safe **only when the founding group has
  relays**, reusing the exact language from R-05.
- Consider a cheap, non-blocking sanity note inside `retryWelcome()` (or the founding create path) when
  `group.relays` is empty — not a guard, just surfacing the D-09 footgun where a caller will actually hit it.
- The multi-epoch backfill-catch-up scenario (backfill spanning more than a handful of epochs in one batch) is
  **not exercised by any existing test** as far as this research found — recommend the planner add this as an
  explicit regression case alongside FOUND-05's positive control, since it is genuinely new territory for this
  codebase even though the underlying mechanism (`IngestionPool` + retry) is not new code.

### 2. Projected admin-leaf coupling — NO GAP, different mechanism for the same guarantee

**Question:** Does MDK's pre-`add_members` admin-leaf check (mdk#737) expose a gap in marmot-ts's post-apply
`validateCommitLegality`?

**Evidence:** Read `refs/mdk/crates/cgka-engine/src/group_lifecycle.rs:436-461`. MDK's comment states the
ordering exists so that "an invalid admin set produces no membership/commit side effects" and explicitly notes
it runs "before `add_members`" because `add_members()` **mutates OpenMLS's stateful `MlsGroup`** in place
(populating `mls_group.pending_commit()`), which would otherwise require an explicit
`clear_pending_commit()`/cleanup guard (see `PendingCommitCleanupGuard` in the same crate) if the admin check
failed afterward.

marmot-ts's `createCommit()` (from `ts-mls`) is architecturally different: it is a **pure function** — it
takes an immutable `ClientState` and returns a **new** `{ commit, newState, welcome }` tuple, mutating nothing.
`this.state`/`this.#state` on the engine is **not** touched until `#setState(pending.newState)` runs inside
`confirmPublished()`. `#assertStagedCommitLegal()` (which calls `validateCommitLegality`) runs **after**
`createCommit()` produces `newState` but **before** `wrapGroupMessage()`, **before** the lifecycle transitions
to `PendingPublish`, and (per D-03) long before anything is persisted. A thrown `CommitLegalityError` at that
point leaves `this.state` at the OLD (pre-commit) value, no lifecycle transition, and — per the existing
code comment at `group-engine.ts:1141-1145` — "the engine is left in Stable with no pending state and no staged
commit to roll back." This is the *identical end state* MDK's earlier check achieves (zero durable/mutated side
effects from an invalid admin set), just reached via a mechanism appropriate to a pure-functional MLS API
instead of a stateful one.

**Conclusion (HIGH confidence):** marmot-ts's existing `#assertStagedCommitLegal` → `validateCommitLegality` →
`validateAdminLeafCoupling` chokepoint, already shared by `case "commit"` and `case "selfUpdate"`, is
**functionally equivalent** to MDK's projected pre-`add_members` check for marmot-ts's own architecture. D-02's
plan to route the founding Add through the same `#assertStagedCommitLegal` call (as it already does for
`commit`/`selfUpdate`) closes this gap with **zero new code**. No earlier or duplicate admin-leaf check is
needed for the founding case.

**One accepted, pre-existing, non-blocking cost:** `createInviteIntent()` itself (`src/client/group/invite.ts`)
is a pure function with no KeyPackage-store side effects — confirmed by reading it end-to-end; it only
validates the raw event and returns a proposal. So no local bookkeeping is mutated before the legality check
either. The "consumed KeyPackage material is not restorable" language in D-04 refers to the **invitee's own**
published KeyPackage material being spent once a Welcome is actually constructed from it — this is unrelated to
admin-leaf-coupling timing and already correctly scoped by D-04's own framing.

### 3. FOUND-05's end-to-end test shape

**Closest existing analog:** `src/__tests__/integration/end-to-end-invite-join-message.test.ts`. Read in full;
it already exercises: `MarmotClient` (not raw `GroupsManager`), `MockNetwork`, KeyPackage creation +
publication, admin-side invite, gift-wrap fetch (`mockNetwork.request(["wss://mock-inbox.test"], {kinds:[1059],
"#p":[inviteePubkey]})`) + `unlockGiftWrap`, `client.joinGroupFromWelcome({ welcomeRumor })`, epoch assertion,
KeyPackage-consumed assertion, manual `group.ingest(groupEvents)` catch-up, and application-message
send/receive in one direction.

**Concrete shape for FOUND-05's test**, built from this analog:
1. Two (or more) invitee `PrivateKeyAccount`s create + publish KeyPackages (reuse `inviteeClient.keyPackages.create()` per invitee).
2. Admin calls `adminClient.groups.create("Founding Group", { adminPubkeys: [adminPubkey], relays: ["wss://mock-relay.test"], invitees: [kpEvent1, kpEvent2] })` — **relays are mandatory** per R-05.
3. **Negative assertion (FOUND-01):** immediately after `create()` resolves, assert `mockNetwork.events.filter(e => e.kind === GROUP_EVENT_KIND).length === 0` — no kind-445 event was ever published for the founding Add. This is the inverse of the existing test's `commitIndex`/`giftwrapIndex` assertions (that test *expects* a kind-445 event; this one must not have one).
4. **Positive assertion (FOUND-03):** synchronously after `create()` resolves (no intervening `await`), assert `adminGroup.state.groupContext.epoch === 1n` (or `1`, matching the codebase's epoch numeric type) and `adminGroup.state`'s lifecycle-equivalent accessor reports `Stable` — this is the literal test CONTEXT's `<specifics>` section calls for.
5. Assert exactly N gift-wrap (1059) events exist, one per invitee, each unwrappable by its intended recipient only (reuse the existing test's gift-wrap-fetch-and-unwrap block per invitee).
6. Each invitee independently calls `joinGroupFromWelcome`; assert each lands at `epoch === 1` and that **both** invitees appear in each other's member list (proves the founding Add was a single shared commit, not N separate epoch-1→2 commits — this is the strongest structural proof of FOUND-01's "one founding Add Commit... containing the initial invitees").
7. Bidirectional messaging: invitee A → admin (reuse the existing test's send/ingest block), **and** admin → invitee B, **and** invitee A → invitee B if the group's ratchet tree supports it directly — at minimum, both directions relative to the creator, matching CONTEXT's positive-control note ("an honest all-N-Welcomes-succeed founding create produces a working group whose invitees can message the creator").

**Seams to wire:** `MockNetwork` (`src/__tests__/helpers/mock-network.ts`), `InMemoryKeyValueStore` for both
clients' `groupStateStore`/`keyPackageStore`, `PrivateKeyAccount.generateNew()` from `applesauce-accounts` for
both admin and invitee identities (matching every existing integration test's account pattern), and
`MarmotClient` as the top-level facade (not `GroupsManager` directly) so `options.invitees` threads through
`CreateGroupOptions` exactly as ordinary callers would use it.

### 4. R-02's audit debt — narrower than framed, with one non-decision-reversing option

**Correction to CONTEXT's framing:** Read `GroupRuntime.#deliverWelcomes()` (`src/client/runtime/group-runtime.ts:448-503`)
in full. It contains **zero** audit-emit calls today. The `publish_attempt`/`publish_outcome`/`publish_failure`
trio is emitted **only** from `#publishToGroupRelays()` (lines 328-372), which is used exclusively for
publishing the **kind-445 commit event** — never for Welcome delivery. This means **ordinary invite's Welcome
delivery is already audit-silent today**, before this phase touches anything.

**What founding create actually loses vs. what it already has:**
- **Already has (inherited "for free" via D-02):** the engine-level `send_entry` / `send_outcome` /
  `epoch_confirmed` audit trio, because D-02 routes the founding Add through the shared `engine.send()` /
  `confirmPublished()` path exactly like `commit`/`selfUpdate`. This is a genuine, non-trivial audit trail
  recording "a group evolution was locally applied" — the same trail an ordinary commit's *engine* layer
  produces (see `#emitAudit({type:"epoch_confirmed", from_epoch, to_epoch, pending_kind})` inside
  `confirmPublished()`).
- **Genuinely absent, and NOT new to this phase:** any audit event for "Welcome delivered/failed to invitee
  X" — this gap exists for ordinary invite today and is not created by D-05.
- **Genuinely absent, and IS specific to founding create (but not a regression):** the
  `publish_attempt`/`publish_outcome`/`publish_failure` trio for a kind-445 *commit* publish. There is no
  equivalent for founding create because FOUND-01 requires that no such event is ever published — there is
  nothing to wrap in that audit trio because there is no publish attempt to make.

**The non-decision-reversing option (named per the task, not recommended):** Since D-07 already puts the
shared fanout on `NostrWelcomeDelivery.deliverMany()` — reached by *both* `GroupRuntime` and `GroupFactory` —
wiring a new audit emission **inside `deliverMany()` itself** would retroactively add Welcome-delivery audit
coverage to *both* paths uniformly, closing the pre-existing gap rather than reopening D-05. Concrete cost if
taken: (a) `NostrWelcomeDeliveryOptions` currently has only `signer`/`network` — adding `audit`/`auditContext`
is new constructor plumbing beyond D-07's "no new plumbing" framing; (b) a new audit event shape would need
defining (the existing `publish_attempt`/`outcome`/`failure` schema is shaped around a `NostrEvent` envelope,
not a per-recipient gift-wrap outcome, so this is schema design, not reuse); (c) since it retroactively adds
audit coverage to ordinary invite too — which never had it — this is an enhancement beyond this phase's stated
scope, not a repayment of a founding-specific debt. **Flagged for the planner's discretion only; this research
does not recommend taking it.**

## Additional Investigation Findings

### D-01's window, precisely enumerated

`confirmPublished()` (`src/engine/group-engine.ts:1553-1648`) is **not** an `async` method and contains **zero**
internal `await` expressions — every operation (`#setState`, `#recordCommitNode`, `deriveStateNotifications`,
`#emitAudit`, `#transitionLifecycle`) is synchronous. This means once a caller has `pending: PendingState` in
hand, calling `engine.confirmPublished(pending)` runs start-to-finish in one synchronous tick with no way for
other code to interleave *inside* it.

Enumerating every `await` between "founding Add staged" and "confirmPublished() returns":
1. Inside the new founding `send()` case (modeled on `case "commit"`): `await createCommit(...)` and
   (if the founding case keeps it — **it must not**, per FOUND-01) `await this.peeler.wrapGroupMessage(...)`.
   Both happen **before** the lifecycle transitions to `PendingPublish`, matching the existing `commit`/
   `selfUpdate` cases' ordering. No lifecycle-visible state exists yet during these awaits.
2. After the case sets lifecycle to `PendingPublish` (synchronous), `#sendInner` returns with no further
   `await`.
3. **The one real yield point:** `send()`'s own `const result = await this.#sendInner(intent);` — even though
   `#sendInner`'s synchronous tail already completed, the `await` keyword still defers `send()`'s continuation
   by one microtask tick. This is inherent to `await`/Promise semantics, not a bug.
4. `send()`'s continuation then calls `this.#emitAudit({type:"send_outcome", ...})` — **synchronously, at a
   moment when `this.#lifecycle === "PendingPublish"`**. This is the "if an emit fires while in PendingPublish"
   case flagged in the task: **it does fire.** If an audit sink is configured on the engine (`options.audit`),
   it *does* observe a `send_outcome` event while the group is technically `PendingPublish` — before
   `confirmPublished()` ever runs. This qualifies D-01's "no observable window" claim precisely: **no
   persisted artifact and no MLS-processing caller ever observes `PendingPublish` for a founding create, but a
   configured engine-level audit sink can.** This is a pre-existing pattern (the same is true for ordinary
   `commit`/`selfUpdate` today — send_outcome always fires before the caller can call `confirmPublished()`), not
   a founding-specific regression, but the planner/R-01's test should be aware of it rather than assume the
   window is *literally* zero.
5. `send()` returns; the founding-create call site's `await engine.send(...)` resolves after **one more**
   microtask tick (same inherent `await` mechanics). If the call site does anything async between this `await`
   resolving and calling `engine.confirmPublished(result.pending)` synchronously, that async gap becomes a real,
   additional observable window — this is exactly R-01's "convention, not signature" risk, and the concrete
   failure mode to test for is: **do not `await` anything (logging, persistence, event emission) between
   `await engine.send(...)` and the synchronous `engine.confirmPublished(...)` call.**

**Practical implication for the plan:** sequence `GroupFactory.create()`'s founding path so that constructing
`MarmotGroup`/wiring `GroupSession`/subscribing to events happens **after** `confirmPublished()` returns, not
before — this removes any possibility of a concurrent `ingest()` call on the same engine instance observing
`PendingPublish` during the one-microtask gap, since no such concurrent caller can exist yet.

### The `send()` audit-wrapper envelope-access hazard (new finding, not in CONTEXT.md)

`send()`'s success path (`group-engine.ts:914-946`) does:
```typescript
this.#emitAudit({
  type: "send_outcome",
  intent_kind: intentKind,
  result_kind: auditSendResultKind(result),
  outbound_messages: [
    {
      msg_id: this.peeler.idOf(result.envelope),
      artifact_kind: this.#artifactKind(result.envelope, result.kind),
      transport: this.#transportEnvelope(result.envelope),
    },
  ],
});
```
This accesses `result.envelope` **unconditionally**, with no per-`kind` branch. Every current `SendResult`
variant (`applicationMessage`, `proposal`, `groupEvolution`, `selfUpdate`) has an `envelope: TEnvelope` field.
D-02's `{ kind: "foundingGroupCreated", welcome, pending }` variant has **no `envelope` field at all** — by
design, since FOUND-01 requires no wrapped/published envelope exists.

Consequences the plan must handle explicitly:
- **TypeScript will not compile** `result.envelope` once the union includes a member without that property —
  this is a compile-time forcing function, so it cannot be silently missed, but the fix is not mechanical
  (there is no existing per-kind branch to extend; one must be added).
- `#transportEnvelope(envelope)` (`group-engine.ts:2625-2639`) does `const candidate = envelope as {...}` then
  immediately `candidate.tags?.find(...)` — if `envelope` were ever `undefined` at runtime (e.g. a future
  refactor loosens the type), this throws `Cannot read properties of undefined (reading 'tags')`, **not** a
  graceful no-op, because the optional chaining protects `.tags`'s access, not `candidate` itself.
- `auditSendResultKind()` (`group-engine.ts:3595-3606`) is an exhaustive `switch` over `SendResult["kind"]` —
  TypeScript will force a new `case "foundingGroupCreated": return "founding_group_created";` arm. Same for
  `auditSendIntentKind()` and the new `"foundingAdd"` intent kind.

**Recommendation:** add an explicit branch in `send()`'s audit-outcome block: when `result.kind ===
"foundingGroupCreated"`, emit `outbound_messages: []` (or omit the field if the audit schema allows), rather
than trying to synthesize a fake envelope reference. This is a small, mechanical fix but easy to miss because
the compiler error will point at three separate call sites, not one obvious place.

### R-03 blast radius, enumerated

Grepped the entire `src/` tree for `welcomeDelivery` and `Failed to deliver` in test files. **Exactly one test
file** encodes assumptions D-06 will break: `src/client/runtime/__tests__/group-runtime.test.ts`.

Concrete inventory:
- **`makeRuntime()`'s default fixture** (line 70): `welcomeDelivery: { deliver } as unknown as NostrWelcomeDelivery`
  — this stub implements only `.deliver()`, not `.deliverMany()`. Once `GroupRuntime.#deliverWelcomes()` is
  rewritten to call `this.welcomeDelivery.deliverMany(...)` (D-07), **every** test that exercises a
  Welcome-bearing `commitWork(...)` through this default fixture will throw `TypeError: ...deliverMany is not a
  function` unless the fixture is updated. This affects the "GroupRuntime Welcome delivery" describe block
  (3 tests, lines 361-415) and the "executes the pinned invite-publish-fail rollback before Welcome delivery"
  test (line 250, which passes `welcomeRecipients` but should not reach delivery at all since publish fails
  first — worth double-checking this test still short-circuits correctly under the new code path).
- **Line 392's override** (`welcomeDelivery: { deliver } as unknown as NostrWelcomeDelivery` inside the
  "preserves confirmed notifications when Welcome delivery fails" test): same `deliverMany`-missing issue,
  plus the assertion below it.
- **Lines 405-410 — the exact aggregate-shape assertion that must be migrated:**
  ```typescript
  expect(result.welcomeDelivery).toEqual({
    kind: "failed",
    error: expect.stringMatching(
      /Failed to deliver 1\/2 Welcome message\(s\).*inbox unreachable/,
    ),
  });
  ```
  Under D-06, `welcomeDelivery` becomes a per-recipient shape (not a single aggregate `{kind,error}` object),
  so this assertion's shape must change to assert on the per-recipient array/record instead — this is the
  single highest-value, most concrete migration target R-03 names, and it is small (one file, ~5 test bodies).
- No other test file in the repo references `welcomeDelivery` or the aggregate-throw error string, confirmed
  via `grep -rln "Failed to deliver\|welcomeDelivery" --include="*.test.ts"`. The ordinary-invite integration
  test (`end-to-end-invite-join-message.test.ts`) makes no assertion on delivery-failure shape, so it is
  unaffected by D-06's shape change.

**Recommendation:** budget one focused task to update `group-runtime.test.ts`'s shared `welcomeDelivery` fixture
to expose `deliverMany` (matching the new interface), and one task to rewrite the specific per-recipient-failure
assertion — both are small, well-scoped, and match R-03's "migrated deliberately, not patched to pass"
instruction.

### `deliverMany()` proposed signature

Modeled on `AncillaryEffectOutcome` (`src/client/session/group-effects.ts:30-33`, confirmed 3-state:
`notRequired | succeeded | failed`) and `NostrWelcomeDelivery.deliver()`'s existing per-call throw behavior:

```typescript
// src/client/transport/nostr/welcome-delivery.ts
export type WelcomeDeliveryOutcome =
  | { recipient: WelcomeRecipient; kind: "succeeded"; response: Record<string, PublishResponse> }
  | { recipient: WelcomeRecipient; kind: "failed"; error: string };

async deliverMany(options: {
  welcome: Welcome;
  author: string;
  groupRelays: string[];
  recipients: WelcomeRecipient[];
}): Promise<WelcomeDeliveryOutcome[]>
```

Internally, `deliverMany()` should be the `Promise.allSettled` loop currently private inside
`GroupRuntime.#deliverWelcomes()`, moved here and **never re-throwing** — each settled result maps to one
`WelcomeDeliveryOutcome` entry, success or failure, with no aggregate error thrown. `deliver()`'s own existing
behavior (throwing when the resolved `inboxRelays` list is empty — no group-relay fallback per D-09) is
preserved unchanged per-recipient; `deliverMany()` simply catches that per-recipient throw via
`Promise.allSettled` and reports it as `{kind:"failed", error: ...}` for that one recipient, exactly as
`#deliverWelcomes()` does today except without the final aggregate throw. `GroupRuntime` then reduces the
array into its existing `AncillaryEffectOutcome`-shaped `GroupPublishResult.welcomeDelivery` field (D-06 changes
this to carry the per-recipient array, or a record keyed by recipient pubkey — Claude's Discretion on the
exact shape) instead of collapsing to a single boolean-ish outcome. `GroupFactory` consumes the same array
directly for `group.pendingWelcomes`.

### D-13's placement — recommended: `GroupFactory`, after `confirmPublished()`, before `save()`

CONTEXT.md's Decisions section frames this as open discretion, but its own **Integration Points** section
already states the intended sequence: "send + confirm (D-01/D-02), assert Welcome count (D-13), save() once
(D-03), fan out (D-05/D-07)" — i.e., confirm first, then assert, then persist. This is the recommended
placement, for a concrete reason beyond just following that ordering: the check needs `result.welcome` (the
already-constructed MLS `Welcome` object with its per-recipient `secrets` entries), which only exists after
`engine.send({kind:"foundingAdd",...})` returns — it cannot run any earlier without re-deriving the Welcome
structure itself. Running it **after** `confirmPublished()` (rather than between `send()` and
`confirmPublished()`) does not violate D-01, since it is a synchronous check with no `await` — it does not
introduce a new yield point between staging and confirmation. If the assertion throws at this point, the
engine already holds the merged epoch-1 state in memory, but per D-03 nothing has been persisted (`save()`
hasn't run yet) — so the failure is clean: `GroupFactory.create()` rejects, no `MarmotGroup` is ever
constructed or returned, and the in-memory engine instance is simply discarded. This matches D-03's own "a
crash before that leaves no local group at all, so there is nothing to reconcile" reasoning exactly, just
triggered by a thrown assertion instead of a process crash.

### The D-09 footgun, confirmed precisely

`createSimpleGroup()` (`src/core/group.ts:146-151`) pushes a `nostrRoutingEntry` component **only** when
`relays.length > 0`. `NostrWelcomeDelivery.deliver()` (`welcome-delivery.ts:65-81`) resolves `inboxRelays` via
`network.getUserInboxRelays(recipient.pubkey)`, falling back to `options.groupRelays` **only** if that lookup
throws, and **throws** if the resulting list is empty. So:
- If the recipient has a NIP-65 relay list (the common case), Welcome delivery works **regardless** of whether
  the founding group has any relays at all — `getUserInboxRelays()` succeeds and `groupRelays` (which would be
  `[]` for a relay-less founding group) is never consulted.
- If the recipient has **no** NIP-65 relay list (or the lookup throws for any other reason), the fallback to
  `groupRelays` kicks in — and for a relay-less founding group, `groupData.relays` is `[]`, so `deliver()`
  throws `"No relays available to send Welcome to recipient..."` for that one recipient specifically.
- This failure is **per-recipient**, not group-wide — under D-06/D-07's per-recipient `deliverMany()`, one
  invitee with no NIP-65 relays in a relay-less founding group fails independently while others (who do have
  NIP-65 relays) succeed. This is actually the *correct*, minimal-blast-radius behavior D-06 already produces;
  it does not need special-casing.

**Recommendation:** R-05's "the relay-less case needs its own documented expectation" should read: "a
relay-less founding create can still deliver Welcomes successfully to invitees who have published their own
NIP-65 relay list; it cannot deliver to invitees who have not, and it can never support ordinary group
messaging afterward regardless of Welcome delivery outcome." Document this exact distinction rather than a
blanket "relay-less create is degraded."

## Standard Stack

**No new external packages are introduced by this phase.** All work is internal wiring across
`src/engine`, `src/core`, and `src/client` using already-present dependencies (`ts-mls`, `@noble/*`,
`applesauce-*`). The Package Legitimacy Gate is not applicable.

## Package Legitimacy Audit

Not applicable — no new packages installed in this phase.

## Architecture Patterns

### System Architecture Diagram

```
GroupsManager.create(name, {invitees, relays})
        │
        ▼
GroupFactory.create()
        │
        ├─ createSimpleGroup()  ──────────► epoch-0 ClientState (solo, admin only)
        │
        ├─ new MarmotGroupEngine(state)     (in-memory only; not yet saved)
        │
        ├─ for each invitee:
        │     createInviteIntent({keyPackageEvent, actorPubkey})
        │         │  (SEC-01 sig, WIRE-01 lifetime, WIRE-02 cardinality,
        │         │   credential-identity == event author)
        │         ▼
        │     { extraProposals: [Add], welcomeRecipients: [recipient] }
        │
        ├─ collect all Add proposals + recipients across invitees
        │
        ├─ engine.send({kind:"foundingAdd", extraProposals:[Add1..AddN]})
        │     │
        │     ├─ createCommit()  (ts-mls, PURE — returns newState, no mutation)
        │     ├─ #assertStagedCommitLegal(parent, newState, ...)  ◄── FOUND-02 gate
        │     │     └─ validateCommitLegality → validateAdminLeafCoupling (thread #2: already sufficient)
        │     ├─ [NO peeler.wrapGroupMessage — FOUND-01: no envelope, ever]
        │     ├─ transitionLifecycle(PendingPublish)
        │     └─ return {kind:"foundingGroupCreated", welcome, pending}
        │           (send_entry/send_outcome audit fires here — PendingPublish is
        │            momentarily visible to a configured audit sink; see D-01 window)
        │
        ├─ engine.confirmPublished(pending)   ◄── synchronous, zero awaits
        │     ├─ #setState(newState)              epoch → 1
        │     ├─ #recordCommitNode(...)            CR-09 recording (retained + tree)
        │     ├─ transitionLifecycle(Stable)       FOUND-03: Stable, epoch 1
        │     └─ emitAudit(epoch_confirmed)
        │
        ├─ assertExactlyOneWelcomePerInvitee(welcome, invitees)   ◄── D-13, HERE
        │
        ├─ new MarmotGroup(...) + group.save(true)   ◄── D-03: the ONE durable write
        │
        └─ group.runtime.welcomeDelivery.deliverMany({welcome, recipients})  ◄── D-05/D-07
              │  (bypasses GroupRuntime/GroupSession entirely; per-recipient outcomes)
              ▼
          group.pendingWelcomes = [outcomes]   ◄── D-10, D-12 (never throws)
```

### Recommended Project Structure

No new files are required beyond test files. Modified files, per CONTEXT's own Integration Points (confirmed
accurate by this research):
```
src/engine/types.ts                              # SendIntent/SendResult new variants (D-02)
src/engine/group-engine.ts                        # new send() case; audit-wrapper fix (new finding)
src/client/transport/nostr/welcome-delivery.ts    # deliverMany() (D-07)
src/client/runtime/group-runtime.ts               # #deliverWelcomes() → deliverMany() caller (D-06)
src/client/session/group-effects.ts               # GroupPublishResult.welcomeDelivery shape (D-06)
src/client/group-factory.ts                       # founding orchestration (D-01/D-02/D-03/D-05/D-07/D-11/D-13)
src/client/groups-manager.ts                      # options.invitees pass-through (D-08)
src/client/group/marmot-group.ts                  # pendingWelcomes + retryWelcome() (D-10)
src/core/group.ts                                 # invitees parameter threading (D-08, discretion on which fn)
```

### Pattern: reuse the `case "commit"` staging skeleton, minus two steps

**What:** D-02's new `send()` case for `"foundingAdd"` should copy `case "commit"`'s structure
(`group-engine.ts:1067-1175`) almost verbatim — `#prepareOutboundCommitProposals`, `createCommit`,
`#assertStagedCommitLegal`, `#transitionLifecycle(pendingPublish)`, `#sentContentIds.add` — but **must skip**:
1. `await this.peeler.wrapGroupMessage(commit, this.state)` — FOUND-01 requires no envelope ever exists for
   this commit.
2. The `mayPrepareLocalCommit(this.#lifecycle)` guard is still correct to keep (a founding Add is prepared from
   `Stable`, same as any commit).

**Example (illustrative, not literal code to copy verbatim):**
```typescript
// Source: pattern derived from src/engine/group-engine.ts case "commit" (lines 1067-1175)
case "foundingAdd": {
  const groupData = getMarmotGroupView(this.state);
  if (!groupData) throw new Error("MarmotGroupData not found in ClientState.");
  if (!mayPrepareLocalCommit(this.#lifecycle)) {
    throw new Error(`Cannot prepare a commit while the group is ${this.#lifecycle}`);
  }
  const parentState = this.state;
  const prepared = this.#prepareOutboundCommitProposals(
    this.state, groupData.adminPubkeys, intent.extraProposals ?? [],
  );
  const { commit, newState, welcome } = await createCommit({
    context: { cipherSuite: this.ciphersuite, authService: marmotAuthService },
    state: prepared.commitState,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: prepared.extraProposals,
  });
  // FOUND-02: identical gate to case "commit" — see Priority Finding #2.
  this.#assertStagedCommitLegal(
    parentState, newState, prepared.committedWithSenders,
    Number(parentState.privatePath.leafIndex),
  );
  // FOUND-01: no wrapGroupMessage() call — no envelope is ever produced.
  this.#transitionLifecycle(groupLifecycleStates.pendingPublish, "begin_pending", "foundingAdd");
  this.#stagedCommitParentEpoch = Number(parentState.groupContext.epoch);
  this.#sentContentIds.add(contentDedupId(commit));
  return {
    kind: "foundingGroupCreated",
    welcome,
    pending: {
      kind: "commit", // or a new pending kind — Claude's discretion; "commit" reuses confirmPublished's existing branch unchanged
      newState, parentState, commitMessage: commit,
      ownCommitStamp: this.#ownCommitStamp(commit, prepared),
    },
  };
}
```

### Anti-Patterns to Avoid

- **Do not call `peeler.wrapGroupMessage()` for the founding Add** — even though `case "commit"` always does,
  doing so for founding create would produce an envelope that must then be deliberately never published, which
  is a much easier invariant to violate than "never construct it at all."
- **Do not leave `send()`'s audit-outcome block unconditionally reading `result.envelope`** — see the new
  finding above; this must be special-cased, not left to "TypeScript will catch it" (it will catch the type
  error, but not guide the fix).
- **Do not construct `MarmotGroup`/wire `GroupSession`/subscribe to events before `confirmPublished()`
  returns** — see the D-01 window analysis; sequencing session construction after confirmation removes any
  possibility of a concurrent `ingest()` observing the momentary `PendingPublish` state.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| KeyPackage trust-boundary validation for a founding invitee | A parallel validation path in `GroupFactory` | `createInviteIntent()` (D-11, already decided) | Zero new trust-boundary code; SEC-01/WIRE-01/WIRE-02 inherited verbatim from the already-hardened invite path (Phase 2). |
| Welcome gift-wrap construction | A founding-specific gift-wrap builder | `createWelcomeRumor()` / `createGiftWrap()` (`src/core/welcome-event.ts`, `src/utils/index.ts`) via `NostrWelcomeDelivery.deliverMany()` (D-07) | Already NIP-59-correct and used by ordinary invite; D-07 makes it the single shared implementation. |
| Admin-leaf-coupling re-validation for the founding case | An earlier/duplicate check in `GroupFactory` before commit staging | The existing `#assertStagedCommitLegal` call, unmodified | Confirmed functionally equivalent to MDK's projected check for this architecture (Priority Finding #2) — a duplicate check would itself be a second seam that can drift (the mdk#707 bug class this milestone has repeatedly closed). |
| Per-recipient retry bookkeeping | A durable queue/store | In-memory `group.pendingWelcomes` + `retryWelcome()` (D-04/D-10) | Explicitly not required for conformance per `publish-lifecycle.md:73-76`; a durable store was considered and rejected in D-04. |

**Key insight:** every "don't hand-roll" item in this phase is actually "don't build a *second* implementation
of something Phase 2/8/9 already hardened" — the mdk#707 "a guard that exists on one seam only is a bug" lesson
this codebase has internalized applies here as much as to any inbound seam.

## Common Pitfalls

### Pitfall 1: `send()`'s audit wrapper crashes or fails to compile on an envelope-less `SendResult`
**What goes wrong:** `this.peeler.idOf(result.envelope)` / `#artifactKind(result.envelope, ...)` /
`#transportEnvelope(result.envelope)` in `send()`'s success path assume every `SendResult` variant has
`.envelope`. D-02's `foundingGroupCreated` variant does not.
**Why it happens:** The audit-outcome block was written before any envelope-less result existed; nothing forced
a per-kind branch there before now.
**How to avoid:** Add an explicit `if (result.kind === "foundingGroupCreated") { ...emit without outbound_messages... }`
branch (or equivalent) in `send()`'s audit-outcome block, plus new arms in `auditSendResultKind()` and
`auditSendIntentKind()`.
**Warning signs:** A TypeScript compile error on `result.envelope` pointing at `group-engine.ts` line ~931 is
the forcing function — do not "fix" it by widening the type or adding a dummy `envelope: undefined` field to
`foundingGroupCreated`, which would silently reintroduce the same crash risk at runtime for `#transportEnvelope`.

### Pitfall 2: Treating D-01's "no observable window" as literally zero-await
**What goes wrong:** Assuming there is truly no yield point anywhere on the founding-create path, and therefore
skipping R-01's test as redundant.
**Why it happens:** `confirmPublished()` itself is genuinely synchronous, which can be mistaken for "the whole
operation is synchronous."
**How to avoid:** The founding-create call site's `await engine.send(...)` **does** introduce one real
microtask-tick gap before the caller can synchronously call `confirmPublished()`. R-01's test should assert
that nothing observable happens in that gap (no persistence, no session construction) rather than assert the
gap doesn't exist.
**Warning signs:** A future refactor that adds `await` between `engine.send(...)` resolving and
`engine.confirmPublished(...)` being called (e.g., an inserted logging call, or moving session wiring earlier)
silently widens this window into something a concurrent caller genuinely could observe.

### Pitfall 3: Migrating `group-runtime.test.ts`'s Welcome fixtures by loosening assertions instead of updating shapes
**What goes wrong:** Making the failing aggregate-shape assertion (lines 405-410) pass by weakening it (e.g.
`toBeDefined()` instead of asserting the actual per-recipient shape), which is exactly what R-03 warns against
("a test edited only to go green here is a regression in disguise").
**Why it happens:** The fixture (`{ deliver } as unknown as NostrWelcomeDelivery`) needs a real interface
update (`deliverMany`), which is more work than patching the assertion.
**How to avoid:** Update the shared fixture to mock `deliverMany` with the same per-recipient semantics the
real implementation will have, and rewrite the assertion to check the actual new per-recipient array/record
shape, preserving the original test's intent (one of two recipients fails, the failure is reported, the
group's confirmed notifications are preserved regardless).

### Pitfall 4: Founding create without relays silently producing an unreachable group
**What goes wrong:** A caller creates a founding group with `invitees` but no `relays`, gets back a
successfully-created `MarmotGroup` at epoch 1 with all invitees Welcomed, and only later discovers the group
has no `transport.nostr.routing` component and can never carry ordinary kind-445 traffic.
**Why it happens:** D-09 deliberately allows this (rejected the alternative of throwing at call time), and the
founding create's success path gives no obvious signal that the group is "created but unusable."
**How to avoid:** Not a code fix (D-09 is locked) — document this exact consequence prominently (JSDoc on
`create()`'s `invitees`+no-`relays` combination) so downstream app developers don't discover it via a support
ticket.
**Warning signs:** A caller passes `invitees` but not `relays` in a test or app and later observes messages
never being delivered to anyone.

## Code Examples

### Existing pattern: the `commit` case's legality-gate placement (to mirror exactly)
```typescript
// Source: src/engine/group-engine.ts, case "commit" (lines ~1130-1152)
const parentState = this.state;
const { commit, newState, welcome } = await createCommit({ /* ... */ });

// D-01/D-02: validate the staged commit before it is wrapped or
// published, and before the lifecycle transitions to PendingPublish.
this.#assertStagedCommitLegal(
  parentState,
  newState,
  prepared.committedWithSenders,
  Number(parentState.privatePath.leafIndex),
);

const envelope = await this.peeler.wrapGroupMessage(commit, this.state); // OMIT for founding case
```

### Existing pattern: `AncillaryEffectOutcome` (the shape to generalize per-recipient)
```typescript
// Source: src/client/session/group-effects.ts:30-33
export type AncillaryEffectOutcome =
  | { kind: "notRequired" }
  | { kind: "succeeded" }
  | { kind: "failed"; error: string };
```

### Existing pattern: unbounded backfill filter (confirms Priority Finding #1)
```typescript
// Source: src/client/groups-manager.ts:539 (#connectGroup)
const filter = { kinds: [GROUP_EVENT_KIND], "#h": [h] };
// Backfill before subscribing (mirrors the proven attach order): the backlog
// ingests as one batch so out-of-order commits resolve together.
await drain(await this.network.request(relays, filter));
```

## State of the Art

Not applicable in the usual sense (no external library version drift to track). The one relevant "state of the
art" fact: `refs/mdk` was fast-forwarded immediately before this research pass (see `10-CONTEXT.md`'s Upstream
submodule check) and its one new commit does not touch `group_lifecycle.rs` or any file this phase models — the
line-number citations in `10-CONTEXT.md`'s `<canonical_refs>` remain valid as of this research.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The pending-state `kind` for the founding Add's `PendingState` can reuse `"commit"` (rather than needing a new `"foundingAdd"` pending kind) since `confirmPublished()` branches on `pending.kind === "commit" \|\| pending.kind === "selfUpdate"` identically | Code Examples / Architecture Patterns | Low — if a new pending kind is preferred instead, `confirmPublished()`'s branch condition needs one more `||` clause; either way the record/audit/notification logic is unchanged. Flagged `[ASSUMED]` because CONTEXT.md does not pin this and it is genuinely Claude's Discretion territory not explicitly listed. |
| A2 | A multi-epoch (>5) backfill catch-up for a very-late joiner fully resolves within `ingestEnvelopes`' `maxRetries=5` internal loop, or else resolves on a subsequent live-subscription event via the persistent `IngestionPool` | Priority Finding #1 | Medium — if neither happens (e.g., the pool has a hard capacity cap that evicts old entries before the chain completes), a very-late joiner could stay stuck even with relays. Not verified by an existing test in this codebase; recommended as a new regression case, not confirmed by empirical testing in this research pass. |

## Open Questions

1. **Exact pending-state discriminant for the founding Add.**
   - What we know: `confirmPublished()`'s commit-recording branch is guarded by `pending.kind === "commit" || pending.kind === "selfUpdate"`.
   - What's unclear: whether the plan should add a third value to that guard or reuse `"commit"` literally for the founding case's `PendingState.kind`.
   - Recommendation: reuse `"commit"` unless the planner wants `PendingState.kind` to be independently diagnostic (e.g., for R-01's test to assert on) — in which case add `"foundingAdd"` as a fourth value and widen `confirmPublished()`'s guard by one clause. Either is low-risk; this is genuinely Claude's Discretion, just not enumerated as such in CONTEXT.md.

2. **Whether `retryWelcome()` should read `group.relays` and short-circuit with a clear error when empty.**
   - What we know: D-09 makes relay-less founding create legal; `deliver()` throws its own error per-recipient when both the NIP-65 lookup and `groupRelays` fallback are empty.
   - What's unclear: whether a clearer, founding-specific error message at the `retryWelcome()` call site is worth the extra code versus just letting `deliverMany()`'s existing per-recipient error surface as-is.
   - Recommendation: low priority; the existing per-recipient error message from `deliver()` ("No relays available to send Welcome to recipient...") is already accurate and actionable — a wrapper message would be a UX nicety, not a correctness requirement.

## Security Domain

### Applicable threat categories for this phase's stack

| Category | Applies | Standard Control |
|----------|---------|-------------------|
| Trust-boundary bypass (untrusted KeyPackage event accepted into a commit) | yes | `createInviteIntent()` reused verbatim (D-11) — SEC-01 signature check, WIRE-01/WIRE-02 cardinality/lifetime, credential-identity-equals-event-author. No new code on this boundary. |
| Admin-set integrity at group founding (mdk#737 class) | yes | Existing `validateCommitLegality` → `validateAdminLeafCoupling`, confirmed sufficient (Priority Finding #2) — no new control needed. |
| Duplicate/malformed Welcome-recipient set (ts-mls behavior drift or duplicate invitee) | yes | D-13's exactly-one-distinct-Welcome-per-invitee assertion, placed per this research's recommendation before any KeyPackage material is delivered. |
| Silent data loss (a member added but never told) | yes, by design (accepted risk) | R-04's compound risk — mitigated only by the spec's re-invite path, not by this phase's code. Must be documented for downstream app developers, not "fixed." |
| Audit-trail completeness for a security-relevant local operation | partial | Engine-level `send_entry`/`send_outcome`/`epoch_confirmed` inherited; Welcome-delivery-specific audit remains absent for both founding and ordinary paths (Priority Finding #4) — a pre-existing gap, not a regression. |

### Known Failure Patterns for this phase's stack

| Pattern | Category | Standard Mitigation |
|---------|----------|----------------------|
| Founding commit accidentally published as a kind-445 event | Protocol violation (`AlreadyAtEpoch` bounce at every invitee, per MDK's own comment) | Omit `peeler.wrapGroupMessage()` entirely for the founding case (not merely skip the runtime publish step) — see Anti-Patterns. |
| KeyPackage material burned by a founding create that then fails legality validation | Resource-consumption-on-failure (shared with ordinary invite, not new) | Accepted per D-04's framing; the spec's re-invite-with-fresh-KeyPackage path is the only recovery, matching ordinary invite's existing behavior. |
| A relay-less founding group silently created and unusable for messaging | Availability / operator error, not a security vulnerability | Document prominently per Pitfall 4; D-09 is locked as-is. |

## Sources

### Primary (HIGH confidence — direct code reads in this repository)
- `src/engine/group-engine.ts` — `confirmPublished()`, `send()`, `#sendInner` `case "commit"`/`case "selfUpdate"`, `#assertStagedCommitLegal`, `#prepareOutboundCommitProposals`, `#transportEnvelope`, `#artifactKind`, `auditSendResultKind`/`auditSendIntentKind`.
- `src/core/group-lifecycle.ts` — `LEGAL_TRANSITIONS`, confirming D-01's "no new FSM edge" claim.
- `src/core/components/integrity.ts` — `validateCommitLegality`'s four-step fixed order, `validateAdminLeafCoupling`.
- `src/client/group-factory.ts`, `src/client/group/invite.ts`, `src/client/transport/nostr/welcome-delivery.ts`, `src/client/runtime/group-runtime.ts`, `src/client/session/group-effects.ts`, `src/core/group.ts`, `src/client/groups-manager.ts` (`#connectGroup`, `create`, `invite`) — full reads, confirming every file/line reference this document makes.
- `src/client/runtime/__tests__/group-runtime.test.ts` — full grep + targeted reads, R-03 blast-radius inventory.
- `src/__tests__/integration/end-to-end-invite-join-message.test.ts` — full read, FOUND-05 test-shape analog.
- `refs/marmot/protocol-core/joining.md` — full read, founding-creation exception, receiving-flow steps 1-14.
- `refs/mdk/crates/cgka-engine/src/group_lifecycle.rs:236-560` — `do_create_group`'s admin-leaf-coupling ordering and its own justifying comment, `SendResult::FoundingGroupCreated`.
- `.planning/phases/10-founding-group-creation-via-welcome/10-CONTEXT.md` — locked decisions, canonical refs, unpursued threads (this document's mandate).
- `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/config.json` — phase requirements, project history, workflow toggles (`nyquist_validation: false` confirmed, `security_enforcement` absent → treated as enabled).

### Secondary (MEDIUM confidence)
- None — every claim in this document is either a direct code/spec read (tagged above) or explicitly marked `[ASSUMED]` in the Assumptions Log.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Priority findings 1-4: HIGH — each grounded in direct reads of the exact code paths involved, cross-checked against spec (`joining.md`) and Rust reference (`group_lifecycle.rs`) source.
- D-01 window analysis / audit-wrapper hazard: HIGH — verified by reading `confirmPublished()`, `send()`, and the three audit-helper methods line-by-line; the envelope-access hazard is a new finding not previously documented.
- R-03 blast radius: HIGH — exhaustive grep across `src/` confirms exactly one affected test file.
- Assumption A2 (multi-epoch backfill resolving within retry bounds): MEDIUM — mechanism confirmed present in code, but no existing test exercises a multi-epoch (>5) backfill scenario, so behavior at that scale is inferred from the retry/pool design, not empirically observed.

**Research date:** 2026-09-24
**Valid until:** No expiry driven by external dependencies (none introduced). Re-verify only if `refs/marmot` or `refs/mdk` receive commits touching `protocol-core/{joining,publish-lifecycle}.md` or `cgka-engine/src/group_lifecycle.rs` before planning begins.
