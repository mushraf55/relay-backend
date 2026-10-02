import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { env } from '../config/env.js';

const redis = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN ? new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }) : null;
const ai = redis ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(12, '1 m'), prefix: 'relay:ai', timeout: 1500 }) : null;
const uploads = redis ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '10 m'), prefix: 'relay:uploads', timeout: 1500 }) : null;
const publicChat = redis ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'relay:public-chat', timeout: 1500 }) : null;
export async function sharedLimit(kind, identifier) {
  const limiter = kind === 'upload' ? uploads : kind === 'public' ? publicChat : ai;
  if (!limiter) return { success: true, limit: 0, remaining: 0, reset: 0, reason: 'local-fallback' };
  return limiter.limit(identifier);
}
export async function checkRedis() { if (!redis) throw new Error('Upstash Redis is not configured'); return redis.ping(); }
export async function testRedisRoundTrip(key) {
  if (!redis) throw new Error('Upstash Redis is not configured');
  try { await redis.set(key, 'ok', { ex: 30 }); return await redis.get(key); }
  finally { await redis.del(key); }
}
