import Stripe from 'stripe';
import type { PlanTier } from '@/types';
import { env } from '@/lib/env';

export const stripe = new Stripe(env.stripeSecretKey(), {
  apiVersion: '2024-04-10',
  typescript: true,
});

/** Map a Stripe Price ID back to a plan tier. */
export function tierFromPriceId(priceId: string): PlanTier {
  if (priceId === env.stripeStudentPriceId()) return 'student';
  if (priceId === env.stripeBoardsPriceId())  return 'boards';
  return 'free';
}
