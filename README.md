# worldlens

Country investment signal tool. A user picks a country (e.g. Myanmar) and
gets a short AI-generated recommendation on whether to invest, grounded in
World Bank economic and governance data.

## How it works

Data ingestion runs on a schedule, independent of user requests:

```
World Bank API (public, no key)
    → gRPC stream (Go, ingest-service)
    → Python ETL (clean/transform)
    → Cloud SQL
        (stats/aggregate table refreshed as part of the same ETL run)
```

Every 5 minutes, the ETL layer calls the Go gRPC service to stream indicator
data for tracked countries, cleans it, and loads it into Cloud SQL, including
a pre-aggregated stats table for fast reads.

User-facing requests are served separately and stay fast, since they only
read already-loaded data:

```
User selects a country
    → TypeScript backend queries Cloud SQL
    → backend builds a prompt (instructions + SQL result data)
    → Vertex AI generates a summary + invest/don't-invest recommendation
    → (v2) response is validated against a JSON schema
    → response returned to user
```

## Why gRPC streaming for ingestion

The World Bank API paginates its responses. Rather than buffering an entire
country/indicator result set before handing it to the ETL layer, the Go
service streams each data point to the client as soon as it's parsed off the
wire.

## Services

| Service | Language | Responsibility |
|---|---|---|
| `ingest-service` | Go | Pulls data from the World Bank REST API and re-exposes it as a gRPC stream (`CountryDataService.StreamCountryIndicators`) |
| `etl` | Python | Consumes the gRPC stream, cleans/transforms records, writes to Cloud SQL, refreshes the stats table. Triggered every 5 min via Cloud Scheduler → Cloud Run job |
| `backend` | TypeScript | Serves user-facing endpoints, queries Cloud SQL, prompts Vertex AI, validates and returns the response |

All three are deployed as separate GCP Cloud Run services/jobs.

## Data

Indicators pulled per country (World Bank WDI codes):

- `NY.GDP.MKTP.CD` — GDP (current US$)
- `NY.GDP.MKTP.KD.ZG` — GDP growth (annual %)
- `NY.GDP.PCAP.CD` — GDP per capita
- `FP.CPI.TOTL.ZG` — Inflation (annual %)
- `PA.NUS.FCRF` — Official exchange rate
- `GC.DOD.TOTL.GD.ZS` — Central government debt (% of GDP)
- `BX.KLT.DINV.CD.WD` — FDI, net inflows
- `NE.TRD.GNFS.ZS` — Trade (% of GDP)
- `SL.UEM.TOTL.ZS` — Unemployment rate
- `SP.POP.TOTL` — Population
- Worldwide Governance Indicators (political stability, rule of law, control
  of corruption, regulatory quality)

World Bank data is economic/statistical only — it has no notion of discrete
political events (e.g. a coup). Any narrative "why" behind a trend either
comes from Vertex AI's own background knowledge or a separate events data
source, not from this pipeline.

## Tech stack

**Data ingestion (`ingest-service`)**
- Go 1.25
- gRPC (`google.golang.org/grpc`) + Protocol Buffers, managed with `buf`
- Standard `net/http` client against the public World Bank REST API

**ETL (`etl`)**
- Python
- `grpcio` — gRPC client consuming `ingest-service`
- pandas — cleaning/transforming indicator data
- SQLAlchemy (or `psycopg2`/`asyncpg`) — loading into Cloud SQL
- Triggered every 5 min via Cloud Scheduler → Cloud Run job (no orchestrator like Airflow/Dagster — one linear pipeline doesn't need one yet)

**Database**
- Google Cloud SQL
- A pre-aggregated stats table, refreshed each ETL run, for fast reads

**Backend (`backend`)**
- TypeScript / Node.js
- Versioned routes (`v1` hardcoded prompt, `v2` adds JSON schema validation)
- Google Vertex AI SDK — calls a Gemini model with a prompt built from SQL-queried data

**Infra & tooling**
- Google Cloud Platform — Cloud Run (all services), Cloud Scheduler
- Docker (multi-stage builds, distroless runtime images)
- `protoc-gen-go`, `protoc-gen-go-grpc`, `buf` — proto codegen
- `grpcurl` — manual gRPC smoke testing
- Git / GitHub

## Repository layout

```
worldlens/
├── proto/                    # shared .proto contracts (buf-managed)
│   └── worldbank/v1/
├── ingest-service/            # Go gRPC service
│   ├── cmd/server/
│   └── internal/
│       ├── worldbank/         # World Bank REST client
│       ├── grpcserver/        # gRPC server implementation
│       └── gen/                # generated protobuf/grpc code
├── etl/                       # Python ETL layer
├── db/
│   └── migrations/            # numbered, plain-SQL schema migrations
├── backend/                   # TypeScript backend
└── infra/                     # Cloud Run deploy configs
```

## Environment

Copy `.env.example` to `.env` and fill in real values (never commit `.env`):

- `CLOUD_SQL_*` — Cloud SQL connection info
- `GCP_PROJECT_ID`, `GCP_REGION`, `VERTEX_MODEL_ID`,
  `GOOGLE_APPLICATION_CREDENTIALS` — Vertex AI access

The World Bank API itself requires no key.

## Database schema

Three tables, applied via `db/migrations/0001_init.sql`:

- `countries` — reference table of tracked countries (code, name)
- `indicators` — reference table of tracked World Bank indicator codes (code, name)
- `indicator_observations` — fact table, one row per (country, indicator, year), upserted by the ETL on each run

`db/migrations/0002_seed.sql` seeds `indicators` with the World Bank codes
listed above and `countries` with Myanmar as the initial tracked country.

No separate pre-aggregated stats table — the backend's read pattern (recent
years, ~14 indicators, one country) is small enough for the indexed fact
table directly. Revisit only if that stops being fast enough.

## Status

`ingest-service` (Go gRPC layer) is implemented: World Bank REST client with
pagination handling, `CountryDataService.StreamCountryIndicators` gRPC
server, and a `main.go` entrypoint with a gRPC health check and graceful
shutdown.

The DB schema is designed and applied to the live Cloud SQL instance.

Not yet built: the Python ETL layer (to actually populate the tables on a
schedule) and the TypeScript backend.
