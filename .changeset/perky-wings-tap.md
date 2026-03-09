---
"@internet-privacy/marmot-ts": minor
---

Add addressable key package events (kind 30443): `createKeyPackageEvent` now publishes kind 30443 with a `d` slot tag; `KeyPackageManager` gains a `clientId` constructor option and `MarmotClient` gains a `clientId` option; `create()` resolves the slot identifier from options, then `clientId`, then throws `MissingSlotIdentifierError`; `rotate()` reuses the stored slot for automatic relay replacement; `getKeyPackageD` helper exported; `d` field added to `LocalKeyPackage`, `TrackedKeyPackage`, and `ListedKeyPackage` types
