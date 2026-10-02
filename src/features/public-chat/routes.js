import { randomBytes } from 'node:crypto';
import { verifyToken } from '@clerk/backend';
import { Router } from 'express';
import { z } from 'zod';
import { client } from '../../infrastructure/database.js';
import { appUrl, clerkAuthorizedParties, env } from '../../config/env.js';
import { groundedChat, groundedChatStream } from '../ai/chat-service.js';
import { recordUsage } from '../analytics/usage.js';
import { sharedLimit } from '../../infrastructure/rate-limits.js';
import { authenticateMember, isBotOnline, joinRoom, loadDeployment, loadRoom, safeBot } from './service.js';

export const publicRouter = Router();
const token = () => randomBytes(18).toString('base64url');
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{16,100}$/);
const messageSchema = z.object({
  senderId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  senderName: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1).max(1000),
});
const joinSchema = z.object({
  name: z.string().trim().min(1).max(40),
  memberId: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/).optional(),
  sessionToken: z.string().min(32).max(100).optional(),
});
const feedbackSchema = z.object({
  memberId: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/),
  sessionToken: z.string().min(32).max(100),
  messageId: z.string().regex(/^\d+$/),
  rating: z.enum(['up', 'down']),
  note: z.string().trim().max(500).default(''),
});
const leadSchema = z.object({
  memberId: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/),
  sessionToken: z.string().min(32).max(100),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  notes: z.string().trim().max(1000).default(''),
});

async function optionalViewer(req) {
  const authorization = req.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  try {
    const claims = await verifyToken(authorization.slice(7), { secretKey: env.CLERK_SECRET_KEY, authorizedParties: clerkAuthorizedParties });
    const organizationId = claims.org_id || claims.o?.id;
    const organizationRole = claims.org_role || claims.o?.rol;
    const isAdmin = !organizationId || organizationRole === 'org:admin' || organizationRole === 'admin';
    return { userId: claims.sub, workspaceId: organizationId ? `org:${organizationId}` : `user:${claims.sub}`, isAdmin };
  } catch { return null; }
}
function embedHost(req) {
  try { const value = req.get('X-Relay-Embed-Origin'); return value ? new URL(value).hostname.toLowerCase() : ''; } catch { return ''; }
}
function domainAllowed(bot, host) {
  const domains = String(bot.domains || '').split(/\s+/).map(value => value.toLowerCase()).filter(Boolean);
  return !!host && (!domains.length || domains.some(domain => host === domain || host.endsWith(`.${domain}`)));
}
function roomOriginAllowed(req, room) { return room.kind !== 'widget' || embedHost(req) === room.origin_host; }
async function appendWorkspaceData(workspaceId, change) {
  await client.begin(async tx => {
    const [row] = await tx`SELECT data FROM relay.workspaces WHERE id=${workspaceId} FOR UPDATE`;
    const data = row?.data || {};
    change(data);
    await tx`UPDATE relay.workspaces SET data=${JSON.stringify(data)}::jsonb, revision=revision+1, updated_at=now() WHERE id=${workspaceId}`;
  });
}

publicRouter.get('/bots/:shareId', async (req, res) => {
  const parsed = idSchema.safeParse(req.params.shareId);
  if (!parsed.success) return res.status(404).json({ error: 'Shared assistant not found' });
  const deployment = await loadDeployment(parsed.data);
  if (!deployment) return res.status(404).json({ error: 'Shared assistant not found' });
  res.json({ bot: safeBot(deployment.bot), roomToken: deployment.group_token, accessMode: deployment.access_mode });
});

