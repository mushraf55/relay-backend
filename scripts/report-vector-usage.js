import { client } from '../src/infrastructure/database.js';

try {
  const groups = await client`
    SELECT source_id,model_key,dimensions,count(*)::integer AS embeddings
    FROM relay.ai_chunks
    GROUP BY source_id,model_key,dimensions
    ORDER BY count(*) DESC
  `;
  const [sizes] = await client`
    SELECT pg_database_size(current_database())::bigint AS database_bytes,
           pg_total_relation_size('relay.ai_chunks')::bigint AS chunks_bytes
  `;
  const jobs = await client`
    SELECT source_id,status,progress,processed_chunks,total_chunks
    FROM relay.knowledge_files
    ORDER BY progress_updated_at DESC
  `;
  const format = bytes => `${(Number(bytes) / 1024 / 1024).toFixed(2)} MB`;
  console.table(groups);
  if (jobs.length) { console.log('Document jobs:'); console.table(jobs); }
  console.log(`Vector table: ${format(sizes.chunks_bytes)}`);
  console.log(`Whole database: ${format(sizes.database_bytes)}`);
} finally {
  await client.end({ timeout: 2 });
}
