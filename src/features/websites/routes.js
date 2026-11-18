import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { load } from 'cheerio';
import { z } from 'zod';

export const websiteRouter = Router();
const inputSchema = z.object({ url: z.string().trim().min(1).max(500), maxPages: z.number().int().min(1).max(15).default(5) });
const sameSite = (left, right) => left === right || `www.${left}` === right || left === `www.${right}`;
const scrapeLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, keyGenerator: req => req.workspaceId });

function blockedAddress(address) {
  const value = address.toLowerCase();
  if (value === '::1' || value === '::' || /^(fc|fd|fe[89ab])/.test(value)) return true;
  const match = value.match(/^(?:.*:ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function validateRemoteUrl(value) {
  const normalized = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(normalized);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use a public HTTPS website URL without credentials or a custom port.');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local') || (isIP(url.hostname) && blockedAddress(url.hostname))) throw new Error('Private network addresses cannot be imported.');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => blockedAddress(item.address))) throw new Error('Private network addresses cannot be imported.');
  return url;
}

async function fetchPage(value, startHost, redirects = 0) {
  const url = await validateRemoteUrl(value);
  if (!sameSite(url.hostname, startHost)) throw new Error('Website crawling stays on the original hostname.');
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'RelayKnowledgeBot/1.0' } });
  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    if (redirects >= 3) throw new Error('The website redirected too many times.');
    return fetchPage(new URL(response.headers.get('location'), url).toString(), startHost, redirects + 1);
  }
  if (!response.ok) throw new Error(`The website returned ${response.status}.`);
  if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) throw new Error('The URL did not return an HTML page.');
  const size = Number(response.headers.get('content-length') || 0); if (size > 2_000_000) throw new Error('A page exceeded the 2 MB crawl limit.');
  const html = await response.text(); if (html.length > 2_000_000) throw new Error('A page exceeded the 2 MB crawl limit.');
  return { url, html };
}

