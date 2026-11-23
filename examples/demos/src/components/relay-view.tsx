import { useEffect, useState } from "react";
import { DEMO_RELAY_CHANNEL } from "../lib/demo-relay.js";
import type { InspectorResponse, RelayState } from "../lib/relay-inspector.js";
import { Json, Panel, short } from "../lib/ui.js";

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
        new URL("../lib/demo-relay.worker.ts", import.meta.url),
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
    <div className="flex h-dvh overflow-hidden bg-base-200">
      <aside className="flex w-40 shrink-0 flex-col overflow-y-auto border-r border-base-300 bg-base-100 sm:w-56">
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
                  className={`rounded-field px-3 py-2 text-left text-sm ${
                    tab === name
                      ? "bg-primary text-primary-content"
                      : "hover:bg-base-200"
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
              className={`badge ${healthy ? "badge-success" : "badge-warning"}`}
            >
              {healthy ? "Running" : state ? "Unresponsive" : "Connecting"}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              className="btn btn-sm btn-error btn-outline"
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
          <p role="alert" className="alert alert-error">
            {error}
          </p>
        )}
        {!healthy && !error && (
          <p className="alert alert-warning">
            Waiting for a worker response. Reload if the relay does not respond.
          </p>
        )}
        <div className="stats stats-vertical w-full bg-base-100 shadow-sm lg:stats-horizontal">
          {[
            ["Transport", "SharedWorker"],
            ["Demo connections", state?.connections.length ?? 0],
            ["Stored events", state?.events.length ?? 0],
            ["Subscriptions", state?.subscriptions.length ?? 0],
            ["Traffic entries", state?.log.length ?? 0],
          ].map(([label, value]) => (
            <div className="stat" key={label}>
              <div className="stat-title">{label}</div>
              <div className="stat-value text-xl">{value}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-base-content/60">
          {DEMO_RELAY_CHANNEL} · Started{" "}
          {state ? new Date(state.startedAt).toLocaleString() : "—"}
          {" · "}Last response{" "}
          {receivedAt ? new Date(receivedAt).toLocaleTimeString() : "—"}
          {" · "}This inspector keeps the relay alive.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
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
        <Panel title={tab}>
          {tab === "Traffic" && (
            <>
              <p className="text-xs">{traffic.length} matching entries</p>
              {traffic.slice(0, limit).map((entry) => (
                <details
                  key={entry.id}
                  className="border-b border-base-300 py-2"
                >
                  <summary className="cursor-pointer break-all font-mono text-xs">
                    {new Date(entry.at).toLocaleTimeString()} · {entry.actor}@
                    {entry.tab} · {entry.op}
                    {entry.event &&
                      ` · kind ${entry.event.kind} · ${short(entry.event.id)}`}
                    {entry.results !== undefined &&
                      ` · ${entry.results} results`}
                  </summary>
                  <Json value={entry} />
                </details>
              ))}
              {!traffic.length && <p>No traffic.</p>}
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
                <div key={sub.id} className="border-b border-base-300 py-2">
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
              {events.slice(0, limit).map((event) => (
                <details
                  key={event.id}
                  className="border-b border-base-300 py-2"
                >
                  <summary className="cursor-pointer break-all font-mono text-xs">
                    kind {event.kind} · {short(event.id)} · author{" "}
                    {short(event.pubkey)} ·{" "}
                    {new Date(event.created_at * 1000).toLocaleString()}
                  </summary>
                  <Json value={event} />
                </details>
              ))}
              {!events.length && <p>No stored events.</p>}
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
        </Panel>
      </main>
    </div>
  );
}
