import { randomUUID } from 'node:crypto';
import { deleteFile, getFile, putFile } from '../src/infrastructure/object-storage.js';
import { testRedisRoundTrip } from '../src/infrastructure/rate-limits.js';
const id = randomUUID(); const objectKey = `_relay_checks/${id}.txt`;
try {
  await putFile(objectKey, Buffer.from('relay-r2-check'), 'text/plain');
  const value = await getFile(objectKey);
  if (value.toString() !== 'relay-r2-check') throw new Error('R2 content mismatch');
  console.log('Cloudflare R2 upload/download: PASS');
} finally { try { await deleteFile(objectKey); } catch { /* A failed check may not have created an object. */ } }
if (await testRedisRoundTrip(`relay:check:${id}`) !== 'ok') throw new Error('Redis content mismatch');
console.log('Upstash Redis write/read/delete: PASS');
