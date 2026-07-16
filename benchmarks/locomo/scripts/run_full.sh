#!/bin/bash
# Full measured LoCoMo run: purge -> ingest (batched, stability-gated) ->
# verification gates -> answer -> score.
#
# bash 3.2 compatible (macOS system bash): no declare -A, no mapfile.
#
# Required env:
#   API_URL, API_KEY        product under test (Deep Recall dev + default product key)
#   ANTHROPIC_API_KEY       locked judge (and adapter-mode answering)
#   ADMIN_KEY               dead-letter verification gate
# Recommended env:
#   CLOUDFLARE_ACCOUNT_ID   wrangler gates (errored workflows, vector sample)
#   RUN_NAME                labels artifacts, e.g. RUN_NAME=captions_bedrock
#   TOP_K                   10 = locked headline config (default)
#
# Usage: run_full.sh [purge|ingest|verify|answer|score|all]
# Stages are separately invocable so a multi-hour run can resume where it
# stopped (answer/score already checkpoint+resume internally).
set -u
cd "$(dirname "$0")/.." || exit 1   # benchmarks/locomo
: "${API_URL:?set API_URL}" "${API_KEY:?set API_KEY}"

PY=${PY:-python3}
STAGE=${1:-all}
RUN_NAME=${RUN_NAME:-run}
export TOP_K=${TOP_K:-10}
export SAMPLES=all
export PREDICTIONS_FILE=${PREDICTIONS_FILE:-results/predictions_${RUN_NAME}.json}
export SCORED_FILE=${SCORED_FILE:-results/scored_${RUN_NAME}.json}

ALL="conv-26 conv-30 conv-41 conv-42 conv-43 conv-44 conv-47 conv-48 conv-49 conv-50"
STAMP_FILE="results/.run_started_at_${RUN_NAME}"

stage_purge() {
  echo "=== PURGE $(date +%H:%M:%S)"
  # Stamp the run start BEFORE any ingestion so the workflow/dead-letter
  # gates can exclude historical noise from earlier imports.
  date -u +%Y-%m-%dT%H:%M:%SZ > "$STAMP_FILE"
  for c in $ALL; do
    bash scripts/purge.sh "$c" || bash scripts/purge.sh "$c" || exit 1
  done
  echo "=== POST-PURGE COUNTS (must all be 0)"
  $PY scripts/verify_store.py count --expect-zero $ALL || exit 1
}

stage_ingest() {
  # Batched with a stability gate between batches — a full-set concurrent
  # import is what previously drove Vectorize 429s.
  # NOT restartable mid-stage: re-submitting a session creates a new workflow
  # instance (duplicate memories). If this stage dies, re-run from purge.
  for spec in "0:1" "1:4" "4:7" "7:10"; do
    echo "=== INGEST batch $spec $(date +%H:%M:%S)"
    SAMPLES=$spec INGEST_WAIT=1 $PY harness/ingest.py || { echo "INGEST FAILED ($spec)"; exit 1; }
  done
  echo "=== INGEST DONE $(date +%H:%M:%S)"
  $PY scripts/verify_store.py count $ALL
}

stage_verify() {
  export RUN_STARTED_AT=${RUN_STARTED_AT:-$(cat "$STAMP_FILE" 2>/dev/null || echo "")}
  $PY scripts/verify_store.py gates $ALL || exit 1
}

stage_answer() {
  echo "=== ANSWER (TOP_K=$TOP_K -> $PREDICTIONS_FILE) $(date +%H:%M:%S)"
  $PY harness/answer.py || exit 1
}

stage_score() {
  echo "=== SCORE ($SCORED_FILE) $(date +%H:%M:%S)"
  $PY harness/score.py
}

case $STAGE in
  purge)  stage_purge ;;
  ingest) stage_ingest ;;
  verify) stage_verify ;;
  answer) stage_answer ;;
  score)  stage_score ;;
  all)    stage_purge && stage_ingest && stage_verify && stage_answer && stage_score ;;
  *) echo "unknown stage: $STAGE (purge|ingest|verify|answer|score|all)"; exit 1 ;;
esac
