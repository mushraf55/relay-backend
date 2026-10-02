import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse } from 'dotenv';
import { encodeDatabaseUrl } from '../src/config/database-url.js';
const root = new URL('../../.env.local', import.meta.url);
const target = new URL('../.env', import.meta.url);
const values = { ...parse(readFileSync(root)), ...(existsSync(target) ? parse(readFileSync(target)) : {}) };
for (const name of ['DATABASE_URL', 'DIRECT_DATABASE_URL']) {
  if (values[name]) values[name] = encodeDatabaseUrl(values[name]);
}
values.CLERK_PUBLISHABLE_KEY ||= values.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
values.APP_URL ||= 'http://localhost:3000';
values.PORT ||= '4000';
writeFileSync(target, Object.entries(values).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n');
console.log('Backend environment copied. Database passwords encoded. No values displayed.');
