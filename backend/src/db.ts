import pg from 'pg';
import { Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import { config } from './config.js';

const connector = new Connector();
const clientOpts = await connector.getOptions({
  instanceConnectionName: config.cloudSql.instanceConnectionName,
  ipType: IpAddressTypes.PUBLIC,
});

export const pool = new pg.Pool({
  ...clientOpts,
  user: config.cloudSql.user,
  password: config.cloudSql.password,
  database: config.cloudSql.dbName,
  max: 5,
});

export async function closeDb(): Promise<void> {
  await pool.end();
  connector.close();
}

export async function insertCountryIfMissing(code: string, name: string): Promise<void> {
  await pool.query('INSERT INTO countries (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [
    code,
    name,
  ]);
}

export async function getTrackedIndicators(): Promise<{ code: string; name: string }[]> {
  const result = await pool.query<{ code: string; name: string }>('SELECT code, name FROM indicators');
  return result.rows;
}

export interface NewObservation {
  country_code: string;
  indicator_code: string;
  year: number;
  value: number | null;
  has_value: boolean;
}

// A single multi-row INSERT, not a loop of single-row INSERTs, to minimize
// round trips - the ETL hit a real perf bug with pg8000's executemany()
// round-tripping once per row. Chunked to keep any one statement's
// parameter count sane at larger scale.
const UPSERT_BATCH_SIZE = 500;

export async function upsertObservations(observations: NewObservation[]): Promise<void> {
  for (let i = 0; i < observations.length; i += UPSERT_BATCH_SIZE) {
    await upsertBatch(observations.slice(i, i + UPSERT_BATCH_SIZE));
  }
}

async function upsertBatch(batch: NewObservation[]): Promise<void> {
  if (batch.length === 0) {
    return;
  }

  const values: unknown[] = [];
  const placeholders = batch.map((o, i) => {
    const base = i * 5;
    values.push(o.country_code, o.indicator_code, o.year, o.value, o.has_value);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, now())`;
  });

  await pool.query(
    `INSERT INTO indicator_observations (country_code, indicator_code, year, value, has_value, updated_at)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (country_code, indicator_code, year) DO UPDATE
     SET value = EXCLUDED.value, has_value = EXCLUDED.has_value, updated_at = EXCLUDED.updated_at`,
    values,
  );
}