publicRouter.post('/bots/:shareId/rooms', async (req, res) => {
  const parsed = idSchema.safeParse(req.params.shareId);
  if (!parsed.success) return res.status(404).json({ error: 'Shared assistant not found' });
  const deployment = await loadDeployment(parsed.data);
  if (!deployment) return res.status(404).json({ error: 'Shared assistant not found' });
  const originHost = embedHost(req);
  if (!domainAllowed(deployment.bot, originHost)) return res.status(403).json({ error: 'This website is not allowed to load the assistant.' });
  const limited = await sharedLimit('public', `room:${parsed.data}:${req.ip}`);
  if (!limited.success) return res.status(429).json({ error: 'Too many chat sessions. Try again shortly.' });
  const [room] = await client`INSERT INTO relay.chat_rooms(deployment_id,token,kind,origin_host) VALUES(${deployment.id},${token()},'widget',${originHost}) RETURNING token`;
  res.status(201).json({ roomToken: room.token });
});

publicRouter.post('/rooms/:roomToken/join', async (req, res) => {
  const parsedToken = idSchema.safeParse(req.params.roomToken);
  const input = joinSchema.safeParse(req.body);
  if (!parsedToken.success || !input.success) return res.status(400).json({ error: 'Choose a valid display name.' });
  const room = await loadRoom(parsedToken.data);
  if (!room) return res.status(404).json({ error: 'Chat room not found' });
  if (!roomOriginAllowed(req, room)) return res.status(403).json({ error: 'This website is not allowed to use the chat room.' });
  const limited = await sharedLimit('public', `join:${room.id}:${req.ip}`);
  if (!limited.success) return res.status(429).json({ error: 'Too many join attempts. Try again shortly.' });
  const viewer = room.kind === 'group' ? await optionalViewer(req) : null;
  const membership = await joinRoom(room, {
    name: room.kind === 'widget' ? 'Visitor' : input.data.name,
    existingId: input.data.memberId,
    existingToken: input.data.sessionToken,
    ownerWorkspaceId: viewer?.isAdmin ? viewer.workspaceId : null,
    accountUserId: viewer?.userId || null,
  });
  res.status(201).json(membership);
});

publicRouter.get('/rooms/:roomToken/messages', async (req, res) => {
  const parsed = idSchema.safeParse(req.params.roomToken);
  const room = parsed.success ? await loadRoom(req.params.roomToken) : null;
  if (!room) return res.status(404).json({ error: 'Chat room not found' });
  if (!roomOriginAllowed(req, room)) return res.status(403).json({ error: 'This website is not allowed to use the chat room.' });
  const after = /^\d+$/.test(String(req.query.after || '')) ? String(req.query.after) : '0';
  const messages = await client`SELECT id::text,sender_id,sender_name,role,content,citations,created_at FROM relay.chat_messages WHERE room_id=(SELECT id FROM relay.chat_rooms WHERE token=${parsed.data}) AND id>${after} ORDER BY id LIMIT 200`;
  res.json({ messages });
});

publicRouter.post('/rooms/:roomToken/feedback', async (req, res) => {
  const parsedToken = idSchema.safeParse(req.params.roomToken);
  const input = feedbackSchema.safeParse(req.body);
  if (!parsedToken.success || !input.success) return res.status(400).json({ error: 'Invalid feedback' });
  const auth = await authenticateMember(parsedToken.data, input.data.memberId, input.data.sessionToken);
  if (!auth || !roomOriginAllowed(req, auth.room)) return res.status(403).json({ error: 'Feedback could not be saved.' });
  const [message] = await client`SELECT id,sender_id,content FROM relay.chat_messages WHERE room_id=${auth.room.id} AND id=${input.data.messageId} AND role='assistant'`;
  if (!message) return res.status(404).json({ error: 'Assistant answer not found.' });
  await appendWorkspaceData(auth.room.workspace_id, data => {
    data.feedback = Array.isArray(data.feedback) ? data.feedback : [];
    data.activity = Array.isArray(data.activity) ? data.activity : [];
    const existing = data.feedback.find(item => item.messageId === String(message.id) && item.conversationId === auth.room.token);
    const item = existing || { id: randomBytes(12).toString('base64url'), botId: auth.room.bot.id, conversationId: auth.room.token, messageId: String(message.id), rating: input.data.rating, note: '', createdAt: new Date().toISOString(), resolved: false };
    item.rating = input.data.rating;
    item.note = input.data.note || (input.data.rating === 'down' ? 'Visitor marked this answer for review' : 'Visitor marked this answer helpful');
    item.resolved = false;
    if (!existing) data.feedback.unshift(item);
    data.activity.unshift({ id: randomBytes(12).toString('base64url'), botId: auth.room.bot.id, type: 'feedback', title: input.data.rating === 'down' ? 'Bad answer reported' : 'Helpful answer reported', detail: message.content.slice(0, 160), createdAt: new Date().toISOString() });
  });
  res.json({ saved: true });
});

