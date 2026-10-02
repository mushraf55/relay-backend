import { randomUUID } from 'node:crypto';
import { client } from '../src/infrastructure/database.js';
import { deleteFile, putFile } from '../src/infrastructure/object-storage.js';
import { indexStoredFile } from '../src/features/knowledge/jobs.js';
import { aiConfig, embed } from '../src/features/ai/client.js';
const workspaceId = `test:${randomUUID()}`; const botId = 'file-bot'; const sourceId = 'file-source';
const objectKey = `_relay_checks/${randomUUID()}.txt`;
const body = Buffer.from('Priority orders arrive in exactly three business days. Reference code ORBIT-8142.\n'.repeat(160));
const source = { id: sourceId, botId, title: 'Shipping guide', type: 'File', content: 'Original document stored privately in Cloudflare R2.' };
const data = { bots: [{ id: botId, name: 'File Test' }], sources: [source] };
try {
  await putFile(objectKey, body, 'text/plain');
  await client`INSERT INTO relay.workspaces(id,data) VALUES(${workspaceId},${JSON.stringify(data)}::jsonb)`;
  await client`INSERT INTO relay.knowledge_files(workspace_id,bot_id,source_id,object_key,filename,content_type,size_bytes) VALUES(${workspaceId},${botId},${sourceId},${objectKey},'shipping.txt','text/plain',${body.length})`;
  const result = await indexStoredFile({ workspaceId, botId, sourceId, objectKey });
  const [chunk] = await client`SELECT content FROM relay.ai_chunks WHERE workspace_id=${workspaceId} AND source_id=${sourceId}`;
  if (!chunk?.content.includes('ORBIT-8142')) throw new Error('Extracted source was not indexed.');
  const [file] = await client`SELECT status FROM relay.knowledge_files WHERE workspace_id=${workspaceId} AND source_id=${sourceId}`;
  if (file?.status !== 'ready') throw new Error('File status did not reach ready.');
  const query = await embed(['What is the reference code for priority shipping?'], aiConfig());
  const matches = await client`
    SELECT c.content FROM relay.ai_chunks c
    JOIN relay.workspaces w ON w.id=c.workspace_id
    LEFT JOIN relay.knowledge_files f ON f.workspace_id=c.workspace_id AND f.source_id=c.source_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'sources','[]'::jsonb)) s
    WHERE c.workspace_id=${workspaceId} AND c.bot_id=${botId}
    AND c.source_id=s->>'id' AND s->>'botId'=${botId}
    AND c.source_hash=CASE WHEN s->>'type'='File'
      THEN md5((s->>'title') || E'\n' || f.object_key)
      ELSE md5((s->>'title') || E'\n' || (s->>'content')) END
    AND c.model_key=${query.modelKey} AND c.dimensions=${query.dimensions}
    ORDER BY c.embedding OPERATOR(extensions.<=>) ${JSON.stringify(query.vectors[0])}::extensions.vector LIMIT 1`;
  if (!matches[0]?.content.includes('ORBIT-8142')) throw new Error('Indexed document was not available to chat retrieval.');
  console.log(`R2 → extraction → Ollama → Supabase: PASS (${result.chunks} chunk, ${result.dimensions} dimensions)`);
} finally {
  try { await deleteFile(objectKey); } catch { /* Test object may not exist. */ }
  await client`DELETE FROM relay.workspaces WHERE id=${workspaceId}`;
  await client.end({ timeout: 2 });
  console.log('Temporary file and workspace removed.');
}
