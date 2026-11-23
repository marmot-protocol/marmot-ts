import {
  account$,
  accountName$,
  logout,
  switchAccount,
} from "../services/accounts.js";
import { hex, short } from "./ui.js";
import { useState } from "react";
import { firstValueFrom } from "rxjs";
import { state$ as publicationState$ } from "../services/key-packages.js";
import { error$ as inviteError$ } from "../services/invites.js";
import { client$ } from "../services/client.js";
import { relays$ } from "../services/relays.js";
import { useAsyncLatest } from "../hooks/use-async-latest.js";
import { use$ } from "applesauce-react/hooks";

/** Active account summary for the sidebar. */
export function AccountBadge() {
  const account = use$(account$)!;
  const name = use$(accountName$);
  const client = use$(client$)!;
  const relays = use$(relays$) ?? [];
  const publication = use$(publicationState$);
  const inviteError = use$(inviteError$);
  const packages = useAsyncLatest(
    (signal) => client.keyPackages.watchKeyPackages({ signal }),
    [client],
  );
  const current = packages
    ?.filter(
      (pkg) =>
        pkg.identifier === client.keyPackages.clientId && pkg.published?.length,
    )
    .sort(
      (a, b) =>
        Math.max(...b.published!.map((event) => event.created_at)) -
        Math.max(...a.published!.map((event) => event.created_at)),
    )[0];
  const [commandBusy, setBusy] = useState(false);
  const busy = commandBusy || !!publication?.busy;
  const [commandError, setCommandError] = useState<string>();
  const error = commandError ?? publication?.error ?? inviteError;

  async function publish(rotate = false) {
    if (busy) return;
    setBusy(true);
    setCommandError(undefined);
    try {
      if (rotate) {
        // Nostr replaces an addressable event only when the new timestamp wins.
        const latest = Math.max(
          ...(current?.published ?? []).map((event) => event.created_at),
        );
        const delay = (latest + 1) * 1000 - Date.now();
        if (delay > 0)
          await new Promise((resolve) => setTimeout(resolve, delay));
        if (client !== (await firstValueFrom(client$))) return;
        // Replace the public slot without deleting keys needed by delayed Welcomes.
        await client.keyPackages.create({ relays });
      } else {
        const pkg = await client.keyPackages.ensurePublished({ relays });
        // An existing signed publication may be missing from a restarted local relay.
        for (const event of pkg.published ?? []) {
          const responses = await client.network.publish(relays, event);
          if (!Object.values(responses).some((response) => response.ok))
            throw new Error(
              "Key-package publication was rejected by every relay",
            );
        }
      }
    } catch (cause) {
      setCommandError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2 border-t border-base-300 p-4">
      <div>
        <span title={account.pubkey}>{name || short(account.pubkey)}</span>
        <div className="text-xs text-base-content/60">{account.type}</div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-base-content/60">
          {busy
            ? "Publishing key package…"
            : current
              ? `Key package ${short(hex(current.keyPackageRef), 5)}`
              : "No session key package"}
        </span>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-xs"
            disabled={busy || !packages}
            onClick={() => void publish()}
          >
            {current ? "Publish again" : "Publish key package"}
          </button>
          <button
            className="btn btn-xs"
            disabled={busy || !current}
            onClick={() => void publish(true)}
          >
            Rotate
          </button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <button className="btn btn-xs" onClick={() => void switchAccount()}>
          switch
        </button>
        <button className="btn btn-xs btn-ghost" onClick={() => void logout()}>
          log out
        </button>
      </div>
    </div>
  );
}
