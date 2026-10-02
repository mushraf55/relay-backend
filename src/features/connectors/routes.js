import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Router } from 'express';
import { z } from 'zod';
import { sharedLimit } from '../../infrastructure/rate-limits.js';
import { env } from '../../config/env.js';

export const connectorRouter = Router();
const inputSchema = z.object({
  provider: z.enum(['shopify','woocommerce','wordpress']),
  storeUrl: z.string().trim().min(1).max(300),
  accessToken: z.string().trim().max(500).optional(),
  consumerKey: z.string().trim().max(300).optional(),
  consumerSecret: z.string().trim().max(300).optional(),
});

function blockedAddress(address) {
  const value = address.toLowerCase();
  if (value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true;
  const match = value.match(/^(?:.*:ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [a,b] = match.slice(1).map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export async function validateRemoteUrl(value) {
  const normalized = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(normalized);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use a public HTTPS website URL without credentials or a custom port.');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local') || isIP(url.hostname) && blockedAddress(url.hostname)) throw new Error('Private network addresses cannot be imported.');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => blockedAddress(item.address))) throw new Error('Private network addresses cannot be imported.');
  return url;
}

async function fetchJson(url, options = {}, redirects = 0) {
  const checked = await validateRemoteUrl(url.toString());
  const response = await fetch(checked, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    if (redirects >= 2) throw new Error('The store redirected too many times.');
    const next = new URL(response.headers.get('location'), checked);
    const sensitive = options.headers?.Authorization || options.headers?.['X-Shopify-Access-Token'];
    if (sensitive && next.hostname !== checked.hostname) throw new Error('The authenticated store endpoint redirected to another host.');
    return fetchJson(next, options, redirects + 1);
  }
  if (!response.ok) throw new Error(`The store API returned ${response.status}. Check the URL and read-only credentials.`);
  const size = Number(response.headers.get('content-length') || 0);
  if (size > 5_000_000) throw new Error('The connector response is too large.');
  const text = await response.text();
  if (text.length > 5_000_000) throw new Error('The connector response is too large.');
  try { return JSON.parse(text); } catch { throw new Error('The store did not return JSON. Check that its API is enabled.'); }
}

function plain(value = '') {
  return String(value).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#039;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,code) => String.fromCodePoint(Number(code))).replace(/\s+/g,' ').trim();
}
function finish(provider, site, entries) {
  if (!entries.length) throw new Error('No published content was returned by this connector.');
  const full = entries.filter(Boolean).join('\n\n---\n\n');
  const content = full.length > 30_000 ? `${full.slice(0,29_850)}\n\n[Import truncated at 30,000 characters]` : full;
  const label = provider === 'shopify' ? 'Shopify catalog' : provider === 'woocommerce' ? 'WooCommerce catalog' : 'WordPress content';
  return { title: `${label} — ${site}`, content, provider, site, items: entries.length, truncated: full.length > 30_000 };
}
function apiUrl(base, path) { const prefix = base.pathname.replace(/\/$/, ''); return new URL(`${prefix}${path}`, base.origin); }

async function shopify(input, base) {
  if (!base.hostname.endsWith('.myshopify.com')) throw new Error('Use the store’s .myshopify.com domain for Shopify.');
  if (!input.accessToken) throw new Error('A Shopify Admin API access token with read_products is required.');
  const version = env.SHOPIFY_API_VERSION || '2026-07';
  const result = await fetchJson(new URL(`/admin/api/${version}/graphql.json`, base.origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': input.accessToken },
    body: JSON.stringify({ query: `query RelayProducts { products(first: 50) { nodes { title description vendor productType tags onlineStoreUrl priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } } } } }` }),
  });
  if (result.errors?.length) throw new Error(`Shopify rejected the product query: ${plain(result.errors[0]?.message).slice(0,180)}`);
  const products = result.data?.products?.nodes || [];
  return finish('shopify', base.hostname, products.map(product => {
    const min = product.priceRangeV2?.minVariantPrice; const max = product.priceRangeV2?.maxVariantPrice;
    const price = min ? `${min.amount}${max?.amount !== min.amount ? `–${max.amount}` : ''} ${min.currencyCode}` : '';
    return [product.title, plain(product.description), product.vendor && `Vendor: ${product.vendor}`, product.productType && `Type: ${product.productType}`, price && `Price: ${price}`, product.tags?.length && `Tags: ${product.tags.join(', ')}`, product.onlineStoreUrl && `URL: ${product.onlineStoreUrl}`].filter(Boolean).join('\n');
  }));
}

async function woocommerce(input, base) {
  if (!input.consumerKey || !input.consumerSecret) throw new Error('WooCommerce read-only consumer key and secret are required.');
  const auth = Buffer.from(`${input.consumerKey}:${input.consumerSecret}`).toString('base64');
  const products = await fetchJson(apiUrl(base, '/wp-json/wc/v3/products?per_page=50&status=publish'), { headers: { Authorization: `Basic ${auth}` } });
  if (!Array.isArray(products)) throw new Error('WooCommerce did not return a product list.');
  return finish('woocommerce', base.hostname, products.map(product => [product.name, plain(product.short_description || product.description), product.sku && `SKU: ${product.sku}`, product.price && `Price: ${product.price}`, product.categories?.length && `Categories: ${product.categories.map(category => category.name).join(', ')}`, product.permalink && `URL: ${product.permalink}`].filter(Boolean).join('\n')));
}

async function wordpress(_input, base) {
  const requests = await Promise.allSettled([
    fetchJson(apiUrl(base, '/wp-json/wp/v2/posts?per_page=50&status=publish&_fields=link,title,excerpt,content')),
    fetchJson(apiUrl(base, '/wp-json/wp/v2/pages?per_page=50&status=publish&_fields=link,title,excerpt,content')),
  ]);
  const [posts, pages] = requests.map(result => result.status === 'fulfilled' ? result.value : []);
  if (requests.every(result => result.status === 'rejected')) throw requests[0].reason;
  const items = [...(Array.isArray(pages) ? pages : []), ...(Array.isArray(posts) ? posts : [])];
  return finish('wordpress', base.hostname, items.map(item => [plain(item.title?.rendered), plain(item.content?.rendered || item.excerpt?.rendered), item.link && `URL: ${item.link}`].filter(Boolean).join('\n')));
}

export async function importConnector(input) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid connector settings');
  const base = await validateRemoteUrl(parsed.data.storeUrl);
  const handlers = { shopify, woocommerce, wordpress };
  return handlers[parsed.data.provider](parsed.data, base);
}

connectorRouter.post('/import', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Workspace admin access required' });
  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid connector settings' });
  const limited = await sharedLimit('upload', req.workspaceId);
  if (!limited.success) return res.status(429).json({ error: 'Import limit reached. Try again later.' });
  try {
    res.json(await importConnector(parsed.data));
  } catch (error) {
    const safe = /^(Use |A Shopify|Shopify |WooCommerce |No published|Private network|The store|The authenticated)/.test(error.message || '') ? error.message : 'Could not import this site. Check its URL, API access, and credentials.';
    res.status(400).json({ error: safe });
  }
});
