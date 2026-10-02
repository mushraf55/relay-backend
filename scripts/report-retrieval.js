import { client } from '../src/infrastructure/database.js';
import { aiConfig, embed } from '../src/features/ai/client.js';

const [, , workspaceId, botId, ...questionParts] = process.argv;
const question = questionParts.join(' ').trim();

if (!workspaceId || !botId || !question) {
  console.error('Usage: node scripts/report-retrieval.js <workspace-id> <bot-id> <question>');
  process.exit(1);
}

try {
  const settings = aiConfig();
  const vector = await embed([question], settings);
  const rows = await client`
    SELECT c.source_id,s->>'title' AS title,left(c.content,220) AS preview,
           c.embedding OPERATOR(extensions.<=>) ${JSON.stringify(vector.vectors[0])}::extensions.vector AS distance
    FROM relay.ai_chunks c JOIN relay.workspaces w ON w.id=c.workspace_id
    LEFT JOIN relay.knowledge_files f ON f.workspace_id=c.workspace_id AND f.source_id=c.source_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'sources','[]'::jsonb)) s
    WHERE c.workspace_id=${workspaceId} AND c.bot_id=${botId}
    AND c.source_id=s->>'id' AND s->>'botId'=${botId}
    AND (s->>'type'<>'File' OR f.status='ready')
    AND c.source_hash=CASE WHEN s->>'type'='File'
      THEN md5((s->>'title') || E'\n' || f.object_key)
      ELSE md5((s->>'title') || E'\n' || (s->>'content')) END
    AND c.model_key=${vector.modelKey} AND c.dimensions=${vector.dimensions}
    ORDER BY distance LIMIT 12
  `;
  console.table(rows);
} finally {
  await client.end({ timeout: 2 });
}
