import { client } from '../src/infrastructure/database.js';
const workspaceId = 'test:browser-preview'; const botId = 'preview-bot'; const shareId = 'relaypreviewroom20260908'; const roomToken = 'relaypreviewchat20260908';
if (process.argv.includes('--clean')) {
  await client`DELETE FROM relay.workspaces WHERE id=${workspaceId}`; console.log('Browser preview removed.');
} else {
  const bot = { id: botId, name: 'Brightside Guide', description: 'A product guide for the Relay workspace', welcome: 'Hi! Bring me into the conversation with @relay.', suggestions: 'What is this chatbot about?', accent: '#1458d6', avatar: 'BG', position: 'Bottom right', domains: '127.0.0.1 localhost', tone: 'Friendly', instructions: 'Answer clearly.', fallback: 'I do not have that answer yet.' };
  await client.begin(async tx => {
    await tx`DELETE FROM relay.workspaces WHERE id=${workspaceId}`;
    await tx`INSERT INTO relay.workspaces(id,data) VALUES(${workspaceId},${JSON.stringify({ bots: [bot], sources: [] })}::jsonb)`;
    const [deployment] = await tx`INSERT INTO relay.deployments(workspace_id,bot_id,share_id) VALUES(${workspaceId},${botId},${shareId}) RETURNING id`;
    await tx`INSERT INTO relay.chat_rooms(deployment_id,token,kind) VALUES(${deployment.id},${roomToken},'group')`;
  });
  console.log(`Browser preview ready: http://127.0.0.1:3000/share/${shareId}`);
}
await client.end({ timeout: 2 });
