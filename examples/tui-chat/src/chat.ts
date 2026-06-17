import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  normalizeToPubkey,
  npubEncode,
} from "applesauce-core/helpers/pointers";
import { relaySet } from "applesauce-core/helpers/relays";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";

import {
  createApplicationMessageIntent,
  createChatRumor,
  type MarmotClient,
  type MarmotGroup,
} from "@internet-privacy/marmot-ts/client";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  createInboxRelayListEvent,
  createNip65RelayListEvent,
  deserializeApplicationData,
  getNostrGroupIdHex,
  GROUP_EVENT_KIND,
} from "@internet-privacy/marmot-ts";

import type { Directory } from "./discovery.js";
import type { RelayPool } from "./relay-pool.js";

const GIFT_WRAP_KIND = 1059;

/** Minimal signer shape (applesauce `EventSigner`) the app needs. */
type Signer = {
  getPublicKey(): Promise<string> | string;
  signEvent(draft: any): Promise<NostrEvent> | NostrEvent;
};

export interface ChatDeps {
  client: MarmotClient;
  pool: RelayPool;
  directory: Directory;
  signer: Signer;
  pubkey: string;
  relays: string[];
  /** This device's key-package slot (`d` tag / clientId). */
  clientId: string;
  /** Print a line above the input prompt. */
  log: (line: string) => void;
  /** When true, error logs include the full stack trace and cause chain. */
  debug: boolean;
}

/**
 * Drives the marmot-ts chat lifecycle: publishes the local identity (KeyPackage
 * + relay lists), restores persisted groups, subscribes for incoming welcomes
 * and group messages, and exposes the commands the TUI calls.
 */
export class ChatApp {
  readonly #deps: ChatDeps;
  readonly #groups = new Map<string, MarmotGroup>();
  readonly #groupSubs = new Map<string, { unsubscribe(): void }>();
  readonly #bound = new Set<string>();
  readonly #seen = new Set<string>();
  #invites: Rumor[] = [];
  #activeId: string | null = null;
  #inviteSub?: { unsubscribe(): void };

  constructor(deps: ChatDeps) {
    this.#deps = deps;
  }

