import { AccountManager, type IAccount } from "applesauce-accounts";
import { registerCommonAccountTypes } from "applesauce-accounts/accounts";
import { use$ } from "applesauce-react/hooks";
import { RelayPool } from "applesauce-relay";
import { NostrConnectSigner } from "applesauce-signers";
import { createDevelopmentAccount } from "./lib/development-identity.js";

const ACCOUNTS_KEY = "marmot-demos:accounts";
const ACTIVE_KEY = "marmot-demos:active";

/** Relay pool used by the login flow (NIP-46 bunker and QR signers). */
export const pool = new RelayPool();

// Restored NostrConnect accounts build their signer from this static pool,
// so it must be set before `fromJSON` below.
NostrConnectSigner.pool = pool;

/** The one account manager shared by the whole demos app. */
export const accounts = new AccountManager();
registerCommonAccountTypes(accounts);

// Restore saved accounts, then persist every change. Restoring first means the
// initial empty values can't overwrite what was saved.
try {
  accounts.fromJSON(
    JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "[]"),
    true,
  );
} catch (error) {
  console.error("Failed to restore saved accounts", error);
}

// Store the serialized active account in this tab so reloads also survive
// concurrent changes to the shared saved-account list.
try {
  const serialized = JSON.parse(sessionStorage.getItem(ACTIVE_KEY) || "null");
  if (serialized) {
    accounts.fromJSON([serialized], true);
    const restored = accounts.getAccount(serialized.id);
    if (restored) accounts.setActive(restored);
  }
} catch (error) {
  console.error("Failed to restore session account", error);
}
if (!accounts.active) login(createDevelopmentAccount());

accounts.accounts$.subscribe(() =>
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts.toJSON(true))),
);
accounts.active$.subscribe((account) => {
  if (account)
    sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(account.toJSON()));
  else sessionStorage.removeItem(ACTIVE_KEY);
});

/**
 * Add `account` (or reuse a saved account for the same pubkey and type) and
 * make it active.
 */
export function login(account: IAccount) {
  const existing = accounts.accounts.find(
    (saved) => saved.type === account.type && saved.pubkey === account.pubkey,
  );
  if (existing) {
    existing.signer = account.signer;
    accounts.setActive(existing);
  } else {
    accounts.addAccount(account);
    accounts.setActive(account);
  }
}

/** Return to the login screen, keeping the account saved for later. */
export function switchAccount() {
  accounts.clearActive();
}

/** Forget the active account entirely. */
export function logout() {
  const active = accounts.active;
  if (!active) return;
  accounts.clearActive();
  accounts.removeAccount(active);
}

/** The active account, or `undefined` when logged out. */
export function useActiveAccount(): IAccount | undefined {
  return use$(accounts.active$);
}

/** Every saved account. */
export function useAccounts(): IAccount[] {
  return use$(accounts.accounts$);
}

/** The active account inside the logged-in app, where one always exists. */
export function useAccount(): IAccount {
  const account = useActiveAccount();
  if (!account) throw new Error("useAccount() requires a logged-in account");
  return account;
}
