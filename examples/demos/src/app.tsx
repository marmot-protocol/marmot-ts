import { useEffect, useState, type ComponentType } from "react";
import { useActiveAccount } from "./accounts.js";
import { AccountBadge } from "./components/account-badge.js";
import { LoginView } from "./components/login-view.js";
import { categories, demos, type Demo } from "./demos.js";
import { ServicesProvider, useDemoServices } from "./services.js";
import type { TransportMode } from "./lib/transport.js";
import { Contacts } from "./components/contacts.js";
import { RelayView } from "./services/relay/relay-view.js";
import { getPageTitle } from "./lib/page-title.js";

function useHashId() {
  const read = () => decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  const [id, setId] = useState(read);
  useEffect(() => {
    const update = () => setId(read());
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return id;
}

export function App() {
  const account = useActiveAccount();
  const [mode, setMode] = useState<TransportMode>("local");
  useEffect(() => {
    document.title = getPageTitle(location.pathname, account);
  }, [account]);
  if (location.pathname.replace(/\/$/, "") === "/relay") return <RelayView />;
  // Every demo runs as the logged-in user, so nothing renders until login.
  if (!account) return <LoginView />;
  // Switching accounts remounts the demos with the new signer.
  return (
    <ServicesProvider key={`${account.id}:${mode}`} mode={mode}>
      <DemoShell setMode={setMode} />
    </ServicesProvider>
  );
}

function DemoShell({ setMode }: { setMode: (mode: TransportMode) => void }) {
  const id = useHashId();
  const demo = demos.find((d) => d.id === id) ?? demos[0];

  return (
    <div className="grid min-h-screen grid-cols-[15rem_minmax(0,1fr)] bg-base-200">
      <Sidebar active={demo} setMode={setMode} />
      <main className="min-w-0 p-6">
        {demo ? (
          <DemoView key={demo.id} demo={demo} />
        ) : (
          <div className="max-w-prose">
            <h2 className="mb-2 text-xl font-semibold">No demos yet</h2>
            <p className="text-base-content/60">
              Create <code>src/demos/&lt;category&gt;/&lt;name&gt;.tsx</code>{" "}
              and add it to the list in <code>src/demos.ts</code>.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

function Sidebar({
  active,
  setMode,
}: {
  active?: Demo;
  setMode: (mode: TransportMode) => void;
}) {
  const { mode } = useDemoServices();
  return (
    <nav className="sticky top-0 flex h-screen flex-col border-r border-base-300 bg-base-100">
      <h1 className="px-4 pt-4 pb-3 font-semibold">marmot-ts demos</h1>
      <a
        className="btn btn-sm mx-4 mb-3"
        href="/relay"
        target="_blank"
        rel="noreferrer"
      >
        Local relay inspector ↗
      </a>
      <div className="px-4 pb-3">
        <select
          className="select select-sm w-full"
          aria-label="Nostr transport"
          value={mode}
          onChange={(event) => setMode(event.target.value as TransportMode)}
        >
          <option value="local">Tabs (local)</option>
          <option value="live">Live network</option>
        </select>
      </div>
      <ul className="menu menu-sm w-full flex-1 flex-nowrap overflow-y-auto">
        {categories.map((category) => (
          <li key={category.label}>
            <h2 className="menu-title">{category.label}</h2>
            <ul>
              {category.demos.map((d) => (
                <li key={d.id}>
                  <a
                    href={`#/${d.id}`}
                    className={d.id === active?.id ? "menu-active" : undefined}
                  >
                    {d.title}
                  </a>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <Contacts />
      <AccountBadge />
    </nav>
  );
}

function DemoView({ demo }: { demo: Demo }) {
  const [Component, setComponent] = useState<ComponentType>();
  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState(false);
  // Reset actors and group state without replacing the shared app services.
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    demo.load().then((mod) => setComponent(() => mod.default), setError);
  }, [demo]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <>
      <header className="mb-4 flex items-start justify-between gap-4">
        <h2 className="text-xl font-semibold">{demo.title}</h2>
        <div className="flex shrink-0 gap-2">
          <button className="btn btn-sm" onClick={() => setRunId((n) => n + 1)}>
            Reset
          </button>
          <button
            className="btn btn-sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(await demo.source());
                setCopied(true);
              } catch (cause) {
                setError(cause);
              }
            }}
          >
            {copied ? "Copied" : "Copy code"}
          </button>
        </div>
      </header>
      {error !== undefined && (
        <div role="alert" className="alert alert-error alert-soft mb-4">
          {String(error)}
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-4">
        {Component ? (
          <Component key={runId} />
        ) : (
          <span className="loading loading-spinner" />
        )}
      </div>
    </>
  );
}
