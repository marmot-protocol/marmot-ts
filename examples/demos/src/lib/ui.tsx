import { useState, type ReactNode } from "react";
import { use$ } from "applesauce-react/hooks";
import type { RelayLogEntry } from "../services/relay/demo-relay.js";
import type { ReactiveTransport } from "./reactive-transport.js";

/** Shorten a hex id or pubkey for display. */
export const short = (hex: string, n = 8) =>
  hex.length > n * 2 ? `${hex.slice(0, n)}…${hex.slice(-4)}` : hex;

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

const KIND_NAMES: Record<number, string> = {
  445: "group event",
  1059: "gift wrap",
  5: "deletion",
  10002: "relay list",
  10050: "inbox relays",
  30443: "key package",
  443: "key package (legacy)",
};

function describe(entry: RelayLogEntry): string {
  if (entry.event) {
    const name = KIND_NAMES[entry.event.kind] ?? "";
    return `kind ${entry.event.kind} ${name} ${short(entry.event.id)}`;
  }
  const filters = (entry.filters ?? []).map((f) => JSON.stringify(f)).join(" ");
  return entry.op === "request"
    ? `${filters} → ${entry.results} event(s)`
    : filters;
}

/** Live view of everything that crossed the demo relay. */
export function RelayLog(props: { relay: ReactiveTransport; limit?: number }) {
  const relay = props.relay;
  const log = use$(relay.log$) ?? [];
  const events = use$(relay.events$) ?? [];
  const state = use$(relay.state$);
  const entries = log.slice(-(props.limit ?? 50)).reverse();
  return (
    <Panel
      title={`Relay traffic (${events.length} stored${
        state?.shared ? `, shared across tabs, this tab ${state.tab}` : ""
      })`}
      actions={
        state?.local ? (
          <>
            <label className="label text-xs">
              <input
                type="checkbox"
                className="toggle toggle-xs"
                checked={state.paused}
                onChange={(e) => {
                  relay.setPaused(e.target.checked);
                }}
              />
              hold publishes
            </label>
            {state.queued > 0 && (
              <button
                className="btn btn-xs btn-primary"
                onClick={() => relay.flush()}
              >
                deliver {state.queued} held
              </button>
            )}
          </>
        ) : undefined
      }
    >
      <ol className="max-h-64 overflow-y-auto font-mono text-xs">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="grid grid-cols-[7rem_6rem_1fr] gap-2 border-b border-dashed border-base-300 py-0.5"
          >
            <span
              className="font-semibold"
              title={entry.tab ? `from tab ${entry.tab}` : undefined}
            >
              {entry.actor}
              {entry.tab && (
                <span className="font-normal text-base-content/50">
                  @{entry.tab}
                </span>
              )}
            </span>
            <span
              className={entry.op === "publish" ? "text-primary" : undefined}
            >
              {entry.op}
            </span>
            <span className="wrap-anywhere text-base-content/60">
              {describe(entry)}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** Lowercase hex for a byte array. */
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
