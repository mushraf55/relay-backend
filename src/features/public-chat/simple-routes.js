import { Router } from 'express';
import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { verifyToken } from '@clerk/backend';
import { appUrl } from '../../config/env.js';
import { clerkAuthorizedParties, env } from '../../config/env.js';
import { client } from '../../infrastructure/database.js';
import { groundedChat, streamGroundedChat } from '../ai/chat-service.js';

export const publicRouter = Router();
const validShareId = value => /^[A-Za-z0-9_-]{16,100}$/.test(value || '');

async function deployment(shareId) {
  const [row] = await client`
    SELECT d.id,d.workspace_id,d.bot_id,d.access_mode,w.data
    FROM relay.deployments d
    JOIN relay.workspaces w ON w.id=d.workspace_id
    WHERE d.share_id=${shareId} AND d.enabled=true
  `;
  if (!row) return null;
  const bot = row.data?.bots?.find(item => item.id === row.bot_id);
  const sources = (row.data?.sources || []).filter(source => source.botId === row.bot_id).map(source => ({ id: source.id, title: source.title, type: source.type, status: source.status }));
  return bot ? { workspaceId: row.workspace_id, bot, sources, deploymentId: row.id, accessMode: row.access_mode } : null;
}

publicRouter.get('/bots/:shareId', async (req, res) => {
  if (!validShareId(req.params.shareId)) return res.status(404).json({ error: 'Chatbot not found' });
  const found = await deployment(req.params.shareId);
  if (!found) return res.status(404).json({ error: 'Chatbot not found' });
  const { name, description, welcome, suggestions, accent, avatar, kind = 'website', visibility = 'public' } = found.bot;
  res.set('Cache-Control', 'no-store').json({ bot: { name, description, welcome, suggestions, accent, avatar, kind, visibility } });
});

const hashToken = value => createHash('sha256').update(value).digest('hex');
async function sharedRoom(found) {
  const [room] = await client`SELECT id FROM relay.chat_rooms WHERE deployment_id=${found.deploymentId} AND kind='group'`;
  return room;
}
async function memberFromRequest(roomId, req) {
  const session = req.get('X-Chat-Session');
  if (!session) return null;
  const [member] = await client`SELECT member_id,display_name FROM relay.chat_members WHERE room_id=${roomId} AND session_token_hash=${hashToken(session)} AND status='active'`;
  return member || null;
}

const chatInput = z.object({
  message: z.string().trim().min(1).max(1000),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).max(8).default([]),
});
publicRouter.post('/bots/:shareId/chat', async (req, res) => {
  if (!validShareId(req.params.shareId)) return res.status(404).json({ error: 'Chatbot not found' });
  const input = chatInput.safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Invalid chat request' });
  const found = await deployment(req.params.shareId);
  if (!found) return res.status(404).json({ error: 'Chatbot not found' });
  try { res.json(await groundedChat({ workspaceId: found.workspaceId, bot: found.bot, ...input.data })); }
  catch { res.status(503).json({ error: 'The chatbot could not answer right now. Please try again.' }); }
});

