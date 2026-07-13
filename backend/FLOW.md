# `backend` v1 request flow

What happens on `GET /api/v1/country/:code`, including the on-demand
ingestion path for a country that isn't tracked yet.

```mermaid
flowchart TD
    A["Client: GET /api/v1/country/:code"] --> B{"Valid ISO alpha-2\nformat? (2 letters)"}
    B -- no --> B1["400 Bad Request"]
    B -- yes --> C{"Row exists in\ncountries table?"}

    C -- yes --> H
    C -- no --> D["Validate code against\nWorld Bank REST API\n(GET api.worldbank.org/v2/country/:code)"]
    D --> E{"Real country?\n(not an aggregate/region)"}
    E -- no --> E1["404 Not Found"]
    E -- yes --> F["Insert into countries\n(ON CONFLICT DO NOTHING)"]
    F --> G["Fetch all tracked indicators via\ningest-service gRPC\n(StreamCountryIndicators,\none call per indicator, concurrent)"]
    G --> G1["Batch upsert into\nindicator_observations\n(single multi-row INSERT ... ON CONFLICT)"]
    G1 --> H["Query indicator_observations\nJOIN indicators\nfor this country"]

    H --> I["Build prompt:\nfixed system framing +\nJSON indicator data"]
    I --> J["Call Vertex AI (Gemini)\ngenerateContent"]
    J --> K["200 OK\n{ country_code, country_name, analysis }"]

    D -.->|"network/API failure"| X1["502\nWorldBankError"]
    G1 -.->|"query failure"| X2["503\nDatabaseError"]
    H -.->|"query failure"| X2
    J -.->|"call failure"| X3["502\nVertexError"]
```

## Notes

- **First-ever request for a new country is slow** (World Bank + gRPC round
  trips); **every request after that** for the same country is a fast
  DB-only path, since the country and its indicator data are now persisted.
- The regular 5-minute ETL schedule takes over keeping already-tracked
  countries fresh — this on-demand path only ever runs once per new
  country, not on every request.
- A per-indicator gRPC fetch failure (e.g. `ingest-service` unreachable)
  degrades gracefully — it's logged and skipped, not fatal to the request.
  The response still returns, just with whatever data was actually fetched
  (possibly none), rather than a 502 for the whole request.
- v2 (not shown here) adds a JSON-schema-validated response shape on top of
  the same flow, with a retry-then-502 step if the model's output doesn't
  validate.
