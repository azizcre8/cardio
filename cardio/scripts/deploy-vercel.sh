#!/usr/bin/env bash
# deploy-vercel.sh — run AFTER `npx vercel login` + `npx vercel link`
# Usage: bash scripts/deploy-vercel.sh [--prod]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CARDIO_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$CARDIO_DIR/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found" && exit 1
fi
if [[ ! -f "$CARDIO_DIR/.vercel/project.json" ]]; then
  echo "ERROR: Vercel project not linked. Run: cd cardio && npx vercel link" && exit 1
fi

echo "==> Pushing env vars to Vercel production..."

push_env() {
  local key=$1
  local val=$2
  if [[ -z "$val" ]]; then
    echo "  SKIP (empty): $key"
    return
  fi
  # Remove existing then add fresh (idempotent)
  printf '%s' "$val" | npx --yes vercel env add "$key" production --force 2>/dev/null || \
  printf '%s' "$val" | npx --yes vercel env add "$key" production
  echo "  OK: $key"
}

# Load .env.local
while IFS='=' read -r key val || [[ -n "$key" ]]; do
  # Skip comments and blank lines
  [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
  # Strip inline comments and surrounding whitespace/quotes
  val="${val%%#*}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  push_env "$key" "$val"
done < "$ENV_FILE"

# Extra env vars not in .env.local
echo ""
echo "==> Setting additional vars..."

# NEXT_PUBLIC_SITE_URL — set from Vercel deployment URL or custom domain
# Get the project URL from Vercel project info
PROJECT_ID=$(cat "$CARDIO_DIR/.vercel/project.json" | python3 -c "import sys,json; print(json.load(sys.stdin)['projectId'])" 2>/dev/null || echo "")
if [[ -n "$PROJECT_ID" ]]; then
  VERCEL_URL=$(npx vercel inspect --scope "$(cat "$CARDIO_DIR/.vercel/project.json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('orgId',''))" 2>/dev/null || echo "")" 2>/dev/null | grep -i "https://" | head -1 | tr -d ' ' || echo "")
fi

# Feature flags (all enabled by default)
for flag in ENABLE_TEXT_QUALITY_CHECK ENABLE_EVIDENCE_GATING ENABLE_HYBRID_RETRIEVAL \
            ENABLE_CONFUSION_DISTRACTORS ENABLE_STRUCTURAL_CHUNKING ENABLE_FUZZY_EVIDENCE_MATCH \
            ENABLE_NEGATIVE_RAG ENABLE_L3_GROUNDING_GUARD ENABLE_DYNAMIC_MODEL_ROUTING \
            ENABLE_STRICT_QUESTION_VALIDATION ENABLE_STRUCTURED_CONFUSION_MAP \
            ENABLE_DISTRACTOR_CANDIDATE_POOL ENABLE_SLOT_BASED_GENERATION; do
  push_env "$flag" "true"
done

echo ""
echo "==> Deploying to production..."
cd "$CARDIO_DIR"
if [[ "${1:-}" == "--prod" ]]; then
  npx vercel --prod --yes
else
  npx vercel --yes
  echo ""
  echo "NOTE: This was a preview deploy. Run with --prod for production."
fi

echo ""
echo "==> Done!"
echo ""
echo "Post-deploy checklist:"
echo "  1. Visit your deployment URL and verify the app loads"
echo "  2. Set NEXT_PUBLIC_SITE_URL in Vercel dashboard to your real domain"
echo "  3. Add Stripe webhook endpoint: <your-url>/api/stripe/webhook"
echo "  4. Paste the STRIPE_WEBHOOK_SECRET from Stripe dashboard into Vercel env vars"
echo "  5. Smoke test: signup → upload PDF → share → join from incognito"
