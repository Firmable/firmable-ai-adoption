#!/usr/bin/env bash
# The request the adoption-landscape recipe makes: one POST /ai-adoption with a batch of companies.
# Reads the key from FIRMABLE_API_KEY. Nothing here runs on install.
# Each company found costs 0.2 credits (1 credit per 5 companies); companies not found are free.
# Adding ?withEvidence=true costs 3 credits per company found with evidence.
set -euo pipefail
: "${FIRMABLE_API_KEY:?Set FIRMABLE_API_KEY to your developer API key}"
API="https://api.firmable.com"

echo "AI Adoption for a batch of three companies (up to 0.6 credits)"
curl -sS -X POST "$API/ai-adoption" \
  -H "Authorization: Bearer $FIRMABLE_API_KEY" -H "Content-Type: application/json" \
  -d '{"records": [
        {"domain": "canva.com", "external_id": "r1"},
        {"domain": "atlassian.com", "external_id": "r2"},
        {"domain": "xero.com", "external_id": "r4"}
      ]}'
echo
