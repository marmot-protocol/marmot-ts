import { afterEach, describe, expect, test } from "bun:test";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { EventStore } from "applesauce-core/event-store";
import { RelayPool as ApplesauceRelayPool } from "applesauce-relay";

import { Directory } from "./discovery.js";
import { RelayPool } from "./relay-pool.js";

const account = PrivateKeyAccount.fromKey("1".padStart(64, "0"));
const event = await account.signEvent({
  kind: 1,
  created_at: 1,
  tags: [],
  content: "test",
});
const wireEvent = JSON.parse(JSON.stringify(event));
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

/** Local relay exercises the real v7 retry/auth lifecycle without public networking. */
function setup({
  requiresAuth = true,
  rejectsAuth = false,
  ignorePublish = false,
} = {}) {
  let publishes = 0;
  let authAttempts = 0;
  const server = Bun.serve<{ authenticated: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req, { data: { authenticated: false } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify(["AUTH", "test-challenge"]));
      },
      message(ws, message) {
        const [verb, value] = JSON.parse(String(message));
        if (verb === "AUTH") {
          authAttempts++;
          ws.data.authenticated = !rejectsAuth;
          ws.send(
            JSON.stringify([
              "OK",
              value.id,
              !rejectsAuth,
              rejectsAuth ? "restricted: denied" : "",
            ]),
          );
        } else if (verb === "REQ") {
          if (requiresAuth && !ws.data.authenticated) {
            ws.send(
              JSON.stringify(["CLOSED", value, "auth-required: sign in"]),
            );
          } else {
            ws.send(JSON.stringify(["EVENT", value, event]));
            ws.send(JSON.stringify(["EOSE", value]));
          }
        } else if (verb === "EVENT") {
          publishes++;
          if (ignorePublish) return;
          const ok = !requiresAuth || ws.data.authenticated;
          ws.send(
            JSON.stringify([
              "OK",
              value.id,
              ok,
              ok ? "" : "auth-required: sign in",
            ]),
          );
        }
      },
    },
  });
  cleanup.push(() => server.stop(true));
  const url = `ws://127.0.0.1:${server.port}/`;
  const store = new EventStore();
  const pool = new RelayPool(
    new ApplesauceRelayPool({ keepAlive: 0 }),
    [url],
    new Directory(store),
    { authSigner: account },
  );
  cleanup.push(() => {
    pool.close();
    store.dispose();
  });
  return {
    pool,
    url,
    authAttempts: () => authAttempts,
    publishes: () => publishes,
  };
}

describe("operation-scoped relay authentication", () => {
  test("a bare challenge does not authenticate a public request", async () => {
    const { pool, authAttempts } = setup({ requiresAuth: false });
    expect(
      JSON.parse(JSON.stringify(await pool.request([], { kinds: [1] }))),
    ).toEqual([wireEvent]);
    expect(authAttempts()).toBe(0);
  });

  test("a refused request authenticates and retries", async () => {
    const { pool, authAttempts } = setup();
    expect(
      JSON.parse(JSON.stringify(await pool.request([], { kinds: [1] }))),
    ).toEqual([wireEvent]);
    expect(authAttempts()).toBe(1);
  });

  test("public lookups can decline authentication and propagate all-relay failure", async () => {
    const { pool, authAttempts } = setup();
    await expect(
      pool.request([], { kinds: [1] }, { waitForAuth: false }),
    ).rejects.toThrow();
    expect(authAttempts()).toBe(0);
  });

  test("a refused publish authenticates and retries", async () => {
    const { pool, url, authAttempts } = setup();
    const responses = await pool.publish([], event);
    expect(responses[url]?.ok).toBe(true);
    expect(authAttempts()).toBe(1);
  });

  test("first accepted OK releases publication while every relay is attempted", async () => {
    const fast = setup({ requiresAuth: false });
    const slow = setup({ requiresAuth: false, ignorePublish: true });
    const store = new EventStore();
    const pool = new RelayPool(
      new ApplesauceRelayPool({ keepAlive: 0 }),
      [],
      new Directory(store),
    );
    cleanup.push(() => {
      pool.close();
      store.dispose();
    });
    const response = await pool.publish([fast.url, slow.url], event);
    expect(response[fast.url]?.ok).toBe(true);
    // Both socket attempts were launched before the first ACK resolved. Allow
    // the second loopback socket to deliver its bytes, without waiting for OK.
    for (let i = 0; i < 100 && !slow.publishes(); i++) await Bun.sleep(5);
    expect(slow.publishes()).toBe(1);
    expect(response[slow.url]).toBeUndefined();
  }, 2000);

  test("a refused subscription authenticates and delivers events", async () => {
    const { pool, authAttempts } = setup();
    const received = await new Promise((resolve, reject) => {
      const sub = pool.subscription([], { kinds: [1] }).subscribe({
        next: (value) => {
          sub.unsubscribe();
          resolve(value);
        },
        error: reject,
      });
    });
    expect(JSON.parse(JSON.stringify(received))).toEqual(wireEvent);
    expect(authAttempts()).toBe(1);
  });

  test("rejected AUTH fails the request without retrying forever", async () => {
    const { pool, authAttempts } = setup({ rejectsAuth: true });
    await expect(pool.request([], { kinds: [1] })).rejects.toThrow();
    expect(authAttempts()).toBe(1);
  });
});
