import { Router } from 'express';
import { z } from 'zod';
import { client } from '../../infrastructure/database.js';
import { aiConfig } from './client.js';
import { sharedLimit } from '../../infrastructure/rate-limits.js';
import { indexStoredFile, jobProvider, queueEvent } from '../knowledge/jobs.js';
import { groundedChat, groundedChatStream } from './chat-service.js';
import { recordUsage } from '../analytics/usage.js';
import { canEditWorkspace } from '../workspaces/permissions.js';
import { trainTextSource } from './training.js';

export const aiRouter = Router();
export const isMeteredAiPath = path => !['/status', '/status/source'].includes(path);
aiRouter.use(async (req, res, next) => {
  if (!isMeteredAiPath(req.path)) return next();
  const result = await sharedLimit('ai', `${req.workspaceId}:${req.path}`);
  res.setHeader('RateLimit-Limit', result.limit); res.setHeader('RateLimit-Remaining', result.remaining); res.setHeader('RateLimit-Reset', result.reset);
  if (!result.success) return res.status(429).json({ error: 'AI request limit reached. Try again shortly.' });
  next();
});
const active = new Set();
aiRouter.use(async (req, res, next) => {
  if (!isMeteredAiPath(req.path)) return next();
  if (active.has(req.workspaceId)) return res.status(429).json({ error: 'Your workspace is already processing an AI request. Please wait.' });
  active.add(req.workspaceId);
  const release = () => active.delete(req.workspaceId);
  res.once('finish', release);
  res.once('close', release);
  next();
});
const fail = (res, error) => res.status(503).json({ error: error.message?.startsWith('Ollama') || /^(ollama|openai|groq|cloudflare|Set OPENAI|Set GROQ|Set CLOUDFLARE|The model|Embedding model)/.test(error.message || '') ? error.message : 'AI processing failed. Check backend connectivity and migrations, then retry.' });
aiRouter.get('/status', (_req, res) => {
  const settings = aiConfig();
  res.json({ provider: settings.provider, chatModel: settings.chat, embeddingProvider: settings.embeddingProvider, embeddingModel: settings.embedding });
});
aiRouter.post('/status/source', async (req, res) => {
  const parsed = z.object({ sourceId: z.string().min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid source' });
  const [file] = await client`SELECT status,error_message,progress,progress_stage,progress_detail,processed_chunks,total_chunks FROM relay.knowledge_files WHERE workspace_id=${req.workspaceId} AND source_id=${parsed.data.sourceId}`;
  if (!file) return res.status(404).json({ error: 'Uploaded source not found' });
  res.json({ status: file.status, error: file.error_message, progress: file.progress, stage: file.progress_stage, detail: file.progress_detail, processedChunks: file.processed_chunks, totalChunks: file.total_chunks });
});
aiRouter.post('/train', async (req, res) => {
  if (!await canEditWorkspace(req)) return res.status(403).json({ error: 'Workspace editor access required' });
  const parsed = z.object({ botId: z.string().min(1).max(100), sourceId: z.string().min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid source' });
  const { botId, sourceId } = parsed.data;
  try {
    const [row] = await client`SELECT data FROM relay.workspaces WHERE id=${req.workspaceId}`;
    const source = row?.data.sources?.find(s => s.id === sourceId && s.botId === botId);
    if (!source || !row.data.bots?.some(b => b.id === botId)) return res.status(404).json({ error: 'Source not found in this workspace' });
    if (source.type === 'File') {
      const [file] = await client`SELECT object_key FROM relay.knowledge_files WHERE workspace_id=${req.workspaceId} AND source_id=${sourceId} AND bot_id=${botId}`;
      if (!file) return res.status(400).json({ error: 'Upload the original file before training it.' });
      const payload = { workspaceId: req.workspaceId, botId, sourceId, objectKey: file.object_key };
      if (jobProvider() === 'inline') void indexStoredFile(payload).catch(error => console.error('Inline file processing failed:', error.name));
      else await queueEvent({ name: 'relay/knowledge.file.uploaded', data: payload });
      return res.status(202).json({ queued: true });
    }
    const payload = { workspaceId: req.workspaceId, userId: req.userId, botId, sourceId };
    if (jobProvider() === 'inline') {
      return res.json(await trainTextSource(payload));
    }
    await queueEvent({ name: 'relay/knowledge.source.train', data: payload });
    return res.status(202).json({ queued: true });
  } catch (error) { fail(res, error); }
});
const chatInput = z.object({ botId: z.string().min(1).max(100), message: z.string().trim().min(1).max(1000), history: z.array(z.object({ role: z.enum(['user','assistant']), content: z.string().max(8000) })).max(8).default([]) });

aiRouter.post('/chat', async (req, res) => {
  const parsed = chatInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid chat request' });
  const { botId, message, history } = parsed.data;
  try {
    const [row] = await client`SELECT data FROM relay.workspaces WHERE id=${req.workspaceId}`;
    const bot = row?.data.bots?.find(b => b.id === botId);
    if (!bot) return res.status(404).json({ error: 'Chatbot not found in this workspace' });
    await recordUsage({ workspaceId: req.workspaceId, userId: req.userId, metric: 'ai_calls', metadata: { channel: 'playground', botId } });
    res.json(await groundedChat({ workspaceId: req.workspaceId, bot, message, history }));
  } catch (error) { fail(res, error); }
});

aiRouter.post('/chat/stream', async (req, res) => {
  const parsed = chatInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid chat request' });
  const { botId, message, history } = parsed.data;
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const [row] = await client`SELECT data FROM relay.workspaces WHERE id=${req.workspaceId}`;
    const bot = row?.data.bots?.find(item => item.id === botId);
    if (!bot) return res.status(404).json({ error: 'Chatbot not found in this workspace' });
    await recordUsage({ workspaceId: req.workspaceId, userId: req.userId, metric: 'ai_calls', metadata: { channel: 'playground_stream', botId } });
    res.status(200).set({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    for await (const event of groundedChatStream({ workspaceId: req.workspaceId, bot, message, history }, controller.signal)) {
      res.write(`${JSON.stringify(event)}\n`);
    }
    res.end();
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = error.message?.startsWith('Ollama') || /^(ollama|openai|groq|cloudflare|Set OPENAI|Set GROQ|Set CLOUDFLARE|The model)/.test(error.message || '')
      ? error.message
      : 'AI processing failed. Check backend connectivity and migrations, then retry.';
    if (res.headersSent) {
      res.write(`${JSON.stringify({ type: 'error', error: message })}\n`);
      return res.end();
    }
    return res.status(503).json({ error: message });
  }
});
