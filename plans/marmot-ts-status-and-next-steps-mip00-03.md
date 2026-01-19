# Marmot-ts status and next steps (focus: MIP-00..03)

This document summarizes:

1. current functional state of the `marmot-ts` implementation
2. gaps blocking completion of the MIP-00..03 “core functionality” slice
3. a concrete end-to-end scenario to implement next (invite/join/welcome/first message)
4. protocol/spec nuances and current limitations that matter for implementation decisions

Last updated: 2026-01-05

---

## Scope

Protocol scope: MIP-00..03 only.

- MIP-00: Credentials + KeyPackages (kind: 443)
- MIP-01: Group construction + Marmot Group Data Extension (0xF2EE)
- MIP-02: Welcome events (kind: 444) delivered via NIP-59 gift wrap
- MIP-03: Group events (kind: 445) for proposals/commits/application messages, double-encrypted (MLS + NIP-44)

Not in scope: MIP-04 encrypted media.

---

## Current state (what works today)

### 1) Core protocol primitives are implemented

#### Marmot Group Data extension (MIP-01)

- TLS-style encoding/decoding is implemented in [`src/core/marmot-group-data.ts`](../src/core/marmot-group-data.ts).
- Current implementation encodes image fields as variable-length (length-prefixed) values. This differs from the latest MIP-01 text which describes fixed-length fields for the image parts. See “Spec nuances / mismatches” below.

#### Group Event encryption/decryption (MIP-03)

- Group events are constructed in [`createGroupEvent()`](../src/core/group-message.ts:138):
  - MLS message is serialized (`encodeMlsMessage`)
  - NIP-44 is applied using a key derived from the MLS exporter secret for the _current epoch_
  - event is published signed by a fresh ephemeral keypair
  - group routing uses tag `h=<nostr_group_id>`.

- Group event decryption is implemented in [`decryptGroupMessageEvent()`](../src/core/group-message.ts:53).

This matches the intended MIP-03 “double encryption” model (MLS for content security + NIP-44 for transport-layer confidentiality / metadata hardening).

#### KeyPackage support (MIP-00)

- KeyPackage generation + event creation is implemented in [`src/core/key-package.ts`](../src/core/key-package.ts).
- Event creation enforces that the MLS BasicCredential identity matches the Nostr event pubkey:
  - see the check in [`createKeyPackageEvent()`](../src/core/key-package.ts:190).

Encoding migration support is present:

- Reads support “hex default” for backward compatibility.
- Writes use base64 with an explicit `encoding` tag.

#### Welcome support (MIP-02)

- Welcome rumor (kind 444) creation and decoding are implemented in [`src/core/welcome.ts`](../src/core/welcome.ts).
- The rumor includes `relays` and `encoding` tags, and optionally an `e` tag (keypackage event id) if known.

Note: MIP-02 requires the Welcome event to be gift-wrapped (NIP-59) and unsigned inside the wrapper chain. The current library creates the rumor; gift-wrap is done via `createGiftWrap()` used in group commit flow.

---

### 2) Group state wrapper exists and is functional

[`MarmotGroup`](../src/client/group/marmot-group.ts:77) provides a useful “application-level group API” over `ts-mls`:

#### Sending

- Proposals: [`MarmotGroup.propose()`](../src/client/group/marmot-group.ts:174) and [`sendProposal()`](../src/client/group/marmot-group.ts:218).
- Application rumors: [`sendApplicationRumor()`](../src/client/group/marmot-group.ts:253) creates an MLS application message and publishes a kind 445.

Key detail: application sends update the state after publish to maintain forward secrecy semantics.

#### Ingestion pipeline

[`MarmotGroup.ingest()`](../src/client/group/marmot-group.ts:443) is the most mature part:

- decrypts NIP-44 to MLSMessage
- processes non-commit messages first (proposals + application messages)
- sorts commits per MIP-03 (epoch, then `created_at`, then lexicographic `id`)
- processes commits sequentially
- retries unreadables recursively (bounded by max retries)
- persists state to the store

This aligns well with the correctness requirements of MIP-03 commit race handling.

The commit race behavior is validated by tests in [`src/__tests__/ingest-commit-race.test.ts`](../src/__tests__/ingest-commit-race.test.ts).

---

### 3) Client wrapper exists (partial)

[`MarmotClient`](../src/client/marmot-client.ts:39) currently covers:

- create group (simple local creation + store persist) via [`MarmotClient.createGroup()`](../src/client/marmot-client.ts:122)
- get group by id (loads state + resolves ciphersuite implementation) via [`MarmotClient.getGroup()`](../src/client/marmot-client.ts:78)

What it does **not** yet cover:

- publishing KeyPackages / managing KeyPackage lifecycle
- processing giftwrapped Welcome messages into a new group state
- orchestrating relay subscriptions and ingestion loops

---

### 4) Example app wiring exists (but not full flow)

There’s an examples React app with a Nostr pool adapter to `NostrNetworkInterface`:

- [`examples/src/lib/marmot-client.ts`](../examples/src/lib/marmot-client.ts)

