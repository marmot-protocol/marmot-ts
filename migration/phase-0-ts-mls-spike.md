# Phase 0 — ts-mls de-risking spike: decision record

Status: complete. Decision resolved — **Option A (cross-impl interop)**. Last updated 2026-06-09.

> **GATE RESOLVED (2026-06-09): the Option A prerequisite has landed.** ts-mls now ships native
> draft-ietf-mls-extensions-09 AppData on the vendored `app-data-update` branch
> (`ts-mls@2.0.0-rc.13`, commit `da72dc1`), and marmot-ts already consumes it via the `./ts-mls` path
> dependency. See **"Gate resolution"** at the end of this doc. Phase 3 mutation is **unblocked**; no
> type-7 scaffold is needed.

Spike probes: `src/__tests__/spikes/phase0-ts-mls.spike.test.ts` (run with
`pnpm vitest run src/__tests__/spikes/phase0-ts-mls.spike.test.ts`). All four probes pass against
`ts-mls@2.0.0-rc.10`; the probe assertions ARE the evidence below. If a future ts-mls bump changes a
capability, the matching probe flips — that is the signal to revisit this record.

## Questions (from MIGRATION_PLAN.md Phase 0)

- **Q1** — Can the app-component model (`app_data_dictionary` `0x0006`, `app_data_update` `0x0008`,
  `app_components` `0x0001`) be carried via ts-mls today, need an upstream contribution, or require a fork?
- **Q2** — Can ts-mls apply a commit to a _retained prior_ `ClientState` (branch replay), as Phase 9
  convergence requires?

## Findings

### Q2 — Branch replay: YES (no blocker for Phase 9). [PROBE 4]

`ClientState` is plain serializable data (`clientStateEncoder`/`clientStateDecoder`, wrapped by marmot's
`serializeClientState`/`deserializeClientState`). `processMessage({ state, message })` is functional — it
takes a state and returns a new one, with no hidden mutable handle on "the live group".

Probe 4 retains an epoch-1 state, serializes it, deserializes it, then applies a commit to that _restored_
snapshot. It reaches the **same epoch and byte-identical confirmation tag** as applying the commit to the
live state. Convergence's core primitive — replaying a commit against an arbitrary retained state — works
on ts-mls today. Phase 9 is de-risked on this axis. (Open sub-question for Phase 9: scoring/selection
logic is ours to build; only the MLS replay mechanic was in question here.)

### Q1 — App components: carrier works, mutation is the gap.

**Carrier (`app_data_dictionary` `0x0006`): works today, with a capability requirement. [PROBE 1]**
A `0x0006` GroupContext extension carried as `makeCustomExtension` (opaque bytes) survives
`createGroup → add-member commit → join` byte-for-byte, and both members agree on the confirmation tag.

**Capability enforcement is mandatory. [discovered on probe run 1]**
First run failed: `ValidationError: Added leaf node that doesn't support extension in GroupContext`. ts-mls
enforces MLS leaf-capability validation: every member's LeafNode MUST advertise extension `0x0006` (and, to
carry the `0x0008` proposal, `0x0008` in its proposal capabilities). The v2 KeyPackage builder
(`default-capabilities.ts` / `capabilities.ts`) must advertise the v2 code points. → **Phase 2/3 task.**

**Native mutation via `group_context_extensions` (type 7): works and converges. [PROBE 2]**
A native type-7 GCE proposal that replaces the extension set (carrying the new dictionary bytes) mutates the
dictionary and both members converge on matching confirmation tags. This is a _working_ mutation path — but
it is **not** the spec's `app_data_update` (`0x0008`) wire message.

**Spec-normative `app_data_update` (`0x0008`): carried opaquely, NOT applied. [PROBE 3]**
Injecting `ProposalCustom { proposalType: 0x0008, proposalData }` via `extraProposals`:
`createCommit` accepts it (no error) and `processMessage` accepts it (no error) — but the
`app_data_dictionary` extension is **unchanged** on both sides. ts-mls has zero extensions-draft AppData
machinery (`grep` of `node_modules/ts-mls/dist` for `app_data*`/`app_components`/`dictionary` →
nothing; `applyProposals` mutates GroupContext extensions only for type-7). The proposal rides in the
signed commit transcript but carries no dictionary semantics.

This is the crux: under draft-ietf-mls-extensions-09 (and OpenMLS's `extensions-draft-08` feature that
darkmatter Rust uses), committing an `app_data_update` updates the `app_data_dictionary` extension _as part
of forming the new GroupContext_, so the new bytes are folded into the confirmed transcript and confirmation
tag. ts-mls does not do this. There is also no hook in `createCommit`/`processMessage` to influence
GroupContext extension formation from a custom proposal — the only extension-mutating proposal ts-mls
understands is type 7.

