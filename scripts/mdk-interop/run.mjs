import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import * as mls from "../../dist/mls.js";
import * as core from "../../dist/core/index.js";
import { createGiftWrap } from "../../dist/utils/index.js";
import { unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";

// This intentionally uses the actual MDK engine with raw MLS transport.
// NIP-59 uses MDK's pinned rust-nostr dependency. No live relays are used.
const directory = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(process.env.MDK_ROOT ?? join(directory, "../../refs/mdk"));
const profile = process.env.MDK_PROFILE ?? "app";
assert(["base", "app", "media"].includes(profile), "Unknown MDK_PROFILE");
const manifest = await readFile(join(root, "Cargo.toml"), "utf8");
const toolchain = (
  await readFile(join(root, "rust-toolchain.toml"), "utf8")
).match(/channel\s*=\s*"([^"]+)"/)[1];
const temporary = await mkdtemp(join(tmpdir(), "marmot-ts-mdk-probe-"));
await mkdir(join(temporary, "src"));
await copyFile(join(directory, "main.rs"), join(temporary, "src/main.rs"));
const nostrDependency = manifest.match(/^nostr = (.+)$/m)[1];
const patches = manifest
  .split("[patch.crates-io]")[1]
  .split(/\n\[profile\./)[0]
  .replaceAll('path = "vendor/', `path = "${root}/vendor/`);
await writeFile(
  join(temporary, "Cargo.toml"),
  `[package]
name = "marmot-ts-mdk-interop"
version = "0.1.0"
edition = "2024"
[dependencies]
cgka-engine = { path = "${root}/crates/cgka-engine" }
cgka-traits = { path = "${root}/crates/traits" }
storage-sqlite = { path = "${root}/crates/storage-sqlite" }
nostr = ${nostrDependency}
async-trait = "0.1"
k256 = { version = "0.13", features = ["schnorr"] }
sha2 = "0.10"
serde_json = "1"
hex = "0.4"
tokio = { version = "1", features = ["macros", "rt"] }
[profile.dev]
debug = 0
[patch.crates-io]
${patches}`,
);
// Reuse MDK's resolved dependency versions; Cargo adds this tiny probe package.
await copyFile(join(root, "Cargo.lock"), join(temporary, "Cargo.lock"));
const target = resolve(
  process.env.CARGO_TARGET_DIR ?? join(tmpdir(), "marmot-ts-mdk-probe-target"),
);
await new Promise((resolve, reject) => {
  const build = spawn(
    "cargo",
    [
      `+${toolchain}`,
      "build",
      "--manifest-path",
      join(temporary, "Cargo.toml"),
    ],
    {
      stdio: "inherit",
      env: { ...process.env, CARGO_TARGET_DIR: target },
    },
  );
  build.on("error", reject);
  build.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`cargo build exited ${code}`)),
  );
});
const child = spawn(join(target, "debug/marmot-ts-mdk-interop"), [], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, MDK_PROFILE: profile, RUST_MIN_STACK: "4194304" },
});
const timeout = setTimeout(() => child.kill(), 120_000);
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const read = async () => {
  const { value, done } = await lines.next();
  if (done) throw new Error("Rust probe exited before responding");
  const result = JSON.parse(value);
  if (result.error) throw new Error(result.error);
  return result;
};
const call = async (value) => {
  child.stdin.write(JSON.stringify(value) + "\n");
  return read();
};
try {
  console.log(`MDK root: ${root}; profile: ${profile}`);
  const rust = await read();
  const suite = await mls.getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    mls.defaultCryptoProvider,
  );
  const account = PrivateKeyAccount.fromKey(new Uint8Array(32).fill(8));
  const kp = await core.generateKeyPackage({
    credential: core.createCredential(account.pubkey),
    ciphersuiteImpl: suite,
    signer: account.signer,
  });
  const request = await call({
    op: "create",
    key_package: bytesToHex(
      mls.encode(mls.mlsMessageEncoder, {
        version: mls.protocolVersions.mls10,
        wireformat: mls.wireformats.mls_key_package,
        keyPackage: kp.publicPackage,
      }),
    ),
  });
  console.log("PASS: MDK accepts TypeScript KeyPackage and creates Welcome");
  const rustWelcome = mls.decode(
    mls.mlsMessageDecoder,
    hexToBytes(request.welcome),
  );
  const rustRumor = core.createWelcomeRumor({
    welcome: rustWelcome.welcome,
    author: rust.pubkey,
    groupRelays: ["wss://relay.example.com"],
    keyPackageEventId: "ab".repeat(32),
  });
  const wrapped = await call({
    op: "wrap",
    rumor: rustRumor,
    recipient: account.pubkey,
  });
  const unwrapped = await unlockGiftWrap(wrapped, account.signer);
  assert.equal(unwrapped.content, rustRumor.content);
  console.log("PASS: TypeScript decrypts rust-nostr NIP-59 Welcome");
  const welcome = { welcome: core.getWelcome(unwrapped) };
  const context = {
    cipherSuite: suite,
    authService: core.marmotAuthService,
    clientConfig: core.defaultMarmotClientConfig,
    externalPsks: {},
  };
  const joined = await mls.joinGroupWithExtensions({
    context,
    welcome: welcome.welcome,
    keyPackage: kp.publicPackage,
    privateKeys: kp.privatePackage,
  });
  assert.equal(
    core.validateWelcomeGroup(joined.state, joined.groupInfo),
    rust.pubkey,
  );
  console.log("PASS: TypeScript decrypts and validates MDK Welcome");
  const rustKp = mls.decode(
    mls.mlsMessageDecoder,
    hexToBytes(rust.key_package),
  ).keyPackage;
  core.validateKeyPackageAccountIdentityProof(rustKp, suite.id);
  const { clientState } = await core.createGroup({
    creatorKeyPackage: kp,
    ciphersuiteImpl: suite,
    components: [
      core.groupProfileEntry({ name: "TypeScript interop", description: "" }),
      core.adminPolicyEntry([account.pubkey]),
    ],
    // The base engine does not register the optional self-remove feature.
    ...(profile === "base"
      ? {
          extensions: [
            {
              extensionType: mls.defaultExtensionTypes.required_capabilities,
              extensionData: {
                extensionTypes: [6],
                proposalTypes: [8],
                credentialTypes: [],
              },
            },
          ],
        }
      : {}),
  });
  const commit = await mls.createCommit({
    context,
    state: clientState,
    extraProposals: [
      {
        proposalType: mls.defaultProposalTypes.add,
        add: { keyPackage: rustKp },
      },
    ],
    ratchetTreeExtension: true,
  });
  const tsRumor = core.createWelcomeRumor({
    welcome: commit.welcome.welcome,
    author: account.pubkey,
    groupRelays: ["wss://relay.example.com"],
    keyPackageEventId: "cd".repeat(32),
  });
  const tsWrap = await createGiftWrap({
    rumor: tsRumor,
    signer: account.signer,
    recipient: rust.pubkey,
  });
  const rustUnwrapped = await call({ op: "unwrap", event: tsWrap });
  assert.equal(rustUnwrapped.content, tsRumor.content);
  assert.deepEqual(rustUnwrapped.tags, tsRumor.tags);
  console.log("PASS: rust-nostr decrypts TypeScript NIP-59 Welcome");
  await call({
    op: "join",
    welcome: bytesToHex(mls.encode(mls.mlsMessageEncoder, commit.welcome)),
  });
  console.log(
    "PASS: TypeScript accepts MDK KeyPackage; MDK joins TypeScript Welcome",
  );
} catch (error) {
  console.error(`INCOMPATIBLE: ${error.message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  child.kill();
}
