# Phase 10: Founding Group Creation via Welcome - Context

**Gathered:** 2026-09-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Creating a Current-profile group **with initial invitees** becomes a two-step local operation: create the
one-member epoch-0 group, then create and **locally merge** exactly one founding Add Commit (epoch 0 → 1)
carrying every invitee. That Add publishes **no kind-445 group event**. The group is `Stable` at epoch 1
immediately, and each invitee receives an independently-retryable Welcome.

Covers FOUND-01..05.

**Established by the codebase scout (do not re-derive):**

- **`GroupFactory.create()` is solo-only today.** `createSimpleGroup` (`src/core/group.ts:124`) has no members
  parameter anywhere in the chain. Adding the *first* invitees currently goes through
  `createInviteIntent` → `GroupSession.send({kind:"commit"})` → `GroupRuntime.publishCommit`, which **does**
  publish a kind-445 handshake commit — exactly the path that must not fire.
- **`Stable → Merging` is not a legal FSM transition** (`src/core/group-lifecycle.ts:37-44`). The only route into
  `Merging` is from `PendingPublish`, and `confirmPublished()` — which performs the entire CR-09 fix
  (`#recordCommitNode` into `RetainedHistoryStore` + `GroupHistoryTree`, notification derivation, own-commit
  stamping) — begins by transitioning *to* `Merging`. "Skip `PendingPublish` and still reuse the recording path"
  was therefore not available. D-01 resolves this.
- **`engine.send({kind:"commit"})` always wraps an envelope** via `peeler.wrapGroupMessage()` and always
  transitions to `PendingPublish`. A founding Add has neither an envelope nor a publish obligation.
- **`GroupRuntime.#deliverWelcomes()` is all-or-nothing**: `Promise.allSettled` over recipients, then one
  aggregate `throw`, collapsing to a single `welcomeDelivery: {kind:"failed"}`. No per-invitee surface exists,
  and nothing is durable.
- **`NostrWelcomeDelivery` is already public API** (exports snapshot `src/__tests__/exports.test.ts:124`, client
  barrel `src/client/index.ts:10`) and reachable as `group.runtime.welcomeDelivery` — a public readonly field
  (`group-runtime.ts:54`), constructed at `marmot-group.ts:735`. Founding create needs **no new plumbing** to
  reach it.
- **`createSimpleGroup` seeds `transport.nostr.routing` only when relays are supplied** (`group.ts:147-151`),
  but Welcome delivery uses `groupData.relays` as its inbox-lookup fallback. This makes "invitees, no relays" a
  live footgun. D-09 accepts it deliberately.

**Not in this phase:**

- Rust-signed MDK fixtures, the exports snapshot update, and the six-runtime QA gate (Phase 11, QA-03..05).
  Note D-07 and D-10 both add names to the public export surface, so Phase 11's snapshot work inherits them.
- Any durable outbound-Welcome queue (explicitly declined in D-04).
- Multi-device and push (milestone-level deferrals).

</domain>

<decisions>
## Implementation Decisions

**13 decisions. Four carry explicitly-accepted costs (D-02, D-05, D-06, D-10) and two produce unmitigated
risks (R-02, R-04 below). None of the four may be silently "improved" during planning — each was chosen against
a named alternative.**

### Lifecycle & merge path

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

### Welcome retry & durability

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

### Create API shape & relays

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

### Partial-failure outcome

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

### Named risks — carry into planning as acceptance criteria, not comments

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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec (normative)

- `refs/marmot/protocol-core/joining.md` lines 21-30 — **the founding-creation exception**, the normative core
  of this phase: solo epoch-0 create has an empty publish obligation and ends at epoch 0; founding creation
  with invitees then creates and **locally merges one** founding Add Commit from epoch 0 to epoch 1, which
  "has no group-message publication obligation because no pre-existing peer needs it"; the creator then
  attempts "independent per-invitee epoch-1 Welcome deliveries".
- `refs/marmot/protocol-core/joining.md` lines 30-33 — the GroupInfo in every Marmot Welcome **MUST** include
  the `ratchet_tree` extension; a joiner MUST reject a Welcome without it.
- `refs/marmot/protocol-core/joining.md` lines 44-80 — the Welcome receiving flow, steps 1-14 (FOUND-05).
  Steps 4-9 are **one tentative validation operation**: they MUST NOT durably create group state, consume or
  rotate the KeyPackage, or delete `init_key` material unless every check through step 9 succeeds.
