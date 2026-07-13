"""ETL entrypoint: run to completion, meant for a Cloud Run job triggered by
Cloud Scheduler every 5 minutes.

Pulls the tracked country/indicator list from the DB itself (not hardcoded),
fetches every pair from the Go ingest-service, and upserts whatever came
back. A partial failure (some indicators unreachable this run) still exits
0 and upserts what succeeded — the next scheduled run will retry the rest,
so there's no need for in-process retry/backfill logic here.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from worldlens_etl import grpc_client
from worldlens_etl.db import Database

# Dev convenience only: loads the repo-root .env if present, without
# overriding real environment variables (e.g. those set by Cloud Run).
load_dotenv(Path(__file__).resolve().parents[3] / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


async def run() -> int:
    ingest_target = os.environ.get("INGEST_SERVICE_ADDR", "localhost:50051")

    with Database() as db:
        countries = db.get_tracked_countries()
        indicators = db.get_tracked_indicators()

        if not countries or not indicators:
            logger.warning("no tracked countries/indicators found; nothing to do")
            return 0

        logger.info(
            "fetching %d countries x %d indicators from %s",
            len(countries), len(indicators), ingest_target,
        )

        results = await grpc_client.fetch_all(ingest_target, countries, indicators)

        observations = [obs for r in results for obs in r.observations]
        failures = [r for r in results if r.error is not None]

        db.upsert_observations(observations)

        logger.info(
            "upserted %d observations from %d/%d successful fetches",
            len(observations), len(results) - len(failures), len(results),
        )
        for f in failures:
            logger.warning("failed: %s/%s: %s", f.country_code, f.indicator_code, f.error)

        # Only fail the whole run if literally nothing could be fetched.
        if failures and len(failures) == len(results):
            return 1
        return 0


def main() -> None:
    exit_code = asyncio.run(run())
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