This is a good place to implement a “real scenario” once the missing glue APIs exist.

---

## Gaps (what blocks end-to-end core functionality)

### Gap A — Determine invited user(s) for Welcome

The largest blocker is in [`MarmotGroup.commit()`](../src/client/group/marmot-group.ts:308):

- `ts-mls createCommit()` returns `{ commit, newState, welcome }`.
- If `welcome` exists, the code intends to send it via NIP-59 to newly added users.
- But it currently cannot determine who those users are:
  - `const users: string[] = [];` with comment “How do we know what nostr users added?”

To send a compliant Welcome per MIP-02 you need at minimum:

- invitee Nostr pubkey(s)
- group relays list (`relays` tag inside kind 444)
- the KeyPackage event id used for that add (`e` tag) — optional in code but strongly desired for correctness and KeyPackage lifecycle management.

**Plan decision (approved by you):**

> Require inviting by KeyPackage _event_ (kind 443), not raw KeyPackage.

This makes it possible to know:

- invitee pubkey: event author pubkey
- keyPackageEventId: event id
- (optional) advertised relays where KeyPackage was published

This is also “protocol natural”, because Marmot uses Nostr events as distribution artifacts.

---

### Gap B — Welcome join path not implemented as a first-class API

You have `getWelcome(event)` but not a higher-level join path that:

- takes (Welcome rumor or decoded Welcome)
- finds/selects the matching local KeyPackage private material
- calls `ts-mls joinGroup()`
- persists the resulting `ClientState`
- returns a `MarmotGroup` instance ready to ingest group events

Without this, even if Welcomes are delivered correctly, new users cannot easily “join a group” with Marmot-ts.

---

### Gap C — Admin verification on commit ingest

MIP-03 requires receivers to verify “Commit sender MUST be an admin” as defined by the group’s Marmot Group Data extension (`admin_pubkeys`).

Currently:

- `commit()` enforces admin for _sending_.
- `ingest()` does not enforce admin for _receiving_.

This is both a security and correctness requirement.

Implementation nuance: commit events are published by ephemeral pubkeys; admin identity is not visible at the Nostr event layer. Admin verification must happen using the _MLS authenticated identity_ inside the decrypted MLS message.

---

### Gap D — End-to-end relay orchestration

Even with the above, you still need a clear orchestration model for:

- where KeyPackages are published and discovered
- how group members subscribe to group events (kinds + tags)
- how Welcomes are delivered to users (inbox relays)

The repo already has a `NostrNetworkInterface` and example wiring, but no “happy path” scenario that uses it all.

---

## Proposed next milestone: a real end-to-end scenario

### MVP scenario definition

This is the scenario to implement next, end-to-end, on real relays:

1. **Invitee publishes KeyPackage event** (kind 443).
   - Stored somewhere the inviter can query.

2. **Admin creates group** locally.
   - Use [`MarmotClient.createGroup()`](../src/client/marmot-client.ts:122).
   - The group has Marmot Group Data extension with `nostr_group_id` + relays + admin list.

3. **Admin invites invitee**.
   - Admin obtains invitee’s KeyPackage event (kind 443).
   - Build an Add proposal using [`proposeInviteUser()`](../src/client/group/proposals/invite-user.ts:8).
   - Create commit via [`MarmotGroup.commit()`](../src/client/group/marmot-group.ts:308) or a refined invite/commit API.

4. **Admin publishes the Commit group event** (kind 445) and waits for at least one relay ack.
   - This ordering is mandatory per MIP-02.

5. **Admin sends Welcome**.
   - Create kind 444 rumor via [`createWelcomeRumor()`](../src/core/welcome.ts:22) including:
     - `relays` (group relays)
     - `encoding base64`
     - `e <keyPackageEventId>`
   - Gift-wrap (NIP-59) and publish to invitee’s inbox relays obtained from `getUserInboxRelays(pubkey)`.

6. **Invitee receives Welcome and joins group**.
   - App unwraps NIP-59 and passes the inner rumor to Marmot-ts.
   - Marmot-ts decodes it via [`getWelcome()`](../src/core/welcome.ts:67).
   - Marmot-ts joins via `ts-mls joinGroup()` and persists state.

7. **Invitee subscribes to group events and ingests**.
   - Subscribe to kind 445, tag `h=<nostr_group_id>`.
   - Process backlog + stream through [`MarmotGroup.ingest()`](../src/client/group/marmot-group.ts:443).

8. **First message**.
   - Invitee sends a chat rumor through [`sendApplicationRumor()`](../src/client/group/marmot-group.ts:253).

### Minimal acceptance criteria

- The invitee joins successfully from a Welcome received via NIP-59.
- Both parties converge on the same group epoch after commit processing.
- An application message sent by the invitee is decrypted and yields a Rumor on the admin side.

---

## The nuance: “How do we know what Nostr users were added?”

This is a real design issue at the Marmot-ts library boundary.

### Why it’s hard

