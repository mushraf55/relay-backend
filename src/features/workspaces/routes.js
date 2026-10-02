import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { db, client } from '../../infrastructure/database.js';
import { entitlement } from '../../config/env.js';
import { aiConfig } from '../ai/client.js';
import { sourceHash } from '../ai/training.js';
import { fileFingerprint, jobProvider, queueEvent, removeStoredFile } from '../knowledge/jobs.js';
import { leaveAccountChat, listAccountChats } from '../public-chat/service.js';
import { workspaceUsage } from '../analytics/usage.js';
import { appRole, roleCanEdit } from './permissions.js';

export const workspaceRouter = Router();
const getWorkspace = async id => (await db.execute(sql`SELECT * FROM relay.workspaces WHERE id=${id}`))[0];
function canEditWorkspace(data, req) {
  if (req.isAdmin) return true;
  const role = appRole(data, req.userEmail);
  return roleCanEdit(role);
}

function estimateCosts(usage, bots) {
  const callsByBot = new Map();
  for (const bot of bots || []) callsByBot.set(bot.id, 0);
  return (bots || []).map(bot => {
    const calls = callsByBot.get(bot.id) || 0;
    const fallbackCalls = usage.totals.aiCalls && bots.length ? Math.ceil(usage.totals.aiCalls / bots.length) : 0;
    const totalCalls = calls || fallbackCalls;
    const tokens = totalCalls * 850;
    return { id: `cost-${bot.id}`, botId: bot.id, period: usage.period.label, calls: totalCalls, tokens, estimatedCost: Number((tokens / 1000 * 0.002).toFixed(4)) };
  });
}

workspaceRouter.get('/chats', async (req, res) => {
  res.json({ chats: await listAccountChats(req.userId) });
});

workspaceRouter.delete('/chats/:shareId', async (req, res) => {
  const shareId = String(req.params.shareId || '');
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(shareId)) return res.status(404).json({ error: 'Room not found' });
  const left = await leaveAccountChat(req.userId, shareId);
  if (!left) return res.status(404).json({ error: 'Room not found' });
  res.json({ left: true });
});

workspaceRouter.get('/', async (req, res) => {
  const row = await getWorkspace(req.workspaceId);
  const settings = aiConfig();
  const embeddingModelKey = `${settings.embeddingProvider || settings.provider}:${settings.embedding}`;
  const [indexed, files] = await Promise.all([
    client`SELECT DISTINCT source_id,source_hash FROM relay.ai_chunks WHERE workspace_id=${req.workspaceId} AND model_key=${embeddingModelKey}`,
    client`SELECT source_id,object_key,status,progress,progress_stage,progress_detail,processed_chunks,total_chunks,error_message FROM relay.knowledge_files WHERE workspace_id=${req.workspaceId}`,
  ]);

  if (Array.isArray(row.data.sources)) {
    row.data.sources = row.data.sources.map(source => {
      const file = source.type === 'File' ? files.find(item => item.source_id === source.id) : null;
      const fingerprint = file ? fileFingerprint(source.title, file.object_key) : sourceHash(source);
      const ready = indexed.some(item => item.source_id === source.id && item.source_hash === fingerprint);
      const status = file?.status === 'error'
        ? 'Error'
        : file && file.status !== 'ready'
          ? 'Processing'
          : ready
            ? 'Ready'
            : ['Processing', 'Error'].includes(source.status)
              ? source.status
              : 'Pending';
      return {
        ...source,
        status,
        ...(file ? {
          progress: file.progress,
          progressStage: file.progress_stage,
          progressDetail: file.progress_detail,
          processedChunks: file.processed_chunks,
          totalChunks: file.total_chunks,
          processingError: file.error_message,
        } : {}),
      };
    });
  }
  try {
    const usage = await workspaceUsage(req.workspaceId, req.userId, entitlement(row.stripe_price_id, row.subscription_status, row));
    row.data.aiCosts = estimateCosts(usage, row.data.bots || []);
  } catch {
    row.data.aiCosts = row.data.aiCosts || [];
  }

  res.json({
    data: row.data,
    revision: row.revision,
    billing: entitlement(row.stripe_price_id, row.subscription_status, row),
    canEdit: canEditWorkspace(row.data, req),
  });
});

