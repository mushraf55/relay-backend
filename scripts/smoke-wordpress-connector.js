import { importConnector } from '../src/features/connectors/routes.js';
const result = await importConnector({ provider: 'wordpress', storeUrl: 'https://wordpress.org/news/' });
if (!result.items || !result.content || !result.title.includes('WordPress')) throw new Error('WordPress connector returned incomplete content.');
console.log(`WordPress connector: PASS (${result.items} published posts/pages imported)`);
