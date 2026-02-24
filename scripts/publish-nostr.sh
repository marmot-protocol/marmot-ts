#!/usr/bin/env bash
set -euo pipefail

# Publish Nostr notification for new releases
# Usage: ./scripts/publish-nostr.sh [published_packages_json]
#
# Environment variables:
#   NOSTR_KEY: Nostr private key (nsec or hex). If not provided, runs in dry-run mode.
#   GITHUB_REPOSITORY: Repository name (e.g., "owner/repo"). Defaults to git remote.

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Require nak to be installed
if ! command -v nak &> /dev/null; then
  echo -e "${RED}Error: nak CLI is required but not found${NC}"
  echo ""
  echo "Install nak from: https://github.com/fiatjaf/nak"
  echo ""
  echo "On Linux:"
  echo "  curl -L https://github.com/fiatjaf/nak/releases/latest/download/nak-linux-amd64 -o /tmp/nak"
  echo "  sudo mv /tmp/nak /usr/local/bin/nak"
  echo "  sudo chmod +x /usr/local/bin/nak"
  echo ""
  echo "On macOS:"
  echo "  brew install fiatjaf/tap/nak"
  echo ""
  exit 1
fi

# Require jq to be installed
if ! command -v jq &> /dev/null; then
  echo -e "${RED}Error: jq is required but not found${NC}"
  echo ""
  echo "Install jq from: https://stedolan.github.io/jq/"
  echo ""
  echo "On Linux:"
  echo "  sudo apt-get install jq"
  echo ""
  echo "On macOS:"
  echo "  brew install jq"
  echo ""
  exit 1
fi

# Get repository name
if [ -z "${GITHUB_REPOSITORY:-}" ]; then
  GITHUB_REPOSITORY=$(git remote get-url origin | sed 's/.*github\.com[:/]\(.*\)\.git/\1/' || echo "unknown/repo")
fi

# Parse published packages JSON
PUBLISHED_PACKAGES_JSON="${1:-}"
if [ -z "$PUBLISHED_PACKAGES_JSON" ]; then
  echo -e "${YELLOW}Warning: No published packages JSON provided${NC}"
  echo ""

  # Fallback to reading from package.json
  if [ -f "package.json" ]; then
    echo -e "${BLUE}Reading package info from package.json...${NC}"
    PKG_NAME=$(jq -r '.name // "unknown"' package.json)
    PKG_VERSION=$(jq -r '.version // "0.0.0"' package.json)
    PUBLISHED_PACKAGES_JSON="[{\"name\":\"$PKG_NAME\",\"version\":\"$PKG_VERSION\"}]"
    echo -e "${GREEN}Found: $PKG_NAME@$PKG_VERSION${NC}"
  else
    echo -e "${RED}Error: No package.json found${NC}"
    echo "Usage: $0 '[{\"name\":\"pkg\",\"version\":\"1.0.0\"}]'"
    exit 1
  fi
fi

# Parse published packages into a comma-separated list
PACKAGES=$(echo "$PUBLISHED_PACKAGES_JSON" | jq -r '.[] | "\(.name)@\(.version)"' | paste -sd ", ")

if [ -z "$PACKAGES" ]; then
  echo -e "${RED}Error: Could not parse published packages${NC}"
  exit 1
fi

# Get the latest changelog entry from CHANGELOG.md
if [ -f "CHANGELOG.md" ]; then
  CHANGELOG=$(awk '/^## /{if(++count==2) exit} count==1' CHANGELOG.md | tail -n +2 | sed 's/^$//' | head -c 500)
else
  echo -e "${YELLOW}Warning: CHANGELOG.md not found${NC}"
  CHANGELOG="No changelog available"
fi

# Compose the message using a heredoc
MESSAGE=$(cat <<EOF
🚀 New Release: ${GITHUB_REPOSITORY}

Published packages:
${PACKAGES}

${CHANGELOG}
EOF
)

# Get outbox relays if NOSTR_KEY is provided
RELAYS=()
if [ -n "${NOSTR_KEY:-}" ]; then
  echo -e "${BLUE}Getting outbox relays from Nostr...${NC}"

  # Get public key from NOSTR_KEY
  PUBKEY=$(nak key public "$NOSTR_KEY" 2>/dev/null || echo "")

  if [ -z "$PUBKEY" ]; then
    echo -e "${YELLOW}Warning: Could not get public key from NOSTR_KEY${NC}"
  else
    echo -e "${BLUE}Public key: ${PUBKEY}${NC}"

    # Get outbox relays for the public key
    RELAY_LIST=$(nak outbox list "$PUBKEY" 2>/dev/null || echo "")

    if [ -n "$RELAY_LIST" ]; then
      # Convert relay list to array
      while IFS= read -r relay; do
        if [ -n "$relay" ]; then
          RELAYS+=("$relay")
        fi
      done <<< "$RELAY_LIST"
    fi
  fi

  # Fallback to default relays if none found
  if [ ${#RELAYS[@]} -eq 0 ]; then
    echo -e "${YELLOW}Warning: No outbox relays found, using defaults${NC}"
    RELAYS=(
      "wss://relay.damus.io"
      "wss://nos.lol"
      "wss://relay.primal.net"
    )
  else
    echo -e "${GREEN}Found ${#RELAYS[@]} outbox relay(s)${NC}"
  fi
fi

# Check if NOSTR_KEY is provided
if [ -z "${NOSTR_KEY:-}" ]; then
  echo -e "${YELLOW}=== DRY RUN MODE ===${NC}"
  echo -e "${BLUE}NOSTR_KEY not provided. This is what would be published:${NC}"
  echo ""
  echo -e "${GREEN}--- Message ---${NC}"
  echo "$MESSAGE"
  echo ""
  echo -e "${GREEN}--- Relays ---${NC}"
  echo "  (Default relays - set NOSTR_KEY to see your outbox relays)"
  echo "  - wss://relay.damus.io"
  echo "  - wss://nos.lol"
  echo "  - wss://relay.primal.net"
  echo ""
  echo -e "${YELLOW}To publish for real, set the NOSTR_KEY environment variable:${NC}"
  echo "  export NOSTR_KEY='your-nsec-or-hex-key'"
  echo "  $0 '$PUBLISHED_PACKAGES_JSON'"
  exit 0
fi

# Publish to Nostr relays
echo -e "${GREEN}Publishing to Nostr...${NC}"
echo -e "${BLUE}Using relays:${NC}"
for relay in "${RELAYS[@]}"; do
  echo "  - $relay"
done
echo ""

# Relays are passed as positional arguments at the end
echo "$MESSAGE" | nak publish --sec "$NOSTR_KEY" "${RELAYS[@]}"

echo -e "${GREEN}✓ Successfully published to Nostr!${NC}"
