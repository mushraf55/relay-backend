import Stripe from 'stripe';
import { env } from '../../config/env.js';

export const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 2,
    appInfo: { name: 'Relay', version: '1.0.0' },
  })
  : null;
