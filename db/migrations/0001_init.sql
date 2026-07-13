-- Reference table of countries the ETL pipeline tracks.
CREATE TABLE countries (
    code       CHAR(2) PRIMARY KEY,   -- ISO 3166-1 alpha-2, e.g. 'MM'
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reference table of World Bank indicator codes the ETL pipeline tracks.
CREATE TABLE indicators (
    code       TEXT PRIMARY KEY,      -- e.g. 'NY.GDP.MKTP.CD'
    name       TEXT NOT NULL,         -- e.g. 'GDP (current US$)'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (country, indicator, year) observation. The ETL upserts into
-- this table on every run; updated_at tracks freshness.
CREATE TABLE indicator_observations (
    country_code   CHAR(2) NOT NULL REFERENCES countries(code),
    indicator_code TEXT NOT NULL REFERENCES indicators(code),
    year           SMALLINT NOT NULL,
    value          DOUBLE PRECISION,
    has_value      BOOLEAN NOT NULL DEFAULT false,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (country_code, indicator_code, year)
);

-- Backs the backend's main read pattern: recent years for one country.
CREATE INDEX idx_indicator_observations_country_year
    ON indicator_observations (country_code, year DESC);
