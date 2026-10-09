#!/usr/bin/env bash
set -euo pipefail

: "${MODEL_API_URL:?Set MODEL_API_URL to the full OpenAI-compatible /v1/chat/completions URL}"
: "${MODEL_API_TOKEN:?Set MODEL_API_TOKEN (dedicated model token, not RUNPOD_API_KEY)}"
: "${MODEL_ID:?Set MODEL_ID accepted by the server}"

access_headers=()
if [[ -n "${INFERENCE_ACCESS_CLIENT_ID:-}" || -n "${INFERENCE_ACCESS_CLIENT_SECRET:-}" ]]; then
  : "${INFERENCE_ACCESS_CLIENT_ID:?Set both inference Access service-token values}"
  : "${INFERENCE_ACCESS_CLIENT_SECRET:?Set both inference Access service-token values}"
  access_headers+=(--header "CF-Access-Client-Id: ${INFERENCE_ACCESS_CLIENT_ID}")
  access_headers+=(--header "CF-Access-Client-Secret: ${INFERENCE_ACCESS_CLIENT_SECRET}")
fi

case "$MODEL_API_URL" in
  https://*) ;;
  *) echo "Refusing non-HTTPS model URL" >&2; exit 2 ;;
esac

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
status="$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
  --max-time 40 \
  --header "Authorization: Bearer ${MODEL_API_TOKEN}" \
  --header 'Content-Type: application/json' \
  --header 'Accept: text/event-stream' \
  "${access_headers[@]}" \
  --data "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word READY.\"}],\"max_tokens\":8,\"stream\":true}" \
  "$MODEL_API_URL")" || { echo "Model endpoint request failed (transport error)." >&2; exit 1; }

if [ "$status" != "200" ]; then
  echo "Model endpoint returned HTTP $status; response body suppressed." >&2
  exit 1
fi
if ! rg -q '^data: ' "$response_file"; then
  echo "Model endpoint did not return SSE data frames." >&2
  exit 1
fi
echo "Model endpoint returned HTTP 200 with SSE data frames."