  async start(): Promise<void> {
    await this.#publishIdentity();
    await this.#ensureKeyPackage();
    await this.#restoreGroups();
    this.#subscribeInvites();
    this.#deps.log(`ready — you are ${npubEncode(this.#deps.pubkey)}`);
    this.#deps.log(`relays: ${this.#deps.relays.join(", ")}`);
    this.#deps.log(
      `type /help for commands; plain text sends to the active group`,
    );
  }

  stop(): void {
    this.#inviteSub?.unsubscribe();
    for (const sub of this.#groupSubs.values()) sub.unsubscribe();
    this.#deps.pool.close();
  }

  whoami(): void {
    this.#deps.log(`npub: ${npubEncode(this.#deps.pubkey)}`);
    this.#deps.log(`hex:  ${this.#deps.pubkey}`);
  }

  async createGroup(name: string): Promise<void> {
    const group = await this.#deps.client.groups.create(name, {
      relays: this.#deps.relays,
    });
    await this.#attachGroup(group, false);
    this.#activeId = group.idStr;
    this.#deps.log(`created "${name}" (${short(group.idStr)}) — now active`);
  }

  async invite(input: string): Promise<void> {
    const group = this.#requireActive();
    const pubkeyHex = normalizeToPubkey(input);
    if (!pubkeyHex) throw new Error(`invalid pubkey or npub: ${input}`);

    // 1) Discover the invitee's NIP-65 (kind 10002) outbox relays — where they
    //    publish their KeyPackage. The Directory's address loader also falls
    //    back to public NIP-65 indexers, so this works even for peers we've
    //    never shared a relay with.
    this.#deps.log(`discovering KeyPackage for ${shortNpub(pubkeyHex)}…`);
    const discovered = await this.#deps.directory.outboxes(
      pubkeyHex,
      this.#deps.relays,
    );
    this.#deps.log(
      discovered.length
        ? `  NIP-65 outbox: ${discovered.join(", ")}`
        : `  no NIP-65 outbox relays found; using session relays`,
    );

    // 2) Fetch the KeyPackage (kind 30443) from the union of the discovered
    //    relays and our own session relays — so we always also look
    //    where we ourselves are connected, not only the advertised relays.
    //    relaySet normalizes + dedups, collapsing e.g. wss://x and wss://x/.
    const searchRelays = relaySet(discovered, this.#deps.relays);
    this.#deps.log(`  fetching KeyPackage from ${searchRelays.join(", ")}`);
    const kps = await this.#deps.pool.request(searchRelays, {
      kinds: [ADDRESSABLE_KEY_PACKAGE_KIND],
      authors: [pubkeyHex],
    });
    if (!kps.length) {
      throw new Error(
        `no KeyPackage found for ${shortNpub(pubkeyHex)} on ${searchRelays.join(", ")}`,
      );
    }
    this.#deps.log(`  found ${kps.length} KeyPackage event(s); inviting…`);

    await this.#deps.client.groups.invite(group.id, this.#newest(kps));
    this.#deps.log(
      `invited ${shortNpub(pubkeyHex)} to "${nameOf(group)}" — welcome delivered`,
    );
  }

  listGroups(): void {
    const arr = [...this.#groups.values()];
    if (!arr.length) {
      this.#deps.log("no groups yet — /new <name> to create one");
      return;
    }
    arr.forEach((group, index) => {
      const marker = group.idStr === this.#activeId ? "*" : " ";
      this.#deps.log(
        `${marker} [${index}] ${group.groupData?.name || "(unnamed)"} ` +
          `${short(group.idStr)} epoch=${group.state.groupContext.epoch}`,
      );
    });
  }

  useGroup(selector: string): void {
    const arr = [...this.#groups.values()];
    const group = /^\d+$/.test(selector)
      ? arr[Number(selector)]
      : arr.find((g) => g.idStr.startsWith(selector));
    if (!group) throw new Error(`no group matching "${selector}"`);
    this.#activeId = group.idStr;
    this.#deps.log(`active group: ${nameOf(group)}`);
  }

  async listInvites(): Promise<void> {
    this.#invites = await this.#deps.client.invites.getUnread();
    if (!this.#invites.length) {
      this.#deps.log("no pending invites");
      return;
    }
    this.#invites.forEach((rumor, index) => {
      this.#deps.log(
        `[${index}] welcome ${short(rumor.id)} from ${shortNpub(rumor.pubkey)}`,
      );
    });
  }

  async join(indexStr: string): Promise<void> {
    this.#invites = await this.#deps.client.invites.getUnread();
    const rumor = this.#invites[Number(indexStr)];
    if (!rumor)
      throw new Error(`no invite at index ${indexStr} — try /invites`);
    const { group } = await this.#deps.client.joinGroupFromWelcome({
      welcomeRumor: rumor,
    });
    await this.#deps.client.invites.markAsRead(rumor.id);
    await this.#attachGroup(group, true);
    this.#activeId = group.idStr;
    this.#invites = await this.#deps.client.invites.getUnread();
    this.#deps.log(`joined "${nameOf(group)}" — now active`);
  }

  async leave(): Promise<void> {
    const group = this.#requireActive();
    this.#deps.log(
      "⚠ leave sends a plain MLS Remove; spec peers expect SelfRemove (gap B6) — divergent",
    );
    await this.#deps.client.groups.leave(group.id);
    this.#groupSubs.get(group.idStr)?.unsubscribe();
    this.#groupSubs.delete(group.idStr);
    this.#groups.delete(group.idStr);
    if (this.#activeId === group.idStr) {
      this.#activeId = [...this.#groups.keys()][0] ?? null;
    }
    this.#deps.log("left group");
  }

  async sendText(text: string): Promise<void> {
    const group = this.#requireActive();
    const pubkey = await group.signer.getPublicKey();
    const intent = createApplicationMessageIntent(
      createChatRumor({ pubkey, content: text }),
    );
    await this.#deps.client.groups.send(group.id, intent);
    this.#deps.log(`[${nameOf(group)}] you: ${text}`);
  }

  async keyPackage(sub: string): Promise<void> {
    const action = (sub || "show").toLowerCase();
    switch (action) {
      case "show":
        await this.#showKeyPackages();
        break;
      case "publish":
      case "new": {
        const kp = await this.#deps.client.keyPackages.create({
          relays: this.#deps.relays,
        });
        this.#deps.log(
          `published new KeyPackage ${shortHex(kp.keyPackageRef)} ` +
            `(slot ${kp.identifier ?? "?"}) to ${this.#deps.relays.join(", ")}`,
        );
        break;
      }
      case "rotate": {
        const list = await this.#deps.client.keyPackages.list();
        const current =
          list.find((p) => !p.used && p.identifier === this.#deps.clientId) ??
          list.find((p) => !p.used) ??
          list[0];
        if (!current) {
          throw new Error("no KeyPackage to rotate — try /keypackage publish");
        }
        const rotated = await this.#deps.client.keyPackages.rotate(
          current.keyPackageRef,
          { relays: this.#deps.relays },
        );
        this.#deps.log(
          `rotated KeyPackage ${shortHex(current.keyPackageRef)} → ` +
            `${shortHex(rotated.keyPackageRef)} (slot ${rotated.identifier ?? "?"})`,
        );
        break;
      }
      default:
        throw new Error("usage: /keypackage [show|publish|rotate]");
    }
  }

  // --- internals -------------------------------------------------------------

  async #publishIdentity(): Promise<void> {
    const nip65 = createNip65RelayListEvent({
      pubkey: this.#deps.pubkey,
      relays: this.#deps.relays,
    });
    const inbox = createInboxRelayListEvent({
      pubkey: this.#deps.pubkey,
      relays: this.#deps.relays,
    });
    await this.#deps.pool.publish(
      this.#deps.relays,
      await this.#deps.signer.signEvent(nip65),
    );
    await this.#deps.pool.publish(
      this.#deps.relays,
      await this.#deps.signer.signEvent(inbox),
    );
  }

  async #ensureKeyPackage(): Promise<void> {
    const existing = await this.#deps.client.keyPackages.list();
    if (existing.some((pkg) => !pkg.used)) return;
    await this.#deps.client.keyPackages.create({ relays: this.#deps.relays });
    this.#deps.log("published a fresh KeyPackage so others can invite you");
  }

  async #restoreGroups(): Promise<void> {
    const groups = await this.#deps.client.groups.loadAll();
    for (const group of groups) await this.#attachGroup(group, true);
    if (groups.length && !this.#activeId) this.#activeId = groups[0].idStr;
    if (groups.length) this.#deps.log(`restored ${groups.length} group(s)`);
  }

  async #attachGroup(group: MarmotGroup, catchUp: boolean): Promise<void> {
    const id = group.idStr;
    this.#groups.set(id, group);
    if (!this.#bound.has(id)) {
      group.on("applicationMessage", (bytes: Uint8Array) =>
        this.#renderApp(group, bytes),
      );
      this.#bound.add(id);
    }
    const relays = group.relays?.length
      ? relaySet(group.relays)
      : this.#deps.relays;
    const h = getNostrGroupIdHex(group.state);
    if (catchUp) {
      const backlog = await this.#deps.pool.request(relays, {
        kinds: [GROUP_EVENT_KIND],
        "#h": [h],
      });
      await this.#drainIngest(group, backlog);
    }
    const sub = this.#deps.pool.subscription(relays, {
      kinds: [GROUP_EVENT_KIND],
      "#h": [h],
    });
    this.#groupSubs.get(id)?.unsubscribe();
    this.#groupSubs.set(
      id,
      sub.subscribe({ next: (event) => void this.#onGroupEvent(group, event) }),
    );
  }

  #subscribeInvites(): void {
    const sub = this.#deps.pool.subscription(this.#deps.relays, {
      kinds: [GIFT_WRAP_KIND],
      "#p": [this.#deps.pubkey],
    });
    this.#inviteSub = sub.subscribe({
      next: (event) => void this.#onGiftWrap(event),
    });
  }

  async #onGiftWrap(event: NostrEvent): Promise<void> {
    if (this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    try {
      const added = await this.#deps.client.invites.ingestEvent(event);
      if (!added) return;
      await this.#deps.client.invites.decryptGiftWraps();
      this.#invites = await this.#deps.client.invites.getUnread();
      this.#deps.log(
        `📨 new invite — ${this.#invites.length} pending; /invites to list, /join <n> to accept`,
      );
    } catch (err) {
      this.#deps.log(`invite error: ${formatError(err, this.#deps.debug)}`);
    }
  }

  async #onGroupEvent(group: MarmotGroup, event: NostrEvent): Promise<void> {
    if (this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    await this.#drainIngest(group, [event]);
  }

  async #drainIngest(group: MarmotGroup, events: NostrEvent[]): Promise<void> {
    if (!events.length) return;
    try {
      for await (const _result of group.ingest(events)) {
        // Application messages surface via the "applicationMessage" event.
        void _result;
      }
    } catch (err) {
      this.#deps.log(`ingest error: ${formatError(err, this.#deps.debug)}`);
    }
  }

  #renderApp(group: MarmotGroup, bytes: Uint8Array): void {
    try {
      const rumor = deserializeApplicationData(bytes);
      const who =
        rumor.pubkey === this.#deps.pubkey ? "you" : shortNpub(rumor.pubkey);
      const label = nameOf(group);
      this.#deps.log(`[${label}] ${who}: ${rumor.content}`);
    } catch (err) {
      this.#deps.log("(received an app message that could not be decoded)");
      if (this.#deps.debug) {
        this.#deps.log(formatError(err, true));
      }
    }
  }

  async #showKeyPackages(): Promise<void> {
    const list = await this.#deps.client.keyPackages.list();
    if (!list.length) {
      this.#deps.log(
        "no KeyPackages stored — /keypackage publish to create one",
      );
      return;
    }
    this.#deps.log(`KeyPackages (${list.length}):`);
    for (const pkg of list) {
      const flags = [
        pkg.used ? "used" : "active",
        pkg.identifier === this.#deps.clientId ? "this-client" : null,
      ]
        .filter(Boolean)
        .join(", ");
      const kinds = (pkg.published ?? []).map((e) => e.kind).join("/");
      this.#deps.log(
        `  • ref ${shortHex(pkg.keyPackageRef)} slot=${pkg.identifier ?? "?"} ` +
          `[${flags}] published=${kinds || "no"}`,
      );
    }
  }

  #requireActive(): MarmotGroup {
    if (!this.#activeId) {
      throw new Error("no active group — /new <name> or /join <n> first");
    }
    const group = this.#groups.get(this.#activeId);
    if (!group) throw new Error("active group is not loaded");
    return group;
  }

  #newest(events: NostrEvent[]): NostrEvent {
    return events.slice().sort((a, b) => b.created_at - a.created_at)[0];
  }
}

function nameOf(group: MarmotGroup): string {
  return group.groupData?.name || short(group.idStr);
}

/** A short, recognizable npub label (not copy-paste complete) for log lines. */
function shortNpub(pubkeyHex: string): string {
  return `${npubEncode(pubkeyHex).slice(0, 12)}…`;
}

function shortHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex").slice(0, 8);
}

function short(value: string): string {
  return value.slice(0, 8);
}

/**
 * Render an error for the log. In debug mode this includes the full stack
 * trace and walks the `cause` chain so wrapped errors are fully visible;
 * otherwise it is just the one-line message.
 */
export function formatError(err: unknown, debug: boolean): string {
  if (!(err instanceof Error)) return String(err);
  if (!debug) return err.message;

  let out = err.stack ?? `${err.name}: ${err.message}`;
  let cause: unknown = (err as { cause?: unknown }).cause;
  while (cause) {
    const rendered =
      cause instanceof Error
        ? (cause.stack ?? `${cause.name}: ${cause.message}`)
        : String(cause);
    out += `\ncaused by: ${rendered}`;
    cause =
      cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined;
  }
  return out;
}