publicRouter.post('/rooms/:roomToken/leads', async (req, res) => {
  const parsedToken = idSchema.safeParse(req.params.roomToken);
  const input = leadSchema.safeParse(req.body);
  if (!parsedToken.success || !input.success) return res.status(400).json({ error: 'Enter a valid name and email.' });
  const auth = await authenticateMember(parsedToken.data, input.data.memberId, input.data.sessionToken, { allowPending: true });
  if (!auth || !roomOriginAllowed(req, auth.room)) return res.status(403).json({ error: 'Lead could not be saved.' });
  await appendWorkspaceData(auth.room.workspace_id, data => {
    data.leads = Array.isArray(data.leads) ? data.leads : [];
    data.activity = Array.isArray(data.activity) ? data.activity : [];
    if (!data.leads.some(item => item.botId === auth.room.bot.id && String(item.email).toLowerCase() === input.data.email.toLowerCase())) {
      data.leads.unshift({ id: randomBytes(12).toString('base64url'), botId: auth.room.bot.id, name: input.data.name, email: input.data.email, source: auth.room.kind === 'widget' ? 'Website widget' : 'Shared room', status: 'New', createdAt: new Date().toISOString(), notes: input.data.notes });
      data.activity.unshift({ id: randomBytes(12).toString('base64url'), botId: auth.room.bot.id, type: 'lead', title: 'Lead captured', detail: `${input.data.name} · ${input.data.email}`, createdAt: new Date().toISOString() });
    }
  });
  res.status(201).json({ saved: true });
});

publicRouter.post('/rooms/:roomToken/messages', async (req, res) => {
  const roomToken = idSchema.safeParse(req.params.roomToken);
  const input = messageSchema.safeParse(req.body);
  if (!roomToken.success || !input.success) return res.status(400).json({ error: 'Invalid chat message' });
  const room = await loadRoom(roomToken.data);
  if (!room) return res.status(404).json({ error: 'Chat room not found' });
  if (!roomOriginAllowed(req, room)) return res.status(403).json({ error: 'This website is not allowed to use the chat room.' });
  const limited = await sharedLimit('public', `message:${room.id}:${input.data.senderId}`);
  if (!limited.success) return res.status(429).json({ error: 'Message limit reached. Try again shortly.' });
  const [message] = await client`INSERT INTO relay.chat_messages(room_id,sender_id,sender_name,role,content) VALUES(${room.id},${input.data.senderId},${input.data.senderName},'member',${input.data.text}) RETURNING id::text,sender_id,sender_name,role,content,citations,created_at`;
  const mentioned = /@relay\b/i.test(input.data.text);
  if (room.kind === 'group' && !mentioned) return res.status(201).json({ message });
  const prompt = room.kind === 'group' ? input.data.text.replace(/@relay\b/ig, '').trim() : input.data.text;
  if (!prompt) return res.status(201).json({ message });
  if (room.kind === 'widget' && room.bot.offlineCapture && !isBotOnline(room.bot)) {
    await appendWorkspaceData(room.workspace_id, data => {
      data.activity = Array.isArray(data.activity) ? data.activity : [];
      data.activity.unshift({ id: randomBytes(12).toString('base64url'), botId: room.bot.id, type: 'offline-message', title: 'Offline message collected', detail: input.data.text.slice(0, 160), createdAt: new Date().toISOString() });
    });
    return res.status(201).json({ message, offline: true });
  }
  const previous = await client`SELECT role,content FROM relay.chat_messages WHERE room_id=${room.id} AND id<${message.id} ORDER BY id DESC LIMIT 12`;
  const history = previous.reverse().map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content.slice(0,8000) }));
  const [sender] = await client`SELECT account_user_id FROM relay.chat_members WHERE room_id=${room.id} AND member_id=${input.data.senderId}`;
  await recordUsage({ workspaceId: room.workspace_id, userId: sender?.account_user_id || null, metric: 'ai_calls', metadata: { channel: 'shared_chat_http', botId: room.bot.id } });
  const result = await groundedChat({ workspaceId: room.workspace_id, bot: room.bot, message: prompt, history });
  const [assistant] = await client`INSERT INTO relay.chat_messages(room_id,sender_id,sender_name,role,content,citations) VALUES(${room.id},'relay',${room.bot.name},'assistant',${result.text},${JSON.stringify(result.citations)}::jsonb) RETURNING id::text,sender_id,sender_name,role,content,citations,created_at`;
  res.status(201).json({ message, assistant });
});

