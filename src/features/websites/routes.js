import { Router } from 'express';
import { load } from 'cheerio';
import { z } from 'zod';
import { sharedLimit } from '../../infrastructure/rate-limits.js';
import { validateRemoteUrl } from '../connectors/routes.js';
import { canEditWorkspace } from '../workspaces/permissions.js';

export const websiteRouter = Router();
const inputSchema = z.object({ url: z.string().trim().min(1).max(500), maxPages: z.number().int().min(1).max(10).default(5) });
const sameSite = (left, right) => left === right || `www.${left}` === right || left === `www.${right}`;

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
export async function scrapeWebsite(input) {
  const parsed = inputSchema.parse(input); const start = await validateRemoteUrl(parsed.url); const queue = [canonical(start)]; const visited = new Set(); const pages = [];
  while (queue.length && visited.size < parsed.maxPages) {
    const next = queue.shift(); if (visited.has(next)) continue; visited.add(next);
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
      if (readable.text.length >= 60) pages.push(`# ${readable.title}\n\nSource: ${page.url}\n\n${readable.text}`);
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

websiteRouter.post('/scrape', async (req, res) => {
  if (!await canEditWorkspace(req)) return res.status(403).json({ error: 'Workspace editor access required' });
  const parsed = inputSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Enter a valid website URL and page limit.' });
  const limited = await sharedLimit('upload', req.workspaceId); if (!limited.success) return res.status(429).json({ error: 'Import limit reached. Try again later.' });
  try { res.json(await scrapeWebsite(parsed.data)); }
  catch (error) { const safe = /^(Use |Private network|Website crawling|The website|The URL|A page|No readable)/.test(error.message || '') ? error.message : 'Could not scrape this website. Check that it is public and server-rendered.'; res.status(400).json({ error: safe }); }
});

websiteRouter.post('/sitemap', async (req, res) => {
  if (!await canEditWorkspace(req)) return res.status(403).json({ error: 'Workspace editor access required' });
  const limited = await sharedLimit('upload', req.workspaceId); if (!limited.success) return res.status(429).json({ error: 'Import limit reached. Try again later.' });
  try { res.json(await discoverSitemap(req.body)); }
  catch { res.status(400).json({ error: 'Could not find a readable sitemap for this website.' }); }
});
