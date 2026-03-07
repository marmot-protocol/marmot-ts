import { randomBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import { describe, expect, it } from "vitest";

import { NotificationManager } from "../client/notification-manager.js";
import {
  createNotificationGiftWrap,
  createNotificationTriggerRumor,
  createTokenListResponseRumor,
  createTokenRemovalRumor,
  createTokenRequestRumor,
  encryptPushToken,
  type ApnsServerConfig,
  type ApnsSubscription,
  type FcmServerConfig,
  type FcmSubscription,
  type NotificationServerConfig,
  type TokenEntry,
  type WebPushServerConfig,
  type WebPushSubscription,
} from "../core/notification.js";
import {
  MIP05_APNS_TOKEN_SIZE,
  MIP05_ENCRYPTED_TOKEN_SIZE,
  MIP05_TOKEN_BATCH_LIMIT,
  NOTIFICATION_TRIGGER_KIND,
  TOKEN_LIST_RESPONSE_KIND,
  TOKEN_REMOVAL_KIND,
  TOKEN_REQUEST_KIND,
} from "../core/protocol.js";
import { InMemoryKeyValueStore } from "../extra/in-memory-key-value-store.js";
import { MockNetwork } from "./helpers/mock-network.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeWebPushSubscription(): WebPushSubscription {
  return {
    type: "web-push",
    endpoint: "https://updates.push.services.mozilla.com/push/v1/abc123",
    p256dh: randomBytes(65),
    auth: randomBytes(16),
  };
}

function makeApnsSubscription(): ApnsSubscription {
  return {
    type: "apns",
    deviceToken: randomBytes(MIP05_APNS_TOKEN_SIZE),
  };
}

function makeFcmSubscription(token = "fcm-token-abc123"): FcmSubscription {
  return {
    type: "fcm",
    registrationToken: token,
  };
}

function makeWebPushServerConfig(): WebPushServerConfig {
  return {
    platform: "web-push",
    pubkey: "a".repeat(64),
    relays: ["wss://notif.example.com"],
    vapidKey: "BNbxDwgBqr4P2hljSW6oFMsL5" + "x".repeat(62),
  };
}

function makeApnsServerConfig(): ApnsServerConfig {
  return {
    platform: "apns",
    pubkey: "a".repeat(64),
    relays: ["wss://notif.example.com"],
  };
}

function makeFcmServerConfig(): FcmServerConfig {
  return {
    platform: "fcm",
    pubkey: "a".repeat(64),
    relays: ["wss://notif.example.com"],
  };
}

function makeSigner(pubkeyHex = "b".repeat(64)) {
  return {
    getPublicKey: async () => pubkeyHex,
    signEvent: async (template: any) => ({ ...template, sig: "00".repeat(32) }),
  };
}

// ---------------------------------------------------------------------------
// Core: encryptPushToken — Web Push (0x03)
// ---------------------------------------------------------------------------

describe("encryptPushToken (web-push)", () => {
  it("produces a token of exactly 572 bytes", () => {
    const token = encryptPushToken(
      makeWebPushSubscription(),
      makeWebPushServerConfig().pubkey,
    );
    expect(token).toBeInstanceOf(Uint8Array);
    expect(token.length).toBe(MIP05_ENCRYPTED_TOKEN_SIZE);
  });

  it("each call produces a different token (ephemeral key + nonce)", () => {
    const sub = makeWebPushSubscription();
    const pubkey = makeWebPushServerConfig().pubkey;
    const t1 = encryptPushToken(sub, pubkey);
    const t2 = encryptPushToken(sub, pubkey);
    expect(t1).not.toEqual(t2);
  });

  it("throws if endpoint exceeds 428 bytes", () => {
    const sub: WebPushSubscription = {
      type: "web-push",
      endpoint: "https://example.com/" + "x".repeat(430),
      p256dh: randomBytes(65),
      auth: randomBytes(16),
    };
    expect(() =>
      encryptPushToken(sub, makeWebPushServerConfig().pubkey),
    ).toThrow("428 bytes");
  });

  it("throws if p256dh is not 65 bytes", () => {
    const sub: WebPushSubscription = {
      type: "web-push",
      endpoint: "https://example.com/push",
      p256dh: randomBytes(32),
      auth: randomBytes(16),
    };
    expect(() =>
      encryptPushToken(sub, makeWebPushServerConfig().pubkey),
    ).toThrow("65 bytes");
  });

  it("throws if auth is not 16 bytes", () => {
    const sub: WebPushSubscription = {
      type: "web-push",
      endpoint: "https://example.com/push",
      p256dh: randomBytes(65),
      auth: randomBytes(8),
    };
    expect(() =>
      encryptPushToken(sub, makeWebPushServerConfig().pubkey),
    ).toThrow("16 bytes");
  });
});

