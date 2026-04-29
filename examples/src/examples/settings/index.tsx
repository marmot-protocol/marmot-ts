import { UnsignedEvent, npubEncode, relaySet } from "applesauce-core/helpers";
import { useEffect, useState } from "react";
import { RelayListCreator } from "../../components/form/relay-list-creator";
import JsonBlock from "../../components/json-block";
import { UserAvatar, UserName } from "../../components/nostr-user";
import QRButton from "../../components/qr-button";
import { useObservable } from "../../hooks/use-observable";
import {
  default as accountManager,
  default as accounts,
  mailboxes$,
} from "../../lib/accounts";
import { createNip65RelayListEvent } from "../../lib/nip65";
import { eventStore, pool } from "../../lib/nostr";
import { lookupRelays$ } from "../../lib/settings";

type Nip65RelayRow = { relay: string; read: boolean; write: boolean };

function normalizeRelayUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://"))
    return trimmed;
  return `wss://${trimmed}`;
}

function AccountManagement() {
  const accounts = useObservable(accountManager.accounts$) || [];
  const activeAccount = useObservable(accountManager.active$);

  const handleAddAccount = () => {
    (document.getElementById("signin_modal") as HTMLDialogElement)?.showModal();
  };

  const handleSwitchAccount = (accountId: string) => {
    accountManager.setActive(accountId);
  };

  const handleRemoveAccount = (accountId: string) => {
    if (confirm("Are you sure you want to remove this account?")) {
      accountManager.removeAccount(accountId);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold mb-2">Accounts</h2>
        <p className="text-base-content/70 text-sm">
          Manage your accounts. Switch between accounts or add new ones.
        </p>
      </div>
      <div className="space-y-3">
        {accounts.length === 0 ? (
          <div className="text-base-content/70 text-sm">
            No accounts configured. Add an account to get started.
          </div>
        ) : (
          <div className="space-y-2">
            {accounts.map((account) => {
              const isActive = activeAccount?.id === account.id;
              return (
                <div
                  key={account.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border ${
                    isActive
                      ? "border-primary bg-primary/10"
                      : "border-base-300 bg-base-200"
                  }`}
                >
                  <UserAvatar pubkey={account.pubkey} />
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">
                      <UserName pubkey={account.pubkey} />
                    </div>
                    <div className="text-xs text-base-content/60 truncate select-all">
                      {account.pubkey}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="join">
                      <QRButton
                        data={npubEncode(account.pubkey)}
                        label="npub"
                        className="btn-ghost btn-sm join-item"
                      />
                      <QRButton
                        data={account.pubkey}
                        label="hex"
                        className="btn-ghost btn-sm join-item"
                      />
                    </div>
                    <button
                      className={`btn ${isActive ? "btn-primary" : "btn-ghost"}`}
                      onClick={() => handleSwitchAccount(account.id)}
                      disabled={isActive}
                    >
                      Switch
                    </button>
                    <button
                      className="btn btn-ghost text-error"
                      onClick={() => handleRemoveAccount(account.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <button className="btn btn-primary w-full" onClick={handleAddAccount}>
          Add Account
        </button>
      </div>
    </div>
  );
}

export default function Settings() {
  const lookupRelays = useObservable(lookupRelays$) || [];
  const mailboxes = useObservable(mailboxes$);
  const account = useObservable(accounts.active$);

  const [nip65Draft, setNip65Draft] = useState<UnsignedEvent | null>(null);
  const [nip65Published, setNip65Published] = useState<string | null>(null);
  const [nip65Error, setNip65Error] = useState<string | null>(null);
  const [isPublishingNip65, setIsPublishingNip65] = useState(false);

  const [nip65Relays, setNip65Relays] = useState<Nip65RelayRow[]>([]);
  const [newNip65Relay, setNewNip65Relay] = useState<string>("");

  // Keep editable state in sync with what we observe from the network.
  useEffect(() => {
    if (!mailboxes) return;
    const inboxes = new Set(mailboxes.inboxes ?? []);
    const outboxes = new Set(mailboxes.outboxes ?? []);

    const merged = new Set<string>([...inboxes, ...outboxes]);
    const rows: Nip65RelayRow[] = [...merged].map((relay) => ({
      relay,
      read: inboxes.has(relay),
      write: outboxes.has(relay),
    }));
    setNip65Relays(rows);
  }, [mailboxes]);

  const handleLookupRelaysChange = (relays: string[]) => {
    lookupRelays$.next(relays);
  };

  const handleCreateNip65Draft = () => {
    setNip65Error(null);
    setNip65Published(null);

    if (!account) {
      setNip65Error("No active account");
      return;
    }

    const inboxes = nip65Relays
      .filter((r) => r.read)
      .map((r) => r.relay)
      .filter(Boolean);
    const outboxes = nip65Relays
      .filter((r) => r.write)
      .map((r) => r.relay)
      .filter(Boolean);

    const draft = createNip65RelayListEvent({
      pubkey: account.pubkey,
      inboxes,
      outboxes,
    });

    setNip65Draft(draft);
  };

  const handlePublishNip65 = async () => {
    if (!account) {
      setNip65Error("No active account");
      return;
    }
    if (!nip65Draft) {
      setNip65Error("No draft event to publish");
      return;
    }

    try {
      setIsPublishingNip65(true);
      setNip65Error(null);

      const signed = await account.signEvent(nip65Draft);

      // Publish kind 10002 to the relays referenced by the event itself.
      // This avoids a mismatch where a user adds a new relay but we publish to
      // unrelated bootstrap relays (or nowhere).
      const inboxes = nip65Relays
        .filter((r) => r.read)
        .map((r) => r.relay)
        .filter(Boolean);
      const outboxes = nip65Relays
        .filter((r) => r.write)
        .map((r) => r.relay)
        .filter(Boolean);

      // Publish to configured relays; this is examples UX, so be robust.
      const publishingRelays = relaySet(inboxes, outboxes, lookupRelays);
      if (publishingRelays.length === 0) {
        throw new Error("No relays configured for publishing");
      }

      for (const relay of publishingRelays) {
        try {
          await pool.publish([relay], signed);
        } catch (err) {
          console.warn("Failed to publish NIP-65 to", relay, err);
        }
      }

      // Add to local eventStore so mailboxes$ / banners update immediately.
      eventStore.add(signed);

      setNip65Published(signed.id);
      setNip65Draft(null);
    } catch (err) {
      setNip65Error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsPublishingNip65(false);
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p>Manage your relay configurations for the application.</p>
      </div>

      {/* Account Management Section */}
      <AccountManagement />

      {/* NIP-65 Section */}
      <div className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold mb-2">
            NIP-65 Relay List (kind 10002)
          </h2>
          <p className="text-base-content/70 text-sm">
            This is your relay reachability configuration. Other users will use
            it to know where to deliver private messages (giftwraps) to you.
          </p>
        </div>

        {!account ? (
          <div className="alert alert-info">
            <span>Sign in to view and publish your NIP-65 relay list.</span>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="card bg-base-100 border border-base-300">
              <div className="card-body">
                <div className="alert alert-info">
                  <div>
                    <div className="font-semibold">Edit read/write relays</div>
                    <div className="text-sm">
                      NIP-65 uses <code className="px-1">read</code> and{" "}
                      <code className="px-1">write</code>
                      markers. In Marmot examples we treat:
                      <div className="mt-1">
                        <code className="px-1">read</code> = inbox relays
                        (receive giftwraps)
                        <br />
                        <code className="px-1">write</code> = outbox relays
                        (publish your metadata)
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="join w-full">
                    <input
                      type="text"
                      className="input input-bordered join-item flex-1"
                      placeholder="wss://relay.example.com"
                      value={newNip65Relay}
                      onChange={(e) => setNewNip65Relay(e.target.value)}
                    />
                    <button
                      className="btn btn-primary join-item"
                      onClick={() => {
                        const normalized = normalizeRelayUrl(newNip65Relay);
                        if (!normalized) return;
                        if (nip65Relays.some((r) => r.relay === normalized)) {
                          setNewNip65Relay("");
                          return;
                        }
                        setNip65Relays([
                          ...nip65Relays,
                          { relay: normalized, read: true, write: true },
                        ]);
                        setNewNip65Relay("");
                      }}
                      disabled={!newNip65Relay.trim()}
                    >
                      Add
                    </button>
                  </div>

                  {nip65Relays.length === 0 ? (
                    <div className="italic p-4 text-center border border-dashed border-base-300 rounded opacity-50">
                      No relays configured. Add 2-4 relays and mark them
                      read/write.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="table table-sm">
                        <thead>
                          <tr>
                            <th>Relay</th>
                            <th className="w-24">Read</th>
                            <th className="w-24">Write</th>
                            <th className="w-24"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {nip65Relays.map((row) => (
                            <tr key={row.relay}>
                              <td className="font-mono text-xs">{row.relay}</td>
                              <td>
                                <input
                                  type="checkbox"
                                  className="checkbox"
                                  checked={row.read}
                                  onChange={(e) => {
                                    const next = nip65Relays.map((r) =>
                                      r.relay === row.relay
                                        ? { ...r, read: e.target.checked }
                                        : r,
                                    );
                                    setNip65Relays(next);
                                  }}
                                />
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  className="checkbox"
                                  checked={row.write}
                                  onChange={(e) => {
                                    const next = nip65Relays.map((r) =>
                                      r.relay === row.relay
                                        ? { ...r, write: e.target.checked }
                                        : r,
                                    );
                                    setNip65Relays(next);
                                  }}
                                />
                              </td>
                              <td>
                                <button
                                  className="btn btn-xs btn-error"
                                  onClick={() =>
                                    setNip65Relays(
                                      nip65Relays.filter(
                                        (r) => r.relay !== row.relay,
                                      ),
                                    )
                                  }
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="card-actions justify-end mt-4">
                  <button
                    className="btn btn-primary"
                    onClick={handleCreateNip65Draft}
                    disabled={
                      nip65Relays.filter((r) => r.read).length === 0 ||
                      nip65Relays.filter((r) => r.write).length === 0
                    }
                  >
                    Create Draft 10002
                  </button>
                </div>
              </div>
            </div>

            {nip65Error && (
              <div className="alert alert-error">
                <span>Error: {nip65Error}</span>
              </div>
            )}

            {nip65Draft && (
              <div className="card bg-base-200">
                <div className="card-body">
                  <h3 className="card-title">Draft Event (kind 10002)</h3>
                  <JsonBlock value={nip65Draft} />
                  <div className="card-actions justify-between">
                    <button
                      className="btn btn-outline"
                      onClick={() => setNip65Draft(null)}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn btn-success"
                      onClick={handlePublishNip65}
                      disabled={isPublishingNip65}
                    >
                      {isPublishingNip65 ? "Publishing…" : "Publish 10002"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {nip65Published && (
              <div className="alert alert-success">
                <span>Published kind 10002 event: {nip65Published}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Lookup Relays Section */}
      <div className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold mb-2">Lookup Relays</h2>
          <p className="text-base-content/70 text-sm">
            Relays used for discovering user profiles and relay lists. These
            relays are queried when looking up user information.
          </p>
        </div>
        <RelayListCreator
          relays={lookupRelays}
          label="Lookup Relays"
          placeholder="wss://relay.example.com"
          emptyMessage="No lookup relays configured. Add relays below to enable user discovery."
          onRelaysChange={handleLookupRelaysChange}
        />
      </div>

      {/* Extra relays removed to avoid implicit fallbacks.
          Relay behavior should be driven by explicit NIP-65 (10002) and key package relay list (10051). */}
    </div>
  );
}
