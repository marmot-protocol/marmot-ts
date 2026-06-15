# Group runtime and session migration

Status: active migration plan.

## Goal

Break `MarmotGroup` into darkmatter-inspired layers so protocol state, runtime publishing, Nostr transport behavior, media helpers, and app convenience APIs have separate owners.

The migration intentionally allows breaking API changes. Applications using the current `MarmotGroup` convenience API must update as the new session/runtime API becomes public.

## Current state

The first migration slice has landed:

- `GroupRuntime` owns group publish orchestration, acknowledgement checks, publish-before-apply confirmation, rollback on failed commits, and post-commit Welcome delivery.
- `NostrWelcomeDelivery` owns Nostr/NIP-59 Welcome rumor creation, gift wrapping, inbox relay lookup, fallback to group relays, and publish.
- `GroupEffects` and `GroupPublishWork` define the first session/runtime effect seam.
- `MarmotGroup` still exists and delegates publish/runtime behavior to `GroupRuntime`, but it still owns too many responsibilities.

## Target ownership

| Layer                             | Owns                                                                                                                                 | Must not own                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `GroupSession`                    | Engine instance, state, dirty/save lifecycle, local protocol intents, ingest mapping, pending confirmation/rollback, session effects | Relay publishing, NIP-59 gift wrapping, inbox relay lookup, UI/app message construction |
| `GroupRuntime`                    | Driving session effects through transport publishing, ack policy, commit confirm/rollback, post-confirm Welcome delivery             | Convergence decisions, MLS processing, component validation                             |
| `transport/nostr`                 | Nostr envelopes, Nostr publish surfaces, Welcome delivery, relay/inbox routing helpers                                               | Group-state branch selection, app-component semantics beyond transport-owned state      |
| `group/media`                     | Encrypted media key derivation helpers, encrypt/decrypt, decrypted blob cache                                                        | Group publishing, state transitions, relay behavior                                     |
| `GroupsManager` / account runtime | Group lifecycle registry, account-level orchestration, loading/adopting groups                                                       | MLS internals, direct transport envelope peeling                                        |

## Migration stages

### Stage 1: runtime split

Status: complete.

- Add `src/client/runtime/group-runtime.ts`.
- Add `src/client/transport/nostr/welcome-delivery.ts`.
- Add `src/client/session/group-effects.ts`.
- Update `MarmotGroup` to delegate publish and Welcome delivery behavior.

### Stage 2: extract `GroupSession`

Status: complete.

Create `src/client/session/group-session.ts` and move session-owned behavior out of `MarmotGroup`:

- construct and own `MarmotGroupEngine`;
- construct and own `NostrGroupPeeler` until the peeler moves fully under transport;
- expose `state`, `lifecycle`, `groupData`, `relays`, and `unappliedProposals`;
- own `dirty` tracking and `save(force?)`;
- own `confirmPublished(pending)` and `publishFailed(pending)`;
- convert local send intents into `GroupEffects`;
- own self-echo tracking during ingest;
- map engine ingest results to client-facing results;
- persist inbound application messages through the injected history store;
- emit or return application-message session events.

After this stage, `MarmotGroup` should hold a `GroupSession` and a `GroupRuntime` rather than a `MarmotGroupEngine` directly.

### Stage 3: replace `MarmotGroup` as the primary API

Status: complete for public session/runtime exposure; transitional convenience methods remain until account manager cleanup.

Expose session/runtime flows directly and stop treating `MarmotGroup` convenience methods as the canonical API.

Target shape:

```ts
const effects = await session.send({
  kind: "applicationMessage",
  payload,
});

await runtime.publishEffects(effects);
```

Expected removals or replacements:

- replace `group.sendChatMessage(...)` with app-level rumor construction plus a session intent;
- replace `group.sendApplicationRumor(...)` with app-message intent helpers;
- replace `group.commit(...)` with commit intent plus runtime effect publishing;
- replace `group.inviteByKeyPackageEvent(...)` with a higher-level invite/account runtime helper;
- replace `group.leave()` with a leave intent or account runtime method.

### Stage 4: extract media service

Status: complete.

Create `src/client/group/group-media-service.ts` and move:

- `encryptMedia`;
- `decryptMedia`;
- in-flight decrypt deduplication;
- optional media cache integration.

The media service should depend only on current group state access, ciphersuite access, and an optional `BaseGroupMedia` implementation.

### Stage 5: account-level runtime and manager cleanup

Status: next.

Move closer to darkmatter's account/session/runtime split:

- `MarmotClient` owns account-level dependencies and creates sessions/runtimes.
- `GroupsManager` manages group session loading/adoption/caching.
- Account/runtime helpers own high-level flows like group creation, invite, join, leave, key-package publication, and transport activation.
- Nostr-specific relay and delivery policy moves behind transport/runtime seams.

## Public API direction

The package should expose explicit seams instead of a monolithic group object:

- `GroupSession` for protocol state and effects;
- `GroupRuntime` for publishing effects;
- `NostrWelcomeDelivery` and future Nostr transport helpers;
- app-level helpers for common chat message construction;
- optional services for media and history.

`MarmotGroup` can remain temporarily during the migration, but it should not receive new behavior.

## Test migration plan

- Keep existing `MarmotGroup` tests passing while it delegates to new layers.
- Add focused `GroupRuntime` tests around ack success, no-ack failure, commit rollback, and Welcome delivery failure aggregation.
- Add focused `GroupSession` tests after Stage 2 for send intent effects, confirm/rollback, self-echo ingest, and history persistence.
- Update integration tests to use session/runtime directly after Stage 3.
- Keep export snapshot tests updated for intentional public API changes.

## Open questions

- Should `GroupSession` be Nostr-envelope-specific in the short term, or generic over `TEnvelope` like `MarmotGroupEngine`?
- Should `GroupRuntime.publishEffects` return raw `PublishResponse` records or a transport-neutral report type?
- Should `WelcomeRecipient` stay in Nostr transport, or move to a generic invite effect with transport-specific metadata?
- Should group history persistence be a session event consumer instead of a direct `GroupSession` dependency?
