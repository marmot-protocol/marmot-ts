import { describe, expect, it } from "vitest";

import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  GROUP_EVENT_KIND,
  INBOX_RELAY_LIST_KIND,
  NIP65_RELAY_LIST_KIND,
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
      addressableKeyPackageKind: ADDRESSABLE_KEY_PACKAGE_KIND,
      nip65RelayListKind: NIP65_RELAY_LIST_KIND,
      inboxRelayListKind: INBOX_RELAY_LIST_KIND,
      giftWrapKind: GIFT_WRAP_KIND,
      groupIdTag: NOSTR_GROUP_ID_TAG,
    });
  });

  it("uses the canonical Nostr code points (445/444/1059, 'h', 10002/10050)", () => {
    expect(nostrTransportBinding.groupMessageKind).toBe(445);
    expect(nostrTransportBinding.welcomeKind).toBe(444);
    expect(nostrTransportBinding.giftWrapKind).toBe(1059);
    expect(nostrTransportBinding.groupIdTag).toBe("h");
    expect(nostrTransportBinding.nip65RelayListKind).toBe(10002);
    expect(nostrTransportBinding.inboxRelayListKind).toBe(10050);
  });
});
