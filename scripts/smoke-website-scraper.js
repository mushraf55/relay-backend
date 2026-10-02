import assert from 'node:assert/strict';
import { scrapeWebsite } from '../src/features/websites/routes.js';

const result = await scrapeWebsite({ url: 'https://example.com', maxPages: 1 });
assert.equal(result.site, 'example.com');
assert.equal(result.pages, 1);
assert.match(result.content, /Example Domain/i);
assert.match(result.content, /https:\/\/example\.com/i);
console.log(`Website scraper smoke test passed (${result.pages} page, ${result.content.length} characters).`);