function normalizeWorkspaceData(input) {
  const data = { ...input };
  data.workspace = String(data.workspace || 'My workspace').slice(0, 100);
  data.timezone = String(data.timezone || 'UTC').slice(0, 100);
  data.onboarded = data.onboarded === true;
  data.bots = Array.isArray(data.bots) ? data.bots.filter(bot => bot && typeof bot === 'object' && typeof bot.id === 'string' && typeof bot.name === 'string').slice(0, 100) : [];
  data.sources = Array.isArray(data.sources) ? data.sources.filter(source => source && typeof source === 'object' && typeof source.id === 'string' && typeof source.botId === 'string').slice(0, 500) : [];
  data.conversations = Array.isArray(data.conversations) ? data.conversations.filter(conversation => conversation && typeof conversation === 'object' && typeof conversation.id === 'string' && typeof conversation.botId === 'string').slice(0, 1000) : [];
  for (const key of ['tests', 'feedback', 'leads', 'team', 'auditLog', 'activity', 'aiCosts']) data[key] = Array.isArray(data[key]) ? data[key].slice(0, 2500) : [];
  data.notifications = data.notifications && typeof data.notifications === 'object' ? data.notifications : {};
  data.notifications = {
    conversations: data.notifications.conversations !== false,
    training: data.notifications.training !== false,
    reports: data.notifications.reports === true,
  };
  return data;
}

workspaceRouter.put('/', async (req, res) => {
  const revision = Number(req.body?.revision);
  if (!Number.isInteger(revision) || revision < 0 || !req.body?.data || typeof req.body.data !== 'object' || Array.isArray(req.body.data)) {
    return res.status(400).json({ error: 'Invalid workspace save payload' });
  }
  const data = normalizeWorkspaceData(req.body.data);
  const ids = new Set(data.bots.map(bot => bot.id));
  if (ids.size !== data.bots.length || data.sources.some(source => !ids.has(source.botId)) || data.conversations.some(conversation => !ids.has(conversation.botId))) {
    return res.status(400).json({ error: 'Invalid chatbot references' });
  }

  const row = await getWorkspace(req.workspaceId);
  if (!canEditWorkspace(row.data, req)) return res.status(403).json({ error: 'Workspace editor access required' });
  if (data.bots.length > entitlement(row.stripe_price_id, row.subscription_status, row).bots) {
    return res.status(403).json({ error: 'Your plan chatbot limit has been reached' });
  }

  const updated = await db.transaction(async tx => {
    const result = await tx.execute(sql`UPDATE relay.workspaces SET data=${JSON.stringify(data)}::jsonb, revision=revision+1, updated_at=now() WHERE id=${req.workspaceId} AND revision=${revision} RETURNING revision`);
    if (result.length) {
      await tx.execute(sql`DELETE FROM relay.ai_chunks c WHERE c.workspace_id=${req.workspaceId} AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(data.sources)}::jsonb) s WHERE s->>'id'=c.source_id AND s->>'botId'=c.bot_id)`);
    }
    return result;
  });
  if (!updated.length) return res.status(409).json({ error: 'Workspace changed elsewhere. Reload before editing.' });

  const orphaned = await client`SELECT f.source_id,f.object_key FROM relay.knowledge_files f WHERE f.workspace_id=${req.workspaceId} AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(data.sources)}::jsonb) s WHERE s->>'id'=f.source_id AND s->>'botId'=f.bot_id)`;
  for (const file of orphaned) {
    const payload = { workspaceId: req.workspaceId, sourceId: file.source_id, objectKey: file.object_key };
    const inline = jobProvider() === 'inline';
    const cleanup = inline
      ? removeStoredFile(payload)
      : queueEvent({ name: 'relay/knowledge.file.deleted', data: payload });
    void cleanup.catch(error => console.error('File cleanup failed:', error.name));
  }

  return res.json({ revision: updated[0].revision });
});
