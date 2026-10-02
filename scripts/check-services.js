import { checkStorage } from '../src/infrastructure/object-storage.js';
import { checkRedis } from '../src/infrastructure/rate-limits.js';
for (const [name, check] of [['Cloudflare R2', checkStorage], ['Upstash Redis', checkRedis]]) {
  try { await check(); console.log(`${name}: connected`); }
  catch (error) { console.error(`${name}: failed (${error.name || error.code || 'unknown error'})`); process.exitCode = 1; }
}
