import { client } from '../../infrastructure/database.js';
import { env } from '../../config/env.js';
import { stripe } from './stripe.js';

const subscriptionEvents = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

export async function stripeWebhook(req, res) {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe webhook is not configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  if (!subscriptionEvents.has(event.type)) return res.json({ received: true });

  await client.begin(async tx => {
    const inserted = await tx`INSERT INTO relay.webhook_events (id) VALUES (${event.id}) ON CONFLICT DO NOTHING RETURNING id`;
    if (!inserted.length) return;

    const customerId = typeof event.data.object.customer === 'string'
      ? event.data.object.customer
      : event.data.object.customer.id;
    const rows = await tx`SELECT id FROM relay.workspaces WHERE stripe_customer_id=${customerId} FOR UPDATE`;
    if (!rows.length) throw new Error('Unknown billing customer');

    const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    const subscription = subscriptions.data.find(item => !['canceled', 'incomplete_expired'].includes(item.status)) || subscriptions.data[0];
    if (!subscription) throw new Error('Subscription not found');

    const item = subscription.items.data[0];
    await tx`UPDATE relay.workspaces SET stripe_subscription_id=${subscription.id}, stripe_price_id=${item?.price.id || null}, subscription_status=${subscription.status}, current_period_end=${item?.current_period_end ? new Date(item.current_period_end * 1000) : null}, cancel_at_period_end=${subscription.cancel_at_period_end}, updated_at=now() WHERE id=${rows[0].id}`;
  });

  return res.json({ received: true });
}
