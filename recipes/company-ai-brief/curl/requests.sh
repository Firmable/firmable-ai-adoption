#!/usr/bin/env bash
# The request the company-ai-brief recipe makes: one POST /ai-adoption batch with evidence.
# Reads the key from FIRMABLE_API_KEY. Nothing here runs on install.
# This call spends credits: 3 credits for each company found with evidence.
# Companies not found are free. Before reading, the API checks your organisation could pay
# 3 credits for every company in the batch, and answers 402 if not.
set -euo pipefail
: "${FIRMABLE_API_KEY:?Set FIRMABLE_API_KEY to your developer API key}"
API="https://api.firmable.com"

echo "AI Adoption with evidence for two companies (up to 6 credits)"
curl -sS -X POST "$API/ai-adoption?withEvidence=true" \
  -H "Authorization: Bearer $FIRMABLE_API_KEY" -H "Content-Type: application/json" \
  -d '{"records": [{"domain": "canva.com", "external_id": "co-001"}, {"domain": "atlassian.com", "external_id": "co-002"}]}' \
  | head -c 3000
echo
