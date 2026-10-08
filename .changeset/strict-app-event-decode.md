---
"@internet-privacy/marmot-ts": patch
---

Decode inner app events as strictly as MDK. `deserializeApplicationData` now rejects
payloads with a duplicate member, an uppercase `id` or `pubkey`, a `created_at` or `kind`
that is not a plain non-negative JSON integer (`1.5`, `1.0`, `1e9`, `-1`), an unpaired
surrogate in a string, invalid UTF-8, or a leading BOM. MDK already dropped all of these,
so a member could show marmot-ts users a message White Noise users never saw.
`serializeApplicationRumor` writes only the six spec members (a `sig` or other extra field
on the input is no longer sent) and throws instead of emitting a payload receivers drop.
