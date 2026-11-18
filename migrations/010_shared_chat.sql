CREATE TABLE IF NOT EXISTS relay.chat_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES relay.deployments(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_invitations_deployment ON relay.chat_invitations(deployment_id,created_at DESC);
ALTER TABLE relay.chat_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON relay.chat_invitations FROM PUBLIC,anon,authenticated;
