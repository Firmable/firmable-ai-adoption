#!/usr/bin/env bash
# The request the peer-comparison recipe makes: one POST /ai-adoption with the focus company and its peers.
# Reads the key from FIRMABLE_API_KEY. Nothing here runs on install.
# Each company found costs 0.2 credits (1 credit per 5 companies); companies not found are free.
set -euo pipefail
: "${FIRMABLE_API_KEY:?Set FIRMABLE_API_KEY to your developer API key}"
API="https://api.firmable.com"

echo "AI Adoption for a focus company and two peers (up to 0.6 credits)"
curl -sS -X POST "$API/ai-adoption" \
  -H "Authorization: Bearer $FIRMABLE_API_KEY" -H "Content-Type: application/json" \
  -d '{"records": [
        {"domain": "canva.com", "external_id": "focus"},
        {"domain": "atlassian.com", "external_id": "p1"},
        {"domain": "xero.com", "external_id": "p4"}
      ]}'
echo
