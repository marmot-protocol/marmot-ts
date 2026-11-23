import type {
  GroupRow,
  IntentRow,
  MarmotClient,
  MarmotDatabase,
} from "@internet-privacy/marmot-ts/client";
import { use$ } from "applesauce-react/hooks";
import { useCallback, useState } from "react";
import { from, startWith } from "rxjs";
import { client$ } from "../../services/client.js";
import { account$ } from "../../services/accounts.js";
import { mode$ } from "../../services/mode.js";
import { short } from "../ui.js";

const PAGE_SIZE = 25;
const BYTE_PAGE_SIZE = 256;

type InspectionTable = {
  id: string;
  scope: string;
  name: string;
  rows?: object[];
  error?: string;
};

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

async function readTable(
  scope: string,
  name: string,
  read?: () => Promise<object[]>,
): Promise<InspectionTable> {
  const table = { id: JSON.stringify([scope, name]), scope, name };
  if (!read) return table;
  try {
    return { ...table, rows: await read() };
  } catch (cause) {
    return { ...table, error: errorMessage(cause) };
  }
}

/** Uses only the public database contract; no adapter or client internals. */
async function readInspection(database: MarmotDatabase) {
  const account = database.account;
  const tables = await Promise.all([
    readTable("Account", "keyPackages", () => account.keyPackages.all()),
    readTable(
      "Account",
      "invites",
      account.invites.all && (() => account.invites.all!()),
    ),
    readTable("Account", "groups", () => account.groups.all()),
    readTable("Account", "intents", () => account.intents.all()),
  ]);
  const registered = (tables[2]!.rows ?? []) as GroupRow[];
  const intents = (tables[3]!.rows ?? []) as IntentRow[];
  let groupIds = [
    ...new Set([
      ...registered.map(({ id }) => id),
      ...intents.map(({ groupId }) => groupId),
    ]),
  ].sort();
  let discoveryError: string | undefined;
  if (database.groups.list) {
    try {
      // The adapter's list is authoritative: do not create databases for stale
      // account records or destroy intents pointing at already-dropped groups.
      groupIds = await database.groups.list();
    } catch (cause) {
      discoveryError = errorMessage(cause);
      groupIds = [];
    }
  }
  const groupTables = await Promise.all(
    groupIds.map(async (id) => {
      const names = [
        "group",
        "treeNodes",
        "wrappers",
        "effects",
        "backfill",
        "messages",
        "deliveries",
      ];
      try {
        const group = await database.groups.open(id);
        try {
          return await Promise.all([
            // The public API always exposes a singleton, even when it is {}.
            readTable(id, "group", async () => [await group.group()]),
            ...(
              [
                "treeNodes",
                "wrappers",
                "effects",
                "backfill",
                "messages",
                "deliveries",
              ] as const
            ).map((name) =>
              readTable(
                id,
                name,
                group[name].all && (() => group[name].all!()),
              ),
            ),
          ]);
        } finally {
          await group.close();
        }
      } catch (cause) {
        return names.map((name): InspectionTable => ({
          id: JSON.stringify([id, name]),
          scope: id,
          name,
          error: errorMessage(cause),
        }));
      }
    }),
  );
  return {
    tables: [...tables, ...groupTables.flat()],
    groupIds,
    limitedDiscovery: !database.groups.list,
    discoveryError,
  };
}