publicRouter.post('/bots/:shareId/chat/stream', async (req, res) => {
  if (!validShareId(req.params.shareId)) return res.status(404).json({ error: 'Chatbot not found' });
  const input = chatInput.safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Invalid chat request' });
  const found = await deployment(req.params.shareId);
  if (!found) return res.status(404).json({ error: 'Chatbot not found' });
  try {
    res.status(200).type('application/x-ndjson').set({ 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    for await (const event of streamGroundedChat({ workspaceId: found.workspaceId, bot: found.bot, ...input.data })) res.write(`${JSON.stringify(event)}\n`);
    res.end();
  } catch {
    if (res.headersSent) { res.write(`${JSON.stringify({ type: 'error', error: 'The chatbot could not finish the response.' })}\n`); return res.end(); }
    res.status(503).json({ error: 'The chatbot could not answer right now. Please try again.' });
  }
});

publicRouter.post('/bots/:shareId/join', async (req, res) => {
  if (!validShareId(req.params.shareId)) return res.status(404).json({ error: 'Chatbot not found' });
  const parsed = z.object({ displayName: z.string().trim().min(2).max(60), inviteToken: z.string().max(200).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter your name to join.' });
  const found = await deployment(req.params.shareId);
  if (!found || found.bot.kind !== 'shared') return res.status(404).json({ error: 'Shared chatbot not found' });
  const room = await sharedRoom(found);
  if (!room) return res.status(503).json({ error: 'The shared room is not ready.' });
  let accountUserId = null;
  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (bearer) {
    try { accountUserId = (await verifyToken(bearer, { secretKey: env.CLERK_SECRET_KEY, authorizedParties: clerkAuthorizedParties })).sub; } catch { /* Guests may join without a Clerk session. */ }
  }
  const [existing] = accountUserId ? await client`SELECT member_id FROM relay.chat_members WHERE room_id=${room.id} AND account_user_id=${accountUserId} AND status IN ('active','pending')` : [];
  if (found.accessMode === 'approval' && !existing) {
    const inviteHash = parsed.data.inviteToken ? hashToken(parsed.data.inviteToken) : '';
    const [invite] = await client`SELECT id FROM relay.chat_invitations WHERE deployment_id=${found.deploymentId} AND token_hash=${inviteHash} AND accepted_at IS NULL AND expires_at>now()`;
    if (!invite) return res.status(403).json({ error: 'A valid invitation is required for this private chat.' });
    await client`UPDATE relay.chat_invitations SET accepted_at=now() WHERE id=${invite.id}`;
  }
  const sessionToken = randomBytes(24).toString('base64url');
  const memberId = existing?.member_id || randomUUID();
  if (existing) await client`UPDATE relay.chat_members SET display_name=${parsed.data.displayName},status='active',session_token_hash=${hashToken(sessionToken)},approved_at=now(),last_seen_at=now() WHERE room_id=${room.id} AND member_id=${memberId}`;
  else await client`INSERT INTO relay.chat_members(room_id,member_id,display_name,role,status,session_token_hash,approved_at,account_user_id) VALUES(${room.id},${memberId},${parsed.data.displayName},'member','active',${hashToken(sessionToken)},now(),${accountUserId})`;
  res.json({ sessionToken, member: { id: memberId, name: parsed.data.displayName } });
});

publicRouter.get('/bots/:shareId/messages', async (req, res) => {
  const found = await deployment(req.params.shareId);
  if (!found || found.bot.kind !== 'shared') return res.status(404).json({ error: 'Shared chatbot not found' });
  const room = await sharedRoom(found);
  const member = room && await memberFromRequest(room.id, req);
  if (!member) return res.status(401).json({ error: 'Join the chat first.' });
  const after = Math.max(0, Number(req.query.after) || 0);
  const messages = await client`SELECT id,sender_id,sender_name,role,content,citations,created_at FROM relay.chat_messages WHERE room_id=${room.id} AND id>${after} ORDER BY id ASC LIMIT 100`;
  res.set('Cache-Control', 'no-store').json({ messages, selfId: member.member_id, sources: found.sources });
});

publicRouter.post('/bots/:shareId/claim', async (req, res) => {
  const found = await deployment(req.params.shareId);
  if (!found || found.bot.kind !== 'shared') return res.status(404).json({ error: 'Shared chatbot not found' });
  const room = await sharedRoom(found);
  const member = room && await memberFromRequest(room.id, req);
  if (!member) return res.status(401).json({ error: 'Join the chat first.' });
  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return res.status(401).json({ error: 'Sign in to add this room to your account.' });
  let accountUserId;
  try { accountUserId = (await verifyToken(bearer, { secretKey: env.CLERK_SECRET_KEY, authorizedParties: clerkAuthorizedParties })).sub; }
  catch { return res.status(401).json({ error: 'Sign in again to add this room.' }); }
  const sessionHash = hashToken(req.get('X-Chat-Session'));
  const [accountMember] = await client`SELECT member_id FROM relay.chat_members WHERE room_id=${room.id} AND account_user_id=${accountUserId} AND status IN ('active','pending')`;
  if (accountMember && accountMember.member_id !== member.member_id) {
    await client.begin(async tx => {
      await tx`UPDATE relay.chat_members SET status='removed',last_seen_at=now() WHERE room_id=${room.id} AND member_id=${member.member_id}`;
      await tx`UPDATE relay.chat_members SET status='active',display_name=${member.display_name},session_token_hash=${sessionHash},approved_at=COALESCE(approved_at,now()),last_seen_at=now() WHERE room_id=${room.id} AND member_id=${accountMember.member_id}`;
    });
  } else await client`UPDATE relay.chat_members SET account_user_id=${accountUserId},last_seen_at=now() WHERE room_id=${room.id} AND member_id=${member.member_id}`;
  res.json({ claimed: true });
});

publicRouter.post('/bots/:shareId/messages/stream', async (req, res) => {
  const input = chatInput.safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Invalid chat request' });
  const found = await deployment(req.params.shareId);
  if (!found || found.bot.kind !== 'shared') return res.status(404).json({ error: 'Shared chatbot not found' });
  const room = await sharedRoom(found);
  const member = room && await memberFromRequest(room.id, req);
  if (!member) return res.status(401).json({ error: 'Join the chat first.' });
  await client`INSERT INTO relay.chat_messages(room_id,sender_id,sender_name,role,content) VALUES(${room.id},${member.member_id},${member.display_name},'member',${input.data.message})`;
  const relayMentioned = /(^|\s)@relay\b/i.test(input.data.message);
  if (!relayMentioned) {
    res.status(200).type('application/x-ndjson').set({ 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    return res.end(`${JSON.stringify({ type: 'done', citations: [], humanOnly: true })}\n`);
  }
  const relayMessage = input.data.message.replace(/(^|\s)@relay\b[:,]?\s*/i, ' ').trim();
  if (!relayMessage) return res.status(400).json({ error: 'Add a question after @relay.' });
  try {
    res.status(200).type('application/x-ndjson').set({ 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    let text = ''; let citations = [];
    for await (const event of streamGroundedChat({ workspaceId: found.workspaceId, bot: found.bot, ...input.data, message: relayMessage })) {
      if (event.type === 'delta') text += event.delta;
      if (event.type === 'done') citations = event.citations || [];
      res.write(`${JSON.stringify(event)}\n`);
    }
    await client`INSERT INTO relay.chat_messages(room_id,sender_id,sender_name,role,content,citations) VALUES(${room.id},'assistant',${found.bot.name},'assistant',${text},${JSON.stringify(citations)}::jsonb)`;
    res.end();
  } catch { if (res.headersSent) { res.write(`${JSON.stringify({ type: 'error', error: 'The chatbot could not finish the response.' })}\n`); res.end(); } else res.status(503).json({ error: 'The chatbot could not answer right now.' }); }
});

export function embedScript(_req, res) {
  res.type('application/javascript').set({ 'Cache-Control': 'public, max-age=300', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*' }).send(`(()=>{const s=document.currentScript,id=s&&s.dataset.chatbot;if(!id)return;const host=document.createElement('div'),root=host.attachShadow({mode:'open'}),side=s.dataset.position==='left'?'left':'right';host.style.cssText='position:fixed;z-index:2147483000;bottom:20px;'+side+':20px';root.innerHTML='<style>.frame{display:none;width:min(390px,calc(100vw - 24px));height:min(650px,calc(100vh - 100px));border:0;border-radius:18px;box-shadow:0 18px 60px #10264d38;background:#fff;margin-bottom:12px}.open .frame{display:block}.button{display:block;margin-left:auto;width:58px;height:58px;border:0;border-radius:18px;background:#1554db;color:#fff;font-size:24px;cursor:pointer}</style><div><iframe class="frame" title="Chatbot"></iframe><button class="button" aria-label="Open chatbot">✦</button></div>';const wrap=root.querySelector('div'),frame=root.querySelector('.frame'),button=root.querySelector('.button');frame.src=${JSON.stringify(appUrl)}+'/embed/'+encodeURIComponent(id)+'?origin='+encodeURIComponent(location.origin);button.onclick=()=>{wrap.classList.toggle('open');button.textContent=wrap.classList.contains('open')?'×':'✦'};document.body.appendChild(host)})();`);
}
