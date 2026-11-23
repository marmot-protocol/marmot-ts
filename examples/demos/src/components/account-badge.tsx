import { logout, switchAccount, useAccount } from "../accounts.js";
import { short } from "../lib/ui.js";
import { getDevelopmentName } from "../lib/development-identity.js";

/** Active account summary for the sidebar. */
export function AccountBadge() {
  const account = useAccount();
  return (
    <div className="flex flex-col gap-2 border-t border-base-300 p-4">
      <div>
        <span title={account.pubkey}>
          {getDevelopmentName(account) || short(account.pubkey)}
        </span>
        <div className="text-xs text-base-content/60">{account.type}</div>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-xs" onClick={switchAccount}>
          switch
        </button>
        <button className="btn btn-xs btn-ghost" onClick={logout}>
          log out
        </button>
      </div>
    </div>
  );
}
