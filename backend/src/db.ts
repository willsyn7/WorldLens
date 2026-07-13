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
