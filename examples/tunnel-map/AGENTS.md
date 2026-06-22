# Agent Notes for tunnel-map

Standalone Hono SSR example inside the `marmot-ts` pnpm workspace.

## Commands

- `npm install` — install deps (the README uses npm, not pnpm; the workspace picks it up via `examples/*` but local deps are managed separately).
- `npm run dev` — runs `tsx watch src/index.ts` (live-reload); server at `http://localhost:3000`.
- `npm run build` — `tsc` into `dist/`.
- `npm run start` — `node dist/index.js` (requires a prior build).

## Entrypoint

- The real entry file is `src/index.tsx` (not `src/index.ts`). The `package.json` `"dev"` script points to `src/index.ts`, but only `src/index.tsx` exists — `tsx` resolves it transparently, but `tsc` outputs to `dist/index.js`.

## JSX

- JSX is configured for Hono's JSX runtime (`jsxImportSource: "hono/jsx"`). Do not switch to React or Preact imports.
- Use `FC` from `hono/jsx` for component types, not `React.FC`.
- `verbatimModuleSyntax` is on — use `import type` for type-only imports.

## TypeScript

- `module`/`moduleResolution` are both `NodeNext`. Relative imports must use `.js` extensions (even though source files are `.ts`/`.tsx`).
- No `outDir` source maps or declaration files configured; build output goes to `dist/`.
- `skipLibCheck: true` — third-party type errors are suppressed.

## Workspace context

- This package is included in the root `pnpm-workspace.yaml` under `examples/*`.
- It has no tests and no lint scripts. Verification = `npm run build` succeeds.
- Root-level `pnpm build` / `pnpm test` do not run this example; work here is isolated.

## Git Workflow

- Commit after completing a feature or significant change, once `npm run build` succeeds.
- Do not commit on the `master` branch; branch first when needed.
