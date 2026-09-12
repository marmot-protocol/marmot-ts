#!/usr/bin/env bash
set -euo pipefail

# Packed-tarball consumer smoke: packs the library, verifies the tarball, npm-installs it
# into a fresh throwaway project, and runs the runtime smoke on Node (always), Bun and Deno
# (when available), plus a type-level consumer check under nodenext and bundler resolution.
#
# This script never builds the library itself; run `pnpm build` before invoking it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORK="${PACKAGE_SMOKE_WORKDIR:-$(mktemp -d)}"

if [ ! -f "$ROOT/dist/vendor/ts-mls/index.js" ]; then
  echo "package-smoke: $ROOT/dist/vendor/ts-mls/index.js not found. Run \"pnpm build\" first." >&2
  exit 1
fi

rm -rf "$WORK/pack" "$WORK/consumer"
mkdir -p "$WORK/pack" "$WORK/consumer"

echo "package-smoke: packing tarball..."
(cd "$ROOT" && pnpm pack --pack-destination "$WORK/pack") >/dev/null

tgz_count=$(find "$WORK/pack" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')
if [ "$tgz_count" -ne 1 ]; then
  echo "package-smoke: expected exactly one .tgz in $WORK/pack, found $tgz_count" >&2
  exit 1
fi
TGZ="$(find "$WORK/pack" -maxdepth 1 -name '*.tgz')"

echo "package-smoke: verifying tarball contents..."
node "$ROOT/scripts/verify-package-tarball.mjs" --tarball "$TGZ"

echo "package-smoke: installing tarball into a fresh npm consumer..."
(
  cd "$WORK/consumer"
  npm init -y >/dev/null
  npm pkg set type=module >/dev/null
  npm install --no-audit --no-fund "$TGZ" >/dev/null

  typescript_range="$(node -p "require('$ROOT/package.json').devDependencies.typescript")"
  npm install --no-audit --no-fund --save-dev "typescript@${typescript_range}" >/dev/null
)

if [ -d "$WORK/consumer/node_modules/ts-mls" ]; then
  echo "package-smoke: node_modules/ts-mls exists in the consumer install; dependency confusion regression" >&2
  exit 1
fi

cp "$SCRIPT_DIR/smoke.mjs" "$WORK/consumer/smoke.mjs"
cp "$SCRIPT_DIR/consumer.ts" "$WORK/consumer/consumer.ts"
cp "$SCRIPT_DIR/tsconfig.nodenext.json" "$WORK/consumer/tsconfig.nodenext.json"
cp "$SCRIPT_DIR/tsconfig.bundler.json" "$WORK/consumer/tsconfig.bundler.json"

echo "package-smoke: running Node runtime smoke..."
(cd "$WORK/consumer" && node smoke.mjs)

echo "package-smoke: type-checking consumer under nodenext..."
(cd "$WORK/consumer" && npx tsc -p tsconfig.nodenext.json)

echo "package-smoke: type-checking consumer under bundler..."
(cd "$WORK/consumer" && npx tsc -p tsconfig.bundler.json)

if command -v bun >/dev/null 2>&1; then
  echo "package-smoke: running Bun runtime smoke..."
  (cd "$WORK/consumer" && bun smoke.mjs)
elif [ "${PACKAGE_SMOKE_REQUIRE_BUN:-0}" = "1" ]; then
  echo "package-smoke: bun is required (PACKAGE_SMOKE_REQUIRE_BUN=1) but was not found on PATH" >&2
  exit 1
else
  echo "package-smoke: bun not found on PATH, skipping Bun runtime smoke"
fi

if command -v deno >/dev/null 2>&1; then
  echo "package-smoke: running Deno runtime smoke..."
  (cd "$WORK/consumer" && deno run -A --node-modules-dir=manual smoke.mjs)
elif [ "${PACKAGE_SMOKE_REQUIRE_DENO:-0}" = "1" ]; then
  echo "package-smoke: deno is required (PACKAGE_SMOKE_REQUIRE_DENO=1) but was not found on PATH" >&2
  exit 1
else
  echo "package-smoke: deno not found on PATH, skipping Deno runtime smoke"
fi

echo "package-smoke: PASSED"
