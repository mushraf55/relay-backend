import { randomUUID } from 'node:crypto';
import { app } from '../src/http/app.js';
import { client } from '../src/infrastructure/database.js';

const workspaceId = `test:${randomUUID()}`; const botId = 'public-test-bot';
const shareId = randomUUID().replaceAll('-', ''); const roomToken = randomUUID().replaceAll('-', '');
const bot = { id: botId, name: 'Store Guide', description: 'A shopping assistant for products and policies', welcome: 'Welcome to the store room.', suggestions: '', accent: '#1554db', avatar: 'SG', position: 'Bottom right', domains: 'example.com', tone: 'Friendly', instructions: 'Be helpful.', fallback: 'I do not have that answer.' };
const data = { bots: [bot], sources: [] };
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const json = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json(); if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body.error}`); return body;
};
try {
  await client`INSERT INTO relay.workspaces(id,data) VALUES(${workspaceId},${JSON.stringify(data)}::jsonb)`;
  const [deployment] = await client`INSERT INTO relay.deployments(workspace_id,bot_id,share_id) VALUES(${workspaceId},${botId},${shareId}) RETURNING id`;
  await client`INSERT INTO relay.chat_rooms(deployment_id,token,kind) VALUES(${deployment.id},${roomToken},'group')`;
  const published = await json(`/public/bots/${shareId}`); if (published.roomToken !== roomToken) throw new Error('Shared room was not returned.');
  await json(`/public/rooms/${roomToken}/messages`, { method: 'POST', body: JSON.stringify({ senderId: 'member_alex', senderName: 'Alex', text: 'Hello team' }) });
  const invoked = await json(`/public/rooms/${roomToken}/messages`, { method: 'POST', body: JSON.stringify({ senderId: 'member_jamie', senderName: 'Jamie', text: '@relay what is this chatbot about?' }) });
  if (!invoked.assistant?.content.includes('shopping assistant')) throw new Error('@relay did not answer from the bot profile.');
  const transcript = await json(`/public/rooms/${roomToken}/messages`); if (transcript.messages.length !== 3) throw new Error('Shared messages were not persisted.');
  const rejected = await fetch(`${base}/public/bots/${shareId}/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Embed-Origin': 'https://not-allowed.example' }, body: '{}' });
  if (rejected.status !== 403) throw new Error('Widget domain enforcement did not reject an unlisted domain.');
  const widget = await json(`/public/bots/${shareId}/rooms`, { method: 'POST', headers: { 'X-Relay-Embed-Origin': 'https://shop.example.com' }, body: '{}' });
  await json(`/public/rooms/${widget.roomToken}/messages`, { method: 'POST', headers: { 'X-Relay-Embed-Origin': 'https://shop.example.com' }, body: JSON.stringify({ senderId: 'visitor_12345678', senderName: 'Visitor', text: 'What is this chatbot about?' }) });
  console.log('Share room persistence, @relay invocation, widget rooms and domain checks: PASS');
} finally {
  await client`DELETE FROM relay.workspaces WHERE id=${workspaceId}`;
  await new Promise(resolve => server.close(resolve)); await client.end({ timeout: 2 });
  console.log('Temporary public-chat workspace removed.');
}
