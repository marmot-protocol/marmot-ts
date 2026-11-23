# Demo Guidelines

- Follow a **show, don't tell** approach: demonstrate behavior through working controls, live state, and results rather than descriptive text.
- Keep demos focused on clean code and functionality. Avoid introductory paragraphs, tutorials, and redundant explanations in the UI.
- Use concise labels, statuses, empty states, and actionable errors. Include explanatory text only when essential to using the demo safely or correctly.
- Keep library calls easy to follow in the demo source; put longer explanations in the README or documentation instead.
- Reuse the shared, mode-aware transport, account, and client infrastructure rather than creating per-demo services.
- Default to local tabs mode. Never bridge local events, identities, or group state into live mode; switching modes must dispose and reset the demo session.
- Persist the active account only in sessionStorage so reloads keep the tab's identity. New sessions generate a development identity and publish its randomly named kind-0 profile only to the local worker relay.
- Offer a header **Copy code** button, not an inline source viewer.
- Use the active account's shared Marmot client. The sidebar owns key-package publication; don't create a second client that cannot access those private bundles.

## Direct Library Usage

- Demos teach the public Marmot client and library APIs. Call those APIs directly in demo source; do not hide them behind service facades, per-operation wrappers, or a parallel reactive client API.
- Shared infrastructure may supply the client, account, and transport. It must not obscure the library operations being demonstrated.
- Keep commands as ordinary async library calls from intentional user actions. Await their results and report actionable errors.
- Read changing library state through its public watchers, not service internals, `.value`, or manually synchronized snapshots.

## Latest-State Async Watchers

- Use `useAsyncLatest` from `src/hooks/use-async-latest.ts` for latest-state async iterables. Keep the public watcher call visible: `useAsyncLatest((signal) => client.watchInvites({ signal }), [client])`.
- Pass a factory that creates a fresh iterator and forwards the hook's signal. Include every changing input in the dependency array; changing inputs or unmounting aborts the previous watcher.
- Each yield replaces the current snapshot. Do not accumulate snapshots, forward them through subjects, or maintain a second collection in React state.
- The hook returns `undefined` until the first yield and throws watcher failures to the nearest error boundary. Distinguish initial loading from a successfully loaded empty snapshot.
- Do not convert generators to RxJS merely to render them. Do not repeat iterator loops, abort controllers, subscription effects, or per-API hooks in demos.
- This hook is only for replaceable state watchers, not commands or finite workflows with required side effects. Consume those directly with `for await...of` when appropriate, awaiting processing inside the loop.
- Fully drain `ingest()` before starting another batch. Never stop ingestion early or run batches concurrently; rendering only the latest state must not discard protocol work.
- Cancellation is cooperative: watcher APIs must honor the supplied signal so a pending `next()` can finish and iterator cleanup can run.

## React and RxJS

- Consume existing observables with `use$`; let the hook own subscription lifetimes. Never mirror observable values with `useEffect`, `.subscribe()`, and `useState`.
- Use the factory form with complete dependencies for changing inputs; pass stable streams directly.
- Keep component-local form values, selections, filters, busy flags, and command errors in `useState`, not local `BehaviorSubject`s. Reserve subjects for genuinely shared reactive state.
- Derive data from its source rather than synchronizing duplicate state. Compose asynchronous data with operators and compute simple presentation values during render; avoid oversized view-model streams that bundle local UI state.
- Write reusable stream functions at module scope with a `$` suffix. Keep component-only wiring local and avoid abstractions that hide public library calls.
- Prefer `switchMap` for replaceable reads, not mutations or ingestion that must finish. Use `concatMap` when async work must complete in order; async `subscribe` callbacks are not awaited.
- Keep mutable accumulators subscription-local with `defer` or pipeline operators. Use reference-counted sharing when consumers should share work, and keep infrastructure disposal with its owner.
- Store or process every incoming event before batching UI emissions. Never debounce or throttle raw protocol ingestion.
- Preserve loading, missing, empty, and failure states. Isolate individual relay failures when other subscriptions should continue instead of converting all errors to empty results.
- Call hooks unconditionally at component top level. Extract child components for per-row subscriptions; return `of([])` for empty `combineLatest` inputs.
- Avoid effects for data coordination and state changes inside `tap`. Use callbacks for user actions and ref callbacks with cleanup for simple DOM observers.
