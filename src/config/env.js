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
export const prices = {
  Starter: { Monthly: env.STRIPE_PRICE_STARTER_MONTHLY, Yearly: env.STRIPE_PRICE_STARTER_YEARLY },
  Growth: { Monthly: env.STRIPE_PRICE_GROWTH_MONTHLY, Yearly: env.STRIPE_PRICE_GROWTH_YEARLY },
  Scale: { Monthly: env.STRIPE_PRICE_SCALE_MONTHLY, Yearly: env.STRIPE_PRICE_SCALE_YEARLY },
};
const planLimits = {
  Trial: { bots: 10, members: 1, storageBytes: 25 * 1024 * 1024, chunks: 5_000, aiCalls: 500 },
  Starter: { bots: 10, members: 1, storageBytes: 25 * 1024 * 1024, chunks: 10_000, aiCalls: 1_000 },
  Growth: { bots: 25, members: 5, storageBytes: 2 * 1024 * 1024 * 1024, chunks: 100_000, aiCalls: 20_000 },
  Scale: { bots: 100, members: 25, storageBytes: 20 * 1024 * 1024 * 1024, chunks: 1_000_000, aiCalls: 100_000 },
};
export function entitlement(price, status, workspace = {}) {
  if (['active', 'trialing'].includes(status)) {
    for (const [plan, cycles] of Object.entries(prices)) {
      for (const [cycle, id] of Object.entries(cycles)) if (id && id === price) return { plan, cycle, ...planLimits[plan] };
    }
  }
  const trialStarted = workspace.trial_started_at ? new Date(workspace.trial_started_at) : new Date();
  const trialEndsAt = new Date(trialStarted.getTime() + 7 * 24 * 60 * 60 * 1000);
  const trialDaysRemaining = Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  return { plan: 'Trial', cycle: '7-day trial', trialEndsAt: trialEndsAt.toISOString(), trialDaysRemaining, autoPay: workspace.auto_pay !== false, ...planLimits.Trial };
}

export function validateProductionConfig() {
  if (env.NODE_ENV !== 'production') return;
  const required = ['APP_URL', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY'];
  const missing = required.filter(name => !env[name]);
  if (missing.length) throw new Error(`Missing production environment variables: ${missing.join(', ')}`);
  if ((env.CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_') || env.CLERK_SECRET_KEY?.startsWith('sk_test_')) && env.ALLOW_CLERK_DEV_MODE !== 'true') throw new Error('Production must use Clerk production keys unless ALLOW_CLERK_DEV_MODE=true is set for a demo deployment.');
  if (env.STRIPE_SECRET_KEY?.startsWith('sk_test_') && env.ALLOW_STRIPE_TEST_MODE !== 'true') throw new Error('Production must use a live Stripe secret key unless ALLOW_STRIPE_TEST_MODE=true is set for a demo deployment.');
  if (!env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) throw new Error('STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret.');
  if ((env.JOB_PROVIDER || 'inngest') !== 'inngest') throw new Error('Production must use JOB_PROVIDER=inngest.');
  if (!Object.values(prices).flatMap(cycles => Object.values(cycles)).every(value => value?.startsWith('price_'))) throw new Error('All Stripe production price IDs must be configured.');
  if (new URL(appUrl).protocol !== 'https:') throw new Error('APP_URL must be HTTPS in production.');
}
