import { connectionUrl, env, origins, validateProductionConfig } from '../src/config/env.js';
import { client, db } from '../src/infrastructure/database.js';
import { log } from '../src/infrastructure/observability.js';
import { sql } from 'drizzle-orm';

function assertConfigured(name) {
  if (!env[name]) throw new Error(`${name} is not configured.`);
}

async function main() {
  validateProductionConfig();
  assertConfigured('R2_ENDPOINT');
  assertConfigured('R2_ACCESS_KEY_ID');
  assertConfigured('R2_SECRET_ACCESS_KEY');
  assertConfigured('R2_BUCKET_NAME');
  assertConfigured('AI_BASE_URL');
  assertConfigured('AI_API_KEY');
  assertConfigured('CHAT_MODEL');
  assertConfigured('EMBEDDING_MODEL');

  if (!connectionUrl()) throw new Error('DATABASE_URL is invalid.');
  await db.execute(sql`SELECT 1`);

  log('info', 'production_check_passed', {
    appUrl: env.APP_URL,
    origins: origins.length,
    aiBaseUrl: new URL(env.AI_BASE_URL).origin,
    chatModel: env.CHAT_MODEL,
    embeddingModel: env.EMBEDDING_MODEL,
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
