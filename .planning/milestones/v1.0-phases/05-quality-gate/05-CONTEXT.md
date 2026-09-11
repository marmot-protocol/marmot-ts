# Phase 5: Quality Gate - Context

**Gathered:** 2026-09-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Produce authoritative release evidence that the full normal and isolated extended suites pass on Node 20/22/24, Deno 2, and Bun latest/1.1, and record reproducible byte-exact MDK cross-checks for proof v2, KeyPackage lifetime, tag cardinality, and SafeAAD. This phase fixes defects uncovered by those gates but adds no new protocol capability.

</domain>

<decisions>
## Implementation Decisions

### Runtime evidence
- **D-01:** Run both the normal and isolated extended conformance suites in every required runtime job.
- **D-02:** Local Node 22, Deno 2, and Bun latest runs are smoke evidence; authoritative missing-version evidence comes from CI jobs, never inferred from local substitutes.
- **D-03:** CI must pin pnpm 10 and preserve the frozen lockfile contract.

### Cross-reference dossiers
- **D-04:** Record separate reproducible dossiers for proof v2, KeyPackage lifetime, tag cardinality, and SafeAAD with exact repository SHAs, commands, outputs/digests, and negative controls.
- **D-05:** For tag cardinality, distinguish Rust-produced kind-30443 byte parity from specification-derived inbound rejection parity; do not claim a Rust oracle where MDK exposes none.
- **D-06:** MDK `b4649c01` changes signed MLS capability advertisements, so KeyPackage and SafeAAD evidence must be regenerated against the updated pinned reference.

### the agent's Discretion
- CI job factoring, artifact naming, and report layout, provided every required runtime/version and both suite classes are unambiguous.
- Whether runtime defects are fixed in one or several plans, with atomic regression commits.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

- `.github/workflows/test.yml` — supported runtime matrix and current CI commands.
- `refs/marmot/foundation/conformance.md` — canonical conformance evidence and snapshot contract.
- `refs/mdk/cgka-conformance-simulator/SCENARIOS.md` — reference scenario families.
- `.planning/phases/04-feature-parity-conformance-vectors/04-VERIFICATION.md` — accepted TypeScript conformance evidence baseline.
- `.planning/phases/04.1-terminal-group-disbanding/04.1-VERIFICATION.md` — terminal lifecycle evidence baseline.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Root and extended Vitest configurations already separate normal and pressure suites.
- Phase 4 proof fixtures, manifest loaders, canonical snapshots, and named vectors provide QA-02 evidence seams.
- Git `.github/workflows/test.yml` already defines most runtime jobs.

### Established Patterns
- CI pnpm is pinned to major 10 with `--frozen-lockfile`.
- Claims must cite actual command output and pinned reference commits; unavailable local versions remain not be reported as run.

### Integration Points
- Extend CI to invoke both suite configurations in each runtime/version job.
- Add stable evidence scripts/tests and reports that consume pinned Marmot/MDK fixtures refs.

</code_context>

<specifics>
## Specific Ideas

- Keep release evidence machine-checkable enough that stale SHAs or missing runtime jobs fail rather than silently aging.

</specifics>

<deferred>
## Deferred Ideas

None — this phase is strictly the milestone release gate.

</deferred>

---

*Phase: 05-quality-gate*
*Context gathered: 2026-09-06*
