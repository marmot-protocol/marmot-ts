import { qrcode } from "@libs/qrcode";
import {
  ExtensionAccount,
  NostrConnectAccount,
  PrivateKeyAccount,
} from "applesauce-accounts/accounts";
import { ExtensionMissingError, NostrConnectSigner } from "applesauce-signers";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { accounts, login, useAccounts } from "../accounts.js";
import { short } from "../lib/ui.js";
import { createDevelopmentAccount } from "../lib/development-identity.js";

const DEFAULT_QR_RELAY = "wss://bucket.coracle.social";
const QR_TIMEOUT_MS = 120_000;

type Method = "extension" | "bunker" | "key" | "qr";

/**
 * Full-screen login. Marmot needs a signer that can sign events and do NIP-44
 * encryption (to open gift-wrapped invites); every method here supports both.
 */
export function LoginView() {
  const saved = useAccounts();
  const [busy, setBusy] = useState<Method | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bunkerUri, setBunkerUri] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [qrRelay, setQrRelay] = useState(DEFAULT_QR_RELAY);
  const [qrUri, setQrUri] = useState<string | null>(null);
  const qrSession = useRef<{
    signer: NostrConnectSigner;
    abort: AbortController;
  }>(null);

  /** Run one login method, tracking its busy state and errors. */
  const attempt = async (method: Method, run: () => Promise<void>) => {
    setBusy(method);
    setError(null);
    try {
      await run();
    } catch (err) {
      if (err instanceof ExtensionMissingError)
        setError("No NIP-07 extension found");
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const stopQr = (closeSigner = true) => {
    const session = qrSession.current;
    qrSession.current = null;
    setQrUri(null);
    if (!session) return;
    session.abort.abort();
    if (closeSigner) void session.signer.close();
  };

  // Close a pending QR session when the view unmounts.
  useEffect(() => () => stopQr(), []);

  const startQr = () =>
    attempt("qr", async () => {
      stopQr();
      const signer = new NostrConnectSigner({ relays: [qrRelay.trim()] });
      const abort = new AbortController();
      qrSession.current = { signer, abort };
      setQrUri(signer.getNostrConnectURI({ name: "marmot-ts demos" }));

      const timeout = setTimeout(() => abort.abort(), QR_TIMEOUT_MS);
      try {
        await signer.waitForSigner(abort.signal);
      } catch (err) {
        // Cancelled by the user or replaced by a newer session: not an error.
        if (qrSession.current?.signer !== signer) return;
        throw err instanceof Error && err.message === "Aborted"
          ? new Error("Timed out waiting for the signer")
          : err;
      } finally {
        clearTimeout(timeout);
      }
      const pubkey = await signer.getPublicKey();
      // The signer now belongs to the account; don't close it.
      stopQr(false);
      login(new NostrConnectAccount(pubkey, signer));
    });

  const disabled = busy !== null && busy !== "qr";

  return (
    <div className="flex min-h-screen items-center justify-center bg-base-200 p-6">
      <div className="card w-full max-w-md bg-base-100 shadow-sm">
        <div className="card-body gap-5">
          <div className="flex flex-col gap-1">
            <h1 className="card-title text-xl">marmot-ts demos</h1>
            <p className="text-sm text-base-content/60">
              Log in with a Nostr signer. Demos use it to sign key packages,
              group events and gift wraps. Events stay on the in-browser demo
              relay.
            </p>
          </div>

          {saved.length > 0 && (
            <Section title="Saved accounts">
              <ul className="list rounded-box border border-base-300">
                {saved.map((account) => (
                  <li key={account.id} className="list-row items-center py-2">
                    <div className="list-col-grow">
                      <code>{short(account.pubkey)}</code>{" "}
                      <span className="text-xs text-base-content/60">
                        {account.type}
                      </span>
                    </div>
                    <button
                      className="btn btn-xs btn-primary"
                      onClick={() => accounts.setActive(account)}
                    >
                      use
                    </button>
                    <button
                      className="btn btn-xs btn-ghost"
                      onClick={() => accounts.removeAccount(account)}
                    >
                      forget
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Browser extension (NIP-07)">
            <button
              className="btn btn-primary"
              disabled={disabled}
              onClick={() =>
                attempt("extension", async () =>
                  login(await ExtensionAccount.fromExtension()),
                )
              }
            >
              {busy === "extension" && (
                <span className="loading loading-spinner loading-sm" />
              )}
              {busy === "extension"
                ? "Waiting for extension…"
                : "Use extension"}
            </button>
          </Section>

          <Section title="Remote signer (NIP-46)">
            {qrUri ? (
              <div className="flex flex-col items-center gap-2">
                <a
                  href={qrUri}
                  title="Open in signer app"
                  className="block size-56 rounded-box bg-white [&_svg]:size-full"
                  dangerouslySetInnerHTML={{
                    __html: qrcode(qrUri, { output: "svg", border: 2 }),
                  }}
                />
                <p className="text-sm text-base-content/60">
                  Scan with a signer app such as Amber.
                </p>
                <button className="btn btn-sm" onClick={() => stopQr()}>
                  Cancel
                </button>
              </div>
            ) : (
              <form
                className="join w-full"
                onSubmit={(e) => {
                  e.preventDefault();
                  void startQr();
                }}
              >
                <input
                  type="text"
                  className="input join-item w-full"
                  value={qrRelay}
                  onChange={(e) => setQrRelay(e.target.value)}
                  placeholder="wss://relay for nostrconnect://"
                />
                <button
                  type="submit"
                  className="btn join-item"
                  disabled={disabled || !qrRelay.trim()}
                >
                  Show QR code
                </button>
              </form>
            )}
            <form
              className="join w-full"
              onSubmit={(e) => {
                e.preventDefault();
                void attempt("bunker", async () => {
                  const signer = await NostrConnectSigner.fromBunkerURI(
                    bunkerUri.trim(),
                  );
                  login(
                    new NostrConnectAccount(
                      await signer.getPublicKey(),
                      signer,
                    ),
                  );
                  setBunkerUri("");
                });
              }}
            >
              <input
                type="text"
                className="input join-item w-full"
                value={bunkerUri}
                onChange={(e) => setBunkerUri(e.target.value)}
                placeholder="bunker://…"
              />
              <button
                type="submit"
                className="btn join-item"
                disabled={disabled || !bunkerUri.trim()}
              >
                {busy === "bunker" ? "Connecting…" : "Connect"}
              </button>
            </form>
          </Section>

          <Section title="Private key">
            <p className="text-sm text-base-content/60">
              Stored unencrypted in localStorage. Use a throwaway key.
            </p>
            <form
              className="join w-full"
              onSubmit={(e) => {
                e.preventDefault();
                void attempt("key", async () => {
                  login(PrivateKeyAccount.fromKey(secretKey.trim()));
                  setSecretKey("");
                });
              }}
            >
              <input
                type="password"
                className="input join-item w-full"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder="nsec1… or hex"
              />
              <button
                type="submit"
                className="btn join-item"
                disabled={disabled || !secretKey.trim()}
              >
                Log in
              </button>
            </form>
            <button
              className="btn btn-outline"
              disabled={disabled}
              onClick={() =>
                attempt("key", async () => login(createDevelopmentAccount()))
              }
            >
              Generate a new key
            </button>
          </Section>

          {error && (
            <div role="alert" className="alert alert-error alert-soft">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-base-content/60 uppercase">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}
