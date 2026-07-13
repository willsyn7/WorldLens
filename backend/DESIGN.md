# worldlens backend — design brief

This is a self-contained brief for building the `backend/` service in the
`worldlens` monorepo. You will not have access to the conversation that
produced this doc, so treat this as the full context.

## What worldlens is

A country investment-signal tool. A user picks a country (e.g. Myanmar) and
gets a short AI-generated recommendation on whether their company should
invest there, grounded in World Bank economic and governance data.

## Where this backend sits in the system

```
World Bank API (public, no key)
    → gRPC stream (Go, ingest-service)         [built]
    → Python ETL (clean/transform)              [built]
    → Cloud SQL / Postgres                       [schema built + live]
        ↓
    → THIS SERVICE (Express.js + TypeScript)
    → Vertex AI (Gemini)
    → response returned to user
```

The Go ingest service and Python ETL run on a 5-minute schedule, independent
of user requests, and keep Cloud SQL populated for countries that are
already tracked. **Bulk indicator data only ever comes from
`ingest-service` over gRPC — this backend never re-implements that
streaming fetch itself.** It does make two kinds of calls outside the DB,
both only in the untracked-country path (see "On-demand ingestion" below):
one lightweight direct call to the World Bank REST API to validate a new
country code and get its name, and gRPC calls to `ingest-service` to fetch
that country's indicator data. For already-tracked countries, keep the
request path fast: just a DB read and a Vertex AI call, no live fetching.

## Your job

Build an Express.js + TypeScript service with a country-recommendation
endpoint, versioned as `v1` and `v2`:

- **v1**: hardcoded prompt, returns Vertex AI's raw text response, no
  output validation.
- **v2**: same route family, but the prompt instructs the model to return
  structured JSON, and the response is validated against a JSON schema
  before being returned to the client. If validation fails, do not pass
  through malformed data — retry once with a stricter follow-up
  instruction, and if it still fails, return a 502.

## Database

Live on Google Cloud SQL (Postgres 18). Three tables already exist and are
seeded:

```sql
CREATE TABLE countries (
    code       CHAR(2) PRIMARY KEY,   -- ISO 3166-1 alpha-2, e.g. 'MM'
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE indicators (
    code       TEXT PRIMARY KEY,      -- e.g. 'NY.GDP.MKTP.CD'
    name       TEXT NOT NULL,         -- e.g. 'GDP (current US$)'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE indicator_observations (
    country_code   CHAR(2) NOT NULL REFERENCES countries(code),
    indicator_code TEXT NOT NULL REFERENCES indicators(code),
    year           SMALLINT NOT NULL,
    value          DOUBLE PRECISION,
    has_value      BOOLEAN NOT NULL DEFAULT false,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (country_code, indicator_code, year)
);

CREATE INDEX idx_indicator_observations_country_year
    ON indicator_observations (country_code, year DESC);
```

Currently tracked indicators (14, all seeded in `indicators`):

| Code | Name |
|---|---|
| `NY.GDP.MKTP.CD` | GDP (current US$) |
| `NY.GDP.MKTP.KD.ZG` | GDP growth (annual %) |
| `NY.GDP.PCAP.CD` | GDP per capita (current US$) |
| `FP.CPI.TOTL.ZG` | Inflation, consumer prices (annual %) |
| `PA.NUS.FCRF` | Official exchange rate (LCU per US$) |
| `GC.DOD.TOTL.GD.ZS` | Central government debt (% of GDP) |
| `BX.KLT.DINV.CD.WD` | Foreign direct investment, net inflows (current US$) |
| `NE.TRD.GNFS.ZS` | Trade (% of GDP) |
| `SL.UEM.TOTL.ZS` | Unemployment, total (% of labor force) |
| `SP.POP.TOTL` | Population, total |
| `GOV_WGI_PV.EST` | Political Stability - Governance estimate (approx. -2.5 to +2.5) |
| `GOV_WGI_RL.EST` | Rule of Law - Governance estimate (approx. -2.5 to +2.5) |
| `GOV_WGI_CC.EST` | Control of Corruption - Governance estimate (approx. -2.5 to +2.5) |
| `GOV_WGI_RQ.EST` | Regulatory Quality - Governance estimate (approx. -2.5 to +2.5) |

