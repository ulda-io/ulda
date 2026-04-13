import PostgresDbAdapter from './PostgresDbAdapter.mjs';
import DemoSigner from './DemoSigner.mjs';
import { startPublicServer } from './public-server.mjs';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3010);
const connectionString = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@db:5432/ulda_demo';
const codec = process.env.BYTES_CODEC ?? 'base64';

const db = new PostgresDbAdapter({ connectionString });
const signer = new DemoSigner();

const app = await startPublicServer({
  signer,
  db,
  config: {
    codec: { bytes: codec },
    http: {
      host,
      port,
      routes: {
        create: '/create',
        read: '/read',
        update: '/update',
        delete: '/delete',
      },
    },
  },
});

console.log(`ulda-crud-demo-app listening on http://${host}:${port}`);

const shutdown = async signal => {
  console.log(`received ${signal}, shutting down`);
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
