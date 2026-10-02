CREATE TABLE IF NOT EXISTS relay.deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES relay.workspaces(id) ON DELETE CASCADE,
  bot_id text NOT NULL,
  share_id text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,bot_id)
);
CREATE INDEX IF NOT EXISTS deployments_workspace ON relay.deployments(workspace_id,bot_id);

CREATE TABLE IF NOT EXISTS relay.chat_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES relay.deployments(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  kind text NOT NULL CHECK(kind IN ('group','widget')),
  origin_host text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE relay.chat_rooms ADD COLUMN IF NOT EXISTS origin_host text;
CREATE UNIQUE INDEX IF NOT EXISTS one_group_room_per_deployment ON relay.chat_rooms(deployment_id) WHERE kind='group';

CREATE TABLE IF NOT EXISTS relay.chat_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES relay.chat_rooms(id) ON DELETE CASCADE,
  sender_id text NOT NULL,
  sender_name text NOT NULL,
  role text NOT NULL CHECK(role IN ('member','assistant')),
  content text NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_room ON relay.chat_messages(room_id,id);

ALTER TABLE relay.deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.chat_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.chat_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON relay.deployments,relay.chat_rooms,relay.chat_messages FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE relay.chat_messages_id_seq FROM PUBLIC,anon,authenticated;
