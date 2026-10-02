import { randomUUID } from 'node:crypto';
import { verifyToken } from '@clerk/backend';
import { Server as SocketServer } from 'socket.io';
import { z } from 'zod';
import { clerkAuthorizedParties, env, origins } from '../config/env.js';
import { client } from '../infrastructure/database.js';
import { sharedLimit } from '../infrastructure/rate-limits.js';
import { groundedChatStream } from '../features/ai/chat-service.js';
import { recordUsage } from '../features/analytics/usage.js';
import { authenticateMember, isBotOnline, roomSnapshot, updateMember } from '../features/public-chat/service.js';
import { setProgressSocketServer, toProgressEvent, workspaceRoom } from '../features/knowledge/progress.js';

const chatInput = z.object({ text: z.string().trim().min(1).max(1000) });
const memberAction = z.object({ memberId: z.string().min(16).max(100), action: z.enum(['make-admin', 'make-member', 'approve', 'deny', 'remove']) });
const publicRoomName = roomId => `public-chat:${roomId}`;
const pendingMemberRoom = (roomId, memberId) => `public-pending:${roomId}:${memberId}`;

function workspaceFromClaims(claims) {
  const organizationId = claims.org_id || claims.o?.id;
  return organizationId ? `org:${organizationId}` : `user:${claims.sub}`;
}

function messageError(error) {
  return error?.message?.startsWith('Ollama') || /^(ollama|openai|groq|cloudflare|Set OPENAI|Set GROQ|Set CLOUDFLARE|The model)/.test(error?.message || '')
    ? error.message
    : 'The assistant could not answer. Please retry.';
}

