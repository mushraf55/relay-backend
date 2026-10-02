CREATE TABLE IF NOT EXISTS relay.knowledge_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES relay.workspaces(id) ON DELETE CASCADE,
  bot_id text NOT NULL,
  source_id text NOT NULL,
  object_key text NOT NULL UNIQUE,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 10485760),
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,source_id)
);
ALTER TABLE relay.knowledge_files ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE relay.knowledge_files ADD COLUMN IF NOT EXISTS error_message text;
CREATE INDEX IF NOT EXISTS knowledge_files_scope ON relay.knowledge_files(workspace_id,bot_id);
ALTER TABLE relay.knowledge_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON relay.knowledge_files FROM PUBLIC,anon,authenticated;
