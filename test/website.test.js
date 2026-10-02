import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { extractReadablePage, scrapeWebsite } from '../src/features/websites/routes.js';

test('website extraction preserves readable headings, paragraphs and lists', () => {
  const $ = load('<html><head><title>Docs</title></head><body><nav>Skip me</nav><main><h1>Quick start</h1><p>Install the package.</p><h2>Features</h2><ul><li>Fast parsing</li><li>Useful selectors</li></ul></main></body></html>');
  $('nav').remove();
  const result = extractReadablePage($, new URL('https://example.com/docs'));
  assert.equal(result.title, 'Quick start');
  assert.equal(result.text, '# Quick start\n\nInstall the package.\n\n## Features\n\n- Fast parsing\n\n- Useful selectors');
});

test('website scraper rejects non-HTTPS URLs before fetching', async () => {
  await assert.rejects(() => scrapeWebsite({ url: 'http://example.com', maxPages: 1 }), /public HTTPS website URL/);
});
