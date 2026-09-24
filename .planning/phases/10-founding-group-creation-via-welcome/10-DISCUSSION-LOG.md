# Phase 10: Founding Group Creation via Welcome - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-24
**Phase:** 10-founding-group-creation-via-welcome
**Areas discussed:** Lifecycle & merge path, Welcome retry & durability, Create API shape & relays, Partial-failure outcome

All four offered areas were selected for discussion. 13 decisions captured.

---

## Lifecycle & merge path

### Q1 — How should the founding Add reach canonical state, given `Stable → Merging` is illegal today?

Context surfaced before asking: `LEGAL_TRANSITIONS` (`src/core/group-lifecycle.ts:37-44`) has no
`Stable → Merging` edge, and `confirmPublished()` — which performs the entire CR-09 recording fix — begins by
transitioning *to* `Merging`. So "skip `PendingPublish` and still reuse the recording path" was not available.

| Option | Description | Selected |
|--------|-------------|----------|
| Transit PendingPublish, never yield | Stage → PendingPublish → `confirmPublished()` in the same uninterrupted await. No FSM change; CR-09 recording inherited verbatim. Window exists in-process but is unobservable. | ✓ |
| Add a founding `Stable → Merging` edge | Literal FOUND-03 compliance. Costs a new FSM edge reachable by any caller unless guarded. | |
| Stay Stable, shared recording helper | Closest to MDK's single atomic transaction. Structurally the CR-09 defect shape — a second recording path that can drift. | |

**User's choice:** Transit PendingPublish, never yield
**Notes:** FOUND-03's "no PendingPublish window" is therefore read as "no *observable* window". Zero FSM
change was the decisive property.

### Q2 — Who owns the stage-and-self-confirm sequence?

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated engine method | `mergeFoundingAdd()` stages and self-confirms internally; no `PendingState` in the signature, so "never yield" is enforced by type. | |
| New `send()` intent + result variant | `{kind:"foundingAdd"}` on `SendIntent`, `{kind:"foundingGroupCreated", welcome, pending}` on `SendResult`. Pitfall 16's literal advice. `PendingState` escapes; invariant becomes convention. | ✓ |
| Client layer sequences both | `GroupFactory` calls `send` then `confirmPublished`. No new engine surface; invariant furthest from the FSM it protects. | |

**User's choice:** New `send()` intent + result variant
**Notes:** Chosen with the tradeoff explicit — this is the option where a `PendingState` escapes, so D-01's
"never yield" invariant is convention-enforced rather than type-enforced. Recorded as risk R-01 with a test
obligation, since the option that would have made it structurally impossible was declined.

### Q3 — What should be durable, and when?

| Option | Description | Selected |
|--------|-------------|----------|
| Only epoch 1, one write | Nothing persisted until the founding Add merges. Crash before that leaves no local group, so nothing to reconcile. Matches today's single `save()`. | ✓ |
| Epoch 0 first, then epoch 1 | Mirrors MDK's `put_group()`-inside-transaction. Crash leaves a loadable solo group whose invitee KeyPackages are already burned. | |

**User's choice:** Only epoch 1, one write

---

## Welcome retry & durability

### Q1 — How should outstanding Welcomes be tracked?

Context surfaced before asking: `publish-lifecycle.md:73-76` makes durable Welcome storage **optional** for
conformance — consumed KeyPackage material is unrecoverable and the creator MAY simply re-invite with a fresh
KeyPackage.

| Option | Description | Selected |
|--------|-------------|----------|
| In-memory per-recipient + `retryWelcome()` | Smallest change: no store, no resume-on-load. Crash loses the Welcome artifact; spec re-invite path recovers it. | ✓ |
| Durable outbound-Welcome store | Mirrors MDK `MessageState::Sent`; survives crash. Costs a new store, purge wiring, resume driver. | |
| Hand welcomes back to the caller | BYO-network. FOUND-04 becomes the app's obligation; library has no test surface proving retry works. | |

**User's choice:** In-memory per-recipient + `retryWelcome()`

### Q2 — How should Welcome fanout be driven, given there is no kind-445 envelope?

| Option | Description | Selected |
|--------|-------------|----------|
| New welcome-only `GroupPublishWork` | Keeps founding create inside the path Phase 03.1 hardened; inherits audit emission, relay resolution, `GroupPublishResult`. | |
| Bypass runtime, deliver directly | Fewer type changes, reads linearly. Re-implements fanout, error shaping, audit emission outside the runtime — the CR-09 shape. | ✓ |

**User's choice:** Bypass runtime, deliver directly
**Notes:** The audit-emission cost was named in the option text and accepted. It was offered again for
repayment in the Partial-failure area (log + audit-emit variant) and declined there too, so it stands
unmitigated as risk R-02.

### Q3 — What happens to the all-or-nothing `#deliverWelcomes()`?

| Option | Description | Selected |
|--------|-------------|----------|
| Replace in place, both paths per-recipient | One implementation, cannot drift; ordinary invite gains granularity. Changes shipped invite behaviour and its tests. | ✓ |
| Parallel per-recipient path, invite untouched | Zero regression risk. Two implementations to keep in sync, only one per-invitee retryable. | |

**User's choice:** Replace in place, both paths per-recipient
**Notes:** Recorded as risk R-03 — existing invite tests asserting the aggregate throw must be migrated
deliberately, not patched to pass.

### Q4 — Where should the shared fanout live? (follow-up: the two prior answers could not both hold as stated)

Raised because "bypass the runtime" and "one shared fanout" are only simultaneously satisfiable if the loop
moves out of `GroupRuntime`'s **private** `#deliverWelcomes()`. A lookup first confirmed
`NostrWelcomeDelivery` is already public API and reachable as `group.runtime.welcomeDelivery`.

