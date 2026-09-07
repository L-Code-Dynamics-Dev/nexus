#!/usr/bin/env bash
# Shadow harness runner -- jediný podporovaný způsob, jak pustit P3/P2.
#
# PROČ SHELL WRAPPER: okfish `pricing-bridge.ts` staví cestu ke
# `src/config/policies/policy-v1.json` přes `process.cwd()`, takže běh musí
# mít CWD = okfish klon. Zároveň klon nemá `node_modules` (a psát do něj je
# zakázáno), takže `decimal.js`/`zod` se musí resolvovat z NEXUSu -- to řeší
# NODE_PATH. Obojí najednou z package.json scriptu nejde čitelně vyjádřit.
#
# ZERO PRODUCTION WRITES: skript explicitně ODEBÍRÁ SHOPTET_PRIVATE_API_TOKEN
# z prostředí potomka. I kdyby ho měl uživatel v shellu, shadow ho nedostane.
#
# Použití:
#   tools/shadow/run.sh p3 [--limit 500] [--offline] [--out out.json]
#   tools/shadow/run.sh p2 [--limit 500] [--out out.json]

set -euo pipefail

NEXUS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OKFISH_CLONE="${OKFISH_CLONE:-/Users/lucky/.claude/jobs/99e48aa8/tmp/okfish-live}"

if [ ! -d "$OKFISH_CLONE" ]; then
  echo "[NEXUS_SHADOW] okfish klon nenalezen: $OKFISH_CLONE" >&2
  echo "  Nastav OKFISH_CLONE=<cesta> a spusť znovu." >&2
  exit 1
fi

MODE="${1:-}"
shift || true

case "$MODE" in
  p3) SCRIPT="$NEXUS_ROOT/tools/shadow/p3-okfish-selfcheck.ts" ;;
  p2) SCRIPT="$NEXUS_ROOT/tools/shadow/p2-nexus-vs-okfish.ts" ;;
  *)
    echo "Použití: $0 {p3|p2} [args...]" >&2
    exit 2
    ;;
esac

cd "$OKFISH_CLONE"

env -u SHOPTET_PRIVATE_API_TOKEN \
    NODE_PATH="$NEXUS_ROOT/node_modules" \
    OKFISH_CLONE="$OKFISH_CLONE" \
    NODE_OPTIONS="--max-old-space-size=8192" \
    npx --yes tsx "$SCRIPT" "$@"
