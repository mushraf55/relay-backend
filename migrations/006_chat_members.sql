CREATE TABLE IF NOT EXISTS relay.chat_members (
  room_id uuid NOT NULL REFERENCES relay.chat_rooms(id) ON DELETE CASCADE,
  member_id text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed')),
  session_token_hash text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(room_id,member_id)
);
CREATE INDEX IF NOT EXISTS chat_members_room_status ON relay.chat_members(room_id,status,joined_at);

ALTER TABLE relay.chat_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON relay.chat_members FROM PUBLIC,anon,authenticated;
