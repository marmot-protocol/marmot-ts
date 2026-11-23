import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { describe, expect, it } from "vitest";
import { getPageTitle } from "./page-title.js";
import { short } from "./ui.js";

describe("demo page titles", () => {
  it("includes the active account name and changes with the account", () => {
    const account = PrivateKeyAccount.generateNew();
    account.metadata = { developmentName: "Amber Fox" };
    expect(getPageTitle("/", account)).toBe("Amber Fox · marmot-ts demos");
    account.metadata = { developmentName: "Sunny Otter" };
    expect(getPageTitle("/", account)).toBe("Sunny Otter · marmot-ts demos");
  });

  it("falls back to the public key for unnamed accounts", () => {
    const account = PrivateKeyAccount.generateNew();
    expect(getPageTitle("/", account)).toBe(
      `${short(account.pubkey)} · marmot-ts demos`,
    );
  });

  it("clears the account name when logged out", () => {
    expect(getPageTitle("/")).toBe("marmot-ts demos");
  });

  it("labels the relay inspector independently of the active account", () => {
    const account = PrivateKeyAccount.generateNew();
    account.metadata = { developmentName: "Amber Fox" };
    for (const pathname of ["/relay", "/relay/"]) {
      expect(getPageTitle(pathname, account)).toBe(
        "Relay inspector · marmot-ts demos",
      );
      expect(getPageTitle(pathname)).toBe("Relay inspector · marmot-ts demos");
    }
  });
});
