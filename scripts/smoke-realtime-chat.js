import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { io as connectSocket } from 'socket.io-client';
import { app } from '../src/http/app.js';
import { client } from '../src/infrastructure/database.js';
import { attachSocketServer } from '../src/realtime/socket-server.js';
import { joinRoom, listAccountChats, loadRoom } from '../src/features/public-chat/service.js';

const workspaceId = `test:${randomUUID()}`;
const botId = 'realtime-test-bot';
const roomToken = randomUUID().replaceAll('-', '');
const bot = { id: botId, name: 'Relay Test', description: 'Realtime test assistant', welcome: 'Welcome', suggestions: '', avatar: 'RT', tone: 'Friendly', instructions: '', fallback: 'No answer.', domains: '' };
const server = createServer(app);
const socketServer = attachSocketServer(server);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sockets = [];

function waitFor(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`Timed out waiting for ${event}`)); }, 5000);
    const handler = value => { if (!predicate(value)) return; clearTimeout(timer); socket.off(event, handler); resolve(value); };
    socket.on(event, handler);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (error, result) => {
    if (error) reject(error); else if (!result?.ok) reject(new Error(result?.error || `${event} failed`)); else resolve(result);
  }));
}

async function connect(room, membership) {
  const socket = connectSocket(origin, { transports: ['websocket'], autoConnect: false, auth: { kind: 'public-room', roomToken: room.token, memberId: membership.member.id, sessionToken: membership.sessionToken } });
  sockets.push(socket);
  const ready = waitFor(socket, 'chat:ready');
  socket.connect();
  await ready;
  return socket;
}

async function connectPending(room, membership) {
  const socket = connectSocket(origin, { transports: ['websocket'], autoConnect: false, auth: { kind: 'public-room', roomToken: room.token, memberId: membership.member.id, sessionToken: membership.sessionToken } });
  sockets.push(socket);
  const pending = waitFor(socket, 'chat:membership', event => event.status === 'pending');
  socket.connect();
  await pending;
  return socket;
}

try {
  await client`INSERT INTO relay.workspaces(id,data) VALUES(${workspaceId},${JSON.stringify({ bots: [bot], sources: [{ id: 'source-test', botId, title: 'Guide.pdf', type: 'File', status: 'Ready', updated: '2026-09-10' }] })}::jsonb)`;
  const [deployment] = await client`INSERT INTO relay.deployments(workspace_id,bot_id,share_id,access_mode) VALUES(${workspaceId},${botId},${randomUUID().replaceAll('-', '')},'approval') RETURNING id`;
  await client`INSERT INTO relay.chat_rooms(deployment_id,token,kind) VALUES(${deployment.id},${roomToken},'group')`;
  const room = await loadRoom(roomToken);
  const admin = await joinRoom(room, { name: 'Owner', ownerWorkspaceId: workspaceId });
  const guest = await joinRoom(room, { name: 'Guest', ownerWorkspaceId: null, accountUserId: 'user_realtime_smoke' });
  if (admin.member.role !== 'admin' || admin.member.status !== 'active' || guest.member.role !== 'member' || guest.member.status !== 'pending') throw new Error('Creator and pending member roles were not assigned.');

  const adminSocket = await connect(room, admin);
  const pendingSocket = await connectPending(room, guest);
  const approved = waitFor(pendingSocket, 'chat:membership', event => event.status === 'active');
  await emitAck(adminSocket, 'chat:member:update', { memberId: guest.member.id, action: 'approve' });
  await approved;
  await new Promise(resolve => setTimeout(resolve, 100));
  const recentChats = await listAccountChats('user_realtime_smoke');
  if (recentChats.length !== 1 || recentChats[0].shareId == null) throw new Error('Approved account chat did not appear in recent history.');
  const guestSocket = await connect(room, guest);
  const delivered = waitFor(adminSocket, 'chat:message', message => message.content === 'Hello from Guest');
  await Promise.all([emitAck(guestSocket, 'chat:send', { text: 'Hello from Guest' }), delivered]);

  const promoted = waitFor(guestSocket, 'chat:snapshot', snapshot => snapshot.members.some(member => member.id === guest.member.id && member.role === 'admin'));
  await emitAck(adminSocket, 'chat:member:update', { memberId: guest.member.id, action: 'make-admin' });
  await promoted;

  const removed = waitFor(guestSocket, 'chat:removed');
  await emitAck(adminSocket, 'chat:member:update', { memberId: guest.member.id, action: 'remove' });
  await removed;
  console.log('Approval request, two-member presence, socket messages, admin promotion and removal: PASS');
} finally {
  sockets.forEach(socket => socket.disconnect());
  await client`DELETE FROM relay.workspaces WHERE id=${workspaceId}`;
  await new Promise(resolve => socketServer.close(resolve));
  await client.end({ timeout: 2 });
}
