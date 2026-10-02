import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
// No remote requests or real credentials are required by these contract tests.
process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_' + Buffer.from('test.clerk.accounts.dev$').toString('base64');
process.env.CLERK_SECRET_KEY = 'sk_test_local_only';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.STRIPE_SECRET_KEY = 'sk_test_local_only';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local_test_only';
const { app } = await import('../src/http/app.js');
const { client } = await import('../src/infrastructure/database.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(resolve => server.close(resolve)); await client.end(); });
test('health endpoint is available without credentials', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
test('unauthenticated workspace reads and writes are rejected before database access', async () => {
  for (const method of ['GET', 'PUT']) {
    const response = await fetch(`${base}/api/workspace`, { method });
    assert.equal(response.status, 401);
  }
});
test('unauthenticated checkout cannot create Stripe sessions', async () => {
  const response = await fetch(`${base}/api/billing/checkout`, { method: 'POST' });
  assert.equal(response.status, 401);
});
test('workspace usage analytics require authentication', async () => {
  const response = await fetch(`${base}/api/analytics/usage`);
  assert.equal(response.status, 401);
});
test('deployment, connector and website management require authentication', async () => {
  for (const path of ['/api/deploy/bot-id', '/api/connectors/import', '/api/websites/scrape']) {
    const post = path.includes('connectors') || path.includes('websites');
    const response = await fetch(`${base}${path}`, { method: post ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: post ? '{}' : undefined });
    assert.equal(response.status, 401);
  }
});
test('public routes reject malformed share tokens without database access', async () => {
  const response = await fetch(`${base}/public/bots/short`);
  assert.equal(response.status, 404);
});
test('embed script is public and mounts an isolated iframe widget', async () => {
  const response = await fetch(`${base}/embed.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
  const script = await response.text();
  assert.match(script, /dataset\.chatbot/);
  assert.match(script, /attachShadow/);
});
test('forged Stripe webhooks are rejected', async () => {
  const response = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'invalid' }, body: '{}' });
  assert.equal(response.status, 400);
});
test('verified irrelevant events are acknowledged without database writes', async () => {
  const body = JSON.stringify({ id: 'evt_local', type: 'payment_intent.created', data: { object: {} } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  const response = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${signature}` }, body });
  assert.equal(response.status, 200);
});
