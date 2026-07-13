import express from 'express';
import { config } from './config.js';
import { closeDb } from './db.js';
import { countryRouterV1 } from './routes/country.js';
import { DatabaseError, VertexError, WorldBankError } from './errors.js';

const app = express();

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

app.use(countryRouterV1);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof DatabaseError) {
    console.error(`${err.message}:`, err.cause);
    res.status(503).json({ error: 'database unavailable' });
    return;
  }
  if (err instanceof VertexError) {
    console.error(`${err.message}:`, err.cause);
    res.status(502).json({ error: 'upstream model call failed' });
    return;
  }
  if (err instanceof WorldBankError) {
    console.error(`${err.message}:`, err.cause);
    res.status(502).json({ error: 'upstream country validation call failed' });
    return;
  }
  console.error('unexpected error:', err);
  res.status(500).json({ error: 'internal server error' });
});

const server = app.listen(config.port, () => {
  console.log(`backend listening on :${config.port}`);
});

async function shutdown(): Promise<void> {
  console.log('shutting down backend...');
  server.close();
  await closeDb();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
