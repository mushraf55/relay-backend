import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { Router } from 'express';
import { z } from 'zod';
import { client } from '../../infrastructure/database.js';
import { canEditWorkspace } from '../workspaces/permissions.js';

export const deployRouter = Router();
const token = () => randomBytes(18).toString('base64url');
const validId = value => /^[A-Za-z0-9_-]{1,100}$/.test(value || '');
const publishInput = z.object({ accessMode: z.enum(['open','approval']).default('open') });
const verifyInput = z.object({ domain: z.string().trim().min(1).max(255) });

async function findBot(workspaceId, botId) {
  const [workspace] = await client`SELECT data FROM relay.workspaces WHERE id=${workspaceId}`;
  return workspace?.data?.bots?.find(bot => bot.id === botId);
}

function verificationToken(workspaceId, botId, domain) {
  return `relay-site-verification=${Buffer.from(`${workspaceId}:${botId}:${domain}`).toString('base64url').slice(0, 32)}`;
}

async function saveVerifiedDomain(workspaceId, botId, domain) {
  await client.begin(async tx => {
    const [row] = await tx`SELECT data FROM relay.workspaces WHERE id=${workspaceId} FOR UPDATE`;
    const data = row?.data || {};
    const bot = data.bots?.find(item => item.id === botId);
    if (!bot) throw new Error('Chatbot not found');
    const verified = new Set(String(bot.verifiedDomains || '').split(/\s+/).filter(Boolean));
    verified.add(domain);
    bot.verifiedDomains = [...verified].join('\n');
    data.activity = Array.isArray(data.activity) ? data.activity : [];
    data.activity.unshift({ id: randomBytes(12).toString('base64url'), botId, type: 'deploy', title: 'Domain verified', detail: domain, createdAt: new Date().toISOString() });
    await tx`UPDATE relay.workspaces SET data=${JSON.stringify(data)}::jsonb, revision=revision+1, updated_at=now() WHERE id=${workspaceId}`;
  });
}

deployRouter.get('/:botId', async (req, res) => {
  if (!validId(req.params.botId)) return res.status(400).json({ error: 'Invalid chatbot' });
  const [deployment] = await client`SELECT share_id,enabled,access_mode FROM relay.deployments WHERE workspace_id=${req.workspaceId} AND bot_id=${req.params.botId}`;
  res.json(deployment ? { published: deployment.enabled, shareId: deployment.share_id, accessMode: deployment.access_mode } : { published: false, accessMode: 'open' });
});

deployRouter.post('/:botId/publish', async (req, res) => {
  if (!await canEditWorkspace(req)) return res.status(403).json({ error: 'Workspace editor access required' });
  const input = publishInput.safeParse(req.body || {});
  if (!input.success) return res.status(400).json({ error: 'Choose a valid room access mode' });
  const botId = req.params.botId;
  if (!validId(botId) || !await findBot(req.workspaceId, botId)) return res.status(404).json({ error: 'Chatbot not found' });
  const deployment = await client.begin(async tx => {
    let [row] = await tx`SELECT id,share_id FROM relay.deployments WHERE workspace_id=${req.workspaceId} AND bot_id=${botId} FOR UPDATE`;
    if (!row) [row] = await tx`INSERT INTO relay.deployments(workspace_id,bot_id,share_id,access_mode) VALUES(${req.workspaceId},${botId},${token()},${input.data.accessMode}) RETURNING id,share_id`;
    else await tx`UPDATE relay.deployments SET enabled=true,access_mode=${input.data.accessMode},updated_at=now() WHERE id=${row.id}`;
    await tx`INSERT INTO relay.chat_rooms(deployment_id,token,kind) VALUES(${row.id},${token()},'group') ON CONFLICT DO NOTHING`;
    return row;
  });
  res.json({ published: true, shareId: deployment.share_id, accessMode: input.data.accessMode });
});

deployRouter.post('/:botId/verify-domain', async (req, res) => {
  if (!await canEditWorkspace(req)) return res.status(403).json({ error: 'Workspace editor access required' });
  const botId = req.params.botId;
  const input = verifyInput.safeParse(req.body);
  if (!validId(botId) || !input.success) return res.status(400).json({ error: 'Invalid domain' });
  const domain = input.data.domain.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  const bot = await findBot(req.workspaceId, botId);
  if (!bot) return res.status(404).json({ error: 'Chatbot not found' });
  const tokenValue = verificationToken(req.workspaceId, botId, domain);
  if (/^(localhost|example\.com|.+\.example\.com)$/.test(domain)) {
    await saveVerifiedDomain(req.workspaceId, botId, domain);
    return res.json({ verified: true, domain, token: tokenValue, mode: 'development' });
  }
  try {
    const records = await resolveTxt(`_relay.${domain}`);
    const values = records.flat().map(value => value.trim());
    if (!values.includes(tokenValue)) return res.status(409).json({ verified: false, domain, token: tokenValue, host: `_relay.${domain}`, error: 'Add the TXT record and try again.' });
    await saveVerifiedDomain(req.workspaceId, botId, domain);
    res.json({ verified: true, domain, token: tokenValue });
  } catch {
    res.status(409).json({ verified: false, domain, token: tokenValue, host: `_relay.${domain}`, error: 'TXT record was not found yet.' });
  }
});

deployRouter.delete('/:botId', async (req, res) => {
  if (!await canEditWorkspace(req)) return res.status(403).json({ error: 'Workspace editor access required' });
  if (!validId(req.params.botId)) return res.status(400).json({ error: 'Invalid chatbot' });
  await client`UPDATE relay.deployments SET enabled=false,updated_at=now() WHERE workspace_id=${req.workspaceId} AND bot_id=${req.params.botId}`;
  res.json({ published: false });
});
