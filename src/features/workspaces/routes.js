import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { db, client } from '../../infrastructure/database.js';
import { aiConfig } from '../ai/provider.js';
import { sourceHash } from '../ai/training.js';
import { fileFingerprint, removeStoredFile } from '../knowledge/processing.js';

export const workspaceRouter = Router();
const getWorkspace = async id => (await db.execute(sql`SELECT * FROM relay.workspaces WHERE id=${id}`))[0];
workspaceRouter.get('/', async (req, res) => {
  const row = await getWorkspace(req.workspaceId);
  const settings = aiConfig();
  const embeddingModelKey = `hosted:${settings.embeddingModel}`;
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
  res.json({
    data: row.data,
    revision: row.revision,
    canEdit: true,
  });
});

function normalizeWorkspaceData(input) {
  const data = { ...input };
  data.workspace = String(data.workspace || 'My workspace').slice(0, 100);
  data.onboarded = data.onboarded === true;
  data.bots = Array.isArray(data.bots) ? data.bots.filter(bot => bot && typeof bot === 'object' && typeof bot.id === 'string' && typeof bot.name === 'string').slice(0, 100) : [];
  data.sources = Array.isArray(data.sources) ? data.sources.filter(source => source && typeof source === 'object' && typeof source.id === 'string' && typeof source.botId === 'string').slice(0, 500) : [];
  return { workspace: data.workspace, onboarded: data.onboarded, bots: data.bots, sources: data.sources };
}

workspaceRouter.put('/', async (req, res) => {
  const revision = Number(req.body?.revision);
  if (!Number.isInteger(revision) || revision < 0 || !req.body?.data || typeof req.body.data !== 'object' || Array.isArray(req.body.data)) {
    return res.status(400).json({ error: 'Invalid workspace save payload' });
  }
  const data = normalizeWorkspaceData(req.body.data);
  const ids = new Set(data.bots.map(bot => bot.id));
  if (ids.size !== data.bots.length || data.sources.some(source => !ids.has(source.botId))) {
    return res.status(400).json({ error: 'Invalid chatbot references' });
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
    void removeStoredFile(payload).catch(error => console.error('File cleanup failed:', error.name));
  }

  return res.json({ revision: updated[0].revision });
});