- The Nostr event pubkey for kind 445 is _ephemeral_ and not correlated with the admin.
- The MLS commit can include multiple Adds (and other proposals).
- `ts-mls createCommit()` returns a single Welcome object (or nullable), but the library needs to determine the recipient(s).

### Viable approaches

#### Approach 1 (recommended for MVP): invitation is explicit and keyed by KeyPackage event

Require the invite API to take a KeyPackage event (kind 443). That gives:

- recipient pubkey
- keyPackageEventId

Then the commit function can send Welcomes based on the “invite intent” it was given, without needing to extract recipients from the commit.

This is pragmatic and keeps the “who do we welcome?” decision at the application layer.

#### Approach 2: derive invitees by inspecting the resulting state

After committing, compare member lists between previous and new group states, find new members, and map their MLS credential identity to Nostr pubkeys.

This requires:

- a stable way to enumerate members and their credential identities
- a way to distinguish “newly added” vs “existing” in a consistent manner
- careful handling for multiple devices per user (each device is a distinct MLS leaf)

This is doable but likely more code + more MLS structural familiarity.

#### Approach 3: parse Add proposals directly

If you have Add proposals (or their refs resolved), you can parse the KeyPackage inside each Add, extract the BasicCredential identity (nostr pubkey bytes), and map to the recipient.

This is also doable, but note:

- you may not know the KeyPackage _event id_ used
- if you accept Add proposals not based on Nostr KeyPackage events, you lose the ability to include the `e` tag required by MIP-02

### Outcome

For MVP, Approach 1 is the simplest and most spec-aligned: invitation requires the KeyPackage event.

---

## Spec nuances / current limitations

### 1) MIP-01 image fields serialization mismatch

MIP-01 (as provided) defines image fields as fixed-size:

- `image_hash[32]`
- `image_key[32]`
- `image_nonce[12]`

But current code in [`encodeMarmotGroupData()`](../src/core/marmot-group-data.ts:31) uses variable-length encoding (2-byte length prefix + 0 or N bytes).

Implication:

- Interop risk with other implementations that follow the fixed-size format.
- For MIP-00..03 MVP, this does not block invite/join, but it is a correctness issue for MIP-01 compatibility.

Recommendation:

- Align encoding to the spec version you want to target, or explicitly declare the “wire format version” for Marmot Group Data and handle multiple versions.

### 2) Welcome size limits for large groups

MIP-02 notes that Welcome objects get large as group size grows.

Implication:

- MVP should focus on small groups.
- Example scenario should use small group sizes (2–3 members).

### 3) Commit/Welcome ordering is mandatory

MIP-02 requires sending Welcome only after Commit is confirmed by relays.

Current code:

- `commit()` already waits for ack on publishing commit before sending welcomes.
  - see `hasAck` check in [`MarmotGroup.commit()`](../src/client/group/marmot-group.ts:384).

But the system still needs proper recipient resolution.

### 4) Inner events MUST remain unsigned

MIP-03 requires inner application rumors to be unsigned.

Current code:

- [`serializeApplicationRumor()`](../src/core/group-message.ts:192) strips `sig` if present.

Recommendation:

- Additionally reject (or warn) if the caller provided a `sig` rather than silently stripping, depending on how strict you want the library.

---

## Implementation plan (next steps)

This is the concrete plan to proceed with your chosen direction (end-to-end scenario, invites must use KeyPackage events).

### 1) Define a new invite flow API that is event-based

Goal: make invite intent explicit so Welcome recipients are known.

Potential new method shape:

- `MarmotGroup.inviteByKeyPackageEvent(keyPackageEvent: NostrEvent)`
  - validates event kind 443
  - validates credential identity matches event pubkey
  - builds Add proposal
  - commits
  - after commit ack, sends welcome to `event.pubkey` with `e=event.id`

### 2) Add a “join from welcome” API

Goal: make it easy for apps to take an unwrapped kind 444 rumor and join.

- `MarmotClient.joinGroupFromWelcome({ welcomeRumor, keyPackagePrivateStore })` (exact shape TBD)
  - decode welcome
  - find appropriate local KeyPackage private package
  - call `ts-mls joinGroup()`
  - persist group state
  - return `MarmotGroup`

### 3) Enforce admin verification during ingest

Goal: implement MIP-03 rule “only commits from admins are accepted”.

Implementation likely requires:

- extracting the MLS sender credential identity from the commit message
- mapping that to a Nostr pubkey
- checking membership in Marmot Group Data `adminPubkeys`
- rejecting (or ignoring) commits that fail this check

### 4) Implement an example scenario in `examples/`

Goal: show the whole flow on real relays.

- two accounts (admin + invitee)
- publish invitee keypackage event
- admin creates group and invites
- invitee receives welcome
- invitee joins and subscribes
- invitee sends first chat

---

## Current limitations summary

- The ingestion pipeline for group events is solid.
- The system lacks the “glue” APIs for:
  - mapping invite → welcome recipient
  - joining from welcome
  - enforcing admin verification on commit ingest
- Marmot Group Data extension serialization likely needs alignment with the latest spec version for interop.
