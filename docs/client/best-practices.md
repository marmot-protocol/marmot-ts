# Best Practices

Patterns for building reliable Marmot applications. They follow from how the [engine](/guide/architecture#engine-module) handles convergence, commit lifecycle, and key material.

## Keep key packages replenished

Others can only add you to a group if you have an unused key package published. Key packages are single-use (unless marked last-resort), so monitor your inventory and top it up:

```typescript
for await (const packages of client.keyPackages.watchKeyPackages()) {
  if (packages.length < 3) {
    await client.keyPackages.create({ relays: myInboxRelays });
  }
}
```

Rotate periodically with `client.keyPackages.rotate(ref, options)` for post-compromise hygiene, and publish to the relays where invitations will look for them (your kind 10050 inbox relays).

## Let convergence settle before relying on state

Outbound sends are **convergence-gated**: an intent submitted while `group.convergenceStatus` is not `Settled` is queued and flushed once concurrent commits resolve. Don't fight this with retries — submit the intent and let the engine order it. When you need to read settled state (e.g. before showing the member list as authoritative), check `convergenceStatus === "Settled"`.

## Treat ingest dispositions exhaustively

`group.ingest` yields a disposition per event. Handle the non-`processed` cases instead of assuming success:

- **`deferred`** — not malformed; retry when more protocol state arrives.
- **`unreadable`** — terminal; the event can't be decrypted (e.g. a pruned epoch). Log and drop.
- **`removed`** — an inbound commit removed this member. Stop sending; decide when to `destroy` the tombstone.

## Drive the UI from history, not from ingest

Render chat from `group.history.subscribe(...)`, which delivers both self-sent and ingested messages through one stream. Listening to the `applicationMessage` event works too, but the history subscription gives you the full timeline, survives reloads, and is idempotent across relay backfill. Avoid building a separate "optimistic echo" path — the session already records self-sent rumors.

## Persist before you publish

The engine uses publish-before-apply for commits: a commit is published, then confirmed or rolled back. Let the client manage this — use `client.groups.commit` / `send` rather than manually advancing state — so a failed publish doesn't leave your local state ahead of the group.

## Isolate storage per account

Every account must use completely separate `groupStateStore`, `keyPackageStore`, and `inviteStore` instances. Key package stores hold private keys; sharing a backend across accounts leaks key material. Namespace stores by pubkey and rebuild the client on account switch — see [Multi-Account Support](/client/marmot-client#multi-account-support).

## Choose relays deliberately

- Publish key packages and receive gift wraps on your **inbox** relays (kind 10050); `getUserInboxRelays` resolves a peer's.
- A group carries its own relay set in `group.groupData.relays`; publish and subscribe to group traffic there, and update it with [`proposeUpdateMetadata({ relays })`](/client/proposals#updating-metadata).
- Use several relays for redundancy — Marmot's privacy and availability come from relay diversity, not from any single relay.

## Clean up subscriptions

`watch()`, `watchKeyPackages()`, `watchUnread()`, and `history.subscribe()` are long-lived async generators. Break out of their loops (or abort them) when a component unmounts or the user switches accounts, and call `group.dispose()` when unloading a group, to avoid leaking listeners and timers.

## Migrating to account identity proof v2 (0x8009)

### Signer

The client's own signer signs the `0x8009` account identity proof — NIP-07 and NIP-46 signers work the same as a local key signer. There is no separate `accountProofSigner` option anywhere in the library; every `generateKeyPackage` call always emits a current, verifiable proof.

### Republish key packages

A KeyPackage published by a pre-v2 release (or one built with the removed `accountProofSigner` option) carries the legacy proof shape, and v2 peers reject it when they try to invite you with it. Call `client.keyPackages.ensurePublished({ relays })` to publish a fresh current KeyPackage — it ignores legacy entries when checking whether a current one already exists.

That alone does not retire the legacy KeyPackage. Nothing is deleted automatically, so its kind-30443 event stays discoverable on relays, and any peer whose invite picks it will fail. Only the local `ensurePublished` check skips legacy entries: `selectForWelcome` still offers them as Welcome candidates, and `rotate()`, `remove()`, and `clear()` act on them like any other entry. To finish the migration, list stored entries with `client.keyPackages.list()` — non-current ones carry `nonCurrent: true` — and pass their refs to `client.keyPackages.purge(refs)`, which publishes the NIP-09 deletion and removes the local key material:

```ts
await client.keyPackages.ensurePublished({ relays });
const legacy = (await client.keyPackages.list()).filter(
  (pkg) => pkg.nonCurrent,
);
if (legacy.length > 0)
  await client.keyPackages.purge(legacy.map((pkg) => pkg.keyPackageRef));
```

### Legacy groups

Groups whose `GroupContext` still requires the legacy `0xf2f1` proof extension, or that never required `0x8009` at all, are outside the current profile: they cannot be joined, they do not interoperate with v2 peers, and they must be recreated.

A group you already had stored before this cut still **loads**: `client.groups.loadAll()` and `client.groups.get(...)` never throw for it, and it stays listed alongside your current-profile groups. Check `group.profileSupport` to find one — it reports `{ kind: "unsupported", proofReason }`, with `proofReason` one of `legacy-group`, `mixed-profile`, or `missing-requirement`. Every send on such a group throws `UnsupportedGroupProfileError` (`reason: "unsupported-profile"`, exported from `@internet-privacy/marmot-ts/engine`), and every inbound event for it is yielded from `group.ingest()` as skipped with reason `unsupported-profile` (a `stale` disposition, category `unsupported_required_feature`) — nothing is decrypted or applied. That refusal covers the commit-producing lifecycle calls too: `group.disband()` and `group.enableDisbanding()` return a `rejected` result and publish nothing, and a disband request persisted before the upgrade is never resumed. Nothing is deleted or published automatically, so it is up to you to find and remove these groups; call `group.destroy()` on each one you no longer need:

```ts
const groups = await client.groups.loadAll();
for (const group of groups) {
  if (group.profileSupport.kind === "unsupported") {
    await group.destroy();
  }
}
```

## Next steps

- **[MarmotClient](/client/marmot-client)** — lifecycle, managers, multi-account
- **[Proposals](/client/proposals)** — commits, membership, metadata
- **[Architecture](/guide/architecture)** — the convergence and lifecycle model these practices follow
