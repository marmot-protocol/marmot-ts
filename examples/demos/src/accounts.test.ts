import { expect, it, vi } from "vitest";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { getDevelopmentName } from "./lib/development-identity.js";

it("generates per-session identities and restores the active identity only within that session", async () => {
  const saved = PrivateKeyAccount.generateNew();
  const local = new Map([
    ["marmot-demos:accounts", JSON.stringify([saved.toJSON()])],
    ["marmot-demos:active", saved.id],
  ]);
  const session = new Map<string, string>();
  const storage = (values: Map<string, string>) => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  });
  vi.stubGlobal("localStorage", storage(local));
  vi.stubGlobal("sessionStorage", storage(session));
  try {
    const first = await import("./accounts.js");
    const pubkey = first.accounts.active!.pubkey;
    expect(pubkey).not.toBe(saved.pubkey);
    expect(getDevelopmentName(first.accounts.active!)).toBeTruthy();
    expect(JSON.parse(session.get("marmot-demos:active")!).pubkey).toBe(pubkey);
    expect(local.get("marmot-demos:active")).toBe(saved.id);
    first.pool.close();

    // Reloading the tab restores even if another tab changed saved accounts.
    local.set("marmot-demos:accounts", "[]");
    vi.resetModules();
    const reloaded = await import("./accounts.js");
    expect(reloaded.accounts.active!.pubkey).toBe(pubkey);
    reloaded.pool.close();

    // A new browsing session ignores other sessions' saved/active accounts.
    session.clear();
    vi.resetModules();
    const next = await import("./accounts.js");
    expect(next.accounts.active!.pubkey).not.toBe(pubkey);
    next.switchAccount();
    expect(session.has("marmot-demos:active")).toBe(false);
    next.login(saved);
    expect(JSON.parse(session.get("marmot-demos:active")!).pubkey).toBe(
      saved.pubkey,
    );
    next.logout();
    expect(session.has("marmot-demos:active")).toBe(false);
    next.pool.close();
  } finally {
    vi.unstubAllGlobals();
  }
});
