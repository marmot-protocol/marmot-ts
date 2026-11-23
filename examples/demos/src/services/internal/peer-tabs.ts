import { Observable } from "rxjs";

export type PeerTab = { id: string; pubkey: string };
type Presence =
  | { type: "hello" | "leave"; id: string }
  | { type: "presence"; id: string; pubkey: string };

const HEARTBEAT_MS = 20_000;
const TTL_MS = 120_000;

/** Contacts-only presence channel; never sends identities through the relay transport. */
export function peerTabs$(pubkey: string): Observable<PeerTab[]> {
  return new Observable((subscriber) => {
    subscriber.next([]);
    if (typeof BroadcastChannel === "undefined")
      throw new Error("Peer discovery requires BroadcastChannel support");
    const channel = new BroadcastChannel("marmot-demos:contacts");
    const id = crypto.randomUUID();
    const peers = new Map<string, PeerTab & { seen: number }>();
    const announce = () =>
      channel.postMessage({ type: "presence", id, pubkey } satisfies Presence);
    const emit = () =>
      subscriber.next(
        [...peers.values()]
          .map(({ id, pubkey }) => ({ id, pubkey }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    channel.onmessage = ({ data }: MessageEvent<Presence>) => {
      if (!data || typeof data.id !== "string" || data.id === id) return;
      if (data.type === "hello") announce();
      else if (data.type === "leave") {
        if (peers.delete(data.id)) emit();
      } else if (
        data.type === "presence" &&
        /^[0-9a-f]{64}$/.test(data.pubkey)
      ) {
        const changed = peers.get(data.id)?.pubkey !== data.pubkey;
        peers.set(data.id, {
          id: data.id,
          pubkey: data.pubkey,
          seen: Date.now(),
        });
        if (changed) emit();
      }
    };
    channel.postMessage({ type: "hello", id } satisfies Presence);
    announce();
    const timer = setInterval(() => {
      announce();
      let changed = false;
      for (const [id, peer] of peers)
        if (Date.now() - peer.seen >= TTL_MS) {
          peers.delete(id);
          changed = true;
        }
      if (changed) emit();
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      channel.postMessage({ type: "leave", id } satisfies Presence);
      channel.close();
    };
  });
}
