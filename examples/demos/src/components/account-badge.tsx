import {
  account$,
  accountName$,
  logout,
  switchAccount,
} from "../services/accounts.js";
import { hex, short } from "./ui.js";
import * as keyPackages from "../services/key-packages.js";
import { use$ } from "applesauce-react/hooks";

/** Active account summary for the sidebar. */
export function AccountBadge() {
  const account = use$(account$)!;
  const name = use$(accountName$);
  const keys = use$(keyPackages.state$) ?? { busy: false, enabled: false };
  return (
    <div className="flex flex-col gap-2 border-t border-base-300 p-4">
      <div>
        <span title={account.pubkey}>{name || short(account.pubkey)}</span>
        <div className="text-xs text-base-content/60">{account.type}</div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-base-content/60">
          {keys.busy
            ? "Publishing key package…"
            : keys.current
              ? `Key package ${short(hex(keys.current.keyPackageRef), 5)}`
              : "No session key package"}
        </span>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-xs"
            disabled={keys.busy}
            onClick={() => void keyPackages.publish().catch(() => {})}
          >
            {keys.current ? "Publish again" : "Publish key package"}
          </button>
          <button
            className="btn btn-xs"
            disabled={keys.busy || !keys.current}
            onClick={() => void keyPackages.rotate().catch(() => {})}
          >
            Rotate
          </button>
        </div>
        {keys.error && (
          <p role="alert" className="text-xs text-error">
            {keys.error}
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
