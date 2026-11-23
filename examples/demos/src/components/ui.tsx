import { useState, type ReactNode } from "react";
export { short, hex } from "../utils/format.js";

export function Panel(props: {
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="card card-border min-w-0 bg-base-100">
      <header className="flex items-center justify-between gap-2 border-b border-base-300 px-4 py-2">
        <h3 className="text-sm font-semibold">{props.title}</h3>
        <div className="flex flex-wrap items-center gap-2">{props.actions}</div>
      </header>
      <div className="flex flex-col gap-2 p-4">{props.children}</div>
    </section>
  );
}

/** A button that runs an async action, shows a spinner and surfaces errors. */
export function Action(props: {
  run: () => unknown | Promise<unknown>;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        className="btn btn-sm"
        disabled={busy || props.disabled}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            await props.run();
          } catch (e) {
            console.error(e);
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <span className="loading loading-spinner loading-xs" />
        ) : (
          props.children
        )}
      </button>
      {error && <span className="text-xs text-error">{error}</span>}
    </span>
  );
}

/** Pretty-print any value, including bigint and Uint8Array. */
export function Json(props: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto">
      {JSON.stringify(
        props.value,
        (_k, v) =>
          typeof v === "bigint"
            ? `${v}n`
            : v instanceof Uint8Array
              ? `0x${Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("")}`
              : v,
        2,
      )}
    </pre>
  );
}
