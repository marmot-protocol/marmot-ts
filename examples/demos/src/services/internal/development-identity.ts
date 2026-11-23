import type { IAccount } from "applesauce-accounts";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import type { NostrNetworkInterface } from "@internet-privacy/marmot-ts/client";
import { DEMO_RELAY_URL } from "./relay/demo-relay.js";
import { getDevelopmentName } from "../../utils/development-name.js";

const newAccounts = new WeakSet<IAccount>();

const ADJECTIVES = [
  "Amber",
  "Brisk",
  "Calm",
  "Cosmic",
  "Lucky",
  "Mellow",
  "Sunny",
  "Velvet",
];
const ANIMALS = [
  "Badger",
  "Finch",
  "Fox",
  "Heron",
  "Lynx",
  "Otter",
  "Panda",
  "Wren",
];

export function createDevelopmentAccount(): PrivateKeyAccount {
  const random = crypto.getRandomValues(new Uint32Array(3));
  const account = PrivateKeyAccount.generateNew();
  account.metadata = {
    developmentName: `${ADJECTIVES[random[0] % ADJECTIVES.length]} ${ANIMALS[random[1] % ANIMALS.length]} ${random[2] % 10_000}`,
  };
  newAccounts.add(account);
  return account;
}

/** Consume the creation intent once; restored and imported accounts never have it. */
export function takeInitialKeyPackagePublication(account: IAccount): boolean {
  return newAccounts.delete(account);
}

export async function publishDevelopmentProfile(
  account: IAccount,
  network: NostrNetworkInterface,
  signal: AbortSignal,
) {
  const name = getDevelopmentName(account);
  if (!name) return;
  signal.throwIfAborted();
  const profile = await account.signer.signEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ name, display_name: name }),
  });
  signal.throwIfAborted();
  await network.publish([DEMO_RELAY_URL], profile);
  return profile;
}
