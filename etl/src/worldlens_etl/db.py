"""Cloud SQL access for the ETL: reads what to track, upserts what was fetched.

Connects via the official Cloud SQL Python Connector (IAM/instance-connection
-name based) rather than a static public IP + password, since this runs as a
Cloud Run job with no stable outbound IP and IAM auth is the safer default.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import pg8000.dbapi
from google.cloud.sql.connector import Connector, IPTypes


@dataclass(frozen=True)
class TrackedCountry:
    code: str
    name: str


@dataclass(frozen=True)
class TrackedIndicator:
    code: str
    name: str


@dataclass(frozen=True)
class Observation:
    country_code: str
    indicator_code: str
    year: int
    value: float | None
    has_value: bool


class Database:
    """Thin wrapper around a single Cloud SQL connection for one ETL run."""

    def __init__(self) -> None:
        self._connector = Connector()
        self._conn = self._connect()

    def _connect(self) -> pg8000.dbapi.Connection:
        instance_connection_name = os.environ["CLOUD_SQL_INSTANCE_CONNECTION_NAME"]
        return self._connector.connect(
            instance_connection_name,
            "pg8000",
            user=os.environ["CLOUD_SQL_USER"],
            password=os.environ["CLOUD_SQL_PASSWORD"],
            db=os.environ["CLOUD_SQL_DB_NAME"],
            ip_type=IPTypes.PUBLIC,
        )

    def close(self) -> None:
        self._conn.close()
        self._connector.close()

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def get_tracked_countries(self) -> list[TrackedCountry]:
        # pg8000's Cursor doesn't support the context-manager protocol.
        cur = self._conn.cursor()
        cur.execute("SELECT code, name FROM countries ORDER BY code")
        return [TrackedCountry(code=row[0], name=row[1]) for row in cur.fetchall()]

    def get_tracked_indicators(self) -> list[TrackedIndicator]:
        cur = self._conn.cursor()
        cur.execute("SELECT code, name FROM indicators ORDER BY code")
        return [TrackedIndicator(code=row[0], name=row[1]) for row in cur.fetchall()]

    # pg8000's executemany() round-trips once per row; for a few hundred
    # rows over the public internet that's minutes, not seconds. A single
    # multi-row INSERT is one round trip. Chunked to keep any one
    # statement's parameter count sane at larger scale.
    _UPSERT_BATCH_SIZE = 500

    def upsert_observations(self, observations: list[Observation]) -> None:
        for i in range(0, len(observations), self._UPSERT_BATCH_SIZE):
            self._upsert_batch(observations[i : i + self._UPSERT_BATCH_SIZE])

    def _upsert_batch(self, batch: list[Observation]) -> None:
        if not batch:
            return
        placeholders = ", ".join("(%s, %s, %s, %s, %s, now())" for _ in batch)
        params = [
            value
            for o in batch
            for value in (o.country_code, o.indicator_code, o.year, o.value, o.has_value)
        ]
        cur = self._conn.cursor()
        cur.execute(
            f"""
            INSERT INTO indicator_observations
                (country_code, indicator_code, year, value, has_value, updated_at)
            VALUES {placeholders}
            ON CONFLICT (country_code, indicator_code, year) DO UPDATE
            SET value = EXCLUDED.value,
                has_value = EXCLUDED.has_value,
                updated_at = EXCLUDED.updated_at
            """,
            params,
        )
        self._conn.commit()