publicRouter.post('/rooms/:roomToken/messages/stream', async (req, res) => {
  const roomToken = idSchema.safeParse(req.params.roomToken);
  const input = messageSchema.safeParse(req.body);
  if (!roomToken.success || !input.success) return res.status(400).json({ error: 'Invalid chat message' });
  const room = await loadRoom(roomToken.data);
  if (!room) return res.status(404).json({ error: 'Chat room not found' });
  if (!roomOriginAllowed(req, room)) return res.status(403).json({ error: 'This website is not allowed to use the chat room.' });
  const limited = await sharedLimit('public', `message:${room.id}:${input.data.senderId}`);
  if (!limited.success) return res.status(429).json({ error: 'Message limit reached. Try again shortly.' });

  const [message] = await client`INSERT INTO relay.chat_messages(room_id,sender_id,sender_name,role,content) VALUES(${room.id},${input.data.senderId},${input.data.senderName},'member',${input.data.text}) RETURNING id::text,sender_id,sender_name,role,content,citations,created_at`;
  res.status(200).set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`${JSON.stringify({ type: 'message', message })}\n`);

  const mentioned = /@relay\b/i.test(input.data.text);
  const prompt = room.kind === 'group' ? input.data.text.replace(/@relay\b/ig, '').trim() : input.data.text;
  if ((room.kind === 'group' && !mentioned) || !prompt) {
    res.write(`${JSON.stringify({ type: 'done' })}\n`);
    return res.end();
  }
  if (room.kind === 'widget' && room.bot.offlineCapture && !isBotOnline(room.bot)) {
    await appendWorkspaceData(room.workspace_id, data => {
      data.activity = Array.isArray(data.activity) ? data.activity : [];
      data.activity.unshift({ id: randomBytes(12).toString('base64url'), botId: room.bot.id, type: 'offline-message', title: 'Offline message collected', detail: input.data.text.slice(0, 160), createdAt: new Date().toISOString() });
    });
    res.write(`${JSON.stringify({ type: 'done', offline: true })}\n`);
    return res.end();
  }

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const [sender] = await client`SELECT account_user_id FROM relay.chat_members WHERE room_id=${room.id} AND member_id=${input.data.senderId}`;
    await recordUsage({ workspaceId: room.workspace_id, userId: sender?.account_user_id || null, metric: 'ai_calls', metadata: { channel: 'shared_chat_stream', botId: room.bot.id } });
    const previous = await client`SELECT role,content FROM relay.chat_messages WHERE room_id=${room.id} AND id<${message.id} ORDER BY id DESC LIMIT 12`;
    const history = previous.reverse().map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content.slice(0,8000) }));
    let text = '';
    let citations = [];
    for await (const event of groundedChatStream({ workspaceId: room.workspace_id, bot: room.bot, message: prompt, history }, controller.signal)) {
      if (event.type === 'delta') text += event.text;
      if (event.type === 'done') citations = event.citations;
      res.write(`${JSON.stringify(event)}\n`);
    }
    const [assistant] = await client`INSERT INTO relay.chat_messages(room_id,sender_id,sender_name,role,content,citations) VALUES(${room.id},'relay',${room.bot.name},'assistant',${text},${JSON.stringify(citations)}::jsonb) RETURNING id::text,sender_id,sender_name,role,content,citations,created_at`;
    res.write(`${JSON.stringify({ type: 'saved', message: assistant })}\n`);
    return res.end();
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = error.message?.startsWith('Ollama') || /^(ollama|openai|groq|cloudflare|Set OPENAI|Set GROQ|Set CLOUDFLARE|The model)/.test(error.message || '')
      ? error.message
      : 'The assistant could not answer. Please retry.';
    res.write(`${JSON.stringify({ type: 'error', error: message })}\n`);
    return res.end();
  }
});

