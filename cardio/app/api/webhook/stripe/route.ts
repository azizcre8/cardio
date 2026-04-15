/**
 * POST /api/webhook/stripe
 * Handles Stripe subscription lifecycle events.
 * bodyParser MUST be disabled — Stripe signature verification requires raw bytes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { stripe, tierFromPriceId } from '@/lib/stripe';
import { supabaseAdmin } from '@/lib/supabase';
import { env } from '@/lib/env';
import type Stripe from 'stripe';
import { jsonError, jsonOk } from '@/lib/api';

// body is read as text below; Next.js App Router does not use bodyParser


export async function POST(req: NextRequest) {
  const body      = await req.text();
  const signature = req.headers.get('stripe-signature') ?? '';

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, env.stripeWebhookSecret());
  } catch (e) {
    return jsonError(`Webhook signature failed: ${(e as Error).message}`, 400);
  }

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = sub.customer as string;
      const priceId    = sub.items.data[0]?.price.id ?? '';
      const tier       = tierFromPriceId(priceId);

      const { error } = await supabaseAdmin
        .from('users')
        .update({ plan: tier, stripe_subscription_id: sub.id })
        .eq('stripe_customer_id', customerId);

      if (error) {
        console.error('Webhook: failed to update plan:', error.message);
        return jsonError('DB update failed');
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = sub.customer as string;

      const { error } = await supabaseAdmin
        .from('users')
        .update({ plan: 'free', stripe_subscription_id: null })
        .eq('stripe_customer_id', customerId);

      if (error) {
        console.error('Webhook: failed to reset plan:', error.message);
        return jsonError('DB update failed');
      }
      break;
    }

    default:
      // Ignore unhandled event types
      break;
  }

  return jsonOk({ received: true });
}
