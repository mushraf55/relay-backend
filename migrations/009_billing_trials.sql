ALTER TABLE relay.workspaces ADD COLUMN IF NOT EXISTS plan_choice text NOT NULL DEFAULT 'Trial';
ALTER TABLE relay.workspaces ADD COLUMN IF NOT EXISTS trial_started_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE relay.workspaces ADD COLUMN IF NOT EXISTS auto_pay boolean NOT NULL DEFAULT true;
UPDATE relay.workspaces SET plan_choice='Trial' WHERE plan_choice NOT IN ('Trial','Starter','Growth','Scale');
