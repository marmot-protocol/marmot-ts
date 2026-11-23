import { describe, expect, it } from "vitest";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { defaultCapabilities } from "../../core/default-capabilities.js";
import { getKeyPackage } from "../../core/key-package-event.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../../core/protocol.js";
import { memoryDatabase } from "../../__tests__/helpers/database.js";
import { MarmotClient } from "../marmot-client.js";

describe("MarmotClient capabilities", () => {
  it("advertises the client's capabilities in published key packages", async () => {
    const account = testAccount(5);
    const network = new MockNetwork();
    const defaults = defaultCapabilities();
    const extraExtension = 0xf2d2;
    expect(defaults.extensions).not.toContain(extraExtension);
    const client = new MarmotClient({
      database: memoryDatabase(),
      signer: account.signer,
      network,
      clientId: "cc".repeat(32),
      capabilities: {
        ...defaults,
        extensions: [...defaults.extensions, extraExtension],
      },
    });

    await client.keyPackages.create({ relays: ["wss://mock-relay.test"] });

    const [event] = await network.request(["wss://mock-relay.test"], {
      kinds: [ADDRESSABLE_KEY_PACKAGE_KIND],
      authors: [account.pubkey],
    });
    expect(getKeyPackage(event!).leafNode.capabilities.extensions).toContain(
      extraExtension,
    );
  });
});
