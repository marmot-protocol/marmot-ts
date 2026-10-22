# MDK and White Noise compatibility review

Reviewed on October 22, 2026 against marmot-ts's `v0.8` branch (package version
`0.7.0` plus unreleased changes). Basic MLS Welcome exchange works after the
join-validation fixes in this change. **Current White Noise media-enabled groups
remain incompatible:** marmot-ts lacks encrypted-media v2 (`0x800b`). A successful
TypeScript test suite does not establish full White Noise interoperability.

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

Each passing cell includes Rust KeyPackage acceptance, NIP-59 decryption and
validated MLS Welcome joins in **both directions**, using the local probe.

| MDK target                | Base engine (no self-remove registration) | Simple group with self-remove | Group requiring media v2 |
| ------------------------- | ----------------------------------------- | ----------------------------- | ------------------------ |
| Latest `c2284b31`         | Pass                                      | Pass                          | Fails: missing `0x800b`  |
| Stable `v0.13.0`          | Pass                                      | Pass                          | Fails: missing `0x800b`  |
| Android-pinned `8c214fee` | Pass                                      | Pass                          | Fails: missing `0x800b`  |

All nine profiles were executed; the three media failures are reproduced
compatibility defects, not skipped tests or successes. These are engine/SDK
results, not tests of the Android UI or full MDK application profile.

## Findings

### Blocking: encrypted-media v2 is missing

Current MDK app groups use `marmot.group.encrypted-media.v2`, component `0x800b`.
The library's `SUPPORTED_APP_COMPONENT_IDS` advertises the frozen v1 component
`0x8008` and omits `0x800b`. An MDK group requiring v2 rejects the TypeScript
KeyPackage with `MissingRequiredCapabilities` before creating a Welcome. The
Rust-backed media profile reproduces this rejection. Advertising `0x8008` does
not satisfy a requirement for `0x800b`.

In the opposite direction, a TypeScript leaf cannot join a group requiring
`0x800b`; `validateWelcomeGroup` rejects unsupported required components. Adding
only a transport tag or capability advertisement would claim support without
implementing its state validation and media semantics. Full compatibility needs
v2 policy codecs, capability/metadata handling, group-state validation and the
corresponding media behavior. Existing groups' required components select the
version; v1 state cannot be silently relabelled as v2.

Sources: MDK `crates/marmot-app/src/lib.rs` (`supported_app_component_ids`),
`crates/marmot-app/src/client/projection.rs`, and
[`app-components/group-encrypted-media-v2.md`](https://github.com/marmot-protocol/marmot/blob/d181ce1c4661ca985e8fb12a48a962dbe76fec6c/app-components/group-encrypted-media-v2.md).

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
pinned rust-nostr dependency. The `media` profile intentionally reports the
remaining incompatibility as a nonzero exit.

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
revision. The media command is expected to exit 1 until v2 is implemented.
See `scripts/mdk-interop/README.md` for dependencies and exact coverage.

The local TypeScript suite covers invitation state management, persistence,
mock-network delivery, conformance scenarios and group messaging. The Rust probe
covers real KeyPackage, Welcome and NIP-59 exchange. Neither is an Android device
test or a live-relay delivery test. It does not certify cross-language message
exchange, recovery, forks, media or every optional MDK component. Matching the
installed Android version and examining its actual error remains necessary to
attribute a particular failed invitation.

## Validation recorded for this review

- `pnpm check`: passed formatting, test types, all **2,315 tests in 146 files**, and the library/fork build.
- `pnpm docs:build`: passed the documentation and API-reference builds.
- Rust probe: all nine matrix profiles executed, with six successful bidirectional exchanges and three reproduced media-v2 capability rejections.
- The first full check, while Rust dependencies compiled concurrently, timed out in one removal-recovery test. That file passed on its focused retry, and the final full check passed after the Rust builds finished.

The fixes and probe are local repository changes; this review does not publish a new package release or change the Android app.
