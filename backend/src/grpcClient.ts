import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(__dirname, '../../proto/worldbank/v1/country_data.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = grpc.loadPackageDefinition(packageDefinition) as any;

const client = new proto.worldbank.v1.CountryDataService(
  config.ingestServiceAddr,
  grpc.credentials.createInsecure(),
);

export interface IndicatorDataPoint {
  country_code: string;
  country_name: string;
  indicator_code: string;
  indicator_name: string;
  year: number;
  value: number;
  has_value: boolean;
}

// Mirrors etl/src/worldlens_etl/grpc_client.py: one (country, indicator) pair
// per RPC call, run concurrently and bounded, rather than one call with all
// indicator codes - the World Bank API's inconsistent per-indicator latency
// otherwise lets a couple of slow indicators exhaust a shared deadline before
// the rest are ever fetched.
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_RETRIES = 1;

function fetchOne(
  countryCode: string,
  indicatorCode: string,
  timeoutMs: number,
  retries: number,
): Promise<IndicatorDataPoint[]> {
  return new Promise((resolve) => {
    attempt(0);

    function attempt(tryNum: number): void {
      const points: IndicatorDataPoint[] = [];
      const deadline = new Date(Date.now() + timeoutMs);
      const call = client.StreamCountryIndicators(
        { country_code: countryCode, indicator_codes: [indicatorCode] },
        new grpc.Metadata(),
        { deadline },
      );

      call.on('data', (point: IndicatorDataPoint) => points.push(point));
      call.on('error', (err: Error) => {
        if (tryNum < retries) {
          attempt(tryNum + 1);
          return;
        }
        console.warn(
          `gRPC fetch failed for ${countryCode}/${indicatorCode} after ${tryNum + 1} attempt(s):`,
          err.message,
        );
        resolve([]);
      });
      call.on('end', () => resolve(points));
    }
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function fetchIndicatorsForCountry(
  countryCode: string,
  indicatorCodes: string[],
): Promise<IndicatorDataPoint[]> {
  const perIndicator = await mapWithConcurrency(indicatorCodes, DEFAULT_CONCURRENCY, (indicatorCode) =>
    fetchOne(countryCode, indicatorCode, DEFAULT_TIMEOUT_MS, DEFAULT_RETRIES),
  );
  return perIndicator.flat();
}
