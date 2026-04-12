import Stripe from 'stripe';
import type { PlanTier, PlanLimits } from '@/types';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-04-10',
  typescript: true,
});

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free:        { pdfsPerMonth: 2,    maxQuestionsPerPdf: 50  },
  student:     { pdfsPerMonth: 20,   maxQuestionsPerPdf: 300 },
  boards:      { pdfsPerMonth: null, maxQuestionsPerPdf: 500 },
  institution: { pdfsPerMonth: null, maxQuestionsPerPdf: 500 },
};

export const STRIPE_PRICE_IDS = {
  student: process.env.STRIPE_STUDENT_PRICE_ID!,
  boards:  process.env.STRIPE_BOARDS_PRICE_ID!,
};

/** Map a Stripe Price ID back to a plan tier. */
export function tierFromPriceId(priceId: string): PlanTier {
  if (priceId === STRIPE_PRICE_IDS.student) return 'student';
  if (priceId === STRIPE_PRICE_IDS.boards)  return 'boards';
  return 'free';
}
