# SafeAAD and Leaf Capability Parity Dossier

Evidence captured on 2026-09-06 UTC from a detached worktree at the immutable tested source. This attestation was written later and does not redefine the tested source.

<!-- quality-dossier-evidence:start -->
```json
{
  "schema_version": 1,
  "dossier": "safe-aad",
  "provenance": {
    "tested_source_sha": "7a71aa56299e7f4e541f0f71a9ff392896c50243",
    "marmot_sha": "4a2bc65f8db5866cec3b2a127dedb37818eaf207",
    "mdk_sha": "dbf45c83a8e157302edd13010944ad2c6a9cf9a5",
    "lockfile_sha256": "0f516945e45e257735c4c89a5e9e08b4bb2f839b7ce48121a71b4fb0b03a0932"
  },
  "environment": {
    "detached_worktree": true,
    "node_version": "v22.23.1",
    "pnpm_version": "10.18.3",
    "cargo_version": "cargo 1.97.1 (c980f4866 2026-06-30)",
    "rustc_version": "rustc 1.97.1 (8bab26f4f 2026-07-14)",
    "install_command": "npx --yes pnpm@10.18.3 install --frozen-lockfile",
    "install_result": "exit=0; lockfile_sha256=0f516945e45e257735c4c89a5e9e08b4bb2f839b7ce48121a71b4fb0b03a0932",
    "install_result_sha256": "81be6d549afad3f8f687e210f75cecf42cb9f7932bc7faaba953322c705bfcfb",
    "post_install_lockfile_sha256": "0f516945e45e257735c4c89a5e9e08b4bb2f839b7ce48121a71b4fb0b03a0932"
  },
  "verification": {
    "compile_command": "npx --yes pnpm@10.18.3 compile",
    "compile_result": "exit=0",
    "build_command": "npx --yes pnpm@10.18.3 build",
    "build_result": "exit=0",
    "rust_command": "cargo run --quiet --manifest-path tools/quality-gate/safe-aad-probe/Cargo.toml --locked",
    "rust_output_or_digest": "exit=0; sha256=e0aa57f747c2cd308be0f78d3206a2ac621f07fb2510d082501f68c7158bf2c7",
    "fixture_diff_result": "exit=0; bytes_equal=true",
    "typescript_command": "npx --yes pnpm@10.18.3 vitest run src/core/components/__tests__/safe-aad-parity.test.ts",
    "vitest_version": "3.2.6",
    "typescript_output": "exit=0; test_files=1; tests=4; vitest=3.2.6",
    "typescript_output_sha256": "e24599415f24e6dcf01d167815546a4933efcca3e4b29a96cbad465197cb2fff"
  },
  "oracle": {
    "generator_language": "Rust",
    "generator_path": "tools/quality-gate/safe-aad-probe/src/main.rs",
    "subject_language": "TypeScript",
    "subject_paths": [
      "src/core/components/__tests__/safe-aad-parity.test.ts"
    ],
    "independence": "independent"
  },
  "negative_control": {
    "command": "npx --yes pnpm@10.18.3 vitest run src/core/components/__tests__/safe-aad-parity.test.ts -t \"detects a one-byte dictionary mutation\"",
    "result": "exit=0; test_files=1; tests=1; vitest=3.2.6",
    "output_sha256": "4f6ee480e6f794f8e5cdf5ef1b9cc2a4cc32a895ea213f31c8301dc42dadc033"
  },
  "review": {
    "b4649c01_sha": "b4649c015dc154e561d0f61147486142114d887a",
    "b4649c01_result": "reviewed PASS: implicit RFC defaults omitted from signed capabilities while effective support is preserved"
  }
}
```
<!-- quality-dossier-evidence:end -->

## Result

PASS — the independent Rust fixture reproduced byte-for-byte, shipping TypeScript verification passed, and the dossier-specific mutation control rejected altered evidence.
