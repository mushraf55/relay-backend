CREATE SCHEMA IF NOT EXISTS relay;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE TABLE IF NOT EXISTS relay.workspaces (
  id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 0,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  stripe_price_id text,
  subscription_status text NOT NULL DEFAULT 'free',
  plan_choice text NOT NULL DEFAULT 'Trial',
  trial_started_at timestamptz NOT NULL DEFAULT now(),
  auto_pay boolean NOT NULL DEFAULT true,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS relay.webhook_events (
  id text PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE relay.workspaces ADD COLUMN IF NOT EXISTS checkout_session_id text;
ALTER TABLE relay.workspaces ADD COLUMN IF NOT EXISTS checkout_attempt integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS relay.document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES relay.workspaces(id) ON DELETE CASCADE,
  bot_id text NOT NULL,
  source_id text NOT NULL,
  content text NOT NULL,
  embedding_model text NOT NULL,
  embedding extensions.vector(1536),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_workspace_bot ON relay.document_chunks(workspace_id,bot_id);
ALTER TABLE relay.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.document_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA relay FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA relay FROM PUBLIC, anon, authenticated;
