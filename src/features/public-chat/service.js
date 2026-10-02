import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { client } from '../../infrastructure/database.js';

const secret = () => randomBytes(32).toString('base64url');
const memberId = () => randomBytes(18).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');

export function safeBot(bot) {
  return {
    name: String(bot.name || 'Assistant').slice(0, 100),
    description: String(bot.description || '').slice(0, 500),
    welcome: String(bot.welcome || 'Hi! How can I help?').slice(0, 500),
    suggestions: String(bot.suggestions || '').slice(0, 500),
    accent: /^#[0-9a-f]{6}$/i.test(bot.accent || '') ? bot.accent : '#1554db',
    avatar: String(bot.avatar || 'R').slice(0, 2),
    position: bot.position === 'Bottom left' ? 'Bottom left' : 'Bottom right',
    leadCapture: bot.leadCapture !== false,
    leadFields: String(bot.leadFields || 'Name\nEmail').slice(0, 500),
    themePreset: String(bot.themePreset || 'Default').slice(0, 60),
    openingRule: String(bot.openingRule || 'Manual').slice(0, 80),
    businessHours: String(bot.businessHours || '').slice(0, 120),
    offlineCapture: bot.offlineCapture !== false,
  };
}

export async function loadDeployment(shareId) {
  const [row] = await client`
    SELECT d.id,d.workspace_id,d.bot_id,d.enabled,d.access_mode,w.data,
      (SELECT token FROM relay.chat_rooms WHERE deployment_id=d.id AND kind='group' LIMIT 1) AS group_token
    FROM relay.deployments d JOIN relay.workspaces w ON w.id=d.workspace_id WHERE d.share_id=${shareId}`;
  if (!row?.enabled) return null;
  const bot = row.data?.bots?.find(item => item.id === row.bot_id);
  return bot ? { ...row, bot } : null;
}

export async function loadRoom(roomToken) {
  const [row] = await client`
    SELECT r.id,r.token,r.kind,r.origin_host,d.workspace_id,d.bot_id,d.enabled,d.access_mode,w.data
    FROM relay.chat_rooms r JOIN relay.deployments d ON d.id=r.deployment_id
    JOIN relay.workspaces w ON w.id=d.workspace_id WHERE r.token=${roomToken}`;
  if (!row?.enabled) return null;
  const bot = row.data?.bots?.find(item => item.id === row.bot_id);
  return bot ? { ...row, bot } : null;
}