Only `MM` (Myanmar) is seeded in `countries` right now, but `countries` is
meant to grow as users request new countries — see "On-demand ingestion"
below. Don't hardcode "Myanmar" or any fixed country list anywhere in
logic.

There is deliberately **no pre-aggregated stats table**. The read pattern
per request (all years for ~14 indicators, one country) is small; query
`indicator_observations` directly, indexed by `(country_code, year DESC)`.

### Connecting to Cloud SQL

**Do not use a static public-IP + password connection in this service.**
That pattern was only used for manual local testing and required manually
allowlisting a specific IP in Cloud SQL's authorized networks — Cloud Run
doesn't have a stable outbound IP, so this breaks in production and is the
weaker security posture anyway. Use the official
[`@google-cloud/cloud-sql-connector`](https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector)
package (IAM/instance-connection-name based, works cleanly from Cloud Run)
with a Postgres client (`pg`). The instance connection name format is
`PROJECT_ID:REGION:INSTANCE_ID`.

## On-demand ingestion for untracked countries

The `countries` table is not a fixed allowlist — it's meant to grow as real
users ask for real countries. It only makes sense to track countries people
actually care about, not pre-populate every ISO code up front. So when a
request comes in for a country that isn't in `countries` yet, do this
instead of a flat 404:

1. Validate `:code` is a plausible ISO alpha-2 code (existing regex check
   is fine), then check `countries` for it. If found, skip straight to the
   normal read path.
2. If not found, look it up against the World Bank API directly to confirm
   it's a real country (not just a well-formed but bogus 2-letter code, and
   not a region/aggregate — World Bank's country endpoint mixes both):
   `GET https://api.worldbank.org/v2/country/{code}?format=json`. Response
   shape is `[metadata, [countryObject]]`; `countryObject.region.id` is
   `"NA"` for aggregates/regions (e.g. "East Asia & Pacific") — reject
   those. If the lookup comes back empty or is an aggregate, **that's** the
   real 404 case now — genuinely invalid input, not "not tracked yet."
3. `INSERT INTO countries (code, name) VALUES ($1, $2) ON CONFLICT (code)
   DO NOTHING` (guards concurrent requests for the same new country).
4. Fetch data for this one country now, synchronously, rather than waiting
   up to 5 minutes for the next scheduled ETL run:
   - Read all rows from `indicators` (the tracked indicator list).
   - Call `ingest-service`'s `CountryDataService.StreamCountryIndicators`
     gRPC method — **one call per indicator, run concurrently**, not one
     call with all indicator codes in the request. A prior smoke test of
     the Python ETL found that batching many indicators into a single
     streaming call lets World Bank's inconsistent per-indicator latency
     exhaust one shared client deadline before every indicator is fetched;
     per-indicator calls isolate that, same as the ETL does in
     `etl/src/worldlens_etl/grpc_client.py` — worth reading that file for
     the concurrency/timeout/retry pattern to mirror here. Use
     `@grpc/grpc-js` with `@grpc/proto-loader` against
     `proto/worldbank/v1/country_data.proto` (dynamic loading is enough
     here; no need for a generated-stubs build step for one client call
     site).
   - Upsert the results into `indicator_observations` as a **single
     multi-row `INSERT ... VALUES (...), (...), ... ON CONFLICT ... DO
     UPDATE`**, not one `INSERT` per row. The Python ETL hit a real
     performance bug here — `pg8000`'s `executemany()` round-trips once
     per row, turning a sub-second write into minutes — before switching
     to a single batched multi-row statement. Node's `pg` driver doesn't
     have that specific problem since parameterized queries with many
     placeholders are still one round trip, but still build one
     multi-row `INSERT`, not a loop of single-row `INSERT`s, for the same
     reason: minimize round trips.
5. Now proceed with the normal read path (query `indicator_observations`,
   build the prompt, call Vertex AI).

