---
"@internet-privacy/marmot-ts": patch
---

The package now bundles the compiled forked ts-mls build under `dist/vendor/ts-mls`
instead of depending on a `ts-mls` package. Import MLS primitives from
`@internet-privacy/marmot-ts/mls`. The X448, ChaCha20-Poly1305, ML-KEM, X-Wing and
ML-DSA backends are now optional peer dependencies, needed only for those ciphersuites.
