import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { connectionUrl, databaseSsl } from '../src/config/env.js';
const migrationUrl = new URL(connectionUrl(!process.argv.includes('--session-pooler')));
if (process.argv.includes('--session-pooler')) migrationUrl.port = '5432';
const sql = postgres(migrationUrl.toString(), { prepare: false, ssl: databaseSsl, connect_timeout: 10, max: 1, onnotice: () => {} });
try {
  await sql.begin(async tx => {
    await tx.unsafe(readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
    await tx.unsafe(readFileSync(new URL('../migrations/002_ai.sql', import.meta.url), 'utf8'));
    await tx.unsafe(readFileSync(new URL('../migrations/003_files.sql', import.meta.url), 'utf8'));
    await tx.unsafe(readFileSync(new URL('../migrations/004_public_chat.sql', import.meta.url), 'utf8'));
    await tx.unsafe(readFileSync(new URL('../migrations/005_knowledge_progress.sql', import.meta.url), 'utf8'));
    await tx.unsafe(readFileSync(new URL('../migrations/006_chat_members.sql', import.meta.url), 'utf8'));
    await tx.unsafe(readFileSync(new URL('../migrations/007_chat_access.sql', import.meta.url), 'utf8'));
    await tx.unsafe(readFileSync(new URL('../migrations/008_usage_analytics.sql', import.meta.url), 'utf8'));
    await tx.unsafe(readFileSync(new URL('../migrations/009_billing_trials.sql', import.meta.url), 'utf8'));
  });
  console.log('Relay schema migration complete.');
} catch (error) { console.error('Migration failed:', error.code || error.name, '(connection details withheld)'); process.exitCode = 1; }
finally { await sql.end(); }
