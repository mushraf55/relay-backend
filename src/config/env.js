import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeDatabaseUrl } from './database-url.js';
const envFile = config({ path: new URL('../../.env', import.meta.url), quiet: true }).parsed || {};
for (const [key, value] of Object.entries(envFile)) {
  if (process.env[key] === '') process.env[key] = value;
}
export const env = process.env;
export const databaseSsl = env.DATABASE_SSL_CA_PATH ? { rejectUnauthorized: true, ca: readFileSync(resolve(fileURLToPath(new URL('../..', import.meta.url)), env.DATABASE_SSL_CA_PATH), 'utf8') } : 'verify-full';
export const appUrl = new URL(env.APP_URL || 'http://localhost:3000').origin;
export const origins = [...new Set([appUrl, ...(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean), ...(env.NODE_ENV !== 'production' ? ['http://127.0.0.1:3000'] : [])])];
export const clerkAuthorizedParties = env.NODE_ENV === 'production' ? origins : undefined;
export const connectionUrl = (direct = false) => encodeDatabaseUrl((direct ? env.DIRECT_DATABASE_URL : env.DATABASE_URL) || env.DATABASE_URL || '');
export function validateProductionConfig() {
  if (env.NODE_ENV !== 'production') return;
  const required = ['APP_URL', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'DATABASE_URL', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
  const missing = required.filter(name => !env[name]);
  if (missing.length) throw new Error(`Missing production environment variables: ${missing.join(', ')}`);
  const genericAi = env.AI_BASE_URL && env.AI_API_KEY && env.CHAT_MODEL && env.EMBEDDING_MODEL;
  const splitAi = env.GROQ_API_KEY && env.GROQ_CHAT_MODEL && env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_EMBEDDING_MODEL;
  if (!genericAi && !splitAi) throw new Error('Configure either generic AI_* variables or Groq chat plus Cloudflare embedding variables.');
  if (new URL(appUrl).protocol !== 'https:') throw new Error('APP_URL must be HTTPS in production.');
}
