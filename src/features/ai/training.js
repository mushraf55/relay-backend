import { createHash } from 'node:crypto';
import { client } from '../../infrastructure/database.js';
import { aiConfig, chunkText, embed, embeddingBatchSize } from './client.js';
import { recordUsage } from '../analytics/usage.js';

export const sourceHash = source => createHash('md5').update(`${source.title}\n${source.content}`).digest('hex');

export async function updateSourceTrainingStatus({ workspaceId, botId, sourceId, status, chunks = null, error = null }) {
  await client.begin(async tx => {
    const [row] = await tx`SELECT data FROM relay.workspaces WHERE id=${workspaceId} FOR UPDATE`;
    const data = row?.data || {};
    const source = data.sources?.find(item => item.id === sourceId && item.botId === botId);
    if (!source) return;
    source.status = status;
    source.updated = new Date().toISOString().slice(0, 10);
    if (status === 'Ready') {
      source.progress = 100;
      source.progressStage = 'Ready';
      source.progressDetail = `${chunks ?? 0} searchable sections are ready.`;
      source.processedChunks = chunks ?? 0;
      source.totalChunks = chunks ?? 0;
      delete source.processingError;
    } else if (status === 'Error') {
      source.progress = 100;
      source.progressStage = 'Processing failed';
      source.progressDetail = error || 'Training failed.';
      source.processingError = error || 'Training failed.';
    } else if (status === 'Processing') {
      source.progress = source.progress || 10;
      source.progressStage = 'Queued';
      source.progressDetail = 'Preparing this source for searchable answers.';
      delete source.processingError;
    }
    await tx`UPDATE relay.workspaces SET data=${JSON.stringify(data)}::jsonb, revision=revision+1, updated_at=now() WHERE id=${workspaceId}`;
  });
}

export async function trainTextSource({ workspaceId, userId = null, botId, sourceId }) {
  const [row] = await client`SELECT data FROM relay.workspaces WHERE id=${workspaceId}`;
  const source = row?.data.sources?.find(s => s.id === sourceId && s.botId === botId);
  if (!source || !row.data.bots?.some(b => b.id === botId)) throw new Error('Source not found in this workspace');
  if (!['Text', 'FAQ', 'Connector', 'Website'].includes(source.type)) throw new Error('Unsupported source type.');
  const chunks = chunkText(`${source.title}\n${source.content}`);
  if (!chunks.length || chunks.length > 40) throw new Error('Source must contain text and be under 30,000 characters');
  const settings = aiConfig();
  const fingerprint = sourceHash(source);
  const vectors = [];
  let modelKey;
  let dimensions;
  try {
    await updateSourceTrainingStatus({ workspaceId, botId, sourceId, status: 'Processing' });
    const batchSize = Math.min(16, embeddingBatchSize(settings));
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = await embed(chunks.slice(i, i + batchSize), settings);
      modelKey = batch.modelKey;
      dimensions = batch.dimensions;
      vectors.push(...batch.vectors);
      await client.begin(async tx => {
        const [current] = await tx`SELECT data FROM relay.workspaces WHERE id=${workspaceId} FOR UPDATE`;
        const data = current?.data || {};
        const item = data.sources?.find(sourceItem => sourceItem.id === sourceId && sourceItem.botId === botId);
        if (!item) return;
        const processed = Math.min(i + batchSize, chunks.length);
        item.status = 'Processing';
        item.progress = Math.min(95, 20 + Math.round((processed / chunks.length) * 70));
        item.progressStage = 'Creating embeddings';
        item.progressDetail = `Embedded ${processed} of ${chunks.length} sections with ${settings.embedding}.`;
        item.processedChunks = processed;
        item.totalChunks = chunks.length;
        await tx`UPDATE relay.workspaces SET data=${JSON.stringify(data)}::jsonb, revision=revision+1, updated_at=now() WHERE id=${workspaceId}`;
      });
    }
    await client.begin(async tx => {
      const [current] = await tx`SELECT data FROM relay.workspaces WHERE id=${workspaceId} FOR UPDATE`;
      const latest = current.data.sources?.find(s => s.id === sourceId && s.botId === botId);
      if (!latest || sourceHash(latest) !== fingerprint) throw new Error('Source changed while processing');
      await tx`DELETE FROM relay.ai_chunks WHERE workspace_id=${workspaceId} AND source_id=${sourceId}`;
      for (let i = 0; i < chunks.length; i++) await tx`INSERT INTO relay.ai_chunks(workspace_id,bot_id,source_id,source_hash,model_key,dimensions,content,embedding,created_by_user_id) VALUES(${workspaceId},${botId},${sourceId},${fingerprint},${modelKey},${dimensions},${chunks[i]},${JSON.stringify(vectors[i])}::extensions.vector,${userId})`;
    });
    await recordUsage({ workspaceId, userId, metric: 'embedding_calls', quantity: Math.ceil(chunks.length / batchSize), metadata: { sourceId, provider: settings.embeddingProvider || settings.provider } });
    await recordUsage({ workspaceId, userId, metric: 'embedded_chunks', quantity: chunks.length, metadata: { sourceId } });
    await updateSourceTrainingStatus({ workspaceId, botId, sourceId, status: 'Ready', chunks: chunks.length });
    return { chunks: chunks.length, modelKey, dimensions };
  } catch (error) {
    await updateSourceTrainingStatus({ workspaceId, botId, sourceId, status: 'Error', error: String(error.message || 'Training failed.').slice(0, 300) });
    throw error;
  }
}
