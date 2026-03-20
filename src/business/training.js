import { getBusinessBlueprint, serializeBlueprint } from './blueprints.js';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
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

const UNIVERSAL_STANDARDS = {
  mission: [
    'Work against the actual business model, not a generic startup checklist.',
    'Prioritise outputs that create real product, revenue, or marketplace movement.',
    'Leave every task with an explicit next state Ventura can continue from later.'
  ],
  execution: [
    'Prefer a working surface, live record, or shipped asset over strategy prose.',
    'Every meaningful task should produce an artifact, state change, or measurable output.',
    'Do not claim completion unless the system changed in a verifiable way.'
  ],
  safety: [
    'Route risky sends, deploys, or public actions through the approval layer when needed.',
    'Keep side effects auditable with artifacts, events, and operation logs.',
    'If a task is blocked, record the blocker explicitly instead of hiding it in narrative.'
  ],
  quality: [
    'Use concrete business context, ICP details, and current workflow state in every task.',
    'Avoid placeholder, literal, or self-referential customer-facing copy.',
    'Treat verification as part of completion, not as a separate nice-to-have.'
  ]
};

const UNIVERSAL_SKILLS = [
  {
    key: 'research',
    label: 'Research and signal gathering',
    summary: 'Turn live information into actionable founder-facing context.',
    checklist: [
      'Start from the business goal and current bottleneck.',
      'Capture source-backed findings as reusable artifacts.',
      'Translate findings into a specific next step, not just notes.'
    ]
  },
  {
    key: 'messaging',
    label: 'Customer-facing messaging',
    summary: 'Write for the end customer, not for internal operators.',
    checklist: [
      'Lead with customer outcome and why-now value.',
      'Remove meta language about conversion, positioning, or page structure.',
      'Make every CTA and supporting line feel product-specific.'
    ]
  },
  {
    key: 'shipping',
    label: 'Product and workflow shipping',
    summary: 'Prefer real app and workflow changes over placeholders.',
    checklist: [
      'Create the underlying record, route, or surface needed for the workflow.',
      'Tie UI work to actual stored state and user actions.',
      'Log the shipped result so Ventura can reference it later.'
    ]
  },
  {
    key: 'operations',
    label: 'Operational clarity',
    summary: 'Keep the platform explainable, reviewable, and recoverable.',
    checklist: [
      'Track statuses explicitly.',
      'Leave founder-readable summaries for major actions.',
      'Capture retries, unresolved items, and approvals clearly.'
    ]
  }
];

const DEPARTMENT_BASE_PLAYBOOKS = {
  planning: {
    title: 'Planning loop playbook',
    purpose: 'Turn market and workflow signals into the next explicit operating move.',
    rules: [
      'Reduce ambiguity in schemas, scorecards, priorities, or review criteria.',
      'Avoid broad strategy docs unless they directly unlock the next workflow step.',
      'Leave the next 7-day execution move obvious.'
    ],
    outputs: [
      'schema',
      'scorecard',
      'decision rubric',
      'priority memo',
      'match rationale'
    ]
  },
  engineering: {
    title: 'Engineering loop playbook',
    purpose: 'Ship real product and workflow surfaces the business can use today.',
    rules: [
      'Prefer user-facing flows, data capture, and admin tooling over abstract architecture.',
      'Connect UI to persisted state whenever possible.',
      'Treat deployed surfaces and valid routes as the unit of progress.'
    ],
    outputs: [
      'route',
      'dashboard surface',
      'form flow',
      'record model',
      'site update'
    ]
  },
  marketing: {
    title: 'Marketing loop playbook',
    purpose: 'Acquire qualified demand with clear, segment-specific messaging.',
    rules: [
      'Choose one audience slice and one clear CTA per campaign.',
      'Ground claims in actual platform capability and proof.',
      'Leave send-ready copy or a concrete prospect list.'
    ],
    outputs: [
      'campaign brief',
      'landing page copy',
      'lead list',
      'email sequence',
      'ad/message test'
    ]
  },
  operations: {
    title: 'Operations loop playbook',
    purpose: 'Keep the business responsive, auditable, and founder-safe.',
    rules: [
      'Use explicit states, queues, and handoffs.',
      'Surface trust, compliance, or review risks clearly.',
      'Optimize for response quality and turnaround time.'
    ],
    outputs: [
      'ops checklist',
      'intro workflow',
      'review queue rule',
      'response template',
      'recovery note'
    ]
  }
};

