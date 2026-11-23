import { MarmotClient, memoryDatabase } from "@internet-privacy/marmot-ts";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import type { IAccount } from "applesauce-accounts";
import type { DemoRelay } from "../services/internal/relay/demo-relay.js";

/** A named demo participant: a Nostr account plus its own `MarmotClient`. */
export type Actor = {
  name: string;
  pubkey: string;
  client: MarmotClient;
};

/**
 * Build an actor from any applesauce account, with in-memory storage and a
 * network view onto the demo relay.
 *
 * `clientId` is the caller's: each example decides how it creates and keeps
 * its own (64 lowercase hex chars, the key package `d` slot).
 */
export function createActor(
  name: string,
  account: IAccount,
  relay: DemoRelay,
  clientId: string,
): Actor {
  const client = new MarmotClient({
    signer: account.signer,
    network: relay.network(name),
    database: memoryDatabase(),
    clientId,
  });
  return { name, pubkey: account.pubkey, client };
}

/** The logged-in user as a demo actor named "you". */
export function createUserActor(
  account: IAccount,
  relay: DemoRelay,
  clientId: string,
): Actor {
  return createActor("you", account, relay, clientId);
}

/** A simulated peer with a throwaway key, for multi-party demos. */
export function createPeerActor(
  name: string,
  relay: DemoRelay,
  clientId: string,
): Actor {
  return createActor(name, PrivateKeyAccount.generateNew(), relay, clientId);
}
