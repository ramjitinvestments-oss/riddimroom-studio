#!/usr/bin/env bash
# Applies storage.cors.json to the riddimroom-studio bucket.
# Requires gcloud / gsutil auth (user must run this — CI cannot, it needs credentials).
# Usage: ./scripts/apply-storage-cors.sh
set -euo pipefail
BUCKET="${BUCKET:-riddimroom-studio.firebasestorage.app}"
echo "Applying CORS to gs://$BUCKET from storage.cors.json ..."
if command -v gcloud >/dev/null 2>&1; then
  gcloud storage buckets update "gs://$BUCKET" --cors-file=storage.cors.json
elif command -v gsutil >/dev/null 2>&1; then
  gsutil cors set storage.cors.json "gs://$BUCKET"
else
  echo "ERROR: neither gcloud nor gsutil found. Install Google Cloud SDK, then re-run." >&2
  exit 1
fi
echo "Done. Verify with: gcloud storage buckets describe gs://$BUCKET --format='json(cors_config)'"