This means a first-ever request for a brand-new country will be
noticeably slower than a cached one (World Bank's latency is inconsistent
— budget for it, e.g. a generous per-indicator gRPC timeout in the 30-45s
range, matching the ETL's default). Every subsequent request for that same
country is back to the fast DB-only path, and the regular 5-minute ETL
schedule takes over keeping it fresh from then on.

`INGEST_SERVICE_ADDR` (see env vars below) is the gRPC target for this.

## Environment variables

Read from `.env` (see `.env.example` at the repo root — do not commit real
values):

```
CLOUD_SQL_INSTANCE_CONNECTION_NAME=
CLOUD_SQL_DB_NAME=
CLOUD_SQL_USER=
CLOUD_SQL_PASSWORD=

GCP_PROJECT_ID=
GCP_REGION=
VERTEX_MODEL_ID=
GOOGLE_APPLICATION_CREDENTIALS=

INGEST_SERVICE_ADDR=
```

## Vertex AI

Use `@google-cloud/vertexai`. Initialize with `GCP_PROJECT_ID` and
`GCP_REGION` from env; model id also from env (`VERTEX_MODEL_ID`, e.g. a
Gemini model) — don't hardcode the model name.

### Prompt design

System framing (this is the fixed part of the prompt for both v1 and v2):

> You are an AI agent recommending whether a company should invest in
> {country_name}. Base your analysis primarily on the World Bank economic
> and governance data provided below. You may use general background
> knowledge of the country to explain notable trends in the data (e.g. a
> political event that coincides with a sharp change in the numbers), but
> do not state unverifiable claims as if they were part of the provided
> data. Return a short, decision-oriented analysis and a clear
> invest / do-not-invest recommendation.

This framing matters: World Bank data alone is purely economic/statistical
— it has no notion of discrete political events (coups, sanctions, etc.).
Those only show up as knock-on effects (GDP dips, FDI flight, currency
depreciation, a drop in the political-stability indicator). The prompt
above deliberately allows the model to name a likely cause using its own
knowledge, while keeping the numeric analysis grounded in the actual data
you inject — don't silently drop this nuance if you adjust the prompt.

Append the queried indicator data to the prompt as compact structured data
(e.g. JSON array of `{indicator_code, indicator_name, year, value}`), not
as loose prose.

**v1**: prompt as above, unstructured text response, returned as-is.

**v2**: append an explicit instruction that the response must be *only*
valid JSON (no markdown fences, no commentary) matching this shape:

```json
{
  "country_code": "MM",
  "country_name": "Myanmar",
  "recommendation": "invest | do_not_invest | neutral",
  "summary": "2-4 sentence analysis",
  "key_factors": ["short phrase", "short phrase", "..."]
}
```

Validate the model's response against this schema (recommend `zod`) before
returning it. Treat this shape as a starting point, not gospel — adjust if
you find a materially better structure, but keep it a strict, machine
-checkable contract.

## API contract

```
GET /api/v1/country/:code
GET /api/v2/country/:code
```

- `:code` is the ISO alpha-2 country code (e.g. `MM`).
- If `:code` isn't in `countries` yet, run the on-demand ingestion flow
  above rather than 404ing. Only return 404 if the World Bank lookup
  confirms `:code` isn't a real country.
- Query all rows from `indicator_observations` (joined with `indicators`
  for names) for that country, ordered by indicator then year.
- Build the prompt, call Vertex AI, return the response.

v1 response shape:
```json
{ "country_code": "MM", "country_name": "Myanmar", "analysis": "<raw model text>" }
```

v2 response shape: the validated JSON object described above.

## Deployment

Deployed as its own GCP Cloud Run service, alongside `ingest-service` and
the Python `etl` service (already established pattern — see
`infra/ingest-service/Dockerfile` for the sibling service's Dockerfile
style, multi-stage build). Add `infra/backend/Dockerfile` following the
same convention: multi-stage Node build, small runtime image.

## Repo conventions to follow

- This is a monorepo; your code lives under `backend/`.
- Don't add abstractions beyond what's asked — this is a small service with
  one real endpoint family (v1/v2 of the same resource), not a large API.
- No frontend or charting work is in scope here — this is backend-only.
- Prefer editing/extending, not reinventing, the patterns already set by
  `ingest-service` (env-based config, no hardcoded secrets, health check
  endpoint for Cloud Run, graceful shutdown).
