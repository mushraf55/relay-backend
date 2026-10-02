import { inngest } from '../src/features/knowledge/jobs.js';

const result = await inngest.send({
  name: 'relay/integration.check',
  data: { source: 'credential-check', checkedAt: new Date().toISOString() },
});

if (!result?.ids?.length) throw new Error('Inngest did not return an event id');
console.log('Inngest event key accepted (credential-check event sent; no function is attached).');
