import { useEffect, useState } from "react";
import { DEMO_RELAY_CHANNEL } from "./demo-relay.js";
import type { InspectorResponse, RelayState } from "./relay-inspector.js";
import { Json } from "../../lib/ui.js";
import { EventsTable, TrafficTable } from "./relay-tables.js";

export function RelayView() {
  const [worker, setWorker] = useState<SharedWorker>();
  const [state, setState] = useState<RelayState>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const [receivedAt, setReceivedAt] = useState(0);
  const [tab, setTab] = useState("Traffic");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (typeof SharedWorker === "undefined") {
      setError(
        "SharedWorker is unavailable. Open this view in a browser with SharedWorker support.",
      );
      return;
    }
    let relay: SharedWorker;
    try {
      relay = new SharedWorker(
        new URL("./demo-relay.worker.ts", import.meta.url),
        { type: "module", name: DEMO_RELAY_CHANNEL },
      );
    } catch (cause) {
      setError(String(cause));
      return;
    }
    relay.onerror = () =>
      setError("Relay worker failed. Reload this view to reconnect.");
    relay.port.onmessage = ({ data }: MessageEvent<InspectorResponse>) => {
      if (data.type !== "relay-state") return;
      setState(data.state);
      setReceivedAt(Date.now());
      setError(undefined);
      setResetting(false);
    };
    relay.port.start();
    const inspect = () => {
      setNow(Date.now());
      relay.port.postMessage({ type: "inspect" });
    };
    inspect();
    const timer = setInterval(inspect, 2000);
    setWorker(relay);
    const disconnect = () => {
      relay.port.postMessage({ type: "disconnect" });
      relay.port.close();
    };
    addEventListener("pagehide", disconnect);
    return () => {
      clearInterval(timer);
      removeEventListener("pagehide", disconnect);
      disconnect();
    };
  }, []);

  const healthy = !!state && now - receivedAt < 6000 && !error;
  const matches = (value: unknown) =>
    JSON.stringify(value).toLowerCase().includes(search.toLowerCase());
  const events = (state?.events ?? []).filter(matches);
  const traffic = (state?.log ?? []).filter(matches).slice().reverse();
  const subscriptions = (state?.subscriptions ?? []).filter(matches);

  return (
    <div className="flex h-dvh overflow-hidden bg-base-100">
      <aside className="flex w-36 shrink-0 flex-col overflow-y-auto sm:w-48">
        <a className="px-4 py-5 font-semibold" href="/relay">
          Local relay
        </a>
        <nav aria-label="Relay inspector" className="flex-1 px-2">
          <div
            role="tablist"
            aria-label="Relay data"
            aria-orientation="vertical"
            className="menu w-full gap-1"
          >
            {["Traffic", "Subscriptions", "Events", "Connections"].map(
              (name) => (
                <button
                  key={name}
                  role="tab"
                  id={`relay-tab-${name.toLowerCase()}`}
                  aria-controls="relay-content"
                  aria-selected={tab === name}
                  className={`px-3 py-2 text-left text-sm ${
                    tab === name
                      ? "font-semibold text-primary"
                      : "text-base-content/60 hover:text-base-content"
                  }`}
                  onClick={() => {
                    setTab(name);
                    setLimit(100);
                  }}
                >
                  {name}
                </button>
              ),
            )}
          </div>
        </nav>
        <a className="btn btn-sm btn-ghost m-3" href="/">
          ← Demos
        </a>
      </aside>
      <main
        id="relay-content"
        role="tabpanel"
        aria-labelledby={`relay-tab-${tab.toLowerCase()}`}
        tabIndex={0}
        className="min-w-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6"
      >
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">Local relay inspector</h1>
            <span
              role="status"
              className={`text-xs font-medium ${healthy ? "text-success" : "text-warning"}`}
            >
              <span aria-hidden="true">● </span>
              {healthy ? "Running" : state ? "Unresponsive" : "Connecting"}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              className="btn btn-sm btn-ghost text-error"
              disabled={!healthy || resetting}
              onClick={() => {
                if (
                  !confirm(
                    "Clear shared relay events, traffic, and queued publishes in ALL tabs? Active subscriptions and demo groups remain; running demos may publish new events immediately.",
                  )
                )
                  return;
                setResetting(true);
                worker?.port.postMessage({ type: "reset" });
              }}
            >
              {resetting ? "Resetting…" : "Reset relay data"}
            </button>
          </div>
        </header>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        {!healthy && !error && (
          <p className="text-sm text-warning">
            Waiting for a worker response. Reload if the relay does not respond.
          </p>
        )}
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          {[
            ["Transport", "SharedWorker"],
            ["Demo connections", state?.connections.length ?? 0],
            ["Stored events", state?.events.length ?? 0],
            ["Subscriptions", state?.subscriptions.length ?? 0],
            ["Traffic entries", state?.log.length ?? 0],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-base-content/60">{label}</dt>
              <dd className="text-lg font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-base-content/60">
          {DEMO_RELAY_CHANNEL} · Started{" "}
          {state ? new Date(state.startedAt).toLocaleString() : "—"}
          {" · "}Last response{" "}
          {receivedAt ? new Date(receivedAt).toLocaleTimeString() : "—"}
          {" · "}This inspector keeps the relay alive.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{tab}</h2>
          <input
            aria-label="Filter relay data"
            className="input input-sm w-full max-w-md"
            placeholder="Filter by kind, actor, ID, content…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(100);
            }}
          />
        </div>
        <section aria-label={tab} className="min-w-0 space-y-2">
          {tab === "Traffic" && (
            <>
              <p className="text-xs">{traffic.length} matching entries</p>
              <TrafficTable entries={traffic.slice(0, limit)} />
              {traffic.length > limit && (
                <button
                  className="btn btn-sm"
                  onClick={() => setLimit(limit + 100)}
                >
                  Show more
                </button>
              )}
            </>
          )}
          {tab === "Subscriptions" && (
            <>
              {subscriptions.map((sub) => (
                <div key={sub.id} className="py-2">
                  <p className="break-all font-mono text-xs">
                    {sub.actor}@{sub.tab} · {sub.id} ·{" "}
                    {new Date(sub.at).toLocaleTimeString()}
                  </p>
                  <Json value={sub.filters} />
                </div>
              ))}
              {!subscriptions.length && <p>No active subscriptions.</p>}
            </>
          )}
          {tab === "Events" && (
            <>
              <p className="text-xs">
                {events.length} matching events ·{" "}
                {new TextEncoder()
                  .encode(JSON.stringify(state?.events ?? []))
                  .byteLength.toLocaleString()}{" "}
                bytes total JSON
              </p>
              <EventsTable events={events.slice(0, limit)} />
              {events.length > limit && (
                <button
                  className="btn btn-sm"
                  onClick={() => setLimit(limit + 100)}
                >
                  Show more
                </button>
              )}
            </>
          )}
          {tab === "Connections" && (
            <>
              {(state?.connections ?? []).filter(matches).map((id) => (
                <div key={id} className="break-all font-mono text-xs">
                  {id} ·{" "}
                  {state?.peers.find((peer) => peer.from === id)?.pubkey ??
                    "No account"}
                </div>
              ))}
              {!state?.connections.length && <p>No demo connections.</p>}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
