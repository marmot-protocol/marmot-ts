import { AccountManager, type SerializedAccount } from "applesauce-accounts";
import { registerCommonAccountTypes } from "applesauce-accounts/accounts";
import { ActionRunner } from "applesauce-actions";
import { castUser } from "applesauce-common/casts/user";
import { chainable } from "applesauce-common/observable/chainable";
import { EventFactory } from "applesauce-core";
import { relaySet, safeParse } from "applesauce-core/helpers";
import { NostrConnectSigner } from "applesauce-signers";
import { getKeyPackageRelayList, KEY_PACKAGE_RELAY_LIST_KIND } from "marmot-ts";
import { combineLatest, map, of, switchMap } from "rxjs";
import { eventStore, pool } from "./nostr";
import { extraRelays$ } from "./settings";

// create an account manager instance
const accounts = new AccountManager();

// register common account types
registerCommonAccountTypes(accounts);

// Setup nostr connect signer
NostrConnectSigner.pool = pool;

// first load all accounts from localStorage
const json = safeParse<SerializedAccount[]>(
  localStorage.getItem("accounts") ?? "[]",
);
if (json) accounts.fromJSON(json, true);

// next, subscribe to any accounts added or removed
accounts.accounts$.subscribe(() => {
  // save all the accounts into the "accounts" field
  localStorage.setItem("accounts", JSON.stringify(accounts.toJSON()));
});

// load active account from storage
const active = localStorage.getItem("active");
if (active) {
  try {
    accounts.setActive(active);
  } catch (error) {}
}

// subscribe to active changes
accounts.active$.subscribe((account) => {
  if (account) localStorage.setItem("active", account.id);
  else localStorage.removeItem("active");
});

/** An observable of the current active user */
export const user$ = chainable(
  accounts.active$.pipe(
    map((account) => account && castUser(account.pubkey, eventStore)),
  ),
);

// Create an event factory for the current active account
export const factory = new EventFactory({ signer: accounts.signer });
export const actions = new ActionRunner(eventStore, factory, (event, relays) =>
  pool.publish(relaySet(relays, extraRelays$.value), event),
);

/** An observable of the current account's mailboxes */
export const mailboxes$ = user$.mailboxes$;
export const contacts$ = user$.contacts$;

/** Observable of current user's key package relay list */
export const keyPackageRelays$ = combineLatest([user$, user$.outboxes$]).pipe(
  switchMap(([user, outboxes]) =>
    user
      ? user
          .replaceable(KEY_PACKAGE_RELAY_LIST_KIND, undefined, outboxes)
          .pipe(
            map((event) => (event ? getKeyPackageRelayList(event) : undefined)),
          )
      : of(undefined),
  ),
);

export default accounts;
