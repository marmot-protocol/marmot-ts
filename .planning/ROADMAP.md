# Roadmap: marmot-ts

## Milestones

- ✅ **v1.0 Catchup** — Phases 1–5, incl. 03.1 and 04.1 (shipped 2026-09-11) — [archive](milestones/v1.0-ROADMAP.md)
- 📋 **Next milestone** — not yet planned (`/gsd-new-milestone`)

## Phases

<details>
<summary>✅ v1.0 Catchup (Phases 1–5) — SHIPPED 2026-09-11</summary>

Resync to the post-split marmot spec + MDK Rust reference. Full details:
`milestones/v1.0-ROADMAP.md`, `milestones/v1.0-REQUIREMENTS.md`, phase artifacts in
`milestones/v1.0-phases/`.

- [x] Phase 1: Proof v2 (2/2 plans) — completed 2026-07-21
- [x] Phase 2: Inbound Trust & Wire Boundary (4/4 plans) — completed 2026-07-22
- [x] Phase 3: Commit Integrity & Convergence Parity (11/11 plans) — completed 2026-09-01
- [x] Phase 03.1: Phase 3 Review Closure (INSERTED) (15/15 plans) — completed 2026-09-02
- [x] Phase 4: Feature Parity & Conformance Vectors (7/7 plans) — completed 2026-09-05
- [x] Phase 04.1: Terminal Group Disbanding (INSERTED) (6/6 plans) — completed 2026-09-06
- [x] Phase 5: Quality Gate (8/8 plans) — completed 2026-09-06

</details>

## Progress

| Phase                                    | Milestone | Plans Complete | Status   | Completed  |
| ---------------------------------------- | --------- | -------------- | -------- | ---------- |
| 1. Proof v2                              | v1.0      | 2/2            | Complete | 2026-07-21 |
| 2. Inbound Trust & Wire Boundary         | v1.0      | 4/4            | Complete | 2026-07-22 |
| 3. Commit Integrity & Convergence Parity | v1.0      | 11/11          | Complete | 2026-09-01 |
| 3.1. Phase 3 Review Closure              | v1.0      | 15/15          | Complete | 2026-09-02 |
| 4. Feature Parity & Conformance Vectors  | v1.0      | 7/7            | Complete | 2026-09-05 |
| 4.1. Terminal Group Disbanding           | v1.0      | 6/6            | Complete | 2026-09-06 |
| 5. Quality Gate                          | v1.0      | 8/8            | Complete | 2026-09-06 |

## Backlog

### Phase 999.1: Group image support — check and add so downstream apps can show and update the group image (BACKLOG)

**Goal:** [Captured for future planning] — verify group image (avatar) support end-to-end so downstream apps can read/display and update a group's image. Likely touches the group image/avatar-url (0x8007) extension and the group metadata surface.
**Requirements:** TBD
**Plans:** 4/4 plans complete

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.2: Documentation review & update for current library state ahead of next release (BACKLOG)

**Goal:** [Captured for future planning] — review and update the docs (VitePress `docs/` + TypeDoc reference) to match the current state of the library in preparation for the next release.
**Requirements:** TBD
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.3: Exhaustive Gap Audit (shelved from milestone v1.0 Phase 1) (BACKLOG)

**Goal:** A rewritten, verified SPEC_GAP_REVIEW.md supersedes the stale June 2026 snapshot and becomes the authoritative closure backlog. Context gathered + discussion completed; no plans written. Depends on nothing; 999.4/999.5/999.6 depend on this. Full detail + prior work in `999.3-exhaustive-gap-audit/` (SHELVED.md, 01-CONTEXT.md, 01-DISCUSSION-LOG.md).
**Requirements:** AUDIT-01, AUDIT-02, AUDIT-03
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.4: Blocker & Security Closure (shelved from milestone v1.0 Phase 2) (BACKLOG)

**Goal:** Close every confirmed single-device blocker and security hardening gap — cross-epoch media decryption, convergence apply-gating, arrival-order-free branch selection, authenticate-before-decrypt, and public API classifiers matching the wire format. Depends on 999.3. Full detail in `999.4-blocker-and-security-closure/SHELVED.md`.
**Requirements:** MEDIA-01, MEDIA-02, CONV-01, CONV-02, SEC-01, SEC-02, API-01
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.5: Wire / Conformance & Docs (shelved from milestone v1.0 Phase 3) (BACKLOG)

**Goal:** Close remaining wire-format, codec, and API conformance gaps confirmed by the audit; document unsupported features (QUIC VarInt canonicality, duplicate-tag rejection, blossom-image 0x8002 unsupported, WIRE-03/04 disposition, URL-normalization vectors). Depends on 999.4. Full detail in `999.5-wire-conformance-and-docs/SHELVED.md`.
**Requirements:** WIRE-01, WIRE-02, WIRE-03, WIRE-04, CONF-01, DOC-01
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.6: Quality Gate (shelved from milestone v1.0 Phase 4) (BACKLOG)

**Goal:** Green Vitest suite on Node 20/22/24, Deno 2, Bun latest/1.1, plus byte-exact Rust reference verification for every closure change. Depends on 999.5. Full detail in `999.6-quality-gate/SHELVED.md`.
**Requirements:** QA-01, QA-02
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)
