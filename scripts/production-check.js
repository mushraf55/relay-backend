import { connectionUrl, env, origins, prices, validateProductionConfig } from '../src/config/env.js';
import { client, db } from '../src/infrastructure/database.js';
import { log } from '../src/infrastructure/observability.js';
import { sql } from 'drizzle-orm';

function assertConfigured(name) {
  if (!env[name]) throw new Error(`${name} is not configured.`);
}

async function main() {
  validateProductionConfig();
  assertConfigured('UPSTASH_REDIS_REST_URL');
  assertConfigured('UPSTASH_REDIS_REST_TOKEN');
  assertConfigured('R2_ACCOUNT_ID');
  assertConfigured('R2_ACCESS_KEY_ID');
  assertConfigured('R2_SECRET_ACCESS_KEY');
  assertConfigured('R2_BUCKET_NAME');
  assertConfigured('AI_PROVIDER');
  assertConfigured('EMBEDDING_PROVIDER');

  if (!connectionUrl()) throw new Error('DATABASE_URL is invalid.');
  await db.execute(sql`SELECT 1`);

  log('info', 'production_check_passed', {
    appUrl: env.APP_URL,
    origins: origins.length,
    plans: Object.values(prices).flatMap(plan => Object.values(plan)).filter(Boolean).length,
    jobProvider: env.JOB_PROVIDER,
    aiProvider: env.AI_PROVIDER,
    embeddingProvider: env.EMBEDDING_PROVIDER,
  });
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  log('error', 'production_check_failed', { name: error.name, message: error.message });
} finally {
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}