export function isBotOnline(bot, now = new Date()) {
  const hours = String(bot.businessHours || '').trim();
  if (!hours || !/mon|tue|wed|thu|fri|sat|sun/i.test(hours)) return true;
  const day = now.getDay();
  const weekday = day >= 1 && day <= 5;
  const weekend = day === 0 || day === 6;
  if (/mon-fri/i.test(hours) && !weekday) return false;
  if (/sat-sun/i.test(hours) && !weekend) return false;
  const match = hours.match(/(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?/);
  if (!match) return true;
  const current = now.getHours() * 60 + now.getMinutes();
  const start = Number(match[1]) * 60 + Number(match[2] || 0);
  const end = Number(match[3]) * 60 + Number(match[4] || 0);
  return current >= start && current <= end;
}

function tokenMatches(candidate, storedHash) {
  if (!candidate || !storedHash) return false;
  const left = Buffer.from(digest(candidate));
  const right = Buffer.from(storedHash);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function authenticateMember(roomToken, candidateId, sessionToken, { allowPending = false } = {}) {
  const room = await loadRoom(roomToken);
  if (!room) return null;
  const [member] = await client`SELECT member_id,display_name,role,status,account_user_id,session_token_hash,joined_at,last_seen_at FROM relay.chat_members WHERE room_id=${room.id} AND member_id=${candidateId}`;
  if (!member || (!allowPending && member.status !== 'active') || !['active','pending'].includes(member.status) || !tokenMatches(sessionToken, member.session_token_hash)) return null;
  return { room, member: publicMember(member) };
}

export async function joinRoom(room, { name, existingId, existingToken, ownerWorkspaceId, accountUserId = null }) {
  if (existingId && existingToken) {
    const [current] = await client`SELECT member_id,display_name,role,status,account_user_id,session_token_hash,joined_at,last_seen_at FROM relay.chat_members WHERE room_id=${room.id} AND member_id=${existingId}`;
    if (['active','pending'].includes(current?.status) && tokenMatches(existingToken, current.session_token_hash)) {
      const desiredRole = ownerWorkspaceId === room.workspace_id ? 'admin' : current.role;
      const desiredStatus = ownerWorkspaceId === room.workspace_id ? 'active' : current.status;
      const [resumed] = await client`UPDATE relay.chat_members SET display_name=${name},role=${desiredRole},status=${desiredStatus},account_user_id=COALESCE(${accountUserId},account_user_id),approved_at=CASE WHEN ${desiredStatus}='active' THEN COALESCE(approved_at,now()) ELSE approved_at END,last_seen_at=now() WHERE room_id=${room.id} AND member_id=${existingId} RETURNING member_id,display_name,role,status,account_user_id,joined_at,last_seen_at`;
      return { member: publicMember(resumed), sessionToken: existingToken };
    }
  }
  if (accountUserId) {
    const [accountMember] = await client`SELECT member_id,display_name,role,status,account_user_id,joined_at,last_seen_at FROM relay.chat_members WHERE room_id=${room.id} AND account_user_id=${accountUserId} AND status IN ('active','pending') ORDER BY joined_at LIMIT 1`;
    if (accountMember) {
      const sessionToken = secret();
      const desiredRole = ownerWorkspaceId === room.workspace_id ? 'admin' : accountMember.role;
      const desiredStatus = ownerWorkspaceId === room.workspace_id ? 'active' : accountMember.status;
      const [resumed] = await client`UPDATE relay.chat_members SET display_name=${name},role=${desiredRole},status=${desiredStatus},session_token_hash=${digest(sessionToken)},approved_at=CASE WHEN ${desiredStatus}='active' THEN COALESCE(approved_at,now()) ELSE approved_at END,last_seen_at=now() WHERE room_id=${room.id} AND member_id=${accountMember.member_id} RETURNING member_id,display_name,role,status,account_user_id,joined_at,last_seen_at`;
      return { member: publicMember(resumed), sessionToken };
    }
  }
  const id = memberId();
  const sessionToken = secret();
  const role = ownerWorkspaceId === room.workspace_id ? 'admin' : 'member';
  const status = role === 'admin' || room.kind === 'widget' || room.access_mode !== 'approval' ? 'active' : 'pending';
  const [created] = await client`INSERT INTO relay.chat_members(room_id,member_id,display_name,role,status,account_user_id,session_token_hash,approved_at) VALUES(${room.id},${id},${name},${role},${status},${accountUserId},${digest(sessionToken)},CASE WHEN ${status}='active' THEN now() ELSE NULL END) RETURNING member_id,display_name,role,status,account_user_id,joined_at,last_seen_at`;
  return { member: publicMember(created), sessionToken };
}

export function publicMember(row) {
  return {
    id: row.member_id,
    name: row.display_name,
    role: row.role,
    status: row.status,
    accountUserId: row.account_user_id || null,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
  };
}

export async function roomSnapshot(room, onlineIds = new Set(), includePending = false) {
  const members = await client`SELECT member_id,display_name,role,status,account_user_id,joined_at,last_seen_at FROM relay.chat_members WHERE room_id=${room.id} AND status IN ('active','pending') ORDER BY CASE WHEN status='pending' THEN 0 WHEN role='admin' THEN 1 ELSE 2 END,joined_at`;
  const sources = (room.data?.sources || [])
    .filter(source => source.botId === room.bot_id && source.status === 'Ready')
    .map(source => ({ id: source.id, title: source.title, type: source.type, updated: source.updated }))
    .slice(0, 100);
  return {
    members: members.filter(row => includePending || row.status === 'active').map(row => ({ ...publicMember(row), online: onlineIds.has(row.member_id) })),
    knowledge: sources,
  };
}

export async function updateMember(room, actor, targetId, action) {
  if (actor.role !== 'admin') throw Object.assign(new Error('Only an admin can manage members.'), { status: 403 });
  if (actor.id === targetId) throw Object.assign(new Error('You cannot change your own access here.'), { status: 400 });
  const [target] = await client`SELECT member_id,role,status FROM relay.chat_members WHERE room_id=${room.id} AND member_id=${targetId}`;
  if (!target || !['active','pending'].includes(target.status)) throw Object.assign(new Error('Member not found.'), { status: 404 });
  if (action === 'remove' || action === 'deny') {
    await client`UPDATE relay.chat_members SET status='removed',last_seen_at=now() WHERE room_id=${room.id} AND member_id=${targetId}`;
  } else if (action === 'approve') {
    if (target.status !== 'pending') throw Object.assign(new Error('This member is already approved.'), { status: 400 });
    await client`UPDATE relay.chat_members SET status='active',approved_at=now(),last_seen_at=now() WHERE room_id=${room.id} AND member_id=${targetId}`;
  } else {
    await client`UPDATE relay.chat_members SET role=${action === 'make-admin' ? 'admin' : 'member'},last_seen_at=now() WHERE room_id=${room.id} AND member_id=${targetId}`;
  }
}

export async function listAccountChats(accountUserId) {
  const rows = await client`
    SELECT r.token,d.share_id,d.bot_id,m.role,m.last_seen_at,w.data,
      (SELECT COUNT(*)::int FROM relay.chat_members people WHERE people.room_id=r.id AND people.status='active') AS member_count,
      latest.content AS last_message,latest.sender_name AS last_sender,latest.created_at AS last_message_at
    FROM relay.chat_members m
    JOIN relay.chat_rooms r ON r.id=m.room_id AND r.kind='group'
    JOIN relay.deployments d ON d.id=r.deployment_id AND d.enabled=true
    JOIN relay.workspaces w ON w.id=d.workspace_id
    LEFT JOIN LATERAL (SELECT content,sender_name,created_at FROM relay.chat_messages WHERE room_id=r.id ORDER BY id DESC LIMIT 1) latest ON true
    WHERE m.account_user_id=${accountUserId} AND m.status='active'
    ORDER BY COALESCE(latest.created_at,m.last_seen_at) DESC LIMIT 20`;
  return rows.map(row => ({
    shareId: row.share_id,
    botId: row.bot_id,
    botName: row.data?.bots?.find(bot => bot.id === row.bot_id)?.name || 'Shared assistant',
    role: row.role,
    memberCount: row.member_count,
    lastMessage: row.last_message || '',
    lastSender: row.last_sender || '',
    updatedAt: row.last_message_at || row.last_seen_at,
  }));
}

export async function leaveAccountChat(accountUserId, shareId) {
  const [row] = await client`
    UPDATE relay.chat_members member
    SET status='removed',last_seen_at=now()
    FROM relay.chat_rooms room
    JOIN relay.deployments deployment ON deployment.id=room.deployment_id AND deployment.enabled=true
    WHERE member.room_id=room.id
      AND room.kind='group'
      AND deployment.share_id=${shareId}
      AND member.account_user_id=${accountUserId}
      AND member.status='active'
    RETURNING member.member_id`;
  return !!row;
}
