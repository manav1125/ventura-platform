import { STRIPE_PLATFORM_FEE_PCT } from '../config.js';

export const PLAN_DEFINITIONS = {
  trial: {
    id: 'trial',
    name: 'Starter Trial',
    price_cents: 0,
    limits: { businesses: 1, tasks_per_month: 3 },
    economics: {
      monthly_subscription_cents: 0,
      api_budget_cents: 0,
      credits_per_month: 200,
      revenue_share_pct: STRIPE_PLATFORM_FEE_PCT,
      tasks_included_per_month: 3,
      infrastructure_included: false
    },
    features: [
      '1 business',
      'Shared infrastructure preview',
      '3 founder-requested tasks / month',
      '200 credits / month',
      'Dashboard + control layer'
    ]
  },
  builder: {
    id: 'builder',
    name: 'Builder',
    price_cents: 4900,
    limits: { businesses: 1, tasks_per_month: 5 },
    economics: {
      monthly_subscription_cents: 4900,
      api_budget_cents: 500,
      credits_per_month: 3000,
      revenue_share_pct: STRIPE_PLATFORM_FEE_PCT,
      tasks_included_per_month: 5,
      infrastructure_included: true
    },
    features: [
      'Daily autonomous loop',
      '5 founder-requested tasks / month',
      '3,000 credits / month',
      'Provisioned infra per company',
      'Live founder approvals + override'
    ]
  },
  fleet: {
    id: 'fleet',
    name: 'Fleet',
    price_cents: 19900,
    limits: { businesses: 5, tasks_per_month: 40 },
    economics: {
      monthly_subscription_cents: 19900,
      api_budget_cents: 2500,
      credits_per_month: 12000,
      revenue_share_pct: 15,
      tasks_included_per_month: 40,
      infrastructure_included: true
    },
    features: [
      '5 businesses',
      '40 founder-requested tasks / month',
      '12,000 credits / month',
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

export function getPlanEconomics(plan = 'trial') {
  return { ...getPlanDefinition(plan).economics };
}

export function resolveBusinessEconomics(business = {}, fallbackPlan = 'trial') {
  const defaults = getPlanEconomics(fallbackPlan);

  return {
    monthly_subscription_cents: Number.isFinite(Number(business.monthly_subscription_cents)) && Number(business.monthly_subscription_cents) >= 0
      ? Number(business.monthly_subscription_cents)
      : defaults.monthly_subscription_cents,
    api_budget_cents: Number.isFinite(Number(business.api_budget_cents)) && Number(business.api_budget_cents) >= 0
      ? Number(business.api_budget_cents)
      : defaults.api_budget_cents,
    revenue_share_pct: Number.isFinite(Number(business.revenue_share_pct)) && Number(business.revenue_share_pct) >= 0
      ? Number(business.revenue_share_pct)
      : defaults.revenue_share_pct,
    tasks_included_per_month: Number.isFinite(Number(business.tasks_included_per_month)) && Number(business.tasks_included_per_month) >= 0
      ? Number(business.tasks_included_per_month)
      : defaults.tasks_included_per_month,
    infrastructure_included: typeof business.infrastructure_included === 'number'
      ? !!business.infrastructure_included
      : typeof business.infrastructure_included === 'boolean'
        ? business.infrastructure_included
        : defaults.infrastructure_included
  };
}

export function serializePlan(plan, stripePriceId = null) {
  const definition = getPlanDefinition(plan);
  const economics = getPlanEconomics(plan);
  return {
    ...definition,
    ...economics,
    stripe_price_id: stripePriceId || null
  };
}
