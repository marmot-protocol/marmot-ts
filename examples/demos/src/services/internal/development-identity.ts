import type { IAccount } from "applesauce-accounts";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import type { DemoRelay } from "./relay/demo-relay.js";
import { getDevelopmentName } from "../../utils/development-name.js";

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
  return account;
}

export async function publishDevelopmentProfile(
  account: IAccount,
  relay: DemoRelay,
  signal: AbortSignal,
) {
  const name = getDevelopmentName(account);
  if (!name) return;
  await relay.ready;
  signal.throwIfAborted();
  const profile = await account.signer.signEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ name, display_name: name }),
  });
  signal.throwIfAborted();
  await relay.network("identity").publish(relay.relays, profile);
}
