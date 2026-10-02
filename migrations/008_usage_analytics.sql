ALTER TABLE relay.knowledge_files ADD COLUMN IF NOT EXISTS uploaded_by_user_id text;
ALTER TABLE relay.ai_chunks ADD COLUMN IF NOT EXISTS created_by_user_id text;
CREATE INDEX IF NOT EXISTS knowledge_files_uploader ON relay.knowledge_files(workspace_id,uploaded_by_user_id);
CREATE INDEX IF NOT EXISTS ai_chunks_creator ON relay.ai_chunks(workspace_id,created_by_user_id);

CREATE TABLE IF NOT EXISTS relay.usage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES relay.workspaces(id) ON DELETE CASCADE,
  user_id text,
  metric text NOT NULL CHECK(metric IN ('ai_calls','embedding_calls','embedded_chunks')),
  quantity integer NOT NULL DEFAULT 1 CHECK(quantity > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_workspace_period ON relay.usage_events(workspace_id,created_at DESC,metric);
CREATE INDEX IF NOT EXISTS usage_events_user_period ON relay.usage_events(workspace_id,user_id,created_at DESC);
ALTER TABLE relay.usage_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON relay.usage_events FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE relay.usage_events_id_seq FROM PUBLIC,anon,authenticated;
