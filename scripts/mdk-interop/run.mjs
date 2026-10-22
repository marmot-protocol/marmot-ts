import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  copyFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils.js";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import * as mls from "../../dist/mls.js";
import * as core from "../../dist/core/index.js";
import { createGiftWrap } from "../../dist/utils/index.js";
import { unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";

// This intentionally uses the actual MDK engine with raw MLS transport.
// NIP-59 uses MDK's pinned rust-nostr dependency. No live relays are used.
const directory = fileURLToPath(new URL(".", import.meta.url));
let root = resolve(process.env.MDK_ROOT ?? join(directory, "../../refs/mdk"));
const profile = process.env.MDK_PROFILE ?? "app";
assert(["base", "app", "media"].includes(profile), "Unknown MDK_PROFILE");
const manifest = await readFile(join(root, "Cargo.toml"), "utf8");
const toolchain = (
  await readFile(join(root, "rust-toolchain.toml"), "utf8")
).match(/channel\s*=\s*"([^"]+)"/)[1];
const temporary = await mkdtemp(join(tmpdir(), "marmot-ts-mdk-probe-"));
await mkdir(join(temporary, "src"));
await copyFile(join(directory, "main.rs"), join(temporary, "src/main.rs"));
// The app keeps its transfer routines crate-private. A disposable worktree
// exposes only the real upstream routines through a test bridge. No upstream
// source or crypto implementation is replaced.
const sourceRoot = root;
if (profile === "media") {
  root = join(temporary, "mdk");
  process.once("exit", () => {
    try {
      execFileSync(
        "git",
        ["-C", sourceRoot, "worktree", "remove", "--force", root],
        { stdio: "ignore" },
      );
    } catch {}
  });
  execFileSync("git", [
    "-C",
    sourceRoot,
    "worktree",
    "add",
    "--detach",
    root,
    "HEAD",
  ]);
  let bridge = await readFile(join(directory, "media-bridge.rs"), "utf8");
  const mediaSource = await readFile(
    join(root, "crates/marmot-app/src/media/mod.rs"),
    "utf8",
  );
  if (
    mediaSource.includes(
      "#[cfg(test)]\npub(crate) async fn upload_encrypted_media(",
    )
  ) {
    bridge = bridge
      .replace(
        "media::upload_encrypted_media(",
        "media::upload_encrypted_media_retaining(",
      )
      .replace("&result.attachments[0]", "&result.0.attachments[0]");
  }
  await appendFile(join(root, "crates/marmot-app/src/lib.rs"), "\n" + bridge);
}
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
[features]
media-probe = []
[dependencies]
${profile === "media" ? `marmot-app = { path = "${root}/crates/marmot-app" }` : ""}
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
      ...(profile === "media" ? ["--features", "media-probe"] : []),
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
const blobs = new Map();
const server = createServer(async (req, res) => {
  if (req.method === "PUT") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = concatBytes(...chunks);
    const hash = bytesToHex(
      (await import("@noble/hashes/sha2.js")).sha256(bytes),
    );
    blobs.set("/" + hash, bytes);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        url: serverUrl + "/" + hash,
        sha256: hash,
        size: bytes.length,
        type: "application/octet-stream",
        uploaded: 1,
      }),
    );
  } else {
    const bytes = blobs.get(req.url);
    if (!bytes) {
      res.statusCode = 404;
      res.end();
    } else res.end(bytes);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const serverUrl = `http://127.0.0.1:${server.address().port}`;
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
    server: serverUrl,
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
  if (profile === "media") {
    const client = await import("../../dist/client/index.js");
    const { InMemoryKeyValueStore } = await import("../../dist/extra/index.js");
    const group = new client.MarmotGroup(joined.state, {
      ciphersuite: suite,
      signer: account.signer,
      store: new InMemoryKeyValueStore(),
      network: {
        publish: async () => ({}),
        request: async () => [],
        subscribe: () => ({ unsubscribe() {} }),
      },
      scheduler: { setTimer: () => 1, clearTimer() {} },
    });
    try {
      const transport = client.createBlossomMediaTransport({
        signer: account.signer,
        allowDestination: (url) => url.origin === serverUrl,
      });
      const plaintext = new TextEncoder().encode("TypeScript media v2 payload");
      const prepared = await client.prepareMediaMessage(
        group,
        [
          {
            blob: new Blob([plaintext], { type: "text/plain" }),
            metadata: { filename: "café.txt" },
          },
        ],
        { transport, caption: "TypeScript caption" },
      );
      const source = group.state;
      const effects = await group.session.send(prepared.intent);
      const peeled = await core.decryptGroupMessages(
        [effects.publish[0].envelope],
        source,
        suite,
      );
      const downloaded = await call({
        op: "media_receive",
        group_id: request.group_id,
        message: bytesToHex(
          mls.encode(mls.mlsMessageEncoder, peeled.read[0].message),
        ),
      });
      assert.equal(downloaded.plaintext, bytesToHex(plaintext));
      assert.equal(downloaded.caption, "TypeScript caption");
      assert.equal(downloaded.filename, "café.txt");
      assert.equal(downloaded.media_type, "text/plain");
      console.log(
        "PASS: public TS client sends MLS message; actual MDK fetches and decrypts attachment",
      );

      const outgoing = await call({
        op: "media_upload",
        group_id: request.group_id,
        server: serverUrl,
      });
      const event = await core.createGroupEvent({
        ciphersuite: suite,
        state: group.state,
        message: mls.decode(
          mls.mlsMessageDecoder,
          hexToBytes(outgoing.message),
        ),
      });
      let decoded, sourceParent;
      for await (const result of group.ingest([event])) {
        if (
          result.kind === "processed" &&
          result.result.kind === "applicationMessage"
        ) {
          decoded = core.deserializeApplicationData(result.result.message);
          sourceParent = result.sourceParent;
        }
      }
      assert(decoded && sourceParent, "No authenticated media delivery/source");
      assert.equal(decoded.content, "Rust caption");
      const attachment = core.getMediaAttachments(decoded.tags)[0];
      assert(attachment);
      const stored = await client.downloadMediaAttachment(
        group,
        attachment,
        sourceParent,
        { transport },
      );
      assert.equal(
        new TextDecoder().decode(stored.data),
        "Rust media v2 payload",
      );
      assert.equal(attachment.filename, "café.txt");
      assert.equal(attachment.mediaType, "text/plain");
      console.log(
        "PASS: public TS client receives MDK MLS message and decrypts actual MDK-uploaded media",
      );
      const ingestRust = async (message) => {
        const envelope = await core.createGroupEvent({
          ciphersuite: suite,
          state: group.state,
          message: mls.decode(mls.mlsMessageDecoder, hexToBytes(message)),
        });
        const results = [];
        for await (const result of group.ingest([envelope]))
          results.push(result);
        return results;
      };
      let advanced = false;
      await assert.rejects(
        client.prepareMediaMessage(
          group,
          [
            {
              blob: new Blob([plaintext], { type: "text/plain" }),
              metadata: { filename: "race.txt" },
            },
          ],
          {
            transport: {
              ...transport,
              async upload(requestBody) {
                const url = await transport.upload(requestBody);
                if (!advanced) {
                  advanced = true;
                  await ingestRust(
                    (await call({ op: "advance", group_id: request.group_id }))
                      .message,
                  );
                }
                return url;
              },
            },
          },
        ),
        core.StaleMediaPreparationError,
      );
      console.log(
        "PASS: real MDK commit during upload makes the public TS preparation stale",
      );

      const delayed = await call({
        op: "media_upload",
        group_id: request.group_id,
        server: serverUrl,
      });
      await ingestRust(
        (await call({ op: "advance", group_id: request.group_id })).message,
      );
      const delayedResults = await ingestRust(delayed.message);
      const delivered = delayedResults.find(
        (result) =>
          result.kind === "processed" &&
          result.result.kind === "applicationMessage",
      );
      assert(
        delivered?.sourceParent,
        "Delayed message has no retained authenticated source",
      );
      const delayedRumor = core.deserializeApplicationData(
        delivered.result.message,
      );
      const delayedMedia = await client.downloadMessageMedia(
        group,
        delayedRumor.tags,
        delivered.sourceParent,
        { transport },
      );
      assert.equal(delayedMedia[0].status, "ready");
      assert.equal(
        new TextDecoder().decode(delayedMedia[0].data),
        "Rust media v2 payload",
      );
      console.log(
        "PASS: delayed MDK attachment decrypts after a real epoch advance",
      );

      const multiple = await client.prepareMediaMessage(
        group,
        ["first", "second"].map((name) => ({
          blob: new Blob([name], { type: "text/plain" }),
          metadata: { filename: name + ".txt" },
        })),
        { transport, caption: "Caption survives missing attachment" },
      );
      blobs.delete("/" + multiple.attachments[0].ciphertextSha256);
      const multiSource = group.state;
      const multiEffects = await group.session.send(multiple.intent);
      const multiPeeled = await core.decryptGroupMessages(
        [multiEffects.publish[0].envelope],
        multiSource,
        suite,
      );
      const multiResult = await call({
        op: "media_receive",
        group_id: request.group_id,
        message: bytesToHex(
          mls.encode(mls.mlsMessageEncoder, multiPeeled.read[0].message),
        ),
      });
      assert.equal(multiResult.caption, "Caption survives missing attachment");
      assert.deepEqual(
        multiResult.outcomes.map((result) => result.status),
        ["unavailable", "ready"],
      );
      assert.equal(
        multiResult.outcomes[1].plaintext,
        bytesToHex(new TextEncoder().encode("second")),
      );
      console.log(
        "PASS: actual MDK media decode keeps caption and valid sibling when one blob is unavailable",
      );
      if (process.env.MDK_WRITE_FIXTURES === "1") {
        const fixture = await call({ op: "media_fixture", server: serverUrl });
        const reference = core.parseMediaImetaTag(fixture.tag);
        await writeFile(
          join(directory, "../../src/__tests__/fixtures/media-v2-rust.json"),
          JSON.stringify(
            {
              provenance: {
                mdk: execFileSync(
                  "git",
                  ["-C", sourceRoot, "rev-parse", "HEAD"],
                  { encoding: "utf8" },
                ).trim(),
                command:
                  "MDK_PROFILE=media MDK_WRITE_FIXTURES=1 node scripts/mdk-interop/run.mjs",
                implementation:
                  "marmot-app upload_encrypted_media; test-only bridge; fixed disposable exporter",
              },
              mediaSecret: "2a".repeat(32),
              plaintext: bytesToHex(
                new TextEncoder().encode("Rust media v2 payload"),
              ),
              policy: fixture.policy,
              tag: fixture.tag,
              encrypted: bytesToHex(
                blobs.get(new URL(reference.locators[0].value).pathname),
              ),
            },
            null,
            2,
          ) + "\n",
        );
      }
    } finally {
      group.dispose();
    }
  }
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
      ...(profile === "media"
        ? [
            core.encryptedMediaEntry(
              core.encryptedMediaBlossomDefault([serverUrl]),
            ),
          ]
        : []),
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
  server.closeAllConnections();
  server.close();
  if (profile === "media")
    execFileSync("git", [
      "-C",
      sourceRoot,
      "worktree",
      "remove",
      "--force",
      root,
    ]);
}
