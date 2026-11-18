import { createHash } from 'node:crypto';
import { client } from '../../infrastructure/database.js';
import { aiConfig, chunkText, embed } from '../ai/provider.js';
import { deleteFile, getFile } from '../../infrastructure/object-storage.js';
import { extractText } from './extraction.js';
import { reportKnowledgeProgress } from './progress.js';

export const fileFingerprint = (title, objectKey) => createHash('md5').update(`${title}\n${objectKey}`).digest('hex');

export async function indexStoredFile({ workspaceId, botId, sourceId, objectKey }) {
  const [file] = await client`SELECT * FROM relay.knowledge_files WHERE workspace_id=${workspaceId} AND bot_id=${botId} AND source_id=${sourceId} AND object_key=${objectKey}`;
  const [workspace] = await client`SELECT data FROM relay.workspaces WHERE id=${workspaceId}`;
  const source = workspace?.data?.sources?.find(item => item.id === sourceId && item.botId === botId);
  if (!file || !source) throw new Error('PDF source not found.');
  try {
    await reportKnowledgeProgress({ workspaceId, sourceId, objectKey, progress: 10, stage: 'Loading document', detail: 'Reading the file from private storage.' });
    const buffer = await getFile(objectKey);
    await reportKnowledgeProgress({ workspaceId, sourceId, objectKey, progress: 18, stage: file.content_type === 'application/pdf' ? 'Parsing PDF' : 'Reading text', detail: 'Extracting readable text from the document.' });
    const text = await extractText(buffer, file.content_type);
    await reportKnowledgeProgress({ workspaceId, sourceId, objectKey, progress: 24, stage: 'Splitting text', detail: 'Dividing the extracted text into searchable chunks.' });
    const chunks = chunkText(`${source.title}\n${text}`);
    if (!chunks.length || chunks.length > 100) throw new Error('The PDF must contain readable text and stay within the source limit.');
    const settings = aiConfig();
    const fingerprint = fileFingerprint(source.title, objectKey);
    const batchSize = 16;
    const records = [];
    for (let index = 0; index < chunks.length; index += batchSize) {
      const batchChunks = chunks.slice(index, index + batchSize);
      const batch = await embed(batchChunks, settings);
      records.push(...batchChunks.map((content, offset) => ({
        content,
        embedding: JSON.stringify(batch.vectors[offset]),
        modelKey: batch.modelKey,
        dimensions: batch.dimensions,
      })));
      const processed = Math.min(index + batchSize, chunks.length);
      await reportKnowledgeProgress({ workspaceId, sourceId, objectKey, progress: 25 + (processed / chunks.length) * 65, stage: 'Creating embeddings', detail: `Embedded ${processed} of ${chunks.length} chunks.`, processedChunks: processed, totalChunks: chunks.length });
    }
    await client.begin(async tx => {
      const [current] = await tx`SELECT object_key FROM relay.knowledge_files WHERE workspace_id=${workspaceId} AND source_id=${sourceId} FOR UPDATE`;
      if (!current || current.object_key !== objectKey) throw new Error('The PDF changed while it was being processed.');
      await tx`DELETE FROM relay.ai_chunks WHERE workspace_id=${workspaceId} AND source_id=${sourceId}`;
      for (const record of records) await tx`INSERT INTO relay.ai_chunks(workspace_id,bot_id,source_id,source_hash,model_key,dimensions,content,embedding) VALUES(${workspaceId},${botId},${sourceId},${fingerprint},${record.modelKey},${record.dimensions},${record.content},${record.embedding}::extensions.vector)`;
      await tx`UPDATE relay.knowledge_files SET status='ready',progress=100,progress_stage='Ready',progress_detail=${`${chunks.length} searchable chunks are ready.`},processed_chunks=${chunks.length},total_chunks=${chunks.length},error_message=NULL,progress_updated_at=now() WHERE workspace_id=${workspaceId} AND source_id=${sourceId}`;
    });
    return { chunks: chunks.length };
  } catch (error) {
    const message = String(error.message || 'PDF processing failed.').slice(0, 300);
    await reportKnowledgeProgress({ workspaceId, sourceId, objectKey, status: 'error', progress: 100, stage: 'Processing failed', detail: message, error: message });
    throw error;
  }
}

export async function removeStoredFile({ workspaceId, sourceId, objectKey }) {
  try { await deleteFile(objectKey); } finally {
    await client`DELETE FROM relay.knowledge_files WHERE workspace_id=${workspaceId} AND source_id=${sourceId} AND object_key=${objectKey}`;
  }
}
