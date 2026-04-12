// src/routes/billing.js
// Billing and subscription management
// Handles plan upgrades, Stripe checkout sessions, portal access

import express from 'express';
import Stripe from 'stripe';
import { requireAuth } from '../auth/auth.js';
import { getDb } from '../db/migrate.js';
import {
  FRONTEND_URL,
  STRIPE_PRICE_BUILDER_MONTHLY,
  STRIPE_PRICE_FLEET_MONTHLY,
  STRIPE_PRICE_CREDITS_1000,
  STRIPE_PRICE_CREDITS_5000,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET
} from '../config.js';
import { getPlanDefinition, serializePlan } from '../billing/plans.js';
import { getCreditsStatus, grantCredits } from '../billing/usage.js';

const router = express.Router();
const stripe = new Stripe(STRIPE_SECRET_KEY || 'sk_test_placeholder');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ── Price IDs (set these in your Stripe dashboard, then update here) ──────────
const PRICES = {
  builder_monthly: STRIPE_PRICE_BUILDER_MONTHLY || null,
  fleet_monthly:   STRIPE_PRICE_FLEET_MONTHLY || null,
  credits_1000:    STRIPE_PRICE_CREDITS_1000 || null,
  credits_5000:    STRIPE_PRICE_CREDITS_5000 || null
};

// GET /api/billing/plans — return available plans and current plan
router.get('/plans', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT plan FROM users WHERE id=?').get(req.user.sub);

  res.json({
    current: user.plan,
    plans: [
      serializePlan('trial'),
      serializePlan('builder', PRICES.builder_monthly),
      serializePlan('fleet', PRICES.fleet_monthly)
    ]
  });
}));

// POST /api/billing/checkout — create a Stripe checkout session for plan upgrade
router.post('/checkout', requireAuth, asyncHandler(async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY.' });
  }

  const { plan } = req.body;
  if (!['builder', 'fleet'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }
  const priceId = PRICES[`${plan}_monthly`];
  if (!priceId) {
    return res.status(503).json({ error: `Stripe price for the ${plan} plan is not configured yet.` });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.sub);

  // Get or create Stripe customer
  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name,
      metadata: { ventura_user_id: user.id }
    });
    customerId = customer.id;
    db.prepare('UPDATE users SET stripe_customer_id=? WHERE id=?').run(customerId, user.id);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: 'subscription',
    success_url: `${FRONTEND_URL}?upgrade=success&plan=${plan}`,
    cancel_url: `${FRONTEND_URL}?upgrade=cancelled`,
    metadata: { ventura_user_id: user.id, plan },
    subscription_data: {
      metadata: { ventura_user_id: user.id, plan }
    }
  });

  res.json({ url: session.url, sessionId: session.id });
}));

// POST /api/billing/topup — purchase credits
router.post('/topup', requireAuth, asyncHandler(async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY.' });
  }

  const { pack } = req.body;
  if (!['credits_1000', 'credits_5000'].includes(pack)) {
    return res.status(400).json({ error: 'Invalid credit pack' });
  }
  const priceId = PRICES[pack];
  if (!priceId) {
    return res.status(503).json({ error: `Stripe price for ${pack} is not configured yet.` });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.sub);

  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name,
      metadata: { ventura_user_id: user.id }
    });
    customerId = customer.id;
    db.prepare('UPDATE users SET stripe_customer_id=? WHERE id=?').run(customerId, user.id);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: 'payment',
    success_url: `${FRONTEND_URL}?topup=success&pack=${pack}`,
    cancel_url: `${FRONTEND_URL}?topup=cancelled`,
    metadata: { ventura_user_id: user.id, pack }
  });

  res.json({ url: session.url, sessionId: session.id });
}));

// POST /api/billing/portal — open Stripe customer portal for subscription management
router.post('/portal', requireAuth, asyncHandler(async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  const db = getDb();
  const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id=?').get(req.user.sub);
  if (!user.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found' });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: FRONTEND_URL,
  });

  res.json({ url: session.url });
}));

// POST /api/billing/webhook — Stripe subscription lifecycle events
router.post('/webhook',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).json({ error: `Webhook signature failed: ${err.message}` });
    }

    const db = getDb();

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.ventura_user_id;
        const plan = session.metadata?.plan;
        const pack = session.metadata?.pack;
        if (userId && plan) {
          db.prepare("UPDATE users SET plan=?, updated_at=datetime('now') WHERE id=?").run(plan, userId);
          console.log(`✅ User ${userId} upgraded to ${plan}`);
        } else if (userId && pack) {
          const credits = pack === 'credits_5000' ? 5000 : 1000;
          grantCredits(db, userId, credits, `Stripe top-up: ${pack}`);
          console.log(`✅ User ${userId} added ${credits} credits`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const user = db.prepare('SELECT id FROM users WHERE stripe_customer_id=?').get(customerId);
        if (user) {
          db.prepare("UPDATE users SET plan='trial', updated_at=datetime('now') WHERE id=?").run(user.id);
          console.log(`⚠️ User ${user.id} subscription cancelled — reverted to trial`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const customerId = inv.customer;
        const user = db.prepare('SELECT * FROM users WHERE stripe_customer_id=?').get(customerId);
        if (user) {
          const { sendEmail } = await import('../integrations/email.js');
          await sendEmail({
            to: user.email,
            subject: 'Payment failed — action needed',
            html: `<p>Hi ${user.name}, your Ventura payment failed. <a href="${FRONTEND_URL}">Open your Ventura dashboard</a> to update billing and keep your businesses running.</p>`
          }).catch(() => {});
        }
        break;
      }
    }

    res.json({ received: true });
  })
);

// GET /api/billing/usage — current month usage stats
router.get('/usage', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT plan FROM users WHERE id=?').get(req.user.sub);

  const tasksThisMonth = db.prepare(`
    SELECT COUNT(*) as n FROM tasks t
    JOIN businesses b ON b.id = t.business_id
    WHERE b.user_id = ?
    AND t.triggered_by = 'user'
    AND date(t.created_at) >= date('now', 'start of month')
  `).get(req.user.sub).n;

  const businessCount = db.prepare('SELECT COUNT(*) as n FROM businesses WHERE user_id=?').get(req.user.sub).n;

  const planLimits = getPlanDefinition(user.plan).limits;
  const credits = getCreditsStatus(db, req.user.sub, user.plan);
  const usageTotals = db.prepare(`
    SELECT
      COALESCE(SUM(cost_cents), 0) AS cost_cents,
      COALESCE(SUM(credits), 0) AS credits_spent
    FROM usage_events
    WHERE user_id = ?
      AND datetime(created_at) >= datetime('now', 'start of month')
  `).get(req.user.sub);

  res.json({
    plan: user.plan,
    tasks: {
      used: tasksThisMonth,
      limit: planLimits.tasks_per_month,
      pct: Math.min(100, Math.round((tasksThisMonth / Math.max(planLimits.tasks_per_month, 1)) * 100))
    },
    businesses: {
      used: businessCount,
      limit: planLimits.businesses,
      pct: Math.min(100, Math.round((businessCount / Math.max(planLimits.businesses, 1)) * 100))
    },
    credits: {
      ...credits,
      spent: Number(usageTotals?.credits_spent || 0),
      cost_cents: Number(usageTotals?.cost_cents || 0)
    }
  });
}));

export default router;