- `refs/marmot/protocol-core/publish-lifecycle.md` lines 66-78 — empty publication obligation for epoch 0 and
  for the founding Add; each epoch-1 Welcome is "a separate retryable per-invitee delivery obligation"; a
  Welcome "succeeds or fails independently and does not affect canonical group state" (**D-12**); consumed
  KeyPackage material is **not restorable** and the creator **MAY re-invite** with a fresh KeyPackage against
  the now-canonical group (**D-04**); the empty-obligation exception is **limited** to epoch 0 and its
  immediately following founding Add — every subsequent Commit follows normal publish-before-apply.
- `refs/marmot/protocol-core/group-setup.md` lines 61-62 — every founding group includes the same required
  admin-policy component, and any founding Welcome is evaluated against it.

### Rust reference

- `refs/mdk/crates/cgka-engine/src/group_lifecycle.rs` `do_create_group` (~400-735) — the Current-profile
  branch is this phase's model. Specifically: admin-leaf coupling validated against **projected** initial
  member accounts before `add_members` (mdk#737); `validate_current_profile_invariants_for_staged_commit` +
  `validate_staged_commit_account_identity_proofs` on the staged founding Add (**FOUND-02**); the explicit
  "we intentionally do NOT emit the commit" comment with its `AlreadyAtEpoch`-bounce rationale (**FOUND-01**);
  the **one-distinct-Welcome-per-invitee guard** (**D-13**); one atomic durable transaction that merges the
  pending commit and persists the canonical record; `set_stable` (**FOUND-03**); and the return
  `SendResult::FoundingGroupCreated { welcomes }` (**D-02**).
  Note the Legacy branch immediately below it takes the ordinary `PendingPublish` / `PendingKind::CreateGroup`
  path — marmot-ts has no Legacy profile (Phase 7 clean cut), so **only the Current branch is a valid model**.

### Planning / research

- `.planning/research/PITFALLS.md` **Pitfall 16** — this phase's namesake risk, quoted at length in the
  decisions above: founding-create changes publish-before-apply and Welcome-failure handling, not just call
  routing. Includes the v1.0 CR-09 precedent (`selfUpdate` commits never recorded into retained history /
  history tree) as the cautionary shape for **any** non-ordinary commit-producing seam.
- `.planning/research/SUMMARY.md` §"Phase 10" and §"Gaps to Address" — the lifecycle-FSM treatment flagged as
  **must-resolve-before-build** ("Must be resolved before Phase 10 implementation, not discovered mid-build").
  Resolved here as D-01.
- `.planning/research/ARCHITECTURE.md` §1.3 — the `group-factory` / `group-runtime` / `group-session` rows
  naming the exact seams that change, and §1.1's `group-lifecycle.ts` row raising the FSM question D-01 answers.
- `.planning/REQUIREMENTS.md` FOUND-01..05 (lines 60-66), with the header note citing the
  `protocol-core/joining.md` founding-creation exception and MDK `SendResult::FoundingGroupCreated`.

### Prior phases

- `.planning/phases/09-self-update-replacement-leaf-identity-binding/09-CONTEXT.md` — the
  `validateCommitLegality` chokepoint, fixed per-seam dispositions, and the fail-closed convention.
- `.planning/phases/08-groupcontext-profile-requirement-legality-seam-extension/08-CONTEXT.md` — D-01 delta
  validation via tree diff, D-07 check ordering inside `validateCommitLegality` (component-integrity →
  profile/proof → disband-legality → admin-leaf coupling).

### Upstream submodule check (2026-09-24)

- `refs/marmot` — **current**, no new commits.
- `refs/mdk` — **1 commit behind**: `aae20359` "fix(app): isolate bounded recovery input and qualify
  resources (#2022)". marmot-app scope; **does not touch `group_lifecycle.rs`** or any file this phase models.
- **Action for the planner:** fast-forward both and commit the pointer bump as its own `chore(refs):` commit at
  plan start, per the standing CLAUDE.md rule. Line numbers cited above are pre-bump but the relevant file is
  unchanged upstream.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/engine/group-engine.ts`:
  - `confirmPublished()` (~`:1553`) — reused **verbatim** by D-01. Performs `#setState`, `#recordCommitNode`,
    notification derivation, the `epoch_confirmed` audit event, and the `merge_complete` transition in a
    `finally`.
  - `#recordCommitNode()` (~`:508`) — the CR-09 fix: records into both `RetainedHistoryStore` and
    `GroupHistoryTree`. Inheriting this is the whole point of D-01.
  - `#assertStagedCommitLegal()` — the FOUND-02 gate; already called by both the `commit` and `selfUpdate`
    send cases with `(parentState, newState, committedWithSenders, committerLeafIndex)`.
  - `#prepareOutboundCommitProposals()` — resolves the exact proposal union, applies the D-05 coupling splice,
    and runs the actor-authorization callback. The founding Add should route through it like any commit.
  - `send()` `case "commit"` (~`:1130-1175`) — the shared staging code D-02's new case reuses. Note the two
    steps a founding Add must **skip**: `peeler.wrapGroupMessage()` and the `PendingPublish`-then-return split.
- `src/engine/types.ts` — `PendingState` (`:83-102`, note `parentState` and `commitMessage` are **required**
  for commit-producing kinds per CR-09), `SendResult` (`:131-140`), `SendIntent` (`:115+`). D-02 extends the
  latter two.
- `src/client/transport/nostr/welcome-delivery.ts` — `NostrWelcomeDelivery.deliver()` does the NIP-59
  gift-wrap, resolves recipient inbox relays with a `groupRelays` fallback, and **throws when the resulting
  relay list is empty**. D-07 adds `deliverMany()` beside it; D-09 depends on the inbox-relay path working
  without a group-relay fallback.
- `src/client/group/invite.ts` `createInviteIntent()` — the reused trust boundary (D-11).
- `src/core/group.ts` — `createGroup()` (`:52`), `createSimpleGroup()` (`:124`). Note `requiredIds` already
  picks up `0x8009` via `DEFAULT_GROUP_COMPONENT_IDS`, and the routing component is pushed **only** when
  `relays.length > 0` (`:147-151`) — the D-09 footgun.

### Established Patterns

- **Seam dispositions are fixed and must not drift** (Phases 8/9): send throws `CommitLegalityError`, inbound
  yields `rejected`, replay drops the edge, tree-fed convergence fails closed. A founding Add is a *send*, so
  a legality failure **throws** — and per D-03 nothing has been persisted at that point.
- **`GroupPublishResult` already models ancillary failure independently** (Phase 03.1-02): `publishFailed` is
  exclusive to pre-confirm relay failures; persistence and Welcome failures are independent discriminated
  outcomes with `retryPublication: false`. D-04/D-12 extend this existing shape rather than inventing one.
- The lifecycle FSM is small and total (84 lines, `LEGAL_TRANSITIONS` as an exhaustive record). Any FSM change
  is highly visible — which is why D-01 avoiding one is valuable.
- Reason/outcome types are literal unions consumed by reference; `AncillaryEffectOutcome`
  (`group-effects.ts:31-34`) is the existing three-state shape per-recipient results should follow.

### Integration Points

- `src/engine/types.ts` — `SendIntent` + `SendResult` variants (D-02).
- `src/engine/group-engine.ts` — new `send()` case; reuses `#prepareOutboundCommitProposals`,
  `#assertStagedCommitLegal`, `confirmPublished` (D-01, D-02, FOUND-02).
- `src/client/transport/nostr/welcome-delivery.ts` — `deliverMany()` (D-07).
- `src/client/runtime/group-runtime.ts` — `#deliverWelcomes()` (its `deliver()` call is at `:463`) becomes a
  `deliverMany()` caller; `#publishCommitResult`'s welcome block (`:294-306`) and
  `GroupPublishResult.welcomeDelivery` change shape (D-06, R-03).
- `src/client/session/group-effects.ts` — `GroupPublishResult.welcomeDelivery` (D-06). `GroupPublishWork` and
  `GroupEffects` are **unchanged** (D-05).
- `src/client/group-factory.ts` `create()` (`:116`) — the founding orchestration site: build intents (D-11),
  send + confirm (D-01/D-02), assert Welcome count (D-13), `save()` once (D-03), fan out (D-05/D-07).
- `src/client/groups-manager.ts` `create()` (`:806`) — `options.invitees` pass-through (D-08); `invite()`
  (`:365`) is the D-06 blast-radius caller.
- `src/client/group/marmot-group.ts` — `pendingWelcomes` + `retryWelcome()` (D-10); `:735` is where
  `NostrWelcomeDelivery` is constructed; `:367` exposes `readonly runtime`.
- `src/core/group.ts` — invitees parameter threading (D-08, discretion on whether it lands on `createGroup` or
  `createSimpleGroup`).
- Tests: existing invite suites (R-03 migration), `src/client/group/__tests__/marmot-group.test.ts`,
  `src/engine/__tests__/` send-path suites, plus a new FOUND-05 integration test that **must supply relays**
  (R-05).
- `src/__tests__/exports.test.ts` — D-07's `deliverMany()` and D-10's new members land here; coordinate with
  Phase 11's QA-05 snapshot work.

</code_context>

<specifics>
## Specific Ideas

- **The FOUND-01 test is an assertion about absence:** creating with invitees must publish **zero** kind-445
  events. Assert on the mock network's publish log, not on the returned value — a spurious founding commit is
  exactly the failure Pitfall 16 predicts, and MDK's own comment explains why it matters (it causes a
  welcome-before-commit `AlreadyAtEpoch` bounce at the joiner).
- **The FOUND-03 test should assert `Stable` and epoch 1 *synchronously* after `create()` resolves**, with no
  intervening await — that is the only way D-01's "no observable window" claim is actually checked.
- **R-01's test is the one most likely to be skipped and most valuable to keep:** construct a
  `foundingGroupCreated` result and assert that failing to confirm it is caught rather than silently leaving a
  staged commit.
- **The D-13 assertion should fail loudly on a duplicate invitee**, which is the realistic trigger (the same
  pubkey's KeyPackage passed twice), not a hypothetical ts-mls regression.
- Phase 8 and 9 both ran review-fix passes (`08-REVIEW-FIX.md` WR-01..07, Phase 9's 1 Critical + 4 Warning).
  Budget one here too — and note Phase 9's lesson that the missing **positive control** was why its Critical
  shipped green. For this phase the positive control is: an honest all-N-Welcomes-succeed founding create
  produces a working group whose invitees can message the creator (FOUND-05).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. No scope-creep candidates arose.

### Explicitly declined alternatives (recorded so they are not re-proposed as improvements)

- **A durable outbound-Welcome store** mirroring MDK's `put_message(MessageState::Sent)` — declined in D-04 on
  the grounds that the spec's re-invite path makes it unnecessary for conformance. Revisit only if R-04's
  silent-loss window proves unacceptable in practice.
- **A welcome-only `GroupPublishWork` variant** — declined in D-05. This is the clean way to repay R-02's audit
  debt if that is ever wanted.
- **Extracting `createInviteIntent`'s KeyPackage gate** into a `{ proposal, recipient }` helper — declined in
  D-11 to avoid refactoring a shipped trust boundary. Worth revisiting if a third caller ever needs it.
- **A uniform `{ group, welcomeDeliveries }` return** — declined in D-10 to avoid breaking existing callers.

### Threads raised but not pursued (planner/researcher may pick these up)

- Whether R-02's audit debt should be repaid somewhere after all, given the log-plus-audit variant was
  explicitly declined in D-12.
- What FOUND-05's end-to-end integration test must look like concretely: creator → Welcome → invitee joins at
  epoch 1 → bidirectional message exchange.
- Whether `retryWelcome()` needs a guard once the group has advanced past epoch 1 (an epoch-1 Welcome delivered
  late may strand the joiner behind the current epoch — `joining.md` step 13 says the joiner "catches up on
  outstanding Commits as best it can", so this may be benign, but it is unverified).
- Whether admin-leaf coupling against **projected** initial members (MDK mdk#737, validated *before*
  `add_members`) is already covered by `validateCommitLegality`'s existing admin-leaf check running post-apply,
  or needs explicit attention at creation. MDK deliberately runs it early "so an invalid admin set produces no
  membership/commit side effects" — with D-03 (nothing persisted until merge) the consequence is milder here,
  but the check's *presence* still needs confirming.

</deferred>

---

*Phase: 10-founding-group-creation-via-welcome*
*Context gathered: 2026-09-24*
