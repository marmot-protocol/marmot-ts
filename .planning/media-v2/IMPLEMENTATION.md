# Media v2 implementation evidence

Date: 2026-10-22. Branch: feat/media-v2, based on v0.8.
The reference fetches at phase start found no new default-branch commits.
Implementation commit: dbfb62b8.

## Delivered

- Distinct canonical v2 policy codec and 0x800b registry/dictionary/view support.
- V2 defaults, explicit frozen v1 helpers, explicit history version dispatch.
- Exact MIME/filename validation, exporter/HKDF/AAD/nonce/integrity rules.
- Guarded application intents with exact source-state identity, including
  same-epoch forks and queued admission; optional caller cancellation.
- Exact-source receive decryption, bounded existing retained canonical states
  and durable delivery provenance; cache entries cannot bypass validation.
- Media group creation, authorized atomic policy activation/replacement/removal,
  known optional policy validation and resulting-member support checks.
- Injectable multi-attachment transfer, bounded authenticated Blossom HTTP,
  contact-time permission, ordered fallback, corrupt-blob retry and local errors.
- Signed KeyPackage media capability support and publication refresh without
  deleting pending-Welcome private material or replacing installation identity.
- Publication app_components tags selected from the actual signed leaf.
- Existing OpenTUI attachment path and policy label migrated.
- Migration guide, sidebar, changelog and compatibility report updated.

## Independent MDK evidence

All three revisions pass the extended media probe:
- latest c2284b314736562bbeb7f2bcb63256a0dd1cc9e0
- stable v0.13.0 / 891ab34980ee9dc2ef45bf690733a6e31d3e6778
- Android source pin 8c214fee07466b0b7b63f8dfa39877cce1f63573

Each includes both Welcome directions and media-bearing real MLS messages/blob
decryption through the public TypeScript transfer APIs and actual MDK media
code. Additional cases: real MDK Commit during upload rejects stale TS
preparation; delayed Rust media after epoch advance; real MDK download keeps
caption/valid sibling when a blob is unavailable.

The Rust source fixture was generated through actual MDK upload with a fixed
public disposable exporter; its ciphertext and policy bytes pass TS tests.

## Implementation choices and limits

MDK transfer routines are crate-private. Rather than inventing another Rust
crypto implementation or building a full relay-driven AppClient fixture, the
probe appends a small test-only bridge in a disposable MDK worktree. Latest
calls upstream upload_encrypted_media; older pins call the production
upload_encrypted_media_retaining routine. Download and parse are upstream code.
The bridge does not alter their algorithms. Rust engine transport stays raw;
TypeScript wraps/ingests local Nostr events and the blobs use loopback HTTP.
This tests engine plus media implementation, not Android UI/full app runtime.

Media exporter retention reuses the existing bounded canonical rollback window
and its durable tree, instead of introducing a second secret retention authority.
The public registry restores that index on restart. Custom plaintext stores
remain application-owned; v2 decrypt does not trust old hash-only entries.
Missing source material makes media unavailable.

No general legacy-profile migration is added: current-profile admission already
rejects frozen 0x8008 state, so unsupported parents still require recreation.

These are focused implementation records, not GSD plan-checker certification.

## Repository validation

- pnpm check: passed formatting, types, 2,359 tests in 152 files, MLS fork
  compilation, package compilation and vendoring.
- pnpm docs:build: passed VitePress and API reference generation, no warnings.
- pnpm --dir examples/opentui typecheck: passed.
- rustfmt +1.97.1 --edition 2024 --check on both probe Rust sources: passed.
- git diff --check: passed.
- Refreshed all six base/simple Welcome profiles after implementation: passed.
- Extended media profile on all three pins: passed.
- Local logs: /tmp/media-v2-complete-check.log,
  /tmp/media-v2-complete-docs.log, /tmp/media-v2-complete-opentui.log,
  /tmp/media-v2-rust-extended-{latest,stable2,android}.log and
  /tmp/media-v2-final-{latest,stable,android}-{base,app}.log.

The user explicitly requested merging into v0.8 after completion. The source
feature and these focused planning/evidence records are committed separately,
then fast-forwarded into that working branch. Nothing is pushed or published.
