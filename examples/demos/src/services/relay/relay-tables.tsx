import { useId, useState, type ReactNode } from "react";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { RelayLogEntry } from "./demo-relay.js";
import { Json, short } from "../../lib/ui.js";

function InspectableRow({
  children,
  value,
  label,
  columns,
}: {
  children: ReactNode;
  value: unknown;
  label: string;
  columns: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return (
    <>
      <tr className="hover:bg-base-200/50">
        {children}
        <td className="text-right">
          <button
            className="btn btn-xs btn-ghost"
            aria-label={label}
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Hide JSON" : "JSON"}
          </button>
        </td>
      </tr>
      <tr id={id} hidden={!expanded} className="bg-base-200/50">
        <td colSpan={columns} className="font-mono text-xs">
          {expanded && <Json value={value} />}
        </td>
      </tr>
    </>
  );
}

export function TrafficTable({ entries }: { entries: RelayLogEntry[] }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="table table-sm w-full [&_td]:border-0 [&_th]:border-0 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th:last-child]:pr-0">
        <caption className="sr-only">Relay traffic</caption>
        <thead>
          <tr>
            {[
              "Time",
              "Actor",
              "Tab",
              "Operation",
              "Event / filters",
              "Results",
              "Details",
            ].map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <InspectableRow
              key={entry.id}
              value={entry}
              label={`Inspect traffic entry ${entry.id}`}
              columns={7}
            >
              <td className="whitespace-nowrap tabular-nums">
                <time
                  dateTime={new Date(entry.at).toISOString()}
                  title={new Date(entry.at).toLocaleString()}
                >
                  {new Date(entry.at).toLocaleTimeString()}
                </time>
              </td>
              <td>{entry.actor}</td>
              <td className="font-mono text-xs">{entry.tab ?? "—"}</td>
              <td>
                <span
                  className={`font-medium ${
                    entry.op === "publish"
                      ? "text-primary"
                      : "text-base-content/70"
                  }`}
                >
                  {entry.op}
                </span>
              </td>
              <td className="font-mono text-xs">
                {entry.event ? (
                  <span className="whitespace-nowrap" title={entry.event.id}>
                    kind {entry.event.kind} · {short(entry.event.id)}
                  </span>
                ) : (
                  <span className="block max-w-96 truncate">
                    {entry.filters ? JSON.stringify(entry.filters) : "—"}
                  </span>
                )}
              </td>
              <td className="text-right tabular-nums">
                {entry.results ?? "—"}
              </td>
            </InspectableRow>
          ))}
          {!entries.length && (
            <tr>
              <td colSpan={7} className="py-8 text-center text-base-content/60">
                No traffic.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function EventsTable({ events }: { events: NostrEvent[] }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="table table-sm w-full [&_td]:border-0 [&_th]:border-0 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th:last-child]:pr-0">
        <caption className="sr-only">Stored relay events</caption>
        <thead>
          <tr>
            {[
              "Created",
              "Kind",
              "Event ID",
              "Author",
              "Content",
              "Details",
            ].map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <InspectableRow
              key={event.id}
              value={event}
              label={`Inspect event ${event.id}`}
              columns={6}
            >
              <td className="whitespace-nowrap tabular-nums">
                <time
                  dateTime={new Date(event.created_at * 1000).toISOString()}
                >
                  {new Date(event.created_at * 1000).toLocaleString()}
                </time>
              </td>
              <td className="tabular-nums">{event.kind}</td>
              <td className="font-mono text-xs" title={event.id}>
                {short(event.id)}
              </td>
              <td className="font-mono text-xs" title={event.pubkey}>
                {short(event.pubkey)}
              </td>
              <td>
                <span className="block max-w-64 truncate text-base-content/60">
                  {event.content.slice(0, 160) || "—"}
                </span>
              </td>
            </InspectableRow>
          ))}
          {!events.length && (
            <tr>
              <td colSpan={6} className="py-8 text-center text-base-content/60">
                No stored events.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
