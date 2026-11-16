# Production checklist

Run through this list before shipping a Marmot app. Each item links to the page that explains it.

## Identity and key packages

- [ ] **Persist one `clientId` per account on each install.** It must be 32 random bytes in lowercase hex. Never derive it from a device name. [Key packages](/client/key-packages#give-each-install-a-slot-id)
- [ ] **Keep a key package published.** Call `client.keyPackages.ensurePublished({ relays })` at startup, using your NIP-65 write relays. Nobody can invite you without one. [Key packages](/client/key-packages#keep-a-key-package-published)
- [ ] **Publish a kind 10050 inbox relay list.** Pass the same relays to `client.invites.listen()`. Welcomes only arrive on inbox relays. [Invites](/client/invites#listen-for-invites)

## Storage

- [ ] **Persist every store**, not just the two required ones. Then check `client.ingestPersistence.kind === "durable"`. [Storage](/client/storage#the-stores-marmotclient-uses)
- [ ] **Protect `keyPackageStore` like a signing key.** `EncryptedKeyValueStore` is a demo, not at-rest encryption. [Storage](/client/storage#encrypt-a-store-demo-only)
- [ ] **Isolate all stores for each account**, and run one client per account. [Multi-account](/client/multi-account)

## Sync and messaging

- [ ] **Use `client.groups.connectAll()` to receive group traffic.** Don't write your own subscription, because `connectAll()` handles verification, deduplication and ordering. [Messages](/client/messages#receive-messages-with-connectall)
- [ ] **Make your network adapter's `request` reject on failure.** A resolved empty array is treated as "no more history", so swallowed errors silently skip messages. [Network](/client/network#the-contract)
- [ ] **Self-update after joining.** Once the group has caught up, call `group.selfUpdate()`, then rotate the key package that was used. [Invites](/client/invites#after-joining)
- [ ] **Let convergence settle.** Sends are queued while the group resolves concurrent commits. Don't retry them yourself, and use the client's commit APIs rather than editing group state, because commits are published before they are applied. [Messages](/client/messages#sends-wait-while-the-group-settles)
- [ ] **Handle fork retractions.** When a result is `invalidated`, remove that message from your UI. [Messages](/client/messages#handle-fork-retractions)
- [ ] **Leave `convergencePolicy` at its default.** Every member must use the same branch-selection rules. `maxRewindCommits: Infinity` is only for debugging. [Fork history](/client/fork-history)

## Relays

- [ ] **Choose relays deliberately.** Key packages go to your NIP-65 write relays, and Welcomes go to the invitee's kind 10050 inbox relays. Group traffic goes to the group's own relays, which should be several, for redundancy. [Key packages](/client/key-packages#publish-your-relay-lists)
- [ ] **Don't treat a relay ack as delivery.** `ok: true` only means a relay accepted the event. Check a group's `pendingWelcomes` for invites that haven't been delivered yet. [Groups](/client/groups#create-a-group-with-founding-members)

## Lifecycle

- [ ] **Clean up.** Abort watchers with `signal`, `unsubscribe()` your `connectAll()` and `listen()` handles, and unload groups when switching accounts. [UI frameworks](/client/ui-frameworks#cancel-watchers-with-signal)
- [ ] **Remove legacy groups.** A group that doesn't require the `0x8009` account identity proof reports `group.profileSupport.kind === "unsupported"`. It can't send, receive or be joined, so offer to `destroy()` it. [Groups](/client/groups#load-unload-and-destroy-groups)
