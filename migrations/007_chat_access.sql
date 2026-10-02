ALTER TABLE relay.deployments
  ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'open';
ALTER TABLE relay.deployments DROP CONSTRAINT IF EXISTS deployments_access_mode_check;
ALTER TABLE relay.deployments ADD CONSTRAINT deployments_access_mode_check CHECK(access_mode IN ('open','approval'));

ALTER TABLE relay.chat_members
  ADD COLUMN IF NOT EXISTS account_user_id text,
  ADD COLUMN IF NOT EXISTS requested_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE relay.chat_members DROP CONSTRAINT IF EXISTS chat_members_status_check;
ALTER TABLE relay.chat_members ADD CONSTRAINT chat_members_status_check CHECK(status IN ('pending','active','removed'));
UPDATE relay.chat_members SET approved_at=COALESCE(approved_at,joined_at) WHERE status='active';
CREATE INDEX IF NOT EXISTS chat_members_account_recent ON relay.chat_members(account_user_id,last_seen_at DESC) WHERE account_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_chat_membership_per_account ON relay.chat_members(room_id,account_user_id) WHERE account_user_id IS NOT NULL AND status IN ('active','pending');