// ---------------------------------------------------------------------------
// Core: encryptPushToken — APNs (0x01)
// ---------------------------------------------------------------------------

describe("encryptPushToken (apns)", () => {
  it("produces a token of exactly 572 bytes", () => {
    const token = encryptPushToken(
      makeApnsSubscription(),
      makeApnsServerConfig().pubkey,
    );
    expect(token).toBeInstanceOf(Uint8Array);
    expect(token.length).toBe(MIP05_ENCRYPTED_TOKEN_SIZE);
  });

  it("each call produces a different token", () => {
    const sub = makeApnsSubscription();
    const pubkey = makeApnsServerConfig().pubkey;
    const t1 = encryptPushToken(sub, pubkey);
    const t2 = encryptPushToken(sub, pubkey);
    expect(t1).not.toEqual(t2);
  });

  it("throws if deviceToken is not 32 bytes", () => {
    const sub: ApnsSubscription = {
      type: "apns",
      deviceToken: randomBytes(16),
    };
    expect(() => encryptPushToken(sub, makeApnsServerConfig().pubkey)).toThrow(
      "32 bytes",
    );
  });
});

// ---------------------------------------------------------------------------
// Core: encryptPushToken — FCM (0x02)
// ---------------------------------------------------------------------------

describe("encryptPushToken (fcm)", () => {
  it("produces a token of exactly 572 bytes", () => {
    const token = encryptPushToken(
      makeFcmSubscription(),
      makeFcmServerConfig().pubkey,
    );
    expect(token).toBeInstanceOf(Uint8Array);
    expect(token.length).toBe(MIP05_ENCRYPTED_TOKEN_SIZE);
  });

  it("each call produces a different token", () => {
    const sub = makeFcmSubscription();
    const pubkey = makeFcmServerConfig().pubkey;
    const t1 = encryptPushToken(sub, pubkey);
    const t2 = encryptPushToken(sub, pubkey);
    expect(t1).not.toEqual(t2);
  });

  it("throws if registrationToken is empty", () => {
    const sub: FcmSubscription = { type: "fcm", registrationToken: "" };
    expect(() => encryptPushToken(sub, makeFcmServerConfig().pubkey)).toThrow(
      "empty",
    );
  });

  it("throws if registrationToken exceeds 509 bytes", () => {
    const sub: FcmSubscription = {
      type: "fcm",
      registrationToken: "x".repeat(600),
    };
    expect(() => encryptPushToken(sub, makeFcmServerConfig().pubkey)).toThrow(
      "509 bytes",
    );
  });
});

// ---------------------------------------------------------------------------
// Core: createTokenRequestRumor (kind:447)
// ---------------------------------------------------------------------------

describe("createTokenRequestRumor", () => {
  it("produces a rumor with kind 447", () => {
    const token = encryptPushToken(
      makeWebPushSubscription(),
      makeWebPushServerConfig().pubkey,
    );
    const rumor = createTokenRequestRumor(
      "c".repeat(64),
      token,
      makeWebPushServerConfig(),
    );
    expect(rumor.kind).toBe(TOKEN_REQUEST_KIND);
    expect(rumor.pubkey).toBe("c".repeat(64));
    expect(rumor.content).toBe("");
  });

  it("includes a token tag with base64 token, server pubkey, and relay hint", () => {
    const serverConfig = makeWebPushServerConfig();
    const token = encryptPushToken(
      makeWebPushSubscription(),
      serverConfig.pubkey,
    );
    const rumor = createTokenRequestRumor("c".repeat(64), token, serverConfig);

    const tokenTag = rumor.tags.find((t) => t[0] === "token");
    expect(tokenTag).toBeDefined();
    expect(tokenTag![1]).toBe(base64.encode(token));
    expect(tokenTag![2]).toBe(serverConfig.pubkey);
    expect(tokenTag![3]).toBe(serverConfig.relays[0]);
  });

  it("has a non-empty event id (hash)", () => {
    const token = encryptPushToken(
      makeWebPushSubscription(),
      makeWebPushServerConfig().pubkey,
    );
    const rumor = createTokenRequestRumor(
      "c".repeat(64),
      token,
      makeWebPushServerConfig(),
    );
    expect(rumor.id).toBeTruthy();
    expect(rumor.id.length).toBe(64);
  });

  it("works with all three server config platform types", () => {
    const token = randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE);
    for (const config of [
      makeWebPushServerConfig(),
      makeApnsServerConfig(),
      makeFcmServerConfig(),
    ] as NotificationServerConfig[]) {
      const rumor = createTokenRequestRumor("c".repeat(64), token, config);
      expect(rumor.kind).toBe(TOKEN_REQUEST_KIND);
    }
  });
});

