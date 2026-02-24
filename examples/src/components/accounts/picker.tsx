import { useObservable } from "../../hooks/use-observable";
import accountManager from "../../lib/accounts";
import { UserAvatar, UserName } from "../nostr-user";

export default function AccountSwitcher() {
  const activeAccount = useObservable(accountManager.active$);
  const accounts = useObservable(accountManager.accounts$);

  const handleSignIn = () => {
    (document.getElementById("signin_modal") as HTMLDialogElement)?.showModal();
  };

  const handleSwitchAccount = (accountId: string) => {
    accountManager.setActive(accountId);
  };

  const handleSignOut = () => {
    if (activeAccount) {
      accountManager.removeAccount(activeAccount.id);
    }
  };

  // If no accounts exist at all, show sign in button
  if (!accounts || accounts.length === 0) {
    return (
      <button className="btn btn-primary w-full" onClick={handleSignIn}>
        Sign In
      </button>
    );
  }

  return (
    <>
      <div className="dropdown dropdown-top dropdown-end w-full">
        <div
          tabIndex={0}
          role="button"
          className="flex items-center gap-3 p-2 rounded-lg hover:bg-base-300 cursor-pointer transition-colors w-full"
        >
          {activeAccount ? (
            <>
              <UserAvatar pubkey={activeAccount.pubkey} />
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">
                  <UserName pubkey={activeAccount.pubkey} />
                </div>
                <div className="text-xs text-base-content/60 truncate">
                  {activeAccount.pubkey.slice(0, 8)}...
                  {activeAccount.pubkey.slice(-8)}
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 min-w-0">
              <div className="font-semibold">Select Account</div>
              <div className="text-xs text-base-content/60">
                Choose an account to continue
              </div>
            </div>
          )}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="w-5 h-5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8.25 15L12 18.75 15.75 15m-7.5-6L12 5.25 15.75 9"
            />
          </svg>
        </div>

        <ul
          tabIndex={0}
          className="dropdown-content menu bg-base-200 rounded-box z-1 p-0 w-full border-t-2 border-b-2 border-base-300 pt-2"
        >
          {accounts
            .filter(
              (account) => !activeAccount || account.id !== activeAccount.id,
            )
            .map((account) => (
              <li key={account.id}>
                <a onClick={() => handleSwitchAccount(account.id)}>
                  <div className="flex items-center gap-2 w-full">
                    <UserAvatar pubkey={account.pubkey} />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate">
                        <UserName pubkey={account.pubkey} />
                      </div>
                      <div className="text-xs opacity-60 truncate">
                        {account.pubkey.slice(0, 8)}...
                        {account.pubkey.slice(-8)}
                      </div>
                    </div>
                  </div>
                </a>
              </li>
            ))}

          <li className="border-t border-base-300 my-2 pt-2 ">
            <a onClick={handleSignIn}>Add Account</a>
            {activeAccount && (
              <a className="text-error" onClick={handleSignOut}>
                Sign Out
              </a>
            )}
          </li>

          {/* Relay Configuration */}
          <li className="border-t border-base-300 pt-2">
            <a href="#settings">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-4 h-4 inline mr-2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75"
                />
              </svg>
              Configure Relays
            </a>
          </li>
        </ul>
      </div>
    </>
  );
}