## Consequence

- ts-mls **cannot** produce a draft-09-wire-conformant `app_data_update` result. Carrying the `0x0008`
  proposal opaquely diverges (ts-mls keeps the old dictionary in the confirmed GroupContext; an OpenMLS peer
  folds in the new one → different confirmation tags → the group forks).
- The native type-7 GCE path converges **among ts-mls peers** but is a different wire message than
  `0x0008`, so it is **not** interoperable with an OpenMLS/darkmatter implementation of the same group.
- Post-hoc rewriting of `ClientState.groupContext` outside ts-mls is not viable — it corrupts the stored
  confirmation tag / transcript that ts-mls verifies against on the next message.

So there is **no in-repo, no-fork path to wire-exact `app_data_update`**. Whether that matters depends
entirely on the interop requirement below.

Note: semantically this is a smaller gap than it looks. The spec already defines v1 component updates as
**full-replacement** payloads ("a caller that wants to change one field reads the current state, changes it,
and sends a full replacement"). The type-7 path is full-replacement of the dictionary. The divergence from
spec is the **proposal wire type (7 vs 8) and draft framing**, not the update semantics.

## Options for Phase 3

- **Option A — wire-conformant.** Add real `app_data_update` (`0x0008`) draft-09 semantics to ts-mls via an
  **upstream contribution** (preferred) or a **fork** (fallback to unblock). Required if marmot-ts must
  interoperate on the wire with darkmatter Rust / any other v2 implementation. Higher effort; gates Phase 3
  until the ts-mls support lands.
- **Option B — self-consistent, deviate on wire.** Implement app components on ts-mls today: `0x0006`
  custom-extension carrier + native type-7 `group_context_extensions` proposals for mutation +
  advertise `0x0006`/`0x0008` in capabilities. All-marmot-ts groups converge correctly. **Not**
  wire-conformant with OpenMLS draft-09 `app_data_update`. Unblocks Phase 3 immediately.

## Decision (resolved 2026-06-09)

**Option A — cross-implementation interop is required.** marmot-ts must interoperate, in the same MLS group
and on the wire, with darkmatter Rust (OpenMLS) and other v2 implementations. (Consistent with the spec
being written for cross-implementation conformance.)

Therefore Phase 3 requires **real `app_data_update` (`0x0008`) draft-09 semantics in ts-mls**, obtained via:

1. **Upstream contribution to ts-mls (preferred)** — add extensions-draft-09 AppData support
   (`app_data_dictionary` `0x0006` extension semantics + `app_data_update` `0x0008` proposal application
   during GroupContext formation, matching OpenMLS `extensions-draft-08` → draft-09 code points). This is
   the path most aligned with long-term maintenance and conformance.
2. **Fork of ts-mls (fallback)** — only to unblock Phase 3 if upstreaming stalls; carry the same patch and
   converge back to upstream when merged.

The native type-7 `group_context_extensions` substitution (Option B) is **rejected** for production: it
converges among ts-mls peers but is not wire-conformant with OpenMLS `app_data_update`, so it would fork any
mixed-implementation group. It may still be used as a _temporary local scaffold_ for building Phase 3
component logic before the ts-mls AppData support lands, but must be replaced before interop testing.

### Phase 3 prerequisites (new work surfaced by this decision)

- Open a ts-mls upstream issue/PR for extensions-draft-09 AppData (`0x0006` / `0x0008` / `0x0001`). Scope it
  against OpenMLS's draft-08 implementation and the draft-09 code points the spec pins.
- Until that lands, Phase 3 is **blocked on wire-exact mutation** (carrier + capabilities work can proceed).

**Phase 1 (canonical encoding) is independent of all of the above and proceeds now** — it is the substrate
every component byte format and the identity-proof preimage need.

## Decisions locked by this spike

- Phase 9 branch replay is feasible on ts-mls as-is. ✅
- The v2 KeyPackage/capabilities builder must advertise `0x0006` (extension) and `0x0008` (proposal). ✅
- Phase 1 (encoding) does not depend on the open decision and can proceed immediately. ✅

## Gate resolution (2026-06-09): native AppData landed in ts-mls

The Phase 3 prerequisite — "real `app_data_update` (`0x0008`) draft-09 semantics in ts-mls" — is **done**.
A ts-mls contribution (commit `da72dc1`, "Add app_data_dictionary extension and app_data_update proposal
support (draft-ietf-mls-extensions-09)", `2.0.0-rc.13`, branch `app-data-update`) implements it, and
marmot-ts already depends on that tree via `"ts-mls": "./ts-mls"` (symlinked into `node_modules`, built by
the `prepare` script). So this is the **Option A "upstream contribution"** path, satisfied in-repo.

What ts-mls now provides (verified importable from `ts-mls`):

- `appDataDictionaryExtensionType = 6` — the `app_data_dictionary` GroupContext extension (our `0x0006`).
- `ComponentData { componentId: number; data: Uint8Array }` and `AppDataDictionary = ComponentData[]`,
  with the **sorted-by-componentId + at-most-one-per-id** invariant enforced in codec and constructor.
  Wire: `componentData = uint16 componentId ++ varLenData data`; dictionary = a var-length vector of those.
  Our per-component `data` codecs (`group.profile.v1`, …) slot in directly as the `data` bytes.
- `makeAppDataDictionaryExtension(dictionary)` — build the extension for **group creation** (initial state).
- `getAppDataDictionary(extensions)` — **read** components from a `ClientState`'s GroupContext extensions.
- `appDataUpdateProposalType = 8` (our `0x0008`) and a first-class `ProposalAppDataUpdate`
  (`{ proposalType, appDataUpdate }`), with `AppDataUpdate = {componentId, operation:"update", update}
  | {componentId, operation:"remove"}`. Built and passed via `createCommit({ extraProposals: [...] })`.
- Full **commit integration**, draft-compliant: AppDataUpdate proposals are validated (must follow any
  GroupContextExtensions proposal; a component gets either one `remove` — only if state exists — or one or
  more `update`s; a type-7 GCE proposal may not touch the dictionary when required-capabilities include
  proposal type 8), applied **after** all other proposals when forming the new GroupContext, and bound to
  the transcript hash / key schedule / confirmation tag. They do **not** force an UpdatePath.
- `ClientConfig.appDataUpdateCallback` with `defaultAppDataUpdateCallback` = **last-update-wins full
  replacement** — which exactly matches Marmot v1 component update semantics (read-modify-write full state).
- `isAppDataUpdateProposal` type guard; opaque `ProposalCustom` with type 8 is now **rejected** (type 8 has
  assigned semantics).

### Consequences for the migration plan

- **Probe 3 is superseded.** Injecting `ProposalCustom { proposalType: 0x0008 }` (the old opaque carry) now
  throws instead of silently no-op'ing — that is the intended behavior change. The spike's PROBE 3
  assertion is expected to flip; it documents the *pre-resolution* state and should be read as historical.
- **No type-7 scaffold.** The temporary `group_context_extensions` substitution discussed under Option B is
  no longer needed at any stage; the public-API work wires straight onto native AppData.
- **The generic core is no longer hand-rolled/provisional.** marmot-ts must **not** ship its own dictionary
  container codec — it would risk diverging from the transcript-bound bytes ts-mls produces. Use ts-mls
  `ComponentData` / `AppDataDictionary` / `make…` / `get…` as the container, and keep marmot's codecs scoped
  to the per-component `data` payloads only.
- **Interop validation is now possible against the real wire.** The dictionary/proposal bytes are produced
  by the same draft-09 machinery on both sides, so cross-impl conformance tests against darkmatter Rust
  vectors become meaningful (was previously blocked).

### Revised Phase 3 / public-API build order (supersedes the gated plan)

1. **Capabilities** — `default-capabilities.ts` / `capabilities.ts` advertise extension `6` and proposal
   `8` on every v2 KeyPackage (still required — leaf-capability validation is enforced; from the spike).
2. **Read accessors** — wrap `getAppDataDictionary(state.groupContext.extensions)` + marmot's `decode*`
   codecs into typed getters (`group.profile`, `group.adminPolicy`, `group.nostrRouting`, …) and a generic
   `getComponent(id)`. Replaces `getMarmotGroupData`.
3. **Group creation** — provision `DEFAULT_GROUP_COMPONENT_IDS` initial state via
   `makeAppDataDictionaryExtension([...])` in the createGroup path.
4. **Mutation** — typed setters + generic `setComponent(id, bytes)` that emit `ProposalAppDataUpdate`
   (operation `update`, or `remove`) into `createCommit({ extraProposals })`. Default callback (full
   replacement) is correct for v1 components; leave it unless a component needs merge semantics.
5. **Delete v1** — remove `marmot-group-data.ts` and the `marmot_group_data` (`0xf2ee`) API once the typed
   facade covers the surface.
