CREATE TABLE IF NOT EXISTS relay.ai_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES relay.workspaces(id) ON DELETE CASCADE,
  bot_id text NOT NULL,
  source_id text NOT NULL,
  source_hash text NOT NULL,
  model_key text NOT NULL,
  dimensions integer NOT NULL,
  content text NOT NULL,
  embedding extensions.vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_chunks_scope ON relay.ai_chunks(workspace_id,bot_id,model_key,dimensions);
ALTER TABLE relay.ai_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON relay.ai_chunks FROM PUBLIC,anon,authenticated;
