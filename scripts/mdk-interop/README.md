# MDK Welcome and media interoperability probe

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
groups do. It exercises the public TypeScript transfer APIs, real MLS messages,
and MDK's actual media upload/download functions against a local HTTP Blossom
fixture. All profiles should exit zero.

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
uses subprocess pipes plus loopback HTTP for blobs. The engine uses a raw
transport peeler; the TypeScript client wraps/ingests locally constructed Nostr
group events. NIP-59 uses pinned rust-nostr routines. The media profile also
tests an MDK Commit during upload, a delayed attachment after epoch advancement,
and a caption with one missing and one valid sibling.

MDK's media transfer functions are crate-private. The media profile creates a
disposable detached worktree and appends `media-bridge.rs` to expose those actual
implementations without changing their algorithms. Older pins use
`upload_encrypted_media_retaining`; newer pins use `upload_encrypted_media`.
The script removes its worktree when it exits, including on build failure.
This does not run the full MDK app runtime, relay routing, inbox discovery,
Android UI or general cross-language recovery/forks.

To regenerate the immutable TypeScript crypto/policy fixture through the actual
MDK uploader (a fresh random nonce changes the fixture):

```sh
MDK_PROFILE=media MDK_WRITE_FIXTURES=1 node scripts/mdk-interop/run.mjs
```

Its exporter is fixed disposable test material, unrelated to the runtime MLS
exporters. Runtime exporter material is never sent across the probe pipes or
logged.