| Option | Description | Selected |
|--------|-------------|----------|
| Method on `NostrWelcomeDelivery` | Public `deliverMany()`. Both callers reach it through an object each already holds; lands on the class whose job is Welcome delivery. | ✓ |
| Free function in the transport module | Keeps the class surface unchanged; trivially unit-testable without a runtime. | |
| Keep it on `GroupRuntime`, make it public | Smallest diff, but re-couples founding create to the runtime, partly undoing the bypass decision. | |

**User's choice:** Method on `NostrWelcomeDelivery`
**Notes:** This is the load-bearing decision that reconciles the previous two. Flagged in CONTEXT.md: D-05 and
D-06 cannot be re-litigated without re-deciding this.

---

## Create API shape & relays

### Q1 — How should initial invitees reach group creation?

| Option | Description | Selected |
|--------|-------------|----------|
| `options.invitees` on `create()` | One entry point; omitting invitees keeps today's exact behaviour and code path. Return shape must cover both cases. | ✓ |
| Separate `createWithInvitees()` | One clear contract per function; riskier path impossible to enter by accident. Two near-identical entry points. | |

**User's choice:** `options.invitees` on `create()`

### Q2 — What should creating with invitees and no relays do?

| Option | Description | Selected |
|--------|-------------|----------|
| Reject at the call site | Fails loudly before KeyPackage material is consumed — the research file's guidance for this footgun class. | |
| Allow it, inbox relays only | Works whenever NIP-65 inbox lookup succeeds. Produces a group with no routing component, so it cannot carry ordinary traffic afterwards. | ✓ |

**User's choice:** Allow it, inbox relays only
**Notes:** Recorded as risk R-05 — this constrains FOUND-05 testability, since "can exchange messages with the
creator" is only satisfiable when relays were supplied.

### Q3 — What should `create()` return, now that one entry point covers both cases?

| Option | Description | Selected |
|--------|-------------|----------|
| Always a result object | Uniform `{group, welcomeDeliveries}`; FOUND-04 data impossible to overlook. Breaking change to every existing caller including `examples/`. | |
| Keep `MarmotGroup`, expose results on it | No caller changes. Delivery report becomes discoverable state a caller can silently ignore. | ✓ |
| Overload by argument | Existing callers untouched, richer shape where meaningful. Return type varies by argument. | |

**User's choice:** Keep `MarmotGroup`, expose results on it
**Notes:** Contributes to compound risk R-04 together with the non-durable choice from the Welcome area.

### Q4 — How should founding invitees be admitted (FOUND-02)?

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse `createInviteIntent` per invitee | Zero new trust-boundary code; founding path cannot drift from SEC-01/WIRE-01/WIRE-02 gates. Returns a whole commit intent per invitee, so most of it is discarded. | ✓ |
| Extract the shared gate | Clean fit for both callers, one implementation. Refactors a shipped trust boundary Phase 2 hardened. | |

**User's choice:** Reuse `createInviteIntent` per invitee

---

## Partial-failure outcome

### Q1 — How should `create()` behave on partial Welcome delivery failure?

Context surfaced before asking: the non-durable choice and the ignorable-state choice compound into a silent
invitee-loss path.

| Option | Description | Selected |
|--------|-------------|----------|
| Never throw, always return the group | Matches the spec exactly ("succeeds or fails independently and does not affect canonical group state"). Silent-loss path fully live. | ✓ |
| Never throw, but log + audit-emit | Same contract plus a durable trace; would have repaid the audit debt from the bypass-runtime decision. | |
| Throw if every Welcome fails | Catches the bad-relays/offline case. The group still exists when it throws, so the error reads misleadingly. | |

**User's choice:** Never throw, always return the group
**Notes:** The log + audit-emit variant was explicitly offered as a way to repay R-02 and was declined.
Founding Welcome delivery is therefore audit-silent by decision, not by oversight.

### Q2 — Should marmot-ts assert one distinct Welcome per invitee, as MDK does?

| Option | Description | Selected |
|--------|-------------|----------|
| Assert one distinct Welcome per invitee | Runs before delivery, before KeyPackage material is burned. Catches ts-mls drift and duplicate invitees. Mirrors MDK. | ✓ |
| Trust ts-mls, no assertion | marmot-ts fans one Welcome out per recipient, so a count mismatch is less structurally possible. Duplicate invitee would go unnoticed. | |

**User's choice:** Assert one distinct Welcome per invitee

---

## Claude's Discretion

The user made an explicit choice on every question asked; nothing was answered with "you decide". The following
were left to the planner by the content of the decisions rather than by deferral, and are listed in CONTEXT.md:

- Exact literal spellings for the `SendIntent`/`SendResult` variants, the per-invitee outcome field, and
  `deliverMany()`'s signature and result-element shape.
- Where the one-distinct-Welcome assertion physically lives, provided it runs before any delivery attempt.
- How `retryWelcome()` resolves relays, and whether it needs a post-epoch-1 guard.
- Test file layout, and whether the invitees parameter lands on `createGroup` or `createSimpleGroup`.

## Deferred Ideas

No scope-creep candidates arose; the discussion stayed inside the phase boundary throughout.

Four alternatives were explicitly declined and are recorded in CONTEXT.md so they are not later re-proposed as
improvements: a durable outbound-Welcome store, a welcome-only `GroupPublishWork` variant, extracting
`createInviteIntent`'s KeyPackage gate, and a uniform `{group, welcomeDeliveries}` return.

Four threads were raised but not pursued and are logged in CONTEXT.md for the planner: repaying the audit debt,
FOUND-05's concrete end-to-end test shape, a `retryWelcome()` epoch guard, and whether projected-member
admin-leaf coupling (MDK mdk#737) is already covered post-apply.
