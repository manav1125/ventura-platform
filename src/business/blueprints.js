function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanLower(value) {
  return clean(value).toLowerCase();
}

function uniqueList(values = [], limit = 12) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const cleaned = clean(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function safeParseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function scoreSignals(haystack, signals = []) {
  return signals.reduce((score, signal) => score + (haystack.includes(signal) ? 1 : 0), 0);
}

const COMMON_GENERIC_TITLES = [
  'write full business plan',
  '90-day roadmap',
  'define mvp feature set',
  'build core mvp',
  'build and deploy complete landing page',
  'technical architecture'
];

const BLUEPRINTS = {
  generic_saas: {
    key: 'generic_saas',
    label: 'SaaS Product',
    version: '1',
    category: 'software',
    summary: 'A recurring-revenue software product with product, growth, and retention loops.',
    entities: ['product surface', 'lead', 'customer account', 'subscription', 'support thread'],
    workflows: ['acquire', 'convert', 'activate', 'retain'],
    metrics: ['MRR', 'activation rate', 'trial-to-paid conversion', 'retention'],
    required_artifacts: ['launch_plan', 'positioning brief', 'landing page copy', 'customer acquisition experiment'],
    playbooks: {
      planning: 'Define product positioning, ICP, and priority roadmap.',
      engineering: 'Ship conversion, activation, and reliability improvements.',
      marketing: 'Run acquisition experiments and messaging tests.',
      operations: 'Handle support, onboarding, and renewal readiness.'
    },
    launchTasks(business) {
      return [
        {
          title: `Define the activation path for ${business.name}`,
          department: 'strategy',
          description: `Turn ${business.name}'s offer into a crisp acquisition-to-activation plan with one core conversion path for ${business.target_customer || 'the target customer'}.`,
          workflowKey: 'planning',
          priority: 1
        },
        {
          title: `Ship the first conversion-ready surface for ${business.name}`,
          department: 'engineering',
          description: `Build or refine the highest-leverage public product surface Ventura can use to capture demand and explain the offer clearly.`,
          workflowKey: 'engineering',
          priority: 2
        },
        {
          title: `Research and queue the first qualified growth campaign for ${business.name}`,
          department: 'marketing',
          description: `Identify reachable prospects, the message angle that should work first, and the CTA Ventura should test this week.`,
          workflowKey: 'marketing',
          priority: 3
        },
        {
          title: `Document the first onboarding and support loop for ${business.name}`,
          department: 'operations',
          description: `Define how Ventura should handle inbound interest, user questions, and handoffs once customers start signing up.`,
          workflowKey: 'operations',
          priority: 4
        }
      ];
    },
    cycleTasks({ business, existingTitles = new Set() }) {
      const tasks = [
        {
          title: `Improve ${business.name}'s signup-to-value path`,
          department: 'engineering',
          description: `Tighten the product journey so a new ${business.target_customer || 'customer'} reaches the first value moment faster and with less friction.`,
          workflowKey: 'engineering'
        },
        {
          title: `Run the next qualified acquisition test for ${business.name}`,
          department: 'marketing',
          description: `Use live signals to refine one acquisition experiment that can move toward ${business.goal_90d || 'the 90-day goal'}.`,
          workflowKey: 'marketing'
        },
        {
          title: `Refresh the operating plan for ${business.name}`,
          department: 'strategy',
          description: `Translate the latest product, customer, and revenue signals into an updated priority order and explicit next moves.`,
          workflowKey: 'planning'
        }
      ];
      return filterBlueprintTasks(tasks, existingTitles);
    }
  },
  generic_marketplace: {
    key: 'generic_marketplace',
    label: 'Marketplace',
    version: '1',
    category: 'network',
    summary: 'A two-sided product that has to acquire, qualify, and coordinate supply and demand.',
    entities: ['supply profile', 'demand profile', 'match', 'intro', 'conversation'],
    workflows: ['supply intake', 'demand intake', 'matching', 'intro coordination', 'trust and safety'],
    metrics: ['qualified supply', 'qualified demand', 'match rate', 'intro acceptance rate'],
    required_artifacts: ['market map', 'match criteria', 'intake flow', 'intro playbook'],
    playbooks: {
      planning: 'Balance supply and demand quality, liquidity, and trust.',
      engineering: 'Ship intake, profile, and match coordination surfaces.',
      marketing: 'Acquire the right side of the marketplace with specificity.',
      operations: 'Review quality, handle exceptions, and drive intro throughput.'
    },
    launchTasks(business) {
      return [
        {
          title: `Define the two-sided marketplace workflow for ${business.name}`,
          department: 'strategy',
          description: `Document who joins, what qualifies them, and how Ventura should move each side from application to active match.`,
          workflowKey: 'planning',
          priority: 1
        },
        {
          title: `Build the first intake and profile surfaces for ${business.name}`,
          department: 'engineering',
          description: `Create the pages and data capture flow Ventura needs to collect high-signal marketplace profiles.`,
          workflowKey: 'engineering',
          priority: 2
        },
        {
          title: `Identify the first high-fit supply and demand segments for ${business.name}`,
          department: 'marketing',
          description: `Map the initial audience slices Ventura should target first so the marketplace can start with quality over volume.`,
          workflowKey: 'marketing',
          priority: 3
        },
        {
          title: `Define the first review and intro operations for ${business.name}`,
          department: 'operations',
          description: `Set the acceptance criteria, review queue, and intro handoff rules Ventura should follow to keep the marketplace high-signal.`,
          workflowKey: 'operations',
          priority: 4
        }
      ];
    },
    cycleTasks({ business, existingTitles = new Set() }) {
      const tasks = [
        {
          title: `Improve the highest-friction marketplace step for ${business.name}`,
          department: 'engineering',
          description: `Use the current intake and match flow to reduce one source of drop-off or confusion in the marketplace journey.`,
          workflowKey: 'engineering'
        },
        {
          title: `Refresh match quality criteria for ${business.name}`,
          department: 'strategy',
          description: `Translate the latest signals into sharper qualification rules, scorecards, and next-step recommendations.`,
          workflowKey: 'planning'
        },
        {
          title: `Source the next high-signal marketplace segment for ${business.name}`,
          department: 'marketing',
          description: `Research and queue outreach or content that attracts a more qualified side of the marketplace.`,
          workflowKey: 'marketing'
        }
      ];
      return filterBlueprintTasks(tasks, existingTitles);
    }
  },
  founder_investor_marketplace: {
    key: 'founder_investor_marketplace',
    label: 'Founder-Investor Marketplace',
    version: '1',
    category: 'marketplace',
    summary: 'A curated marketplace that collects founder and investor profiles, scores fit, and coordinates warm introductions.',
    entities: [
      'founder profile',
      'startup profile',
      'investor profile',
      'investor thesis',
      'match',
      'intro',
      'conversation',
      'review decision'
    ],
    workflows: [
      'founder application',
      'investor onboarding',
      'fit scoring',
      'admin review',
      'intro delivery',
      'response tracking'
    ],
    metrics: [
      'qualified founder applications',
      'qualified investors',
      'match quality score',
      'intro sent rate',
      'intro acceptance rate',
      'time to first intro'
    ],
    required_artifacts: [
      'founder intake schema',
      'investor thesis schema',
      'match rationale',
      'intro draft',
      'review rubric',
      'cycle report'
    ],
    playbooks: {
      planning: 'Refine qualification, fit scoring, review rules, and liquidity between founders and investors.',
      engineering: 'Ship founder application flows, investor profiles, match views, and admin matching tools.',
      marketing: 'Attract high-fit founders and investors with sector, stage, and raise-specific messaging.',
      operations: 'Review profiles, coordinate intros, and keep the marketplace trustworthy and responsive.'
    },
    taskGuidance: {
      planning: {
        requirements: [
          'Make qualification logic explicit for both founders and investors.',
          'Every planning task should improve match quality, response rate, or time-to-intro.',
          'Prefer structured schemas, scorecards, and review states over vague strategy output.'
        ],
        context: [
          'This business is a two-sided marketplace, not a generic SaaS app.',
          'The real product is the founder application, investor profile, match engine, and intro workflow.'
        ],
        output: [
          'Return a concrete operating rule, schema, or scorecard Ventura can reuse.',
          'Record how the change affects match quality, trust, or intro throughput.'
        ],
        preferredTools: [
          'create_marketplace_match',
          'update_marketplace_match',
          'log_marketplace_conversation'
        ],
        success: [
          'A founder or investor can move one step further through the marketplace with less ambiguity.'
        ]
      },
      engineering: {
        requirements: [
          'Build real marketplace surfaces: application forms, investor profiles, matches, intros, review queues.',
          'Prefer live records and working flows over placeholder dashboards.',
          'Any UI work should improve the customer-facing founder or investor experience.'
        ],
        context: [
          'The landing page is only the top of funnel. The core product is the matching platform itself.'
        ],
        output: [
          'Ship an app surface, data model, or workflow Ventura can operate directly.',
          'Describe how a founder, investor, or admin will use the new flow.'
        ],
        preferredTools: [
          'write_code',
          'deploy_website'
        ],
        success: [
          'A real marketplace action is possible that was not possible before.'
        ]
      },
      marketing: {
        requirements: [
          'Differentiate messaging for founders and investors where appropriate.',
          'Emphasize match quality, warm intros, and stage-specific fit.',
          'Ground every campaign in a concrete audience slice.'
        ],
        context: [
          'The marketplace must attract both sides without letting quality degrade.'
        ],
        output: [
          'Produce campaign assets or lead lists tied to one side of the marketplace.',
          'Capture the hypothesis about why this segment should convert.'
        ],
        preferredTools: [
          'web_search',
          'create_content',
          'add_lead',
          'post_social'
        ],
        success: [
          'The next acquisition action targets a higher-signal founder or investor segment.'
        ]
      },
      operations: {
        requirements: [
          'Design for trust, reviewability, and clear intro handoffs.',
          'Track responses and unresolved intros explicitly.',
          'Prefer clear state transitions over prose.'
        ],
        context: [
          'Ventura should be able to explain exactly where every founder and investor sits in the intro pipeline.'
        ],
        output: [
          'Leave behind a durable review rule, intro template, or queue state change.',
          'Capture any trust or manual review concerns explicitly.'
        ],
        preferredTools: [
          'create_marketplace_founder',
          'create_marketplace_investor',
          'create_marketplace_match',
          'update_marketplace_match',
          'log_marketplace_conversation'
        ],
        success: [
          'The intro pipeline is easier to audit and less dependent on hidden knowledge.'
        ]
      }
    },
    launchTasks(business) {
      const audience = business.target_customer || 'early-stage founders and high-fit investors';
      return [
        {
          title: `Define the founder application and startup profile schema for ${business.name}`,
          department: 'strategy',
          description: `Design the fields, qualification rules, lifecycle statuses, and acceptance rubric Ventura should use to collect high-signal founder applications from ${audience}.`,
          workflowKey: 'planning',
          priority: 1
        },
        {
          title: `Define the investor profile and thesis schema for ${business.name}`,
          department: 'strategy',
          description: `Specify the investor data Ventura needs to collect, including stage focus, sector fit, geography, check size, and intro preferences.`,
          workflowKey: 'planning',
          priority: 2
        },
        {
          title: `Build the founder application and investor onboarding surfaces for ${business.name}`,
          department: 'engineering',
          description: `Create the real product entry points founders and investors will use after the landing page, including profile capture and submission states.`,
          workflowKey: 'engineering',
          priority: 2
        },
        {
          title: `Implement match records, rationale, and admin review flow for ${business.name}`,
          department: 'engineering',
          description: `Ship the first internal workflow for Ventura to score founder-investor fit, create match records, and queue intros or review decisions.`,
          workflowKey: 'engineering',
          priority: 3
        },
        {
          title: `Source the first qualified founder and investor segments for ${business.name}`,
          department: 'marketing',
          description: `Identify the earliest high-fit founder and investor segments, message them separately, and document the first acquisition motion for each side.`,
          workflowKey: 'marketing',
          priority: 4
        },
        {
          title: `Define intro sequencing and response tracking for ${business.name}`,
          department: 'operations',
          description: `Create the operational playbook Ventura should follow once a founder-investor match is approved, including intro draft, follow-up timing, and response states.`,
          workflowKey: 'operations',
          priority: 4
        }
      ];
    },
    cycleTasks({ business, existingTitles = new Set(), runtime = {} }) {
      const counts = runtime?.marketplace?.counts || {};
      const tasks = [];

      if (!counts.founders) {
        tasks.push({
          title: `Drive the first qualified founder applications for ${business.name}`,
          department: 'marketing',
          description: `Use the live intake flow to attract and capture the first batch of founder applications with stage, raise context, and traction details Ventura can score.`,
          workflowKey: 'marketing'
        });
      } else if (!counts.investors) {
        tasks.push({
          title: `Source the first investor roster for ${business.name}`,
          department: 'marketing',
          description: `Research and queue the first investor segment that fits the current founder pipeline, then create investor-ready targets Ventura can onboard into the marketplace.`,
          workflowKey: 'marketing'
        });
      } else if (!counts.matches) {
        tasks.push({
          title: `Create the first scored founder-investor matches for ${business.name}`,
          department: 'operations',
          description: `Review the live founder and investor records, create candidate matches, and persist rationale plus intro readiness states Ventura can act on.`,
          workflowKey: 'operations'
        });
      }

      if ((counts.matches || 0) > (counts.intros_sent || 0)) {
        tasks.push({
          title: `Queue the next investor introductions for ${business.name}`,
          department: 'operations',
          description: `Move approved matches into queued intro or sent states, persist the intro draft, and leave the intro pipeline in a founder-readable state.`,
          workflowKey: 'operations'
        });
      }

      if ((counts.open_conversations || 0) > 0) {
        tasks.push({
          title: `Advance open investor conversations for ${business.name}`,
          department: 'operations',
          description: `Review active intro threads, log the latest response state, and make the next follow-up or acceptance outcome explicit inside the marketplace runtime.`,
          workflowKey: 'operations'
        });
      }

      if ((counts.pending_reviews || 0) > 0) {
        tasks.push({
          title: `Clear the founder-investor review queue for ${business.name}`,
          department: 'operations',
          description: `Work through pending founder, investor, or match review decisions so Ventura can keep the intro pipeline moving without hidden blockers.`,
          workflowKey: 'operations'
        });
      }

      tasks.push(
        {
          title: `Improve the founder application flow for ${business.name}`,
          department: 'engineering',
          description: `Reduce friction in the founder intake experience and ensure Ventura captures stage, sector, traction, raise context, and contact details cleanly.`,
          workflowKey: 'engineering'
        },
        {
          title: `Refine the investor fit scorecard for ${business.name}`,
          department: 'strategy',
          description: `Turn the latest marketplace signals into a sharper match-scoring rubric Ventura can use before sending intros.`,
          workflowKey: 'planning'
        },
        {
          title: `Tighten intro operations and response tracking for ${business.name}`,
          department: 'operations',
          description: `Make the intro queue clearer, surface blocked conversations, and leave explicit follow-up states Ventura can audit.`,
          workflowKey: 'operations'
        }
      );
      return filterBlueprintTasks(tasks, existingTitles);
    }
  }
};

function filterBlueprintTasks(tasks, existingTitles = new Set()) {
  return tasks.filter(task => {
    const title = cleanLower(task.title);
    return title && !existingTitles.has(title);
  }).slice(0, 5);
}

function inferBlueprintKey(input = {}) {
  const haystack = cleanLower([
    input.name,
    input.type,
    input.description,
    input.target_customer,
    input.targetCustomer,
    input.goal_90d,
    input.goal90d
  ].filter(Boolean).join(' '));

  const founderInvestorSignals = [
    'founder', 'investor', 'fundraising', 'fundraise', 'pre-seed', 'seed round',
    'venture', 'vc', 'angel', 'warm intro', 'intro', 'matchmaking', 'thesis'
  ];
  const founderInvestorScore = scoreSignals(haystack, founderInvestorSignals);
  if ((haystack.includes('founder') && haystack.includes('investor')) || founderInvestorScore >= 4) {
    return 'founder_investor_marketplace';
  }

  const type = cleanLower(input.type);
  if (type === 'marketplace') return 'generic_marketplace';
  if (type === 'saas') return 'generic_saas';
  if (type === 'agency') return 'generic_saas';
  if (type === 'content') return 'generic_saas';
  if (type === 'education') return 'generic_saas';
  if (type === 'ecommerce') return 'generic_marketplace';
  return 'generic_saas';
}

export function getBlueprintDefinition(key) {
  return BLUEPRINTS[key] || BLUEPRINTS.generic_saas;
}

export function resolveBusinessBlueprint(input = {}) {
  const key = inferBlueprintKey(input);
  const definition = getBlueprintDefinition(key);
  const config = {
    inferred: true,
    source_type: clean(input.type) || null,
    source_signals: uniqueList([
      clean(input.name),
      clean(input.type),
      clean(input.targetCustomer || input.target_customer),
      clean(input.goal90d || input.goal_90d)
    ], 6)
  };

  return {
    ...definition,
    config
  };
}

export function getBusinessBlueprint(business = {}) {
  if (clean(business.blueprint_key)) {
    const definition = getBlueprintDefinition(business.blueprint_key);
    return {
      ...definition,
      label: clean(business.blueprint_label) || definition.label,
      version: clean(business.blueprint_version) || definition.version,
      config: safeParseJson(business.blueprint_config, {})
    };
  }
  return resolveBusinessBlueprint(business);
}

export function serializeBlueprint(blueprint) {
  if (!blueprint) return null;
  return {
    key: blueprint.key,
    label: blueprint.label,
    version: blueprint.version,
    category: blueprint.category,
    summary: blueprint.summary,
    entities: blueprint.entities || [],
    workflows: blueprint.workflows || [],
    metrics: blueprint.metrics || [],
    required_artifacts: blueprint.required_artifacts || [],
    playbooks: blueprint.playbooks || {},
    config: blueprint.config || {}
  };
}

export function buildBlueprintStorage(input = {}) {
  const blueprint = resolveBusinessBlueprint(input);
  return {
    blueprint,
    columns: {
      blueprint_key: blueprint.key,
      blueprint_label: blueprint.label,
      blueprint_version: blueprint.version,
      blueprint_config: JSON.stringify(blueprint.config || {})
    }
  };
}

export function isGenericBlueprintTask(task = {}) {
  const title = cleanLower(task.title);
  return COMMON_GENERIC_TITLES.some(fragment => title.includes(fragment));
}

function normaliseBlueprintTask(task) {
  return {
    title: clean(task.title),
    department: clean(task.department) || 'strategy',
    description: clean(task.description),
    workflowKey: clean(task.workflowKey),
    priority: Number(task.priority || 5)
  };
}

export function getInitialBlueprintTasks(business, launchPlanTasks = []) {
  const blueprint = getBusinessBlueprint(business);
  const planned = Array.isArray(launchPlanTasks)
    ? launchPlanTasks.map(normaliseBlueprintTask).filter(task => task.title && task.description)
    : [];
  const blueprintTasks = (typeof blueprint.launchTasks === 'function' ? blueprint.launchTasks(business) : [])
    .map(normaliseBlueprintTask)
    .filter(task => task.title && task.description);

  if (!planned.length) return blueprintTasks;
  if (!blueprintTasks.length) return planned;

  const genericCount = planned.filter(isGenericBlueprintTask).length;
  if (genericCount >= Math.ceil(planned.length / 2) || blueprint.key === 'founder_investor_marketplace') {
    return blueprintTasks;
  }

  const seen = new Set();
  return [...planned, ...blueprintTasks]
    .filter(task => {
      const title = cleanLower(task.title);
      if (!title || seen.has(title)) return false;
      seen.add(title);
      return true;
    })
    .slice(0, 8);
}

export function getBlueprintFallbackTasks({
  business,
  existingTitles = new Set(),
  runtime = {}
}) {
  const blueprint = getBusinessBlueprint(business);
  if (typeof blueprint.cycleTasks !== 'function') return [];
  return blueprint.cycleTasks({ business, existingTitles, runtime }).map(normaliseBlueprintTask);
}

export function getBlueprintTaskGuidance(business, workflowKey) {
  const blueprint = getBusinessBlueprint(business);
  const guide = blueprint.taskGuidance?.[workflowKey] || {};
  return {
    blueprint: serializeBlueprint(blueprint),
    requirements: uniqueList(guide.requirements || [], 6),
    context: uniqueList(guide.context || [], 6),
    output: uniqueList(guide.output || [], 6),
    preferredTools: uniqueList(guide.preferredTools || [], 8),
    success: uniqueList(guide.success || [], 6)
  };
}

export function formatBlueprintArtifactContent(blueprint) {
  return [
    `${blueprint.label}`,
    '',
    blueprint.summary,
    '',
    'Entities:',
    ...(blueprint.entities || []).map(item => `- ${item}`),
    '',
    'Workflows:',
    ...(blueprint.workflows || []).map(item => `- ${item}`),
    '',
    'Key metrics:',
    ...(blueprint.metrics || []).map(item => `- ${item}`),
    '',
    'Required artifacts:',
    ...(blueprint.required_artifacts || []).map(item => `- ${item}`)
  ].join('\n');
}
