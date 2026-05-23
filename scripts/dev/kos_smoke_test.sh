#!/usr/bin/env bash
# Sprint 19 M2 PR-2g — KOS connectivity smoke test.
#
# 4-step automated check covering everything PR-2c ships:
#   1. GET /health (no auth)
#   2. POST /token client_credentials → access_token
#   3. POST /mcp tools/call query "redis" → SSE response parse
#   4. Python KOSClient e2e (env-driven config + smart unwrap)
#
# Reads KOS_MCP_BASE / KOS_OAUTH_CLIENT_ID / KOS_OAUTH_CLIENT_SECRET from .env.
# Exits 0 on full success, 1 on any step failure.
#
# Usage: bash scripts/dev/kos_smoke_test.sh

set -uo pipefail

# Locate project root (script is in scripts/dev/, root is 2 up)
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"

# ---- helpers ----------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RESET='\033[0m'

ok()   { printf "${GREEN}OK${RESET} %s\n" "$1"; }
fail() { printf "${RED}FAIL${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}WARN${RESET} %s\n" "$1"; }

# ---- 0. Load env ------------------------------------------------------------
if [[ ! -f .env ]]; then
  fail "no .env at $PROJECT_ROOT/.env"
  exit 1
fi

# shellcheck disable=SC1091
set -a
source .env
set +a

if [[ -z "${KOS_MCP_BASE:-}" ]] || [[ -z "${KOS_OAUTH_CLIENT_ID:-}" ]] || [[ -z "${KOS_OAUTH_CLIENT_SECRET:-}" ]]; then
  fail "missing KOS env (need KOS_MCP_BASE + KOS_OAUTH_CLIENT_ID + KOS_OAUTH_CLIENT_SECRET in .env)"
  exit 1
fi

echo "─── Sprint 19 M2 PR-2g KOS smoke test ───"
echo "base: $KOS_MCP_BASE"
echo

# ---- 1. /health (no auth) ---------------------------------------------------
HEALTH=$(curl -fsS --max-time 10 "$KOS_MCP_BASE/health" 2>&1)
RC=$?
if [[ $RC -ne 0 ]]; then
  fail "[1/4] /health curl failed (rc=$RC): $HEALTH"
  exit 1
fi
STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")
VERSION=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "?")
ENGINE=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('engine','?'))" 2>/dev/null || echo "?")
if [[ "$STATUS" != "ok" ]]; then
  fail "[1/4] /health status=$STATUS (expected 'ok'); raw=$HEALTH"
  exit 1
fi
ok "[1/4] /health ............... status=$STATUS version=$VERSION engine=$ENGINE"

# ---- 2. /token client_credentials -------------------------------------------
TOKEN_RESPONSE=$(curl -fsS --max-time 10 -X POST "$KOS_MCP_BASE/token" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=$KOS_OAUTH_CLIENT_ID" \
  --data-urlencode "client_secret=$KOS_OAUTH_CLIENT_SECRET" \
  --data-urlencode "scope=read write" 2>&1)
RC=$?
if [[ $RC -ne 0 ]]; then
  fail "[2/4] /token curl failed (rc=$RC): $TOKEN_RESPONSE"
  exit 1
fi
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
EXPIRES_IN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('expires_in','?'))" 2>/dev/null)
if [[ -z "$ACCESS_TOKEN" ]]; then
  fail "[2/4] /token returned no access_token; raw=$TOKEN_RESPONSE"
  exit 1
fi
ok "[2/4] OAuth /token .......... access_token len=${#ACCESS_TOKEN} expires_in=${EXPIRES_IN}s"

# ---- 3. /mcp tools/call query (SSE response) --------------------------------
MCP_PAYLOAD='{"jsonrpc":"2.0","id":"smoke","method":"tools/call","params":{"name":"query","arguments":{"query":"redis","limit":3}}}'

MCP_RESPONSE=$(curl -fsS --max-time 15 -X POST "$KOS_MCP_BASE/mcp" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$MCP_PAYLOAD" 2>&1)
RC=$?
if [[ $RC -ne 0 ]]; then
  fail "[3/4] /mcp curl failed (rc=$RC): $MCP_RESPONSE"
  exit 1
fi

# Extract SSE data: line then JSON-parse
HIT_COUNT=$(echo "$MCP_RESPONSE" \
  | grep '^data: ' | sed 's/^data: //' \
  | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    inner = json.loads(d['result']['content'][0]['text'])
    print(len(inner) if isinstance(inner, list) else -1)
except Exception as e:
    print(-1)
" 2>/dev/null)

TOP_SCORE=$(echo "$MCP_RESPONSE" \
  | grep '^data: ' | sed 's/^data: //' \
  | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    inner = json.loads(d['result']['content'][0]['text'])
    if isinstance(inner, list) and inner:
        print(f\"{inner[0].get('score', 0):.3f}\")
    else:
        print('?')
except Exception:
    print('?')
" 2>/dev/null)

if [[ "$HIT_COUNT" -lt 0 ]] 2>/dev/null; then
  fail "[3/4] /mcp SSE parse failed; raw first 200B: $(echo "$MCP_RESPONSE" | head -c 200)"
  exit 1
fi
ok "[3/4] MCP query 'redis' ..... $HIT_COUNT hits, top score=$TOP_SCORE"

# ---- 4. Python KOSClient e2e ------------------------------------------------
PYTHON_OUTPUT=$(./venv/bin/python3 -c "
import os, sys
sys.path.insert(0, '$PROJECT_ROOT')
from src.kos import KOSClient
c = KOSClient()
assert c.configured, 'client not configured'
h = c.health()
assert h.get('status') == 'ok', f'health bad: {h}'
hits = c.query('redis', limit=3)
print(f'configured={c.configured} health_engine={h.get(\"engine\")} query_hits={len(hits)}')
" 2>&1)
RC=$?
if [[ $RC -ne 0 ]]; then
  fail "[4/4] Python KOSClient e2e (rc=$RC): $PYTHON_OUTPUT"
  exit 1
fi
ok "[4/4] Python KOSClient e2e .. $PYTHON_OUTPUT"

echo
echo "─── All 4 steps OK — KOS pipeline ready ───"
exit 0
