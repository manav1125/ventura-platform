// src/integrations/stripe.js
// Stripe Connect:
//   - Create Connect Express accounts per business
//   - Receive webhooks to track revenue
//   - Platform fee is STRIPE_PLATFORM_FEE_PCT % on each transaction

import Stripe from 'stripe';
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PLATFORM_FEE_PCT, FRONTEND_URL } from '../config.js';
import { getDb } from '../db/migrate.js';
import { logActivity } from '../agents/activity.js';
import { emitToBusiness } from '../ws/websocket.js';

const stripe = new Stripe(STRIPE_SECRET_KEY || 'sk_test_placeholder');

// ─── Create a Stripe Connect account for a business ───────────────────────────

export async function createConnectAccount(business, user) {
  if (!STRIPE_SECRET_KEY) {
    console.log('[Stripe] No key configured — skipping Connect account creation');
    return null;
  }

  const account = await stripe.accounts.create({
    type: 'express',
    email: user.email,
    business_type: 'individual',
    metadata: { ventura_business_id: business.id, ventura_user_id: user.id },
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } }
  });

  const db = getDb();
  db.prepare('UPDATE businesses SET stripe_account_id=? WHERE id=?').run(account.id, business.id);

  return account;
}

// Onboarding link so the user can complete Stripe KYC
export async function createOnboardingLink(stripeAccountId, businessId) {
  const link = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: `${FRONTEND_URL}#settings?stripe=refresh&business=${businessId}`,
    return_url:  `${FRONTEND_URL}#settings?stripe=complete&business=${businessId}`,
    type: 'account_onboarding'
  });
  return link.url;
}

// ─── Webhook handler — receives Stripe events ─────────────────────────────────

export async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook error' });
  }

  const db = getDb();

  switch (event.type) {

    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      const businessId = pi.metadata?.ventura_business_id;
      if (!businessId) break;

      const business = db.prepare('SELECT revenue_share_pct FROM businesses WHERE id = ?').get(businessId);
      const feePct = Number.isFinite(Number(business?.revenue_share_pct)) && Number(business?.revenue_share_pct) >= 0
        ? Number(business.revenue_share_pct)
        : STRIPE_PLATFORM_FEE_PCT;
      const amountCents = pi.amount - Math.floor(pi.amount * feePct / 100);

      db.prepare(`
        UPDATE businesses
        SET total_revenue_cents = total_revenue_cents + ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(amountCents, businessId);

      db.prepare(`
        INSERT INTO metrics (id, business_id, date, revenue_cents)
        VALUES (?, ?, date('now'), ?)
        ON CONFLICT(business_id, date) DO UPDATE SET revenue_cents = revenue_cents + ?
      `).run(`met_${Date.now()}`, businessId, amountCents, amountCents);

      await logActivity(businessId, {
        type: 'revenue',
        department: 'finance',
        title: `Payment received: $${(amountCents / 100).toFixed(2)}`,
        detail: { amount_cents: amountCents, payment_intent_id: pi.id }
      });

      emitToBusiness(businessId, {
        event: 'revenue:new',
        amountCents,
        total: db.prepare('SELECT total_revenue_cents FROM businesses WHERE id=?').get(businessId)?.total_revenue_cents
      });
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const businessId = sub.metadata?.ventura_business_id;
      if (!businessId) break;

      // Recalculate MRR from active subscriptions
      const mrrCents = sub.status === 'active'
        ? Math.floor(sub.items.data.reduce((acc, item) => acc + (item.price.unit_amount * item.quantity), 0))
        : 0;

      db.prepare(`
        UPDATE businesses SET mrr_cents=?, updated_at=datetime('now') WHERE id=?
      `).run(mrrCents, businessId);

      await logActivity(businessId, {
        type: 'revenue',
        department: 'finance',
        title: `MRR updated: $${(mrrCents / 100).toFixed(2)}/mo`,
        detail: { subscription_id: sub.id, status: sub.status }
      });
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const businessId = sub.metadata?.ventura_business_id;
      if (!businessId) break;

      await logActivity(businessId, {
        type: 'alert',
        department: 'finance',
        title: `Subscription cancelled`,
        detail: { subscription_id: sub.id }
      });
      break;
    }
  }

  res.json({ received: true });
}

// ─── Retrieve revenue summary for a business ─────────────────────────────────

export async function getRevenueMetrics(stripeAccountId) {
  if (!STRIPE_SECRET_KEY || !stripeAccountId) return null;

  try {
    const balance = await stripe.balance.retrieve({ stripeAccount: stripeAccountId });
    return {
      available: balance.available.reduce((sum, b) => sum + b.amount, 0),
      pending: balance.pending.reduce((sum, b) => sum + b.amount, 0)
    };
  } catch {
    return null;
  }
}
