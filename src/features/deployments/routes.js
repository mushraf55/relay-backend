import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { client } from '../../infrastructure/database.js';
import { appUrl, env } from '../../config/env.js';

export const deployRouter = Router();
const token = () => randomBytes(18).toString('base64url');
const validId = value => /^[A-Za-z0-9_-]{1,100}$/.test(value || '');

async function findBot(workspaceId, botId) {
  const [workspace] = await client`SELECT data FROM relay.workspaces WHERE id=${workspaceId}`;
  return workspace?.data?.bots?.find(bot => bot.id === botId);
}

deployRouter.get('/:botId', async (req, res) => {
  if (!validId(req.params.botId)) return res.status(400).json({ error: 'Invalid chatbot' });
  const [deployment] = await client`SELECT share_id,enabled,access_mode FROM relay.deployments WHERE workspace_id=${req.workspaceId} AND bot_id=${req.params.botId}`;
  res.json(deployment ? { published: deployment.enabled, shareId: deployment.share_id, visibility: deployment.access_mode === 'approval' ? 'private' : 'public' } : { published: false });
});

deployRouter.post('/:botId/publish', async (req, res) => {
  const botId = req.params.botId;
  if (!validId(botId) || !await findBot(req.workspaceId, botId)) return res.status(404).json({ error: 'Chatbot not found' });
  const deployment = await client.begin(async tx => {
    let [row] = await tx`SELECT id,share_id FROM relay.deployments WHERE workspace_id=${req.workspaceId} AND bot_id=${botId} FOR UPDATE`;
    const bot = await findBot(req.workspaceId, botId);
    const accessMode = bot?.visibility === 'private' ? 'approval' : 'open';
    if (!row) [row] = await tx`INSERT INTO relay.deployments(workspace_id,bot_id,share_id,access_mode) VALUES(${req.workspaceId},${botId},${token()},${accessMode}) RETURNING id,share_id`;
    else await tx`UPDATE relay.deployments SET enabled=true,access_mode=${accessMode},updated_at=now() WHERE id=${row.id}`;
    if (bot?.kind === 'shared') await tx`INSERT INTO relay.chat_rooms(deployment_id,token,kind) VALUES(${row.id},${token()},'group') ON CONFLICT DO NOTHING`;
    return row;
  });
  res.json({ published: true, shareId: deployment.share_id });
});

deployRouter.post('/:botId/invitations', async (req, res) => {
  const parsed = z.object({ email: z.string().email().max(254) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email address.' });
  const [deployment] = await client`SELECT id,share_id,access_mode FROM relay.deployments WHERE workspace_id=${req.workspaceId} AND bot_id=${req.params.botId} AND enabled=true`;
  if (!deployment || deployment.access_mode !== 'approval') return res.status(400).json({ error: 'Publish this chatbot as private before inviting members.' });
  const rawToken = token();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  await client`INSERT INTO relay.chat_invitations(deployment_id,email,token_hash) VALUES(${deployment.id},${parsed.data.email.toLowerCase()},${tokenHash})`;
  const inviteUrl = `${appUrl}/share/${deployment.share_id}?invite=${rawToken}`;
  let emailed = false;
  if (env.RESEND_API_KEY && env.INVITE_FROM_EMAIL) {
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.INVITE_FROM_EMAIL, to: parsed.data.email, subject: 'You are invited to a private Relay chat', html: `<p>You have been invited to a private chatbot room.</p><p><a href="${inviteUrl}">Join the chat</a></p>` }) });
    emailed = response.ok;
  }
  res.json({ inviteUrl, emailed });
});

deployRouter.delete('/:botId', async (req, res) => {
  if (!validId(req.params.botId)) return res.status(400).json({ error: 'Invalid chatbot' });
  await client`UPDATE relay.deployments SET enabled=false,updated_at=now() WHERE workspace_id=${req.workspaceId} AND bot_id=${req.params.botId}`;
  res.json({ published: false });
});
