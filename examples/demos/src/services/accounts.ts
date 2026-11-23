import { AccountManager, type IAccount } from "applesauce-accounts";
import { registerCommonAccountTypes } from "applesauce-accounts/accounts";
import { RelayPool } from "applesauce-relay";
import { NostrConnectSigner } from "applesauce-signers";
import { distinctUntilChanged, map } from "rxjs";
import { createDevelopmentAccount } from "./internal/development-identity.js";
import { getDevelopmentName } from "../utils/development-name.js";

const ACCOUNTS_KEY = "marmot-demos:accounts";
const ACTIVE_KEY = "marmot-demos:active";

// Restored NIP-46 accounts need their signer pool before deserialization.
NostrConnectSigner.pool = new RelayPool();
const manager = new AccountManager();
registerCommonAccountTypes(manager);

try {
  manager.fromJSON(
    JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "[]"),
    true,
  );
} catch (error) {
  console.error("Failed to restore saved accounts", error);
}
try {
  const serialized = JSON.parse(sessionStorage.getItem(ACTIVE_KEY) || "null");
  if (serialized) {
    manager.fromJSON([serialized], true);
    const restored = manager.getAccount(serialized.id);
    if (restored) manager.setActive(restored);
  }
} catch (error) {
  console.error("Failed to restore session account", error);
}
if (!manager.active) activate(createDevelopmentAccount());

// Subscribe only after restoration, so initial empty state cannot erase storage.
manager.accounts$.subscribe(() =>
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(manager.toJSON(true))),
);
manager.active$.subscribe((account) => {
  if (account)
    sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(account.toJSON()));
  else sessionStorage.removeItem(ACTIVE_KEY);
});

export const account$ = manager.active$.asObservable();
export const accounts$ = manager.accounts$.asObservable();
export const accountName$ = account$.pipe(
  map((account) => account && getDevelopmentName(account)),
  distinctUntilChanged(),
);

function activate(account: IAccount): void {
  const existing = manager.accounts.find(
    (saved) => saved.type === account.type && saved.pubkey === account.pubkey,
  );
  if (existing) {
    existing.signer = account.signer;
    manager.setActive(existing);
  } else {
    manager.addAccount(account);
    manager.setActive(account);
  }
}

export async function login(account: IAccount): Promise<void> {
  activate(account);
}

export async function selectAccount(id: string): Promise<void> {
  const account = manager.getAccount(id);
  if (!account) throw new Error("Saved account is no longer available");
  manager.setActive(account);
}

export async function forgetAccount(id: string): Promise<void> {
  const account = manager.getAccount(id);
  if (account) manager.removeAccount(account);
}

export async function switchAccount(): Promise<void> {
  manager.clearActive();
}

export async function logout(): Promise<void> {
  const active = manager.active;
  if (!active) return;
  manager.clearActive();
  manager.removeAccount(active);
}

export async function loginDevelopmentAccount(): Promise<void> {
  activate(createDevelopmentAccount());
}
