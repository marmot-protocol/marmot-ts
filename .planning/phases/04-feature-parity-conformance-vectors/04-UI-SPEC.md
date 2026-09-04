---
phase: 04
slug: feature-parity-conformance-vectors
status: draft
shadcn_initialized: false
preset: none
created: 2026-09-04
---

# Phase 04 — UI Design Contract

> Phase 04 has no visual or interactive user interface. This contract records the deliberate
> non-applicability of UI requirements so implementation and verification do not invent a
> frontend surface for protocol, engine, persistence, and conformance-test work.

---

## Applicability Decision

**UI surface: none.** Phase 04 changes the published ESM TypeScript library and its automated
conformance tests. Its observable outcomes are encoded bytes, persisted engine state,
discriminated result values, application-visible library events, and test assertions—not
rendered screens, terminal views, forms, navigation, or interactive controls.

The repository contains a separate `examples/opentui` application, but neither
`04-CONTEXT.md` nor the Phase 04 roadmap criteria place that example in scope. Conformance
snapshots and scenario-runner output are test interfaces, not end-user UI. This decision is
pre-populated from `REQUIREMENTS.md`, `ROADMAP.md`, `04-CONTEXT.md`, the root package stack,
and the codebase scan performed on 2026-09-04.

## Design System

| Property | Value |
|----------|-------|
| Tool | none — not applicable |
| Preset | not applicable |
| Component library | none |
| Icon library | none |
| Font | none |

No root `components.json`, Tailwind configuration, UI component tree, or phase-scoped style
surface exists. The shadcn initialization gate is not applicable because the root project is
a framework-free TypeScript library and this phase does not alter a React/Next.js/Vite UI.

---

## Spacing Scale

Declared values: **not applicable**. Phase 04 renders no layout, so declaring spacing tokens
would create an implementation requirement with no consumer.

Exceptions: none; there are no visual elements or touch targets in phase scope.

---

## Typography

Typography roles, sizes, weights, and line heights: **not applicable**. Phase 04 produces no
rendered text. Stable scenario identifiers, result discriminants, diagnostics, and test
failure messages are technical API/test artifacts and follow existing code conventions rather
than a visual typography system.

---

## Color

Dominant, secondary, accent, and destructive colors: **not applicable**. No surface is
rendered and no visual semantic state is introduced.

Accent reserved for: none.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA | not applicable — no user action is introduced |
| Empty state heading | not applicable — no collection is rendered |
| Empty state body | not applicable — no collection is rendered |
| Error state | not applicable — failures remain typed results, thrown errors, or test diagnostics |
| Destructive confirmation | not applicable — no UI-triggered destructive action exists |

This exemption does not loosen API naming or diagnostic requirements. New public outcomes must
use the project's existing `kind`-discriminated-union conventions, and MDK scenario names must
remain stable test identifiers as locked in `04-CONTEXT.md`.

---

## UI Considerations

> The UI-consideration probe covers shape-rooted states such as empty, loading, error,
> populated, partial, overflow, zero/one/many, and long text.

Applicable state considerations resolved: **none applicable**.

| Category | Element(s) | Status | Resolution / Reason |
|----------|------------|--------|---------------------|
| all UI state categories | none (`elements: []`) | dismissed | Phase 04 defines no rendered UI element; protocol/test states are verified through typed outcomes and automated tests. |

The explicit empty element classification is intentional. It prevents the probe from creating
an `unclassified` UI candidate for nonvisual conformance machinery.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none | not applicable — shadcn is not initialized and no UI is in scope |
| third-party | none | passed 2026-09-04 — no registry or block declared |

No component registry content may be added under Phase 04 unless the phase boundary is
explicitly revised to include a rendered UI and this contract is regenerated and rechecked.

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS — not applicable; no rendered copy
- [x] Dimension 2 Visuals: PASS — not applicable; no visual surface
- [x] Dimension 3 Color: PASS — not applicable; no visual surface
- [x] Dimension 4 Typography: PASS — not applicable; no rendered text
- [x] Dimension 5 Spacing: PASS — not applicable; no layout
- [x] Dimension 6 Registry Safety: PASS — no registry or blocks used

**Approval:** pending checker verification

