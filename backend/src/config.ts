import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: process.env.PORT ?? '8080',
  cloudSql: {
    instanceConnectionName: required('CLOUD_SQL_INSTANCE_CONNECTION_NAME'),
    dbName: required('CLOUD_SQL_DB_NAME'),
    user: required('CLOUD_SQL_USER'),
    password: required('CLOUD_SQL_PASSWORD'),
  },
  vertex: {
    projectId: required('GCP_PROJECT_ID'),
    region: required('GCP_REGION'),
    modelId: required('VERTEX_MODEL_ID'),
  },
};
