#!/usr/bin/env bash
set -euo pipefail

# Build and publish an ephemeral prerelease to the npm "next" dist-tag.
# The generated version is not committed and package files are restored on exit.

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm is required but was not found" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required but was not found" >&2
  exit 1
fi

if [ ! -f package.json ]; then
  echo "Error: package.json not found. Run this script from the repository root." >&2
  exit 1
fi

current_branch=$(git branch --show-current)
if [ "$current_branch" != "master" ]; then
  echo "Error: next releases can only be published from the master branch." >&2
  echo "Current branch: ${current_branch:-detached HEAD}" >&2
  exit 1
fi

git fetch origin master
local_head=$(git rev-parse HEAD)
remote_head=$(git rev-parse refs/remotes/origin/master)
if [ "$local_head" != "$remote_head" ]; then
  echo "Error: next releases can only be published from the tip of origin/master." >&2
  echo "Local HEAD:    $local_head" >&2
  echo "origin/master: $remote_head" >&2
  exit 1
fi

if ! pnpm npm whoami >/dev/null 2>&1; then
  echo "Error: not logged in to the npm registry used by pnpm." >&2
  echo "Run 'pnpm npm login' before publishing a next release." >&2
  exit 1
fi

if [ "${SKIP_GIT_CHECK:-}" != "1" ] && [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree must be clean before publishing a next release." >&2
  echo "Set SKIP_GIT_CHECK=1 to override." >&2
  exit 1
fi

backup_dir=$(mktemp -d)
cp package.json "$backup_dir/package.json"
if [ -f pnpm-lock.yaml ]; then
  cp pnpm-lock.yaml "$backup_dir/pnpm-lock.yaml"
fi

restore_package_files() {
  cp "$backup_dir/package.json" package.json
  if [ -f "$backup_dir/pnpm-lock.yaml" ]; then
    cp "$backup_dir/pnpm-lock.yaml" pnpm-lock.yaml
  fi
  rm -rf "$backup_dir"
}
trap restore_package_files EXIT

package_name=$(node -p "require('./package.json').name")
current_version=$(node -p "require('./package.json').version")
base_version=$(node -e '
const version = process.argv[1];
const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
if (!match) throw new Error(`Unsupported package version: ${version}`);
const [, major, minor, patch] = match;
process.stdout.write(`${major}.${minor}.${Number(patch) + 1}`);
' "$current_version")
timestamp=$(date -u +%Y%m%d%H%M%S)
next_version="${base_version}-next.${timestamp}"

echo "Preparing ${package_name}@${next_version} for the npm next dist-tag..."

if pnpm view "${package_name}@${next_version}" version >/dev/null 2>&1; then
  echo "Error: ${package_name}@${next_version} already exists on npm." >&2
  exit 1
fi

pnpm version "$next_version" --no-git-tag-version
pnpm build
pnpm publish --tag next --access public --no-git-checks

echo "Published ${package_name}@${next_version} with dist-tag next."
