# Phase 8: GroupContext Profile Requirement & Legality-Seam Extension - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md; this log preserves the alternatives considered.

**Date:** 2026-09-15
**Phase:** 08-groupcontext-profile-requirement-legality-seam-extension
**Areas discussed:** Leaf-check scope, Rejection surface, Standalone proposal admission, Legacy stored groups

---

## Leaf-check scope

**Which leaves should the commit-legality check verify?**

| Option | Description | Selected |
|--------|-------------|----------|
| Delta only | MDK parity: a profile-unchanged check plus added, Update, and update-path leaves | ✓ |
| Full resulting tree | Re-verify every member's proof on every commit | |
| Delta + debug full-tree assert | Delta in production; a test flag re-validates the whole tree | |

**How are changed leaves identified?**

| Option | Description | Selected |
|--------|-------------|----------|
| Tree diff | Compare parent and resulting trees; validate every non-blank new or changed leaf | ✓ |
| Proposal walk | Enumerate Add, Update, and update-path the way MDK does | |

**How much should Phase 8 check for Update and update-path leaves?**

| Option | Description | Selected |
|--------|-------------|----------|
| Proof validity only | Identity equality stays in Phase 9 | ✓ |
| Include identity equality now | Pull UPD-01 forward | |

**How much seam-parity testing?**

| Option | Description | Selected |
|--------|-------------|----------|
| Targeted GRP-02 matrix | Three invalid commits × four seams, identical violation | ✓ |
| Full QA-F1 matrix now | Every malformed case × every seam | |
| Unit + one seam | Adapter unit tests plus existing wiring tests | |

**User's choice:** All recommended options.

---

## Rejection surface

**Which violation reason?**

| Option | Description | Selected |
|--------|-------------|----------|
| One new `account-identity-proof` | A single category | ✓ |
| Two: `group-profile` + `account-identity-proof` | Separate profile and leaf reasons | |
| Reuse `component-integrity` | Detail string only | |

**Structured detail?**

| Option | Description | Selected |
|--------|-------------|----------|
| `proofReason` + `leafIndex` | Typed and pubkey-free | ✓ |
| `proofReason` only | | |
| `detail` string only | | |

**Order inside the adapter?**

| Option | Description | Selected |
|--------|-------------|----------|
| After integrity, before disband/admin | | ✓ |
| First | | |
| Last | | |

**User's choice:** All recommended options.

---

## Standalone proposal admission

**How to close the Phase 7 D-06 gap for Adds in commits?**

| Option | Description | Selected |
|--------|-------------|----------|
| Remove skip, keep early check | Pre-apply callback check plus post-apply tree diff, using the same core validator | ✓ |
| Drop callback proof check | Rely only on the adapter | |

**Where are standalone Adds validated?**

| Option | Description | Selected |
|--------|-------------|----------|
| Inbound + local propose | Callback on `kind=proposal` plus the engine propose path | ✓ |
| Inbound only | | |

**Standalone Update admission?**

| Option | Description | Selected |
|--------|-------------|----------|
| Defer entirely to Phase 9 | UPD-04 owns it | ✓ |
| Proof validity now, identity in Phase 9 | | |

**User's choice:** All recommended options.

---

## Legacy stored groups

**What happens on load?**

| Option | Description | Selected |
|--------|-------------|----------|
| Load, mark unsupported, refuse all traffic | Listable and destroyable; inbound and outbound (including app messages) refused | ✓ |
| Reject at load | Never becomes a MarmotGroup | |
| Load untouched, commits only blocked | Phase 7 behavior; half-working group | |

**Automatic cleanup?**

| Option | Description | Selected |
|--------|-------------|----------|
| No, the app decides | Docs tell apps to call `destroy()` | ✓ |
| Offer a helper | List or purge unsupported groups | |

**User's choice:** All recommended options.

---

## Claude's Discretion

- Names for the unsupported-profile flag, the refusal error, and the tree-diff helper.
- Where the D-11 traffic gate sits (session and/or engine).
- Parity-matrix fixture construction.

## Deferred Ideas

- Standalone Update admission → Phase 9 UPD-04.
- Update-leaf identity equality → Phase 9 UPD-01..03.
- Full QA-F1 matrix → future / Phase 11.
