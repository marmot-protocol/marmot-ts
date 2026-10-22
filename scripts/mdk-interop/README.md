# MDK Welcome interoperability probe

Build the TypeScript library first, then exchange real MLS KeyPackages and
Welcomes with the Rust MDK engine and NIP-59 wraps with its pinned rust-nostr:

```sh
pnpm build
node scripts/mdk-interop/run.mjs
MDK_PROFILE=base node scripts/mdk-interop/run.mjs
MDK_PROFILE=media node scripts/mdk-interop/run.mjs
```

`app` (default) registers self-remove and supports profile, admin-policy and
lifecycle state. `base` uses the engine's protocol baseline without the optional
self-remove registration. Neither profile claims to reproduce the full MDK app.
`media` additionally requires encrypted-media v2 (`0x800b`), as current MDK app
groups do. This currently exits **1** with `MissingRequiredCapabilities`:
marmot-ts does not advertise or implement this component. This failure is an
interoperability finding, not a passing test.

To test another checked-out MDK revision without changing reference pointers:

```sh
MDK_ROOT=/absolute/path/to/mdk node scripts/mdk-interop/run.mjs
MDK_ROOT=/absolute/path/to/mdk MDK_PROFILE=media node scripts/mdk-interop/run.mjs
```

The script reads that checkout's toolchain, local crates, rust-nostr pin,
dependency lockfile and patches. Cargo must be installed and able to download
dependencies. Sources/manifests are generated in a temporary directory; build
artifacts are cached in `/tmp/marmot-ts-mdk-probe-target` by default, or
`CARGO_TARGET_DIR`. Run probes sequentially when sharing the target directory.
Test identities are fixed, public, disposable fixture keys. Never use them for
real accounts.

Coverage: MDK accepts the TypeScript KeyPackage, emits a Welcome, TypeScript
unwraps it and validates the resulting group; TypeScript accepts the MDK
KeyPackage, emits a Welcome, Rust unwraps it and MDK joins it. All communication
is local over subprocess pipes. The engine uses a raw transport peeler;
NIP-59 uses the same pinned rust-nostr routines used by MDK, rather than running
the full MDK Nostr peeler or app runtime. No relays, Android UI, inbox discovery,
message exchange, concurrent-commit recovery or restart delivery are tested by
this probe.
