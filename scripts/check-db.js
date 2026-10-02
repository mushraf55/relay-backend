import { client } from '../src/infrastructure/database.js';
try {
  await client`SELECT 1`;
  console.log('Database connection OK');
  const [row] = await client`SELECT to_regclass('relay.workspaces') AS workspace_table`;
  console.log('Workspace table:', row.workspace_table ? 'present' : 'missing');
  if (row.workspace_table) {
    const shapes = await client`SELECT jsonb_typeof(data) AS document_type, jsonb_typeof(data->'bots') AS bots_type, jsonb_typeof(data->'sources') AS sources_type, count(*)::int AS count FROM relay.workspaces GROUP BY 1,2,3`;
    console.log('Saved workspace shapes (no contents):', JSON.stringify(shapes));
  }
} catch (error) {
  console.error('Database check failed:', error.code || error.name);
  process.exitCode = 1;
} finally { await client.end({ timeout: 2 }); }