function workflowPlaybook(workflowKey, blueprint) {
  const base = DEPARTMENT_BASE_PLAYBOOKS[workflowKey] || DEPARTMENT_BASE_PLAYBOOKS.operations;
  return {
    workflow_key: workflowKey,
    title: base.title,
    purpose: base.purpose,
    rules: uniqueList([
      ...(blueprint.taskGuidance?.[workflowKey]?.requirements || []),
      ...(blueprint.taskGuidance?.[workflowKey]?.context || []),
      ...base.rules
    ], 10),
    outputs: uniqueList([
      ...(blueprint.taskGuidance?.[workflowKey]?.output || []),
      ...base.outputs
    ], 10),
    success: uniqueList([
      ...(blueprint.taskGuidance?.[workflowKey]?.success || []),
      'The next operator can understand what happened and continue without guessing.'
    ], 8)
  };
}

export function getBusinessTrainingPack(business) {
  const blueprint = getBusinessBlueprint(business);
  return {
    business: {
      id: business.id,
      name: business.name,
      type: business.type
    },
    blueprint: serializeBlueprint(blueprint),
    universal_standards: UNIVERSAL_STANDARDS,
    universal_skills: UNIVERSAL_SKILLS,
    playbooks: {
      planning: workflowPlaybook('planning', blueprint),
      engineering: workflowPlaybook('engineering', blueprint),
      marketing: workflowPlaybook('marketing', blueprint),
      operations: workflowPlaybook('operations', blueprint)
    },
    readiness: {
      must_exist: uniqueList([
        ...(blueprint.entities || []).map(item => `${item} record exists and is queryable`),
        ...(blueprint.required_artifacts || []).map(item => `${item} can be generated and persisted`)
      ], 16),
      north_star: uniqueList(blueprint.metrics || [], 8)
    }
  };
}

export function getTrainingTaskGuidance(business, workflowKey) {
  const pack = getBusinessTrainingPack(business);
  const playbook = pack.playbooks[workflowKey] || pack.playbooks.operations;
  return {
    pack,
    requirements: uniqueList([
      ...pack.universal_standards.execution,
      ...playbook.rules.slice(0, 3)
    ], 6),
    context: uniqueList([
      ...pack.universal_standards.mission,
      `Blueprint: ${pack.blueprint.label}.`,
      `Focus on ${pack.blueprint.summary}`
    ], 6),
    output: uniqueList([
      ...playbook.outputs.slice(0, 4).map(item => `Prefer an output equivalent to: ${item}.`),
      ...pack.universal_standards.quality.slice(0, 2)
    ], 6),
    success: uniqueList([
      ...playbook.success,
      ...pack.universal_standards.safety.slice(0, 2)
    ], 6)
  };
}

export function buildTrainingArtifacts(business) {
  const pack = getBusinessTrainingPack(business);
  const manual = {
    department: 'strategy',
    kind: 'training_manual',
    title: `${business.name} operator handbook`,
    summary: `${pack.blueprint.label} handbook with reusable standards, playbooks, and readiness checks.`,
    content: [
      `${business.name} operator handbook`,
      '',
      `Blueprint: ${pack.blueprint.label}`,
      pack.blueprint.summary,
      '',
      'Universal standards:',
      ...Object.entries(pack.universal_standards).flatMap(([section, items]) => [
        `${section.toUpperCase()}:`,
        ...items.map(item => `- ${item}`)
      ]),
      '',
      'Readiness checks:',
      ...pack.readiness.must_exist.map(item => `- ${item}`)
    ].join('\n'),
    metadata: pack
  };

  const playbooks = Object.values(pack.playbooks).map(playbook => ({
    department: playbook.workflow_key === 'planning'
      ? 'strategy'
      : playbook.workflow_key === 'engineering'
        ? 'engineering'
        : playbook.workflow_key === 'marketing'
          ? 'marketing'
          : 'operations',
    kind: 'playbook',
    title: `${business.name} ${playbook.workflow_key} playbook`,
    summary: playbook.purpose,
    content: [
      playbook.title,
      '',
      `Purpose: ${playbook.purpose}`,
      '',
      'Rules:',
      ...playbook.rules.map(item => `- ${item}`),
      '',
      'Preferred outputs:',
      ...playbook.outputs.map(item => `- ${item}`),
      '',
      'Success signals:',
      ...playbook.success.map(item => `- ${item}`)
    ].join('\n'),
    metadata: {
      workflow_key: playbook.workflow_key,
      blueprint: pack.blueprint
    }
  }));

  return { pack, manual, playbooks };
}
