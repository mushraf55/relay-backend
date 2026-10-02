import { client } from '../../infrastructure/database.js';

export async function recordUsage({ workspaceId, userId = null, metric, quantity = 1, metadata = {} }) {
  await client`INSERT INTO relay.usage_events(workspace_id,user_id,metric,quantity,metadata) VALUES(${workspaceId},${userId},${metric},${quantity},${JSON.stringify(metadata)}::jsonb)`;
}

const key = value => value || 'unattributed';

export async function workspaceUsage(workspaceId, currentUserId, limits) {
  const [totalRows, fileRows, chunkRows, callRows, messageRows, names, trends] = await Promise.all([
    client`SELECT
      (SELECT COUNT(*)::int FROM relay.ai_chunks WHERE workspace_id=${workspaceId}) AS chunks,
      (SELECT COALESCE(SUM(size_bytes),0)::bigint FROM relay.knowledge_files WHERE workspace_id=${workspaceId}) AS r2_bytes,
      (SELECT COALESCE(SUM(pg_column_size(embedding)+octet_length(content)),0)::bigint FROM relay.ai_chunks WHERE workspace_id=${workspaceId}) AS vector_bytes,
      (SELECT COUNT(*)::int FROM relay.knowledge_files WHERE workspace_id=${workspaceId}) AS files,
      (SELECT COALESCE(SUM(quantity),0)::int FROM relay.usage_events WHERE workspace_id=${workspaceId} AND metric='ai_calls' AND created_at>=date_trunc('month',now())) AS ai_calls,
      (SELECT COUNT(*)::int FROM relay.chat_messages message JOIN relay.chat_rooms room ON room.id=message.room_id JOIN relay.deployments deployment ON deployment.id=room.deployment_id WHERE deployment.workspace_id=${workspaceId}) AS messages,
      (SELECT COUNT(DISTINCT room.id)::int FROM relay.chat_rooms room JOIN relay.deployments deployment ON deployment.id=room.deployment_id JOIN relay.chat_messages message ON message.room_id=room.id WHERE deployment.workspace_id=${workspaceId}) AS conversations,
      (SELECT COUNT(DISTINCT member.account_user_id)::int FROM relay.chat_members member JOIN relay.chat_rooms room ON room.id=member.room_id JOIN relay.deployments deployment ON deployment.id=room.deployment_id WHERE deployment.workspace_id=${workspaceId} AND member.account_user_id IS NOT NULL AND member.status='active') AS account_members`,
    client`SELECT uploaded_by_user_id AS user_id,COUNT(*)::int AS files,COALESCE(SUM(size_bytes),0)::bigint AS r2_bytes FROM relay.knowledge_files WHERE workspace_id=${workspaceId} GROUP BY uploaded_by_user_id`,
    client`SELECT created_by_user_id AS user_id,COUNT(*)::int AS chunks,COALESCE(SUM(pg_column_size(embedding)+octet_length(content)),0)::bigint AS vector_bytes FROM relay.ai_chunks WHERE workspace_id=${workspaceId} GROUP BY created_by_user_id`,
    client`SELECT user_id,COALESCE(SUM(quantity),0)::int AS ai_calls FROM relay.usage_events WHERE workspace_id=${workspaceId} AND metric='ai_calls' AND created_at>=date_trunc('month',now()) GROUP BY user_id`,
    client`SELECT member.account_user_id AS user_id,COUNT(message.id)::int AS messages FROM relay.chat_messages message JOIN relay.chat_rooms room ON room.id=message.room_id JOIN relay.deployments deployment ON deployment.id=room.deployment_id LEFT JOIN relay.chat_members member ON member.room_id=room.id AND member.member_id=message.sender_id WHERE deployment.workspace_id=${workspaceId} AND message.role='member' GROUP BY member.account_user_id`,
    client`SELECT member.account_user_id AS user_id,MAX(member.display_name) AS display_name FROM relay.chat_members member JOIN relay.chat_rooms room ON room.id=member.room_id JOIN relay.deployments deployment ON deployment.id=room.deployment_id WHERE deployment.workspace_id=${workspaceId} AND member.account_user_id IS NOT NULL GROUP BY member.account_user_id`,
    client`SELECT day::date::text,COALESCE(SUM(event.quantity) FILTER(WHERE event.metric='ai_calls'),0)::int AS ai_calls,COALESCE(SUM(event.quantity) FILTER(WHERE event.metric='embedded_chunks'),0)::int AS embedded_chunks FROM generate_series(current_date-13,current_date,'1 day') day LEFT JOIN relay.usage_events event ON event.workspace_id=${workspaceId} AND event.created_at>=day AND event.created_at<day+'1 day'::interval GROUP BY day ORDER BY day`,
  ]);
  const totals = totalRows[0];
  const members = new Map([[currentUserId, { userId: currentUserId, name: 'You', files: 0, chunks: 0, r2Bytes: 0, vectorBytes: 0, aiCalls: 0, messages: 0, isCurrent: true }]]);
  const rowFor = userId => {
    const id = key(userId);
    if (!members.has(id)) members.set(id, { userId: userId || null, name: userId ? names.find(item => item.user_id === userId)?.display_name || `Member ·${userId.slice(-6)}` : 'Unattributed workspace data', files: 0, chunks: 0, r2Bytes: 0, vectorBytes: 0, aiCalls: 0, messages: 0, isCurrent: userId === currentUserId });
    return members.get(id);
  };
  fileRows.forEach(row => Object.assign(rowFor(row.user_id), { files: row.files, r2Bytes: Number(row.r2_bytes) }));
  chunkRows.forEach(row => Object.assign(rowFor(row.user_id), { chunks: row.chunks, vectorBytes: Number(row.vector_bytes) }));
  callRows.forEach(row => Object.assign(rowFor(row.user_id), { aiCalls: row.ai_calls }));
  messageRows.forEach(row => Object.assign(rowFor(row.user_id), { messages: row.messages }));
  return {
    period: { label: 'Current month', startsAt: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() },
    totals: { chunks: totals.chunks, r2Bytes: Number(totals.r2_bytes), vectorBytes: Number(totals.vector_bytes), files: totals.files, aiCalls: totals.ai_calls, messages: totals.messages, conversations: totals.conversations, accountMembers: totals.account_members },
    limits,
    members: [...members.values()].sort((a,b) => Number(b.isCurrent)-Number(a.isCurrent) || b.r2Bytes-a.r2Bytes || b.chunks-a.chunks),
    trends: trends.map(row => ({ date: row.day, aiCalls: row.ai_calls, embeddedChunks: row.embedded_chunks })),
  };
}
