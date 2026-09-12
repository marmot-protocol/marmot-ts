---
phase: quick-260912-dph
plan: 01
subsystem: opentui
tags: [nip-05, invites, applesauce]
status: complete
completed: 2026-09-12
---

# Quick Task 260912-dph Summary

Added NIP-05 user resolution to the OpenTUI group invite flow.

## Changes

- Added `Directory.resolveNip05()` using Applesauce's `DnsIdentityLoader`.
- Preserved direct hex and npub invite input handling.
- Included NIP-05 relay hints in NIP-65 and KeyPackage discovery.
- Updated the invite prompt to advertise `name@domain` support.
- Added four Bun tests covering found, missing, failed, and malformed identifiers.

## Verification

- `pnpm test` in `examples/opentui`: 4 passed, 0 failed.
- `pnpm typecheck` in `examples/opentui`: passed.
- Focused Prettier check: passed.
- `git diff --check`: passed.
