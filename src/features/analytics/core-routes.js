import { Router } from 'express';
import { client } from '../../infrastructure/database.js';

export const coreAnalyticsRouter = Router();

coreAnalyticsRouter.get('/', async (req, res) => {
  const [[files], [vectors], [deployments], [messages], [workspace]] = await Promise.all([
    client`SELECT COUNT(*)::int AS files,COALESCE(SUM(size_bytes),0)::bigint AS bytes,COUNT(*) FILTER (WHERE status='ready')::int AS ready FROM relay.knowledge_files WHERE workspace_id=${req.workspaceId}`,
    client`SELECT COUNT(*)::int AS chunks,COALESCE(SUM(pg_column_size(embedding)),0)::bigint AS vector_bytes,COALESCE(SUM(octet_length(content)),0)::bigint AS text_bytes,COALESCE(MAX(dimensions),0)::int AS dimensions FROM relay.ai_chunks WHERE workspace_id=${req.workspaceId}`,
    client`SELECT COUNT(*) FILTER (WHERE enabled=true)::int AS published FROM relay.deployments WHERE workspace_id=${req.workspaceId}`,
    client`SELECT COUNT(m.id)::int AS messages FROM relay.chat_messages m JOIN relay.chat_rooms r ON r.id=m.room_id JOIN relay.deployments d ON d.id=r.deployment_id WHERE d.workspace_id=${req.workspaceId}`,
    client`SELECT data FROM relay.workspaces WHERE id=${req.workspaceId}`,
  ]);
  const sources = workspace?.data?.sources || [];
  res.set('Cache-Control', 'no-store').json({
    chatbots: workspace?.data?.bots?.length || 0,
    sources: sources.length,
    websiteSources: sources.filter(source => source.type === 'Website').length,
    fileSources: sources.filter(source => source.type === 'File').length,
    readySources: sources.filter(source => source.status === 'Ready').length,
    files: files.files,
    readyFiles: files.ready,
    r2Bytes: Number(files.bytes),
    chunks: vectors.chunks,
    vectorBytes: Number(vectors.vector_bytes),
    indexedTextBytes: Number(vectors.text_bytes),
    embeddingDimensions: vectors.dimensions,
    published: deployments.published,
    messages: messages.messages,
  });
});
