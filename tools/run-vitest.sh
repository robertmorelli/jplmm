#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANDIDATES=()

if [[ -x /opt/homebrew/bin/node ]]; then
  CANDIDATES+=("/opt/homebrew/bin/node")
fi
if [[ -x /usr/local/bin/node ]]; then
  CANDIDATES+=("/usr/local/bin/node")
fi
CANDIDATES+=("node")

for NODE_BIN in "${CANDIDATES[@]}"; do
  if "$NODE_BIN" -e 'process.exit(Number(Number(process.versions.node.split(".")[0]) < 20))' >/dev/null 2>&1; then
    exec "$NODE_BIN" "$ROOT_DIR/node_modules/vitest/vitest.mjs" run "$@"
  fi
done

echo "Vitest requires Node 20+ and no suitable node binary was found." >&2
exit 1