function canonical(value) { const url = new URL(value); url.hash = ''; url.search = ''; return url.toString(); }
export function extractReadablePage($, pageUrl) {
  const root = $('main').first().length ? $('main').first() : $('article').first().length ? $('article').first() : $('body');
  const blocks = []; let previous = '';
  root.find('h1,h2,h3,h4,p,li,blockquote,pre,dt,dd,tr').each((_index, node) => {
    const element = $(node); const tag = node.tagName?.toLowerCase();
    if (element.parents('p,li,blockquote,pre,dt,dd,tr').length) return;
    let value = element.text().replace(/\s+/g, ' ').trim(); if (!value || value === previous) return; previous = value;
    if (/^h[1-4]$/.test(tag)) value = `${'#'.repeat(Number(tag[1]))} ${value}`;
    else if (tag === 'li') value = `- ${value}`;
    else if (tag === 'blockquote') value = `> ${value}`;
    else if (tag === 'tr') { const cells = element.find('th,td').map((_cellIndex, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean); if (cells.length) value = cells.join(' | '); }
    blocks.push(value);
  });
  const fallback = root.text().replace(/\s+/g, ' ').trim();
  return { title: ($('h1').first().text() || $('title').first().text() || new URL(pageUrl).pathname).replace(/\s+/g,' ').trim(), text: blocks.join('\n\n') || fallback };
}
export async function scrapeWebsite(input, onProgress = () => {}) {
  const parsed = inputSchema.parse(input); const start = await validateRemoteUrl(parsed.url); const queue = [canonical(start)]; const visited = new Set(); const pages = [];
  await onProgress({ stage: 'Starting crawl', detail: `Preparing to scan up to ${parsed.maxPages} pages from ${start.hostname}.`, current: 0, limit: parsed.maxPages, url: start.toString() });
  while (queue.length && visited.size < parsed.maxPages) {
    const next = queue.shift(); if (visited.has(next)) continue; visited.add(next);
    await onProgress({ stage: 'Fetching page', detail: `Downloading page ${visited.size} of up to ${parsed.maxPages}.`, current: visited.size, limit: parsed.maxPages, url: next });
    const page = await fetchPage(next, start.hostname); const $ = load(page.html, { baseURI: page.url.toString() });
    const robots = $('meta[name="robots"],meta[name="googlebot"]').map((_index, node) => $(node).attr('content') || '').get().join(',').toLowerCase();
    if (!robots.includes('nofollow')) $('a[href]').each((_index, node) => {
      try {
        const linked = new URL($(node).attr('href'), page.url); linked.hash = ''; linked.search = '';
        if (linked.protocol === 'https:' && sameSite(linked.hostname, start.hostname) && !/\.(?:pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|xml)$/i.test(linked.pathname)) {
          const value = linked.toString(); if (!visited.has(value) && !queue.includes(value) && queue.length < 30) queue.push(value);
        }
      } catch { /* Ignore malformed page links. */ }
    });
    if (!robots.includes('noindex')) {
      $('script,style,noscript,svg,nav,footer,form,iframe,template').remove();
      const readable = extractReadablePage($, page.url);
      if (readable.text.length >= 60) {
        pages.push(`# ${readable.title}\n\nSource: ${page.url}\n\n${readable.text}`);
        await onProgress({ stage: 'Page parsed', detail: `${readable.text.length.toLocaleString()} readable characters extracted.`, current: visited.size, limit: parsed.maxPages, url: page.url.toString(), title: readable.title, discovered: queue.length });
      } else await onProgress({ stage: 'Page skipped', detail: 'The page did not contain enough readable content.', current: visited.size, limit: parsed.maxPages, url: page.url.toString(), discovered: queue.length });
    }
  }
  if (!pages.length) throw new Error('No readable page content was found.');
  const full = pages.join('\n\n---\n\n'); const content = full.length > 30_000 ? `${full.slice(0,29_850)}\n\n[Crawl truncated at 30,000 characters]` : full;
  return { title: `Website — ${start.hostname}`, content, site: start.hostname, pages: pages.length, truncated: full.length > 30_000, sourceUrl: start.toString() };
}

async function discoverSitemap(input) {
  const parsed = z.object({ url: z.string().trim().min(1).max(500) }).parse(input);
  const start = await validateRemoteUrl(parsed.url);
  const candidates = [new URL('/sitemap.xml', start).toString(), new URL('/sitemap_index.xml', start).toString()];
  const urls = [];
  for (const candidate of candidates) {
    try {
      const sitemap = await fetch(candidate, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/xml,text/xml,*/*', 'User-Agent': 'RelayKnowledgeBot/1.0' } });
      if (!sitemap.ok) continue;
      const text = await sitemap.text();
      const $ = load(text, { xmlMode: true });
      $('loc').each((_index, node) => {
        try {
          const value = new URL($(node).text().trim());
          if (sameSite(value.hostname, start.hostname) && value.protocol === 'https:') urls.push(value.toString());
        } catch { /* Ignore malformed sitemap entries. */ }
      });
    } catch { /* Ignore missing or blocked sitemap candidates. */ }
    if (urls.length) break;
  }
  return { site: start.hostname, urls: [...new Set(urls)].slice(0, 50) };
}

websiteRouter.post('/scrape', scrapeLimit, async (req, res) => {
  const parsed = inputSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Enter a valid website URL and page limit.' });
  try { res.json(await scrapeWebsite(parsed.data)); }
  catch (error) { const safe = /^(Use |Private network|Website crawling|The website|The URL|A page|No readable)/.test(error.message || '') ? error.message : 'Could not scrape this website. Check that it is public and server-rendered.'; res.status(400).json({ error: safe }); }
});

websiteRouter.post('/scrape/stream', scrapeLimit, async (req, res) => {
  const parsed = inputSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Enter a valid website URL and choose 5, 10, or 15 pages.' });
  try {
    res.status(200).type('application/x-ndjson').set({ 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    const result = await scrapeWebsite(parsed.data, event => { res.write(`${JSON.stringify({ type: 'progress', ...event })}\n`); });
    res.write(`${JSON.stringify({ type: 'done', result })}\n`); res.end();
  } catch (error) {
    const safe = /^(Use |Private network|Website crawling|The website|The URL|A page|No readable)/.test(error.message || '') ? error.message : 'Could not scrape this website. Check that it is public and server-rendered.';
    if (res.headersSent) { res.write(`${JSON.stringify({ type: 'error', error: safe })}\n`); res.end(); } else res.status(400).json({ error: safe });
  }
});

websiteRouter.post('/sitemap', scrapeLimit, async (req, res) => {
  try { res.json(await discoverSitemap(req.body)); }
  catch { res.status(400).json({ error: 'Could not find a readable sitemap for this website.' }); }
});
