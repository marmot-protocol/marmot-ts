# Tag Cardinality Cross-Implementation Dossier

Evidence captured on 2026-09-06 UTC from a detached worktree at the immutable tested source. This attestation was written later and does not redefine the tested source.

<!-- quality-dossier-evidence:start -->
```json
{
  "schema_version": 1,
  "dossier": "tag-cardinality",
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
    "rust_command": "cargo run --quiet --manifest-path tools/quality-gate/tag-probe/Cargo.toml --locked",
    "rust_output_or_digest": "exit=0; sha256=72449286faac63fbc300c8972386430406ba947a4a0784b8a4d9aca13714bf80",
    "fixture_diff_result": "exit=0; bytes_equal=true",
    "typescript_command": "npx --yes pnpm@10.18.3 vitest run src/core/__tests__/key-package-tag-parity.test.ts",
    "vitest_version": "3.2.6",
    "typescript_output": "exit=0; test_files=1; tests=57; vitest=3.2.6",
    "typescript_output_sha256": "b7ddf2fd09d6fb657885a8c7add8d511c03163172b4a935210253fd3598093de"
  },
  "oracle": {
    "generator_language": "Rust",
    "generator_path": "tools/quality-gate/tag-probe/src/main.rs",
    "subject_language": "TypeScript",
    "subject_paths": [
      "src/core/__tests__/key-package-tag-parity.test.ts",
      "src/utils/tag-cardinality.ts"
    ],
    "independence": "independent",
    "source_classification": "rust-producer-and-spec-receiver"
  },
  "negative_control": {
    "command": "npx --yes pnpm@10.18.3 vitest run src/core/__tests__/key-package-tag-parity.test.ts -t \"negative control rejects a mutated Rust oracle through production parity\"",
    "result": "exit=0; test_files=1; tests=1; vitest=3.2.6",
    "output_sha256": "4f6ee480e6f794f8e5cdf5ef1b9cc2a4cc32a895ea213f31c8301dc42dadc033"
  }
}
```
<!-- quality-dossier-evidence:end -->

## Result

PASS — the independent Rust fixture reproduced byte-for-byte, shipping TypeScript verification passed, and the dossier-specific mutation control rejected altered evidence.
