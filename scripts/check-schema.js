import { client } from '../src/infrastructure/database.js';

const tables = await client`SELECT table_name FROM information_schema.tables WHERE table_schema='relay' ORDER BY table_name`;
console.log(`Supabase relay schema: ${tables.map(row => row.table_name).join(', ')}`);
const progressColumns = await client`SELECT column_name FROM information_schema.columns WHERE table_schema='relay' AND table_name='knowledge_files' AND column_name IN ('progress','progress_stage','progress_detail','processed_chunks','total_chunks','progress_updated_at') ORDER BY column_name`;
if (progressColumns.length !== 6) throw new Error('Knowledge progress migration is incomplete');
const required = ['workspaces', 'ai_chunks', 'knowledge_files', 'deployments', 'chat_rooms', 'chat_messages', 'chat_members', 'chat_invitations'];
if (required.some(name => !tables.some(row => row.table_name === name))) throw new Error('Core RAG schema is incomplete');
console.log(`Core RAG schema ready: ${progressColumns.length} persisted progress fields`);
await client.end({ timeout: 2 });