export function attachSocketServer(httpServer) {
  const io = new SocketServer(httpServer, { cors: { origin: origins, methods: ['GET', 'POST'] } });
  const presence = new Map();
  const activeAnswers = new Set();
  setProgressSocketServer(io);

  function onlineIds(roomId) { return new Set(presence.get(roomId)?.keys() || []); }
  function enter(roomId, id) {
    const room = presence.get(roomId) || new Map();
    room.set(id, (room.get(id) || 0) + 1);
    presence.set(roomId, room);
  }
  function leave(roomId, id) {
    const room = presence.get(roomId); if (!room) return;
    const remaining = (room.get(id) || 1) - 1;
    if (remaining > 0) room.set(id, remaining); else room.delete(id);
    if (!room.size) presence.delete(roomId);
  }
  async function emitSnapshot(room) {
    const channel = publicRoomName(room.id);
    const all = await roomSnapshot(room, onlineIds(room.id), true);
    const activeOnly = { ...all, members: all.members.filter(member => member.status === 'active') };
    const sockets = await io.in(channel).fetchSockets();
    for (const connected of sockets) {
      const current = all.members.find(member => member.id === connected.data.publicChat?.member.id);
      connected.emit('chat:snapshot', current?.role === 'admin' ? all : activeOnly);
    }
  }

  io.use(async (socket, next) => {
    try {
      if (socket.handshake.auth?.kind === 'public-room') {
        const auth = await authenticateMember(socket.handshake.auth.roomToken, socket.handshake.auth.memberId, socket.handshake.auth.sessionToken, { allowPending: true });
        if (!auth) throw new Error('Invalid room membership');
        socket.data.publicChat = auth;
        return next();
      }
      const token = socket.handshake.auth?.token;
      const requestedWorkspace = socket.handshake.auth?.workspaceId;
      if (typeof token !== 'string' || typeof requestedWorkspace !== 'string') throw new Error('Missing socket credentials');
      const claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY, authorizedParties: clerkAuthorizedParties });
      const workspaceId = workspaceFromClaims(claims);
      if (requestedWorkspace !== workspaceId) throw new Error('Workspace mismatch');
      socket.data.workspaceId = workspaceId;
      return next();
    } catch { return next(new Error('Unauthorized')); }
  });

  io.on('connection', async socket => {
    if (socket.data.publicChat) {
      const { room, member } = socket.data.publicChat;
      const channel = publicRoomName(room.id);
      if (member.status === 'pending') {
        socket.join(pendingMemberRoom(room.id, member.id));
        socket.emit('chat:membership', { status: 'pending' });
        await emitSnapshot(room);
        return;
      }
      socket.join(channel);
      enter(room.id, member.id);
      await client`UPDATE relay.chat_members SET last_seen_at=now() WHERE room_id=${room.id} AND member_id=${member.id}`;

      socket.on('chat:send', async (payload, acknowledge = () => {}) => {
        try {
          const input = chatInput.parse(payload);
          const current = await authenticateMember(room.token, member.id, socket.handshake.auth.sessionToken);
          if (!current) throw new Error('You no longer have access to this chat.');
          socket.data.publicChat.member = current.member;
          const limited = await sharedLimit('public', `message:${room.id}:${member.id}`);
          if (!limited.success) throw new Error('Message limit reached. Try again shortly.');
          const [message] = await client`INSERT INTO relay.chat_messages(room_id,sender_id,sender_name,role,content) VALUES(${room.id},${member.id},${current.member.name},'member',${input.text}) RETURNING id::text,sender_id,sender_name,role,content,citations,created_at`;
          io.to(channel).emit('chat:message', message);
          acknowledge({ ok: true, messageId: message.id });

          const mentioned = /@relay\b/i.test(input.text);
          const prompt = room.kind === 'group' ? input.text.replace(/@relay\b/ig, '').trim() : input.text;
          if ((room.kind === 'group' && !mentioned) || !prompt) return;
          if (room.kind === 'widget' && room.bot.offlineCapture && !isBotOnline(room.bot)) {
            await client.begin(async tx => {
              const [row] = await tx`SELECT data FROM relay.workspaces WHERE id=${room.workspace_id} FOR UPDATE`;
              const data = row?.data || {};
              data.activity = Array.isArray(data.activity) ? data.activity : [];
              data.activity.unshift({ id: randomUUID(), botId: room.bot.id, type: 'offline-message', title: 'Offline message collected', detail: input.text.slice(0, 160), createdAt: new Date().toISOString() });
              await tx`UPDATE relay.workspaces SET data=${JSON.stringify(data)}::jsonb, revision=revision+1, updated_at=now() WHERE id=${room.workspace_id}`;
            });
            return;
          }
          if (activeAnswers.has(room.id)) return socket.emit('chat:assistant:error', { error: 'Relay is already answering in this room. Try again when it finishes.' });
          activeAnswers.add(room.id);
          const requestId = randomUUID();
          io.to(channel).emit('chat:assistant:start', { requestId, senderName: room.bot.name });
          try {
            await recordUsage({ workspaceId: room.workspace_id, userId: current.member.accountUserId || null, metric: 'ai_calls', metadata: { channel: 'shared_chat_socket', botId: room.bot.id } });
            const previous = await client`SELECT role,content FROM relay.chat_messages WHERE room_id=${room.id} AND id<${message.id} ORDER BY id DESC LIMIT 12`;
            const history = previous.reverse().map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content.slice(0, 8000) }));
            let text = ''; let citations = [];
            for await (const event of groundedChatStream({ workspaceId: room.workspace_id, bot: room.bot, message: prompt, history })) {
              if (event.type === 'delta') { text += event.text; io.to(channel).emit('chat:assistant:delta', { requestId, text: event.text }); }
              if (event.type === 'done') citations = event.citations;
            }
            const [assistant] = await client`INSERT INTO relay.chat_messages(room_id,sender_id,sender_name,role,content,citations) VALUES(${room.id},'relay',${room.bot.name},'assistant',${text},${JSON.stringify(citations)}::jsonb) RETURNING id::text,sender_id,sender_name,role,content,citations,created_at`;
            io.to(channel).emit('chat:assistant:done', { requestId, message: assistant });
          } catch (error) {
            io.to(channel).emit('chat:assistant:error', { requestId, error: messageError(error) });
          } finally { activeAnswers.delete(room.id); }
        } catch (error) { acknowledge({ ok: false, error: error.message || 'Message could not be sent.' }); }
      });

      socket.on('chat:member:update', async (payload, acknowledge = () => {}) => {
        try {
          const input = memberAction.parse(payload);
          const current = await authenticateMember(room.token, member.id, socket.handshake.auth.sessionToken);
          if (!current) throw new Error('You no longer have access to this chat.');
          await updateMember(room, current.member, input.memberId, input.action);
          if (input.action === 'approve') {
            const sockets = await io.in(pendingMemberRoom(room.id, input.memberId)).fetchSockets();
            for (const connected of sockets) {
              connected.emit('chat:membership', { status: 'active' });
              setTimeout(() => connected.disconnect(true), 50);
            }
          }
          if (input.action === 'remove' || input.action === 'deny') {
            const targetRoom = input.action === 'deny' ? pendingMemberRoom(room.id, input.memberId) : channel;
            const sockets = await io.in(targetRoom).fetchSockets();
            for (const connected of sockets) if (connected.data.publicChat?.member.id === input.memberId) {
              connected.emit('chat:removed', { message: input.action === 'deny' ? 'The room admin declined your request.' : 'An admin removed you from this chat.' });
              connected.disconnect(true);
            }
          }
          await emitSnapshot(room);
          acknowledge({ ok: true });
        } catch (error) { acknowledge({ ok: false, error: error.message || 'Member could not be updated.' }); }
      });

      socket.on('disconnect', async () => {
        leave(room.id, member.id);
        try {
          await client`UPDATE relay.chat_members SET last_seen_at=now() WHERE room_id=${room.id} AND member_id=${member.id}`;
          await emitSnapshot(room);
        } catch { /* The room may have been unpublished or deleted. */ }
      });
      const messages = await client`SELECT id::text,sender_id,sender_name,role,content,citations,created_at FROM relay.chat_messages WHERE room_id=${room.id} ORDER BY id DESC LIMIT 200`;
      socket.emit('chat:ready', { messages: messages.reverse(), snapshot: await roomSnapshot(room, onlineIds(room.id), member.role === 'admin') });
      await emitSnapshot(room);
      return;
    }

    const workspaceId = socket.data.workspaceId;
    socket.join(workspaceRoom(workspaceId));
    try {
      const rows = await client`SELECT source_id,status,progress,progress_stage,progress_detail,processed_chunks,total_chunks,error_message FROM relay.knowledge_files WHERE workspace_id=${workspaceId} AND status IN ('pending','processing')`;
      rows.forEach(row => socket.emit('knowledge:progress', toProgressEvent(row)));
    } catch { socket.emit('knowledge:progress-error', { message: 'Could not restore current processing progress.' }); }
  });

  return io;
}
