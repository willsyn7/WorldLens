#!/usr/bin/env bash
# Local dev convenience: builds and starts ingest-service, runs the ETL
# against it, then shuts it down. In production these are two separate
# Cloud Run deployments (ingest-service is long-running; the ETL is a job
# triggered by Cloud Scheduler) — this script only exists to make a manual
# local run a single command.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BIN="$(mktemp -d)/ingest-service"
echo "Building ingest-service..."
(cd ingest-service && go build -o "$BIN" ./cmd/server)

echo "Starting ingest-service..."
"$BIN" &
INGEST_PID=$!
trap 'kill "$INGEST_PID" 2>/dev/null || true' EXIT
sleep 2

echo "Running ETL..."
(cd etl && .venv/bin/python -m worldlens_etl.main)
