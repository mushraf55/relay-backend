import { Inngest } from 'inngest';
import { env } from '../../config/env.js';
import { client } from '../../infrastructure/database.js';
import { aiConfig, chunkText, embed, embeddingBatchSize } from '../ai/client.js';
import { deleteFile, getFile } from '../../infrastructure/object-storage.js';
import { extractText } from './extraction.js';
import { createHash } from 'node:crypto';
import { reportKnowledgeProgress } from './progress.js';
import { recordUsage } from '../analytics/usage.js';
import { trainTextSource } from '../ai/training.js';
import { findDueRecrawlSources, recrawlSourceById } from '../websites/recrawl.js';

export const inngest = new Inngest({ id: 'relay-backend', eventKey: env.INNGEST_EVENT_KEY });
export function jobProvider() {
  return env.JOB_PROVIDER || (env.AI_PROVIDER === 'ollama' ? 'inline' : 'inngest');
}

export async function indexStoredFile({ workspaceId, botId, sourceId, objectKey }) {
  const [file] = await client`SELECT * FROM relay.knowledge_files WHERE workspace_id=${workspaceId} AND bot_id=${botId} AND source_id=${sourceId} AND object_key=${objectKey}`;
  if (!file) return { skipped: true };
  const [workspace] = await client`SELECT data FROM relay.workspaces WHERE id=${workspaceId}`;
  const source = workspace?.data?.sources?.find(item => item.id === sourceId && item.botId === botId);
  if (!source) return { skipped: true };
  try {
    await reportKnowledgeProgress({ workspaceId, sourceId, objectKey, progress: 10, stage: 'Loading file', detail: 'Reading the private document from storage.' });
    const buffer = await getFile(objectKey);
    await reportKnowledgeProgress({ workspaceId, sourceId, objectKey, progress: 20, stage: 'Extracting text', detail: `Reading ${file.filename}.` });
    const text = await extractText(buffer, file.content_type);
    await reportKnowledgeProgress({ workspaceId, sourceId, objectKey, progress: 32, stage: 'Preparing content', detail: `${text.length.toLocaleString()} characters extracted. Splitting the document into searchable sections.` });
    const chunks = chunkText(`${source.title}\n${text}`);
    if (!chunks.length) throw new Error('No searchable text was found in this document.');
    const settings = aiConfig(); let modelKey; let dimensions;
    const fingerprint = fileFingerprint(source.title, objectKey);
    await client.begin(async tx => {
      const [current] = await tx`SELECT object_key FROM relay.knowledge_files WHERE workspace_id=${workspaceId} AND source_id=${sourceId} FOR UPDATE`;
      if (!current || current.object_key !== objectKey) throw new Error('The uploaded source changed while processing.');
      await tx`DELETE FROM relay.ai_chunks WHERE workspace_id=${workspaceId} AND source_id=${sourceId}`;
    });
    const batchSize = embeddingBatchSize(settings);
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batchChunks = chunks.slice(i, i + batchSize);
      const batch = await embed(batchChunks, settings);
      modelKey = batch.modelKey; dimensions = batch.dimensions;
      await client.begin(async tx => {
        const [current] = await tx`SELECT object_key FROM relay.knowledge_files WHERE workspace_id=${workspaceId} AND source_id=${sourceId} FOR UPDATE`;
        if (!current || current.object_key !== objectKey) throw new Error('The uploaded source changed while processing.');
        const records = batchChunks.map((content, index) => ({ content, embedding: JSON.stringify(batch.vectors[index]) }));
        await tx`
          INSERT INTO relay.ai_chunks(workspace_id,bot_id,source_id,source_hash,model_key,dimensions,content,embedding,created_by_user_id)
          SELECT ${workspaceId},${botId},${sourceId},${fingerprint},${batch.modelKey},${batch.dimensions},record.content,record.embedding::extensions.vector,${file.uploaded_by_user_id}
          FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS record(content text,embedding text)
      `;
      });
      await recordUsage({ workspaceId, userId: file.uploaded_by_user_id, metric: 'embedding_calls', metadata: { sourceId, provider: settings.embeddingProvider || settings.provider } });
      await recordUsage({ workspaceId, userId: file.uploaded_by_user_id, metric: 'embedded_chunks', quantity: batchChunks.length, metadata: { sourceId } });
      const processedChunks = Math.min(i + batchSize, chunks.length);
      await reportKnowledgeProgress({ workspaceId, sourceId, objectKey, progress: 35 + (processedChunks / chunks.length) * 55, stage: 'Creating embeddings', detail: `Embedded ${processedChunks} of ${chunks.length} sections with ${settings.embedding}.`, processedChunks, totalChunks: chunks.length });
    }
    await reportKnowledgeProgress({ workspaceId, sourceId, objectKey, progress: 94, stage: 'Saving index', detail: `Saving ${chunks.length} searchable sections.`, processedChunks: chunks.length, totalChunks: chunks.length });
    await client.begin(async tx => {
      const [current] = await tx`SELECT object_key FROM relay.knowledge_files WHERE workspace_id=${workspaceId} AND source_id=${sourceId} FOR UPDATE`;
      if (!current || current.object_key !== objectKey) throw new Error('The uploaded source changed while processing.');
      await tx`UPDATE relay.knowledge_files SET status='ready',progress=100,progress_stage='Ready',progress_detail=${`${chunks.length} searchable sections are ready.`},processed_chunks=${chunks.length},total_chunks=${chunks.length},error_message=NULL,progress_updated_at=now() WHERE workspace_id=${workspaceId} AND source_id=${sourceId} AND object_key=${objectKey}`;
    });
    await reportKnowledgeProgress({ workspaceId, sourceId, objectKey, status: 'ready', progress: 100, stage: 'Ready', detail: `${chunks.length} searchable sections are ready.`, processedChunks: chunks.length, totalChunks: chunks.length });
    return { chunks: chunks.length, dimensions, modelKey };
  } catch (error) {
    const message = String(error.message || 'Processing failed').slice(0,300);
    await reportKnowledgeProgress({ workspaceId, sourceId, objectKey, status: 'error', progress: 100, stage: 'Processing failed', detail: message, error: message });
    throw error;
  }
}
export const fileFingerprint = (title, objectKey) => hashValue(`${title}\n${objectKey}`);
function hashValue(value) {
  // MD5 matches PostgreSQL's md5() used only as a change fingerprint, not for security.
  return createHash('md5').update(value).digest('hex');
}
export async function removeStoredFile({ workspaceId, sourceId, objectKey }) {
  const [file] = await client`SELECT object_key FROM relay.knowledge_files WHERE workspace_id=${workspaceId} AND source_id=${sourceId}`;
  if (file && file.object_key !== objectKey) { await deleteFile(objectKey); return { deleted: true, replaced: true }; }
  if (!file) { await deleteFile(objectKey); return { deleted: true, orphan: true }; }
  await deleteFile(objectKey);
  await client`DELETE FROM relay.knowledge_files WHERE workspace_id=${workspaceId} AND source_id=${sourceId} AND object_key=${objectKey}`;
  return { deleted: true };
}
export const indexFileFunction = inngest.createFunction({ id: 'index-knowledge-file', triggers: { event: 'relay/knowledge.file.uploaded' }, concurrency: [{ limit: 1, key: 'event.data.workspaceId' }], retries: 4 }, async ({ event, step }) => step.run('extract-embed-and-index', () => indexStoredFile(event.data)));
export const deleteFileFunction = inngest.createFunction({ id: 'delete-knowledge-file', triggers: { event: 'relay/knowledge.file.deleted' }, retries: 6 }, async ({ event, step }) => step.run('delete-private-object', () => removeStoredFile(event.data)));
export const trainSourceFunction = inngest.createFunction({ id: 'train-knowledge-source', triggers: { event: 'relay/knowledge.source.train' }, concurrency: [{ limit: 1, key: 'event.data.workspaceId' }], retries: 4 }, async ({ event, step }) => step.run('embed-and-index-source', () => trainTextSource(event.data)));
export const recrawlSweepFunction = inngest.createFunction({ id: 'sweep-website-recrawls', triggers: { event: 'relay/websites.recrawl.sweep' }, concurrency: [{ limit: 1, key: "'global'" }], retries: 2 }, async ({ event, step }) => {
  const sources = await step.run('find-due-recrawls', () => findDueRecrawlSources({ limit: Number(event.data?.limit || env.RECRAWL_BATCH_LIMIT || 20) }));
  if (!sources.length) return { queued: 0 };
  await step.sendEvent('queue-due-recrawls', sources.map(source => ({ name: 'relay/websites.source.recrawl', data: source })));
  return { queued: sources.length };
});
export const recrawlSourceFunction = inngest.createFunction({ id: 'recrawl-website-source', triggers: { event: 'relay/websites.source.recrawl' }, concurrency: [{ limit: 1, key: 'event.data.workspaceId' }], retries: 3 }, async ({ event, step }) => step.run('scrape-and-train-changed-source', () => recrawlSourceById(event.data)));
export const inngestFunctions = [indexFileFunction, deleteFileFunction, trainSourceFunction, recrawlSweepFunction, recrawlSourceFunction];
export async function queueEvent(event) { return inngest.send(event); }
