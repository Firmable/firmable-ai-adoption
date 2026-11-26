#!/usr/bin/env bash
# The request the ai-momentum-watchlist recipe makes: one POST /ai-adoption batch, without evidence.
# Reads the key from FIRMABLE_API_KEY. Nothing here runs on install.
# This call spends credits: 1 credit per 5 companies found (0.2 each). Companies not found are free.
# Part-credits carry over between requests.
set -euo pipefail
: "${FIRMABLE_API_KEY:?Set FIRMABLE_API_KEY to your developer API key}"
API="https://api.firmable.com"

echo "AI Adoption for two accounts (up to 0.4 credits)"
curl -sS -X POST "$API/ai-adoption" \
  -H "Authorization: Bearer $FIRMABLE_API_KEY" -H "Content-Type: application/json" \
  -d '{"records": [{"domain": "canva.com", "external_id": "acct-001"}, {"domain": "safetyculture.com", "external_id": "acct-002"}]}' \
  | head -c 3000
echo
