import { describe, expect, it } from "vitest";

import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  GROUP_EVENT_KIND,
  KEY_PACKAGE_KIND,
  KEY_PACKAGE_RELAY_LIST_KIND,
  WELCOME_EVENT_KIND,
} from "../protocol.js";
import {
  GIFT_WRAP_KIND,
  NOSTR_GROUP_ID_TAG,
  nostrTransportBinding,
} from "../transport.js";

describe("nostrTransportBinding", () => {
  it("bundles the Nostr wire identity from the protocol constants", () => {
    expect(nostrTransportBinding).toEqual({
      name: "nostr",
      groupMessageKind: GROUP_EVENT_KIND,
      welcomeKind: WELCOME_EVENT_KIND,
      keyPackageKind: KEY_PACKAGE_KIND,
      addressableKeyPackageKind: ADDRESSABLE_KEY_PACKAGE_KIND,
      keyPackageRelayListKind: KEY_PACKAGE_RELAY_LIST_KIND,
      giftWrapKind: GIFT_WRAP_KIND,
      groupIdTag: NOSTR_GROUP_ID_TAG,
    });
  });

  it("uses the canonical Nostr code points (445/444/1059, 'h')", () => {
    expect(nostrTransportBinding.groupMessageKind).toBe(445);
    expect(nostrTransportBinding.welcomeKind).toBe(444);
    expect(nostrTransportBinding.giftWrapKind).toBe(1059);
    expect(nostrTransportBinding.groupIdTag).toBe("h");
  });
});