function preview(value: unknown): string {
  if (value instanceof Uint8Array) return `${value.length} bytes`;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") return `{${Object.keys(value).length} fields}`;
  const text = String(value);
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

/** Search nested values without expanding private binary material into strings. */
function searchable(row: object) {
  return JSON.stringify(row, (_key, value) =>
    value instanceof Uint8Array ? `${value.length} bytes` : value,
  ).toLowerCase();
}

export function DatabaseInspector() {
  const client = use$(client$);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="btn btn-sm mx-4 mb-3"
        disabled={!client}
        onClick={() => setOpen(true)}
      >
        Inspect database
      </button>
      {open && client && (
        <DatabaseModal client={client} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function DatabaseModal({
  client,
  onClose,
}: {
  client: MarmotClient;
  onClose: () => void;
}) {
  const account = use$(account$);
  const mode = use$(mode$);
  const [selected, setSelected] = useState(
    JSON.stringify(["Account", "keyPackages"]),
  );
  const [revision, setRevision] = useState(0);
  const result = use$(
    () => from(readInspection(client.database)).pipe(startWith(undefined)),
    [client, revision],
  );
  const tables = result?.tables ?? [];
  const table = tables.find(({ id }) => id === selected) ?? tables[0];
  const showDialog = useCallback((dialog: HTMLDialogElement) => {
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      className="modal"
      aria-labelledby="database-inspector-title"
      onClose={onClose}
      ref={showDialog}
    >
      <div className="modal-box flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-3 rounded-none p-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id="database-inspector-title" className="text-lg font-semibold">
              Client database
            </h2>
            <div className="flex flex-wrap gap-x-3 text-xs text-base-content/60">
              <span title={account?.pubkey}>
                {short(account?.pubkey ?? "")}
              </span>
              <span>{mode}</span>
              <span>Client: {client.keyPackages.clientId}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              className="btn btn-sm"
              onClick={() => {
                setRevision((value) => value + 1);
              }}
              disabled={!result}
            >
              Refresh
            </button>
            <button className="btn btn-sm" autoFocus onClick={onClose}>
              Close
            </button>
          </div>
        </header>
        <p className="text-xs text-warning">
          Read-only · Tables read independently · May contain private keys and
          decrypted messages.
        </p>
        {!result && (
          <span
            role="status"
            className="loading loading-spinner"
            aria-label="Loading database"
          />
        )}
        {result?.limitedDiscovery && (
          <p role="status" className="text-xs text-warning">
            Group discovery limited to account records and pending intents.
          </p>
        )}
        {result?.discoveryError && (
          <div role="alert" className="alert alert-error">
            Could not list group databases: {result.discoveryError}
          </div>
        )}
        {result && (
          <div className="grid min-h-0 flex-1 grid-cols-[10rem_minmax(0,1fr)] gap-4 sm:grid-cols-[15rem_minmax(0,1fr)]">
            <nav aria-label="Database tables" className="overflow-y-auto">
              {["Account", ...result.groupIds].map((scope) => (
                <section key={scope} className="mb-4">
                  <h3
                    className="mb-1 truncate px-2 font-mono text-xs font-semibold"
                    title={scope}
                  >
                    {scope === "Account" ? scope : `Group ${short(scope)}`}
                  </h3>
                  {tables
                    .filter((entry) => entry.scope === scope)
                    .map((entry) => (
                      <button
                        key={entry.id}
                        className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-base-200 ${table?.id === entry.id ? "bg-base-200 font-semibold" : ""}`}
                        aria-current={
                          table?.id === entry.id ? "true" : undefined
                        }
                        onClick={() => setSelected(entry.id)}
                      >
                        <span className="truncate">{entry.name}</span>
                        <span className="text-xs tabular-nums text-base-content/60">
                          {entry.rows?.length ?? (entry.error ? "!" : "—")}
                        </span>
                      </button>
                    ))}
                </section>
              ))}
              {result.groupIds.length === 0 && !result.discoveryError && (
                <p className="px-2 text-xs text-base-content/60">
                  No group databases
                </p>
              )}
            </nav>
            {table && (
              <TableView key={`${table.id}:${revision}`} table={table} />
            )}
          </div>
        )}
      </div>
    </dialog>
  );
}

function TableView({ table }: { table: InspectionTable }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const needle = query.trim().toLowerCase();
  const allRows = table.rows ?? [];
  const rows = needle
    ? allRows.filter((row) => searchable(row).includes(needle))
    : allRows;
  const columns = [...new Set(allRows.flatMap((row) => Object.keys(row)))];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visible = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <section className="flex min-h-0 min-w-0 flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <h3 className="font-mono font-semibold">{table.name}</h3>
        <span className="text-sm text-base-content/60">
          {table.rows && `${rows.length} / ${allRows.length} rows`}
        </span>
        <input
          className="input input-sm ml-auto"
          aria-label="Search table rows"
          placeholder="Search rows"
          value={query}
          disabled={!table.rows}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {table.error ? (
          <div role="alert" className="alert alert-error">
            {table.error}
          </div>
        ) : !table.rows ? (
          <p role="status" className="p-4 text-sm text-base-content/60">
            Full-table inspection unavailable
          </p>
        ) : visible.length ? (
          <table className="table table-sm">
            <caption className="sr-only">{table.name} rows</caption>
            <thead>
              <tr>
                <th scope="col">Row</th>
                {columns.map((column) => (
                  <th scope="col" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, index) => (
                <DatabaseRow
                  key={`${query}:${page * PAGE_SIZE + index}`}
                  row={row}
                  columns={columns}
                  number={page * PAGE_SIZE + index + 1}
                />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="p-4 text-sm text-base-content/60">
            {allRows.length ? "No matching rows" : "Empty table"}
          </p>
        )}
      </div>
      <footer className="flex items-center justify-end gap-3 text-sm">
        <button
          className="btn btn-sm"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
        >
          Previous
        </button>
        <span>
          Page {page + 1} / {pages}
        </span>
        <button
          className="btn btn-sm"
          disabled={page + 1 >= pages}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </footer>
    </section>
  );
}

function DatabaseRow({
  row,
  columns,
  number,
}: {
  row: object;
  columns: string[];
  number: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const record = row as Record<string, unknown>;
  return (
    <>
      <tr className="hover:bg-base-200/50">
        <td>
          <button
            className="btn btn-xs"
            aria-expanded={expanded}
            aria-label={`Inspect row ${number}`}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Hide" : "Inspect"} {number}
          </button>
        </td>
        {columns.map((column) => (
          <td key={column} className="max-w-64 truncate font-mono text-xs">
            {preview(record[column])}
          </td>
        ))}
      </tr>
      {expanded && (
        <tr className="bg-base-200/50">
          <td colSpan={columns.length + 1}>
            <dl className="flex max-w-4xl flex-col gap-2 p-2 font-mono text-xs">
              {Object.keys(record).length === 0 && (
                <div>
                  <dt>Record</dt>
                  <dd>No fields</dd>
                </div>
              )}
              {Object.entries(record).map(([key, value]) => (
                <div key={key}>
                  <dt className="font-semibold">{key}</dt>
                  <dd className="ml-4">
                    <Value value={value} />
                  </dd>
                </div>
              ))}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

function Value({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  if (
    value instanceof Uint8Array ||
    (typeof value === "object" && value !== null)
  ) {
    return (
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="cursor-pointer">{preview(value)}</summary>
        {expanded &&
          (value instanceof Uint8Array ? (
            <div className="flex flex-col gap-2 py-2">
              <pre className="whitespace-pre-wrap break-all">
                {Array.from(
                  value.subarray(
                    page * BYTE_PAGE_SIZE,
                    (page + 1) * BYTE_PAGE_SIZE,
                  ),
                  (byte) => byte.toString(16).padStart(2, "0"),
                ).join(" ")}
              </pre>
              <div className="flex items-center gap-2">
                <button
                  className="btn btn-xs"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  Previous bytes
                </button>
                <span>
                  {page * BYTE_PAGE_SIZE}–
                  {Math.min((page + 1) * BYTE_PAGE_SIZE, value.length)} /{" "}
                  {value.length}
                </span>
                <button
                  className="btn btn-xs"
                  disabled={(page + 1) * BYTE_PAGE_SIZE >= value.length}
                  onClick={() => setPage(page + 1)}
                >
                  Next bytes
                </button>
              </div>
            </div>
          ) : (
            <dl className="ml-4 flex flex-col gap-2 py-2">
              {Object.entries(value).map(([key, nested]) => (
                <div key={key}>
                  <dt className="font-semibold">{key}</dt>
                  <dd className="ml-4">
                    <Value value={nested} />
                  </dd>
                </div>
              ))}
            </dl>
          ))}
      </details>
    );
  }
  return <span className="whitespace-pre-wrap break-all">{String(value)}</span>;
}
