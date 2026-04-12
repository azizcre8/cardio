/**
 * POST /api/webhook/stripe
 * Handles Stripe subscription lifecycle events.
 * bodyParser MUST be disabled — Stripe signature verification requires raw bytes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { stripe, tierFromPriceId } from '@/lib/stripe';
import { supabaseAdmin } from '@/lib/supabase';
import type Stripe from 'stripe';

// body is read as text below; Next.js App Router does not use bodyParser


export async function POST(req: NextRequest) {
  const body      = await req.text();
  const signature = req.headers.get('stripe-signature') ?? '';

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (e) {
    return NextResponse.json({ error: `Webhook signature failed: ${(e as Error).message}` }, { status: 400 });
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
        return NextResponse.json({ error: 'DB update failed' }, { status: 500 });
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
        return NextResponse.json({ error: 'DB update failed' }, { status: 500 });
      }
      break;
    }

    default:
      // Ignore unhandled event types
      break;
  }

  return NextResponse.json({ received: true });
}