// ---------------------------------------------------------------------------
// Core: createTokenListResponseRumor (kind:448)
// ---------------------------------------------------------------------------

describe("createTokenListResponseRumor", () => {
  it("produces a rumor with kind 448", () => {
    const entries: TokenEntry[] = [
      {
        encryptedToken: randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE),
        serverPubkey: "d".repeat(64),
        relayHint: "wss://relay.example.com",
        leafIndex: 3,
        addedAt: 1_700_000_000,
        platform: "apns",
      },
    ];
    const rumor = createTokenListResponseRumor(
      "e".repeat(64),
      entries,
      "f".repeat(64),
    );
    expect(rumor.kind).toBe(TOKEN_LIST_RESPONSE_KIND);
  });

  it("includes a token tag for each entry with leaf index", () => {
    const token = randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE);
    const entries: TokenEntry[] = [
      {
        encryptedToken: token,
        serverPubkey: "d".repeat(64),
        relayHint: "wss://relay.example.com",
        leafIndex: 5,
        addedAt: 1_700_000_000,
        platform: "fcm",
      },
    ];
    const rumor = createTokenListResponseRumor(
      "e".repeat(64),
      entries,
      "f".repeat(64),
    );
    const tokenTag = rumor.tags.find((t) => t[0] === "token");
    expect(tokenTag![4]).toBe("5");
  });

  it("includes an e tag referencing the kind:447 event id", () => {
    const replyTo = "a1".repeat(32);
    const rumor = createTokenListResponseRumor("e".repeat(64), [], replyTo);
    const eTag = rumor.tags.find((t) => t[0] === "e");
    expect(eTag![1]).toBe(replyTo);
  });
});

// ---------------------------------------------------------------------------
// Core: createTokenRemovalRumor (kind:449)
// ---------------------------------------------------------------------------

describe("createTokenRemovalRumor", () => {
  it("produces a rumor with kind 449 and no tags", () => {
    const rumor = createTokenRemovalRumor("f".repeat(64));
    expect(rumor.kind).toBe(TOKEN_REMOVAL_KIND);
    expect(rumor.tags).toHaveLength(0);
    expect(rumor.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Core: createNotificationTriggerRumor (kind:446)
// ---------------------------------------------------------------------------

describe("createNotificationTriggerRumor", () => {
  it("produces a rumor with kind 446", () => {
    const tokens = [randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE)];
    const rumor = createNotificationTriggerRumor(tokens);
    expect(rumor.kind).toBe(NOTIFICATION_TRIGGER_KIND);
  });

  it("content is base64 of concatenated tokens", () => {
    const t1 = randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE);
    const t2 = randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE);
    const rumor = createNotificationTriggerRumor([t1, t2]);
    const decoded = base64.decode(rumor.content);
    expect(decoded.length).toBe(MIP05_ENCRYPTED_TOKEN_SIZE * 2);
  });

  it("uses a fresh ephemeral pubkey each call", () => {
    const token = randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE);
    const r1 = createNotificationTriggerRumor([token]);
    const r2 = createNotificationTriggerRumor([token]);
    expect(r1.pubkey).not.toBe(r2.pubkey);
  });

  it("throws if tokens array is empty", () => {
    expect(() => createNotificationTriggerRumor([])).toThrow("zero tokens");
  });

  it("throws if tokens exceed batch limit", () => {
    const tokens = Array.from({ length: MIP05_TOKEN_BATCH_LIMIT + 1 }, () =>
      randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE),
    );
    expect(() => createNotificationTriggerRumor(tokens)).toThrow("batch");
  });
});

// ---------------------------------------------------------------------------
// Core: createNotificationGiftWrap (kind:1059)
// ---------------------------------------------------------------------------

