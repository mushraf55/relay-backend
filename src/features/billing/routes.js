import { Router } from 'express';
import { z } from 'zod';
import { appUrl, entitlement, env, prices } from '../../config/env.js';
import { client } from '../../infrastructure/database.js';
import { stripe } from './stripe.js';

export const billingRouter = Router();
const admin = (req, res, next) => req.isAdmin
  ? next()
  : res.status(403).json({ error: 'Workspace admin access required' });
const getWorkspace = async id => (await client`SELECT * FROM relay.workspaces WHERE id=${id}`)[0];

billingRouter.get('/', async (req, res) => {
  const row = await getWorkspace(req.workspaceId);
  res.json({
    ...entitlement(row.stripe_price_id, row.subscription_status, row),
    status: row.subscription_status,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    currentPeriodEnd: row.current_period_end,
    hasCustomer: !!row.stripe_customer_id,
    planChoice: row.plan_choice,
    autoPay: row.auto_pay,
  });
});

billingRouter.post('/free-plan', admin, async (req, res) => {
  const parsed = z.object({
    plan: z.enum(['Trial']),
    autoPay: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid free plan selection' });
  const [row] = await client`
    UPDATE relay.workspaces
    SET plan_choice=${parsed.data.plan}, auto_pay=${parsed.data.autoPay !== false}, updated_at=now()
    WHERE id=${req.workspaceId}
    RETURNING *
  `;
  res.json(entitlement(row.stripe_price_id, row.subscription_status, row));
});

billingRouter.post('/checkout', admin, async (req, res) => {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Configure Stripe and its webhook signing secret before checkout' });
  }

  const parsed = z.object({
    plan: z.enum(['Starter', 'Growth', 'Scale']),
    cycle: z.enum(['Monthly', 'Yearly']),
    autoPay: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid plan or billing cycle' });

  const price = prices[parsed.data.plan][parsed.data.cycle];
  if (!price?.startsWith('price_')) return res.status(503).json({ error: 'This Stripe price is not configured' });

  let customer;
  await client.begin(async tx => {
    const [row] = await tx`SELECT * FROM relay.workspaces WHERE id=${req.workspaceId} FOR UPDATE`;
    customer = row.stripe_customer_id;
    if (!customer) {
      const created = await stripe.customers.create(
        { metadata: { workspaceId: req.workspaceId } },
        { idempotencyKey: `customer:${req.workspaceId}` },
      );
      customer = created.id;
      await tx`UPDATE relay.workspaces SET stripe_customer_id=${customer} WHERE id=${req.workspaceId}`;
    }
    await tx`UPDATE relay.workspaces SET plan_choice=${parsed.data.plan}, auto_pay=${parsed.data.autoPay !== false}, updated_at=now() WHERE id=${req.workspaceId}`;
  });

  const result = await client.begin(async tx => {
    const [row] = await tx`SELECT * FROM relay.workspaces WHERE id=${req.workspaceId} FOR UPDATE`;
    const subscriptions = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    if (subscriptions.data.some(item => !['canceled', 'incomplete_expired'].includes(item.status))) {
      return { error: 'Manage your existing subscription in the billing portal' };
    }

    if (row.checkout_session_id) {
      const existing = await stripe.checkout.sessions.retrieve(row.checkout_session_id);
      if (existing.status === 'open') {
        if (existing.metadata?.price !== price) {
          return { error: 'A checkout for another plan is already open. Complete that checkout or wait until it expires before choosing a different plan.' };
        }
        return { url: existing.url };
      }
    }

    const attempt = row.checkout_attempt + 1;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      metadata: { price, autoPay: String(parsed.data.autoPay !== false) },
      line_items: [{ price, quantity: 1 }],
      client_reference_id: req.workspaceId,
      subscription_data: { metadata: { workspaceId: req.workspaceId, autoPay: String(parsed.data.autoPay !== false) } },
      success_url: `${appUrl}/dashboard/settings?billing=success`,
      cancel_url: `${appUrl}/dashboard/settings?billing=cancelled`,
    }, { idempotencyKey: `checkout:${req.workspaceId}:${attempt}:${price}` });
    await tx`UPDATE relay.workspaces SET checkout_session_id=${session.id}, checkout_attempt=${attempt} WHERE id=${req.workspaceId}`;
    return { url: session.url };
  });

  return res.status(result.error ? 409 : 200).json(result);
});

billingRouter.post('/portal', admin, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured' });
  const row = await getWorkspace(req.workspaceId);
  if (!row.stripe_customer_id) return res.status(400).json({ error: 'No billing account yet' });
  const session = await stripe.billingPortal.sessions.create({
    customer: row.stripe_customer_id,
    return_url: `${appUrl}/dashboard/settings`,
  });
  return res.json({ url: session.url });
});
