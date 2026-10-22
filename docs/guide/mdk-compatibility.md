# MDK and White Noise compatibility review

Reviewed on October 22, 2026 against marmot-ts's `v0.8` work (package version
`0.7.0` plus unreleased changes). Media v2 groups now pass actual bidirectional
MLS Welcome, application-message and attachment decryption checks against the
three MDK revisions below. This is local Rust/TypeScript interoperability evidence;
Android UI and live-relay delivery remain separate tests.

## Reference versions

| Target                         | Revision                                              | Meaning                                                                           |
| ------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| Latest MDK default branch      | `c2284b314736562bbeb7f2bcb63256a0dd1cc9e0`            | October 22; workspace `0.14.0-dev`                                                |
| Latest stable MDK              | `v0.13.0`, `891ab34980ee9dc2ef45bf690733a6e31d3e6778` | October 12 release                                                                |
| White Noise Android source pin | `8c214fee07466b0b7b63f8dfa39877cce1f63573`            | MarmotKit `0.14.0-nightly.20261021`                                               |
| Marmot specification           | `d181ce1c4661ca985e8fb12a48a962dbe76fec6c`            | Both reference submodules already matched `origin/HEAD`; no pointer update needed |

The Android pin comes from
[`MARMOT_VERSION`](https://github.com/marmot-protocol/whitenoise-android/blob/9f39a21709c9ec20ff3f4d2c12e8398b88ec91ce/app/src/main/marmotkit/MARMOT_VERSION).
It identifies the app source reviewed, not the user's installed APK. An installed
release may embed a different MDK revision.

## Executed compatibility matrix

Each media passing cell includes KeyPackage acceptance, NIP-59 decryption,
validated Welcomes and media-bearing MLS messages with attachment decryption in
**both directions**. A local HTTP Blossom fixture carries the encrypted blobs.

| MDK target                | Base engine | Simple group with self-remove | Required media v2 group |
| ------------------------- | ----------- | ----------------------------- | ----------------------- |
| Latest `c2284b31`         | Pass        | Pass                          | Pass                    |
| Stable `v0.13.0`          | Pass        | Pass                          | Pass                    |
| Android-pinned `8c214fee` | Pass        | Pass                          | Pass                    |

The extended media probe also passed on all three revisions: a real MDK Commit
during a TypeScript upload invalidates preparation; a delayed MDK attachment
decrypts after an epoch advance; and actual MDK parsing/download preserves a
caption and valid sibling when another attachment's blob is unavailable.

The base/simple rows cover Welcome exchange; their scope is narrower than the
media rows. These are engine/SDK results, not Android-device or full app-runtime
certification.

## Findings

### Fixed: encrypted-media v2 negotiation and attachment exchange

The earlier review reproduced `MissingRequiredCapabilities` because the library
implemented frozen v1 `0x8008` while current MDK groups require v2 `0x800b`.
The implementation now includes the distinct v2 policy codec, complete-state
validation, signed capability advertisement, strict reference fields, v2
exporter/HKDF/AAD contexts, source-bound sending and receiving, and an injectable
bounded transfer path. Frozen v1 remains available only through explicit helpers
for historical data. See [the media guide](../core/media.md) for API migration.

Media source identities include branch state as well as epoch. An attachment
prepared before a Commit cannot be silently published under the new state.
Delayed incoming delivery evidence records the authenticated source epoch, so it
can be persisted and resolved after restart. Metadata or ciphertext changes
cannot bypass validation through plaintext cache hits.

KeyPackage publication tags now reflect the supplied signed LeafNode rather than
the running library's global capabilities. Startup `ensurePublished()` refreshes
packages missing v2 while preserving pending-Welcome private material.

Sources: MDK `crates/marmot-app/src/media/`, `crates/cgka-engine/src/app_payload.rs`,
`crates/nostr-directory/src/published_records.rs` (older pins:
`crates/marmot-app/src/key_package_records.rs`), and
[the v2 policy specification](https://github.com/marmot-protocol/marmot/blob/d181ce1c4661ca985e8fb12a48a962dbe76fec6c/app-components/group-encrypted-media-v2.md).

### Fixed: Welcome admission confused creation defaults with protocol requirements

Previously, `validateWelcomeGroup` required all TypeScript creation defaults,
including group profile (`0x8001`), lifecycle (`0x800c`) and the MLS self-remove
proposal (`0x000a`). The MDK base engine produces a valid current-profile Welcome
requiring only `app_data_update` (`0x0008`), and TypeScript rejected it with
`Welcome lacks mandatory MLS required capabilities`. This was reproduced with
actual Rust-generated Welcome bytes before the fix.

Join admission now validates the shared complete-state protocol invariants,
requires admin-policy and account-proof requirements, and checks support for
what the group actually declares. New-group defaults remain unchanged.
Authenticated groups predating lifecycle-v1 may omit it and remain usable;
required-but-missing lifecycle state and disbanded Welcomes remain rejected.
Regression tests generate signed MLS Welcomes for these cases.

Sources: MDK `crates/cgka-engine/src/app_components.rs`
(`CURRENT_PROFILE_REQUIRED_*`), `crates/cgka-engine/src/capabilities.rs`,
[`app-components/group-lifecycle-v1.md`](https://github.com/marmot-protocol/marmot/blob/d181ce1c4661ca985e8fb12a48a962dbe76fec6c/app-components/group-lifecycle-v1.md).

### Coverage gap: the previous compatibility test never ran MDK

`darkmatter-invite-compat.test.ts` checks a hard-coded historical capability list
against TypeScript's own output. It included v1 media and described that list as
current MDK defaults. Its passing result therefore concealed the v2 gap. Its
scope is now labelled accurately. Imported MDK conformance scenarios also run
TypeScript actors; those do not prove a Rust peer accepts the same wire bytes.

The new `scripts/mdk-interop/run.mjs` compiles a real MDK engine, exchanges fresh
KeyPackages and Welcomes in both directions, and exercises NIP-59 with MDK's
pinned rust-nostr dependency. The `media` profile additionally runs the public
TypeScript client transfer path against unchanged MDK media upload/download code.
A test-only bridge in a disposable MDK worktree exposes its crate-private
routines. Stable/Android pins use their production retaining-upload routine;
latest uses its production upload routine. No crypto implementation is mirrored.
The pinned ciphertext fixture in `src/__tests__/fixtures/media-v2-rust.json`
was generated by the actual latest-MDK uploader with a fixed disposable exporter;
ordinary tests verify its policy bytes and decrypt its ciphertext.

### Existing legacy groups remain outside the current join profile

The library deliberately rejects groups without the current `0x8009` account
identity proof requirement and groups requiring the legacy `0xf2f1` extension.
MDK retaining access to an old conversation therefore does not imply that a
marmot-ts user can join it. The lifecycle absence fixed here is separate from
that account-proof profile cutover. See [Best Practices](../client/best-practices.md).

### Transport findings and limits

Both implementations use a full MLSMessage Welcome inside standard base64 in a
kind-444 rumor, with `e` identifying the consumed KeyPackage event and `relays`
identifying group relays, wrapped in NIP-59 kind 1059. The TypeScript delivery
adapter resolves the recipient's kind-10050 inbox relays. The receiving app must
subscribe to those relays for kind 1059 addressed to its account; group-relay
subscriptions alone do not receive inbox delivery.

A relay acknowledgement records accepted publication, not invite receipt or
successful join. In `NostrWelcomeDelivery`, an inbox lookup that throws falls
back to group relays, while a lookup resolving to an empty list fails delivery.
A fallback relay acknowledgement can therefore leave an invite undelivered to a
recipient listening only to its inbox. This is a source-inspected delivery risk,
not a reproduction of the user's Android failure. Pending Welcome outcomes
must be inspected separately from group commit success.

MDK's Welcome peeler also limits relay count to 16 and each URL to 512 bytes,
and validates ws/wss URLs. TypeScript's Welcome creator checks nonempty,
distinct strings without those MDK bounds. Malformed or oversized relay lists
can therefore be emitted by TypeScript and rejected by MDK. Ordinary canonical
wss relay URLs used by the probe do not exercise this difference.

Sources: `src/client/transport/nostr/welcome-delivery.ts`,
`src/client/invite-manager.ts`, MDK
`crates/transport-nostr-peeler/src/peeler.rs`,
[`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/d181ce1c4661ca985e8fb12a48a962dbe76fec6c/transports/nostr.md).

## Reproduce and interpret results

```sh
pnpm build
node scripts/mdk-interop/run.mjs
MDK_PROFILE=base node scripts/mdk-interop/run.mjs
MDK_PROFILE=media node scripts/mdk-interop/run.mjs
```

Use `MDK_ROOT=/absolute/path/to/checkout` to test stable or the Android-pinned
revision. All profiles are expected to exit zero.
See `scripts/mdk-interop/README.md` for dependencies and exact coverage.

The local TypeScript suite covers invitation state management, persistence,
mock-network delivery, conformance scenarios and group messaging. The Rust probe
covers real KeyPackage, Welcome and NIP-59 exchange, plus media-bearing messages
and blobs in the media profile. Neither is an Android device test or a live-relay
delivery test. They do not certify every optional MDK component or general
cross-language fork/recovery behavior. Matching the
installed Android version and examining its actual error remains necessary to
attribute a particular failed invitation.

## Validation recorded for this implementation

- All three Rust media profiles pass the extended bidirectional checks above.
- TypeScript tests cover strict metadata, policy canonicalization, v1 history,
  source-state races, bounded transport, invalid cache metadata, policy removal,
  delayed inbound media across durable restart and KeyPackage refresh.
- `pnpm check` passed formatting, test types, **2,359 tests across 152 files**,
  and the package/MLS-fork build.
- `pnpm docs:build` passed VitePress and API-reference generation without warnings.
- `pnpm --dir examples/opentui typecheck` passed.
- All six plain-group base/simple Welcome probes were refreshed after implementation;
  all three extended media probes passed as described above.

No package release or Android application change is published by these local checks.
