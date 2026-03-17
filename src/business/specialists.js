import { queueTask } from '../agents/tasks.js';

export const SPECIALIST_PLAYBOOKS = {
  planning: {
    id: 'planning',
    label: 'Planning',
    department: 'strategy',
    title: 'Founder dispatch: planning sprint',
    description: 'Review current business performance, identify the highest leverage next steps, and produce a concrete 7-day plan with priorities, risks, and experiments.'
  },
  engineering: {
    id: 'engineering',
    label: 'Engineering',
    department: 'engineering',
    title: 'Founder dispatch: engineering sprint',
    description: 'Ship the highest impact product or infrastructure improvement next, prioritising reliability, conversion, and measurable business outcomes.'
  },
  marketing: {
    id: 'marketing',
    label: 'Marketing',
    department: 'marketing',
    title: 'Founder dispatch: growth sprint',
    description: 'Launch the next best growth experiment across content, outbound, SEO, or lifecycle marketing, with clear messaging and a measurable target.'
  },
  operations: {
    id: 'operations',
    label: 'Operations',
    department: 'operations',
    title: 'Founder dispatch: ops sweep',
    description: 'Handle operational debt, inbox and support cleanup, workflow automation, and any human-risk items that could slow the business down.'
  }
};

export function listSpecialistPlaybooks() {
  return Object.values(SPECIALIST_PLAYBOOKS);
}

export async function dispatchSpecialistTask({ business, specialist, brief = '', triggeredBy = 'user', priority = 2 }) {
  const playbook = SPECIALIST_PLAYBOOKS[specialist];
  if (!playbook) {
    throw Object.assign(new Error('Unknown specialist'), { statusCode: 400 });
  }

  const founderBrief = brief.trim();
  const title = founderBrief
    ? `${playbook.title} — ${founderBrief.slice(0, 90)}`
    : playbook.title;

  const description = [
    playbook.description,
    founderBrief ? `Founder brief: ${founderBrief}` : null,
    `Business goal: ${business.goal_90d}.`,
    `Current involvement mode: ${business.involvement}.`,
    `Business status: ${business.status}.`
  ].filter(Boolean).join('\n\n');

  const taskId = await queueTask({
    businessId: business.id,
    title,
    description,
    department: playbook.department,
    triggeredBy,
    priority
  });

  return {
    taskId,
    specialist: playbook.id,
    label: playbook.label,
    department: playbook.department,
    title
  };
}
