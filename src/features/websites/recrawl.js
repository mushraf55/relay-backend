import { randomUUID } from 'node:crypto';
import { client } from '../../infrastructure/database.js';
import { trainTextSource } from '../ai/training.js';
import { scrapeWebsite } from './routes.js';

const DAY = 24 * 60 * 60 * 1000;
const intervalBySchedule = { Daily: DAY, Weekly: 7 * DAY, Monthly: 30 * DAY };

function due(source, now = Date.now()) {
  const every = intervalBySchedule[source.recrawl];
  if (!every || !source.sourceUrl) return false;
  const last = new Date(source.lastSyncedAt || source.updated || 0).getTime();
  return !Number.isFinite(last) || now - last >= every;
}

export async function recrawlSource(workspaceId, source) {
  const result = await scrapeWebsite({ url: source.sourceUrl, maxPages: 10 });
  const changed = result.content !== source.content;
  await client.begin(async tx => {
    const [row] = await tx`SELECT data FROM relay.workspaces WHERE id=${workspaceId} FOR UPDATE`;
    const data = row?.data || {};
    const item = data.sources?.find(value => value.id === source.id && value.botId === source.botId);
    if (!item) return;
    item.title = result.title;
    item.sourceUrl = result.sourceUrl || source.sourceUrl;
    item.lastSyncedAt = new Date().toISOString();
    item.updated = new Date().toISOString().slice(0, 10);
    item.changedPages = [{ url: item.sourceUrl, title: item.title, status: changed ? 'Changed' : 'Unchanged', lastSeenAt: new Date().toISOString() }];
    if (changed) {
      item.content = result.content;
      item.status = 'Pending';
    }
    data.activity = Array.isArray(data.activity) ? data.activity : [];
    data.activity.unshift({ id: randomUUID(), botId: item.botId, type: 'recrawl', title: changed ? 'Scheduled recrawl found changes' : 'Scheduled recrawl found no changes', detail: item.title, createdAt: new Date().toISOString() });
    await tx`UPDATE relay.workspaces SET data=${JSON.stringify(data)}::jsonb, revision=revision+1, updated_at=now() WHERE id=${workspaceId}`;
  });
  if (changed) await trainTextSource({ workspaceId, botId: source.botId, sourceId: source.id });
  return changed;
}

export async function runScheduledRecrawls({ limit = 20 } = {}) {
  const rows = await client`SELECT id,data FROM relay.workspaces WHERE jsonb_typeof(data->'sources')='array' LIMIT 200`;
  let checked = 0;
  for (const row of rows) {
    for (const source of row.data.sources || []) {
      if (checked >= limit) return { checked };
      if (!due(source)) continue;
      checked++;
      try {
        await recrawlSource(row.id, source);
      } catch (error) {
        await client.begin(async tx => {
          const [current] = await tx`SELECT data FROM relay.workspaces WHERE id=${row.id} FOR UPDATE`;
          const data = current?.data || {};
          const item = data.sources?.find(value => value.id === source.id && value.botId === source.botId);
          if (item) {
            item.status = 'Error';
            item.processingError = error.message || 'Scheduled recrawl failed.';
            item.lastSyncedAt = new Date().toISOString();
          }
          data.activity = Array.isArray(data.activity) ? data.activity : [];
          data.activity.unshift({ id: randomUUID(), botId: source.botId, type: 'recrawl', title: 'Scheduled recrawl failed', detail: source.title, createdAt: new Date().toISOString() });
          await tx`UPDATE relay.workspaces SET data=${JSON.stringify(data)}::jsonb, revision=revision+1, updated_at=now() WHERE id=${row.id}`;
        });
      }
    }
  }
  return { checked };
}

export async function findDueRecrawlSources({ limit = 20 } = {}) {
  const rows = await client`SELECT id,data FROM relay.workspaces WHERE jsonb_typeof(data->'sources')='array' LIMIT 200`;
  const dueSources = [];
  for (const row of rows) {
    for (const source of row.data.sources || []) {
      if (dueSources.length >= limit) return dueSources;
      if (due(source)) dueSources.push({ workspaceId: row.id, botId: source.botId, sourceId: source.id });
    }
  }
  return dueSources;
}

export async function recrawlSourceById({ workspaceId, botId, sourceId }) {
  const [row] = await client`SELECT data FROM relay.workspaces WHERE id=${workspaceId}`;
  const source = row?.data?.sources?.find(item => item.id === sourceId && item.botId === botId);
  if (!source) return { skipped: true };
  return { changed: await recrawlSource(workspaceId, source) };
}

export function startRecrawlScheduler() {
  const minutes = Number(process.env.RECRAWL_INTERVAL_MINUTES || 60);
  const timer = setInterval(() => {
    void runScheduledRecrawls().catch(error => console.error('Scheduled recrawl failed:', error.name));
  }, Math.max(5, minutes) * 60 * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
