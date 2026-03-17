import { STRIPE_PLATFORM_FEE_PCT } from '../config.js';

export const PLAN_DEFINITIONS = {
  trial: {
    id: 'trial',
    name: 'Starter Trial',
    price_cents: 0,
    limits: { businesses: 1, tasks_per_month: 3 },
    features: [
      '1 business',
      'Shared infrastructure preview',
      '3 founder-requested tasks / month',
      'Dashboard + control layer'
    ]
  },
  builder: {
    id: 'builder',
    name: 'Builder',
    price_cents: 4900,
    limits: { businesses: 1, tasks_per_month: 5 },
    features: [
      'Daily autonomous loop',
      '5 founder-requested tasks / month',
      'Provisioned infra per company',
      'Live founder approvals + override'
    ]
  },
  fleet: {
    id: 'fleet',
    name: 'Fleet',
    price_cents: 19900,
    limits: { businesses: 5, tasks_per_month: 40 },
    features: [
      '5 businesses',
      '40 founder-requested tasks / month',
      'Cross-business oversight',
      'Priority specialist agents'
    ]
  }
};

export function getPlanDefinition(plan = 'trial') {
  return PLAN_DEFINITIONS[plan] || PLAN_DEFINITIONS.trial;
}

export function getPlanLimits(plan = 'trial') {
  return getPlanDefinition(plan).limits;
}

export function serializePlan(plan, stripePriceId = null) {
  const definition = getPlanDefinition(plan);
  return {
    ...definition,
    revenue_share_pct: STRIPE_PLATFORM_FEE_PCT,
    infrastructure_included: plan !== 'trial',
    stripe_price_id: stripePriceId || null
  };
}