export function embedScript(_req, res) {
  res.type('application/javascript').set({ 'Cache-Control': 'public, max-age=300', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*' }).send(`(()=>{const s=document.currentScript,id=s&&s.dataset.chatbot;if(!id)return;const app=${JSON.stringify(appUrl)},api=new URL(s.src).origin,embedOrigin=s.dataset.origin||location.origin,side=s.dataset.position==='left'?'left':'right',host=document.createElement('div'),root=host.attachShadow({mode:'open'});let opened=false;const open=()=>{if(opened)return;opened=true;host.classList.add('o');const b=root.querySelector('.b');if(b){b.textContent='×';b.setAttribute('aria-label','Close chat')}};const close=()=>{opened=false;host.classList.remove('o');const b=root.querySelector('.b');if(b){b.textContent='✦';b.setAttribute('aria-label','Open chat')}};host.setAttribute('data-relay-widget',id);root.innerHTML='<style>:host{position:fixed;z-index:2147483000;bottom:20px;'+side+':20px;font-family:Arial,sans-serif}.b{width:58px;height:58px;border:0;border-radius:18px;background:#1554db;color:white;box-shadow:0 12px 35px #10264d42;font-size:25px;cursor:pointer}.f{display:none;width:min(390px,calc(100vw - 24px));height:min(650px,calc(100vh - 100px));border:0;border-radius:20px;box-shadow:0 18px 60px #10264d38;background:white;margin-bottom:12px}:host(.o) .f{display:block}:host(.o) .b{float:'+side+'}@media(max-width:520px){:host{bottom:10px;'+side+':10px}.f{width:calc(100vw - 20px);height:calc(100vh - 86px)}}</style><iframe class="f" title="Relay chat"></iframe><button class="b" type="button" aria-label="Open chat">✦</button>';const f=root.querySelector('.f'),b=root.querySelector('.b');f.src=app+'/embed/'+encodeURIComponent(id)+'?origin='+encodeURIComponent(embedOrigin);b.onclick=()=>opened?close():open();document.body.appendChild(host);fetch(api+'/public/bots/'+encodeURIComponent(id)).then(r=>r.ok?r.json():null).then(cfg=>{const bot=cfg&&cfg.bot;if(!bot)return;if(/^#[0-9a-f]{6}$/i.test(bot.accent))b.style.background=bot.accent;const rule=bot.openingRule||'Manual';if(/5 seconds/i.test(rule))setTimeout(open,5000);if(/50% scroll/i.test(rule))addEventListener('scroll',()=>{if(scrollY/(document.documentElement.scrollHeight-innerHeight||1)>.5)open()},{once:true,passive:true});if(/exit intent/i.test(rule))addEventListener('mouseout',e=>{if(e.clientY<=0)open()},{once:true})}).catch(()=>{})})();`);
}

