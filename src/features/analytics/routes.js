import { Router } from 'express';
import { client } from '../../infrastructure/database.js';
import { entitlement } from '../../config/env.js';
import { workspaceUsage } from './usage.js';

export const analyticsRouter = Router();
analyticsRouter.get('/usage', async (req, res) => {
  const [workspace] = await client`SELECT stripe_price_id,subscription_status,plan_choice,trial_started_at,auto_pay FROM relay.workspaces WHERE id=${req.workspaceId}`;
  const plan = entitlement(workspace?.stripe_price_id, workspace?.subscription_status, workspace);
  res.json(await workspaceUsage(req.workspaceId, req.userId, plan));
});
