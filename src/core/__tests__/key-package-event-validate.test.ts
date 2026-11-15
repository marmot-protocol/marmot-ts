import type { NostrEvent } from "applesauce-core/helpers/event";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { proposeInviteUser } from "../../client/group/proposals/invite-user.js";
import type { ProposalContext } from "../../engine/types.js";
import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import {
  createKeyPackageEvent,
  getKeyPackage,
  KeyPackageEventMetadataError,
  validateKeyPackageEventMetadata,
} from "../key-package-event.js";

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

// A kind-30443 event published by MDK HEAD (ec6c2bc2, `wnd`) to a local relay;
// `wn keys fetch` accepts it.
const MDK_EVENT: NostrEvent = {
  kind: 30443,
  pubkey: "094aeec7f61e9d04c43bb30604a7fb690af5f66410e17d04e0bb2c4b0fca3b02",
  id: "dd558713e60670cbd2c06d4321c72d71fe6fea82b2a781cc7c72abee7b253ade",
  created_at: 1791157326,
  tags: [
    ["d", "dd0004d7c917deef25615cee674e95338f13fc7f8137bf077b83ba9dc65bd697"],
    ["mls_protocol_version", "1.0"],
    ["i", "bb3322f2efd0ba9955bed8a1be0d7ee4417c8f152d60a9d1bde975dd88f04b72"],
    ["mls_ciphersuite", "0x0001"],
    ["mls_extensions", "0x0006", "0xf2d1", "0xf2d2", "0xf2d4"],
    ["mls_proposals", "0x0008", "0x000a"],
    [
      "app_components",
      "0x8001",
      "0x8002",
      "0x8003",
      "0x8004",
      "0x8005",
      "0x8006",
      "0x8007",
      "0x8008",
      "0x8009",
      "0x800b",
      "0x800c",
    ],
  ],
  content:
    "AAEABQABAAEgSkcmFyKmPCDehCVuWilO47tB8bG7Mo2Hm/xL4vIqaD0geGpLsA82k5hoOaPZlG5vMMFQHUsqf/3zNt0Fbsws+hwgVdfM14BI7pevebcAErtUS4LrMytgD0iAHpUhSUB7+UIAASAJSu7H9h6dBMQ7swYEp/tpCvX2ZBDhfQTguyxLD8o7AgIAAQIAAQgABvLR8tLy1AQACgAIAgABAQAAAABqwtY+AAAAAGsxok5AkgAGQI5AjAABGRgAAYABgAKAA4AEgAWABoAHgAiACYALgAwAAgEAgAlAaAlK7sf2Hp0ExDuzBgSn+2kK9fZkEOF9BOC7LEsPyjsCAAAAAGrC5E0Q/z0OCJwrziov4IPfK3/6G9G5PQd88238zE4KxdVHbLSR4FG2KGKaNXjy03VYWJF9te8jf6cegTiX6qoWTjkYQEAe40jCr4dQ9ixm7wLw5I6tf+WzUY2xg2Qfh2f7XON5ptZWZqhu6CWZkHfmEU7x9SfT6KKDfkfh7a99SzHFFlEBBwAGBAMABABAQNDlxAIc6w9otC103SQ+ntu6qAQ75M3QFGDIKCno57AGbm+PwAcLPqbJTXyTI+xJqa8tu+Q4hn/uT/FysmfuXAo=",
  sig: "1b530424dd4e272507bfda815637028862054c018974b96ef10fff9ad4a7c0372bc2b65fcf593256f58eefadbfb48f5cdd2e222e13d787451902426d6ab58df6",
};

type Mutation = [string, (tags: string[][]) => string[][]];

const set =
  (name: string, ...values: string[]) =>
  (tags: string[][]) =>
    tags.map((t) => (t[0] === name ? [name, ...values] : t));

const MUTATIONS: Mutation[] = [
  ["i tag for another KeyPackage", set("i", "00".repeat(32))],
  ["missing i tag", (tags) => tags.filter((t) => t[0] !== "i")],
  ["missing d tag", (tags) => tags.filter((t) => t[0] !== "d")],
  ["wrong mls_ciphersuite", set("mls_ciphersuite", "0x0002")],
  [
    "mls_extensions missing an advertised extension",
    (tags) => tags.map((t) => (t[0] === "mls_extensions" ? t.slice(0, -1) : t)),
  ],
  [
    "mls_extensions with an extra id",
    (tags) =>
      tags.map((t) => (t[0] === "mls_extensions" ? [...t, "0x00ff"] : t)),
  ],
  [
    "repeated mls_extensions tag",
    (tags) => [...tags, tags.find((t) => t[0] === "mls_extensions")!],
  ],
  [
    "missing mls_proposals",
    (tags) => tags.filter((t) => t[0] !== "mls_proposals"),
  ],
  [
    "duplicate value in mls_proposals",
    (tags) => tags.map((t) => (t[0] === "mls_proposals" ? [...t, t[1]] : t)),
  ],
  [
    "app_components claiming an unadvertised component",
    (tags) =>
      tags.map((t) => (t[0] === "app_components" ? [...t, "0x80ff"] : t)),
  ],
  [
    "app_components without 0x8009",
    (tags) =>
      tags.map((t) =>
        t[0] === "app_components" ? t.filter((v) => v !== "0x8009") : t,
      ),
  ],
  ["uppercase hex", set("mls_ciphersuite", "0X0001")],
];

const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
const account = testAccount(7);
const ours: NostrEvent = await account.signer.signEvent(
  await createKeyPackageEvent({
    keyPackage: (
      await generateKeyPackage({
        credential: createCredential(account.pubkey),
        ciphersuiteImpl: impl,
        signer: account.signer,
      })
    ).publicPackage,
    identifier: "ab".repeat(32),
  }),
);

describe("kind-30443 tag vs KeyPackage validation", () => {
  for (const [label, event] of [
    ["MDK", MDK_EVENT],
    ["marmot-ts", ours],
  ] as const) {
    it(`accepts a ${label}-produced event`, async () => {
      await expect(
        validateKeyPackageEventMetadata(event, getKeyPackage(event), impl.hash),
      ).resolves.toBeUndefined();
    });

    for (const [name, mutate] of MUTATIONS) {
      it(`proposeInviteUser rejects a ${label} event with ${name}`, async () => {
        const bad = { ...event, tags: mutate(event.tags.map((t) => [...t])) };
        await expect(
          proposeInviteUser(bad)({ ciphersuite: impl } as ProposalContext),
        ).rejects.toBeInstanceOf(KeyPackageEventMetadataError);
      });
    }
  }
});
