# Phase 5: Quality Gate - Discussion Log

> **Audit trail only.** Decisions are captured in CONTEXT.md.

**Date:** 2026-09-06
**Phase:** 05-quality-gate
**Areas discussed:** Runtime evidence scope, reference-oracle boundaries

## Runtime evidence scope

The roadmap requires the full supported runtime matrix. Both normal and isolated extended suites will execute in every job; locally unavailable versions require CI evidence.

## Reference-oracle boundaries

Tag-cardinality reporting will separate Rust-produced byte parity from specification-derived rejection parity because MDK does not expose a general inbound cardinality oracle.

## the agent's Discretion

CI factoring, evidence artifact naming, and plan decomposition.

## Deferred Ideas

None.
