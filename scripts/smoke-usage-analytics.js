import { randomUUID } from 'node:crypto';
import { client } from '../src/infrastructure/database.js';
import { recordUsage, workspaceUsage } from '../src/features/analytics/usage.js';

const workspaceId = `usage-test:${randomUUID()}`;
const userId = `user_${randomUUID()}`;
const limits = { plan: 'Starter', bots: 10, members: 1, storageBytes: 25 * 1024 * 1024, chunks: 10_000, aiCalls: 1_000 };

try {
  await client`INSERT INTO relay.workspaces(id,data) VALUES(${workspaceId},${JSON.stringify({ bots: [], sources: [] })}::jsonb)`;
  await client`INSERT INTO relay.knowledge_files(workspace_id,bot_id,source_id,object_key,filename,content_type,size_bytes,status,uploaded_by_user_id) VALUES(${workspaceId},'bot','source',${`tests/${randomUUID()}`},'guide.txt','text/plain',4096,'ready',${userId})`;
  await client`INSERT INTO relay.ai_chunks(workspace_id,bot_id,source_id,source_hash,model_key,dimensions,content,embedding,created_by_user_id) VALUES(${workspaceId},'bot','source','hash','test:3',3,'A test chunk','[0,0,0]'::extensions.vector,${userId})`;
  await recordUsage({ workspaceId, userId, metric: 'ai_calls', quantity: 3 });
  await recordUsage({ workspaceId, userId, metric: 'embedded_chunks', quantity: 1 });
  const usage = await workspaceUsage(workspaceId, userId, limits);
  const member = usage.members.find(item => item.userId === userId);
  if (usage.totals.r2Bytes !== 4096 || usage.totals.chunks !== 1 || usage.totals.aiCalls !== 3) throw new Error('Workspace totals do not match stored usage.');
  if (!member || member.files !== 1 || member.chunks !== 1 || member.aiCalls !== 3) throw new Error('Per-user attribution does not match stored usage.');
  if (usage.trends.length !== 14) throw new Error('Usage trend must contain 14 calendar days.');
  console.log('Usage totals, plan limits, member attribution and trends: PASS');
} finally {
  await client`DELETE FROM relay.workspaces WHERE id=${workspaceId}`;
  await client.end({ timeout: 2 });
}
