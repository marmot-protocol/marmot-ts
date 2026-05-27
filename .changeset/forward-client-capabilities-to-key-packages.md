---
"@internet-privacy/marmot-ts": patch
---

Forward the `MarmotClient` `capabilities` option to `KeyPackageManager` so custom capabilities (such as adding SelfRemove proposal type `0x000A` for Amethyst interop) are reflected in generated key packages instead of being silently ignored.