describe("createNotificationGiftWrap", () => {
  it("produces a signed kind:1059 gift wrap addressed to the server", async () => {
    const tokens = [randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE)];
    const serverConfig = makeWebPushServerConfig();

    const giftWrap = await createNotificationGiftWrap(tokens, serverConfig);

    expect(giftWrap.kind).toBe(1059);
    expect(giftWrap.sig).toBeTruthy();
    const pTag = giftWrap.tags.find((t) => t[0] === "p");
    expect(pTag?.[1]).toBe(serverConfig.pubkey);
  });

  it("works with APNs server config", async () => {
    const tokens = [randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE)];
    const giftWrap = await createNotificationGiftWrap(
      tokens,
      makeApnsServerConfig(),
    );
    expect(giftWrap.kind).toBe(1059);
  });

  it("works with FCM server config", async () => {
    const tokens = [randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE)];
    const giftWrap = await createNotificationGiftWrap(
      tokens,
      makeFcmServerConfig(),
    );
    expect(giftWrap.kind).toBe(1059);
  });
});

// ---------------------------------------------------------------------------
// Client: NotificationManager
// ---------------------------------------------------------------------------

describe("NotificationManager", () => {
  function makeManager(pubkey = "b".repeat(64)) {
    const backend = new InMemoryKeyValueStore<TokenEntry>();
    const network = new MockNetwork();
    const manager = new NotificationManager({
      signer: makeSigner(pubkey),
      network,
      backend,
      groupId: "0".repeat(64),
    });
    return { manager, backend, network };
  }

  // --- Web Push ---

  it("register() web-push stores a token with correct platform and returns kind:447", async () => {
    const { manager } = makeManager();
    const rumor = await manager.register(
      makeWebPushSubscription(),
      makeWebPushServerConfig(),
      0,
    );

    expect(rumor.kind).toBe(TOKEN_REQUEST_KIND);
    const tokens = await manager.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].leafIndex).toBe(0);
    expect(tokens[0].platform).toBe("web-push");
    expect(tokens[0].encryptedToken.length).toBe(MIP05_ENCRYPTED_TOKEN_SIZE);
  });

  // --- APNs ---

  it("register() apns stores a token with platform 'apns'", async () => {
    const { manager } = makeManager();
    const rumor = await manager.register(
      makeApnsSubscription(),
      makeApnsServerConfig(),
      1,
    );

    expect(rumor.kind).toBe(TOKEN_REQUEST_KIND);
    const tokens = await manager.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].platform).toBe("apns");
    expect(tokens[0].leafIndex).toBe(1);
    expect(tokens[0].encryptedToken.length).toBe(MIP05_ENCRYPTED_TOKEN_SIZE);
  });

  it("register() apns emits tokenRegistered with platform 'apns'", async () => {
    const { manager } = makeManager();
    const emitted: TokenEntry[] = [];
    manager.on("tokenRegistered", (e) => emitted.push(e));

    await manager.register(makeApnsSubscription(), makeApnsServerConfig(), 2);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].platform).toBe("apns");
  });

  // --- FCM ---

  it("register() fcm stores a token with platform 'fcm'", async () => {
    const { manager } = makeManager();
    const rumor = await manager.register(
      makeFcmSubscription(),
      makeFcmServerConfig(),
      3,
    );

    expect(rumor.kind).toBe(TOKEN_REQUEST_KIND);
    const tokens = await manager.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].platform).toBe("fcm");
    expect(tokens[0].leafIndex).toBe(3);
    expect(tokens[0].encryptedToken.length).toBe(MIP05_ENCRYPTED_TOKEN_SIZE);
  });

  it("register() fcm emits tokenRegistered with platform 'fcm'", async () => {
    const { manager } = makeManager();
    const emitted: TokenEntry[] = [];
    manager.on("tokenRegistered", (e) => emitted.push(e));

    await manager.register(makeFcmSubscription(), makeFcmServerConfig(), 4);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].platform).toBe("fcm");
  });

  // --- Unregister ---

  it("unregister() removes the token and returns a kind:449 rumor", async () => {
    const { manager } = makeManager();
    await manager.register(makeApnsSubscription(), makeApnsServerConfig(), 0);

    const rumor = await manager.unregister(0);
    expect(rumor.kind).toBe(TOKEN_REMOVAL_KIND);
    expect(await manager.getTokens()).toHaveLength(0);
  });

  // --- Ingest ---

  it("ingest() kind:447 stores the sender's token", async () => {
    const { manager } = makeManager();
    const serverConfig = makeApnsServerConfig();
    const token = encryptPushToken(makeApnsSubscription(), serverConfig.pubkey);
    const senderRumor = createTokenRequestRumor(
      "1".repeat(64),
      token,
      serverConfig,
    );

    await manager.ingest(senderRumor, 3);

    const tokens = await manager.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].leafIndex).toBe(3);
  });

  it("ingest() kind:447 emits tokenRequested", async () => {
    const { manager } = makeManager();
    const serverConfig = makeFcmServerConfig();
    const token = encryptPushToken(makeFcmSubscription(), serverConfig.pubkey);
    const senderRumor = createTokenRequestRumor(
      "1".repeat(64),
      token,
      serverConfig,
    );

    const emitted: any[] = [];
    manager.on("tokenRequested", (r) => emitted.push(r));
    await manager.ingest(senderRumor, 3);

    expect(emitted).toHaveLength(1);
  });

  it("ingest() kind:448 upserts all tokens from the response", async () => {
    const { manager } = makeManager();
    const entries: TokenEntry[] = [
      {
        encryptedToken: randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE),
        serverPubkey: "d".repeat(64),
        relayHint: "wss://relay.example.com",
        leafIndex: 1,
        addedAt: 1_700_000_000,
        platform: "apns",
      },
      {
        encryptedToken: randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE),
        serverPubkey: "d".repeat(64),
        relayHint: "wss://relay.example.com",
        leafIndex: 2,
        addedAt: 1_700_000_000,
        platform: "fcm",
      },
    ];
    const responseRumor = createTokenListResponseRumor(
      "e".repeat(64),
      entries,
      "f".repeat(64),
    );
    await manager.ingest(responseRumor, 0);

    const tokens = await manager.getTokens();
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t) => t.leafIndex).sort()).toEqual([1, 2]);
  });

  it("ingest() kind:449 removes the sender's token", async () => {
    const { manager } = makeManager();
    await manager.register(makeApnsSubscription(), makeApnsServerConfig(), 4);

    await manager.ingest(createTokenRemovalRumor("2".repeat(64)), 4);
    expect(await manager.getTokens()).toHaveLength(0);
  });

  it("ingest() kind:449 emits tokenRemoved", async () => {
    const { manager } = makeManager();
    await manager.register(makeFcmSubscription(), makeFcmServerConfig(), 4);

    const emitted: number[] = [];
    manager.on("tokenRemoved", (i) => emitted.push(i));
    await manager.ingest(createTokenRemovalRumor("2".repeat(64)), 4);

    expect(emitted).toContain(4);
  });

  // --- Prune ---

  it("pruneExpiredTokens() removes tokens older than 35 days", async () => {
    const { manager, backend } = makeManager();
    const oldEntry: TokenEntry = {
      encryptedToken: randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE),
      serverPubkey: "d".repeat(64),
      relayHint: "wss://relay.example.com",
      leafIndex: 7,
      addedAt: Math.floor(Date.now() / 1000) - 36 * 24 * 60 * 60,
      platform: "apns",
    };
    const freshEntry: TokenEntry = {
      encryptedToken: randomBytes(MIP05_ENCRYPTED_TOKEN_SIZE),
      serverPubkey: "d".repeat(64),
      relayHint: "wss://relay.example.com",
      leafIndex: 8,
      addedAt: Math.floor(Date.now() / 1000),
      platform: "fcm",
    };
    await backend.setItem("7", oldEntry);
    await backend.setItem("8", freshEntry);

    const pruned = await manager.pruneExpiredTokens();

    expect(pruned).toBe(1);
    const remaining = await manager.getTokens();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].leafIndex).toBe(8);
  });

  // --- sendNotification ---

  it("sendNotification() publishes gift wrap events to server relays", async () => {
    const { manager, network } = makeManager();
    const serverConfig = makeApnsServerConfig();
    await manager.register(makeApnsSubscription(), serverConfig, 0);

    await manager.sendNotification(serverConfig);

    const giftWraps = network.events.filter((e) => e.kind === 1059);
    expect(giftWraps.length).toBeGreaterThan(0);
  });

  it("sendNotification() works with FCM server config", async () => {
    const { manager, network } = makeManager();
    const serverConfig = makeFcmServerConfig();
    await manager.register(makeFcmSubscription(), serverConfig, 0);

    await manager.sendNotification(serverConfig);

    expect(
      network.events.filter((e) => e.kind === 1059).length,
    ).toBeGreaterThan(0);
  });

  // --- Watch ---

  it("watchTokens() yields initial snapshot then updates on change", async () => {
    const { manager } = makeManager();

    const gen = manager.watchTokens();
    const first = await gen.next();
    expect(first.value).toHaveLength(0);

    const registerPromise = manager.register(
      makeApnsSubscription(),
      makeApnsServerConfig(),
      0,
    );
    const second = await gen.next();
    await registerPromise;

    expect(second.value).toHaveLength(1);
    await gen.return(undefined);
  });
});
