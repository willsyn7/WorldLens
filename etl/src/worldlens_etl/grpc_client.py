"""Client for the Go ingest-service's CountryDataService.

Fetches one (country, indicator) pair per RPC call, run concurrently across
all pairs, rather than passing a whole indicator list into a single RPC. A
manual smoke test showed the World Bank API has inconsistent per-indicator
latency; batching many indicators into one streaming call let a couple of
slow indicators exhaust the client deadline before the rest were ever
fetched. Per-pair calls isolate that: one slow/failed indicator doesn't
block the others, and a fixed timeout is enough per pair since the ETL has
the whole 5-minute cadence to work with, not one deadline for everything.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from dataclasses import dataclass

import grpc

_GEN_DIR = os.path.join(os.path.dirname(__file__), "gen")
if _GEN_DIR not in sys.path:
    sys.path.insert(0, _GEN_DIR)

from worldbank.v1 import country_data_pb2, country_data_pb2_grpc  # noqa: E402

from worldlens_etl.db import Observation, TrackedCountry, TrackedIndicator

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_CONCURRENCY = 8
DEFAULT_RETRIES = 1


@dataclass(frozen=True)
class FetchResult:
    country_code: str
    indicator_code: str
    observations: list[Observation]
    error: str | None


async def _fetch_one(
    stub: country_data_pb2_grpc.CountryDataServiceStub,
    country: TrackedCountry,
    indicator: TrackedIndicator,
    timeout_seconds: float,
    retries: int,
) -> FetchResult:
    request = country_data_pb2.IndicatorRequest(
        country_code=country.code,
        indicator_codes=[indicator.code],
    )

    last_error: Exception | None = None
    for attempt in range(retries + 1):
        observations: list[Observation] = []
        try:
            call = stub.StreamCountryIndicators(request, timeout=timeout_seconds)
            async for point in call:
                observations.append(
                    Observation(
                        country_code=point.country_code,
                        indicator_code=point.indicator_code,
                        year=point.year,
                        value=point.value if point.has_value else None,
                        has_value=point.has_value,
                    )
                )
            return FetchResult(country.code, indicator.code, observations, None)
        except grpc.aio.AioRpcError as e:
            last_error = e
            logger.warning(
                "fetch failed for %s/%s (attempt %d/%d): %s",
                country.code, indicator.code, attempt + 1, retries + 1, e.details(),
            )

    return FetchResult(country.code, indicator.code, [], str(last_error))


async def fetch_all(
    target: str,
    countries: list[TrackedCountry],
    indicators: list[TrackedIndicator],
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    concurrency: int = DEFAULT_CONCURRENCY,
    retries: int = DEFAULT_RETRIES,
) -> list[FetchResult]:
    """Fetches every (country, indicator) pair concurrently, bounded by
    `concurrency` in-flight requests at a time."""
    async with grpc.aio.insecure_channel(target) as channel:
        stub = country_data_pb2_grpc.CountryDataServiceStub(channel)
        semaphore = asyncio.Semaphore(concurrency)

        async def bounded_fetch(country: TrackedCountry, indicator: TrackedIndicator) -> FetchResult:
            async with semaphore:
                return await _fetch_one(stub, country, indicator, timeout_seconds, retries)

        tasks = [
            bounded_fetch(country, indicator)
            for country in countries
            for indicator in indicators
        ]
        return await asyncio.gather(*tasks)
