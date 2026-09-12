// Packed-tarball consumer smoke test for @internet-privacy/marmot-ts.
//
// Runs unchanged under Node, Bun and Deno against a real `npm install` of the
// packed tarball (see run.sh). It exercises `.`, `/mls` and `/core`, creating a
// real one-member Marmot group and encoding its GroupContext with the
// fork-only groupContextEncoder.
//
// Deliberately uses no `node:` imports so it stays runtime-neutral.

import * as marmotTs from "@internet-privacy/marmot-ts";
import {
  defaultCryptoProvider,
  encode,
  getCiphersuiteImpl,
  groupContextEncoder,
} from "@internet-privacy/marmot-ts/mls";
import {
  createCredential,
  createSimpleGroup,
  generateKeyPackage,
} from "@internet-privacy/marmot-ts/core";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`package smoke assertion failed: ${message}`);
  }
}

assert(
  typeof marmotTs.MarmotClient === "function",
  "MarmotClient is not exported as a function from the root entrypoint",
);

const pubkey = "a".repeat(64);

const impl = await getCiphersuiteImpl(
  "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
  defaultCryptoProvider,
);

const credential = createCredential(pubkey);
const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });
const { clientState } = await createSimpleGroup(kp, impl, "Package Smoke", {
  adminPubkeys: [pubkey],
  relays: [],
});

assert(
  clientState.groupContext.epoch === 0n,
  `expected fresh group epoch 0n, got ${clientState.groupContext.epoch}`,
);

const encoded = encode(groupContextEncoder, clientState.groupContext);
assert(
  encoded instanceof Uint8Array && encoded.length > 0,
  "encode(groupContextEncoder, groupContext) did not return a non-empty Uint8Array",
);

const runtime = globalThis.Deno
  ? "Deno"
  : globalThis.Bun
    ? "Bun"
    : `node ${typeof process !== "undefined" ? process.version : "unknown"}`;

console.log(`package smoke OK (${runtime})`);
