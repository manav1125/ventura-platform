import { getDb } from '../db/migrate.js';
import { queueTask, getAllTasks } from '../agents/tasks.js';
import { startBusinessCycleIfIdle } from '../agents/runner.js';
import { getMarketplaceMatchDetail, getMarketplaceOverview } from './marketplace.js';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasOpenTask(tasks, title) {
  const needle = clean(title).toLowerCase();
  return tasks.some(task => ['queued', 'running'].includes(task.status) && clean(task.title).toLowerCase() === needle);
}

function collectLifecycleTasks({ business, marketplace, source, founder, investor, matchDetail, conversation }) {
  const counts = marketplace?.counts || {};
  const tasks = [];

  if (source === 'founder' && founder) {
    tasks.push({
      title: `Review founder application for ${founder.company_name}`,
      description: `Review ${founder.founder_name}'s application for ${founder.company_name}, approve or reject the profile, and queue the next investor-fit action Ventura should take.`,
      department: 'operations',
      workflowKey: 'operations',
      priority: 1
    });
    tasks.push(counts.investors
      ? {
          title: `Score investor matches for ${founder.company_name}`,
          description: `Use the current investor roster to create or refine the best investor matches for ${founder.company_name}, leaving persisted rationale and intro readiness.`,
          department: 'operations',
          workflowKey: 'operations',
          priority: 2
        }
      : {
          title: `Source aligned investors for ${founder.company_name}`,
          description: `Research the next investor targets who fit ${founder.company_name}'s stage, sector, and geography so Ventura can expand the investor roster with high-signal candidates.`,
          department: 'marketing',
          workflowKey: 'marketing',
          priority: 2
        });
  }

  if (source === 'investor' && investor) {
    tasks.push({
      title: `Review investor profile for ${investor.name}`,
      description: `Review ${investor.name}${investor.firm ? ` from ${investor.firm}` : ''}, confirm fit for the marketplace, and make the next founder-match step explicit.`,
      department: 'operations',
      workflowKey: 'operations',
      priority: 1
    });
    tasks.push(counts.founders
      ? {
          title: `Score founder matches for ${investor.name}`,
          description: `Use the current founder pipeline to create or refine the best founder matches for ${investor.name}, leaving persisted rationale and intro readiness.`,
          department: 'operations',
          workflowKey: 'operations',
          priority: 2
        }
      : {
          title: `Attract more qualified founders for ${business.name}`,
          description: `Use the marketplace positioning to source the next founder segment that best fits the live investor roster and current thesis coverage.`,
          department: 'marketing',
          workflowKey: 'marketing',
          priority: 2
        });
  }

  if (source === 'match' && matchDetail) {
    tasks.push({
      title: `Prepare intro workflow for ${matchDetail.company_name} and ${matchDetail.investor_name}`,
      description: `Take the current match between ${matchDetail.company_name} and ${matchDetail.investor_name}, move it to the right intro state, and leave a persisted intro draft or explicit blocker.`,
      department: 'operations',
      workflowKey: 'operations',
      priority: 1
    });
  }

  if (source === 'conversation' && matchDetail && conversation) {
    tasks.push({
      title: `Advance intro follow-up for ${matchDetail.company_name} and ${matchDetail.investor_name}`,
      description: `Review the ${conversation.channel} conversation state for ${matchDetail.company_name} and ${matchDetail.investor_name}, update the intro pipeline, and make the next follow-up or closure explicit.`,
      department: 'operations',
      workflowKey: 'operations',
      priority: 1
    });
  }

  if ((counts.pending_reviews || 0) > 0) {
    tasks.push({
      title: `Clear the review queue for ${business.name}`,
      description: `Work through pending founder, investor, or match review states so Ventura can keep the marketplace moving without hidden bottlenecks.`,
      department: 'operations',
      workflowKey: 'operations',
      priority: 2
    });
  }

  if ((counts.matches || 0) > (counts.intros_sent || 0)) {
    tasks.push({
      title: `Move candidate matches toward intros for ${business.name}`,
      description: `Review the live candidate matches, advance the highest-confidence ones into queued intro or sent states, and persist the intro workflow artifacts.`,
      department: 'operations',
      workflowKey: 'operations',
      priority: 3
    });
  }

  if ((counts.open_conversations || 0) > 0) {
    tasks.push({
      title: `Keep open intro conversations moving for ${business.name}`,
      description: `Use the tracked intro threads to identify waiting responses, replied conversations, and the next follow-up Ventura should log or send.`,
      department: 'operations',
      workflowKey: 'operations',
      priority: 3
    });
  }

  return tasks;
}

export async function enqueueMarketplaceLifecycleWork({
  businessId,
  source,
  founderId = null,
  investorId = null,
  matchId = null,
  conversation = null
}) {
  const db = getDb();
  const business = db.prepare(`SELECT * FROM businesses WHERE id = ?`).get(businessId);
  if (!business || business.blueprint_key !== 'founder_investor_marketplace') {
    return { queued: [], started: false };
  }

  const founder = founderId
    ? db.prepare(`SELECT * FROM marketplace_founder_profiles WHERE business_id = ? AND id = ?`).get(businessId, founderId)
    : null;
  const investor = investorId
    ? db.prepare(`SELECT * FROM marketplace_investor_profiles WHERE business_id = ? AND id = ?`).get(businessId, investorId)
    : null;
  const matchDetail = matchId ? getMarketplaceMatchDetail(db, businessId, matchId) : null;
  const marketplace = getMarketplaceOverview(db, businessId);
  const existing = getAllTasks(businessId, 200);
  const candidates = collectLifecycleTasks({
    business,
    marketplace,
    source,
    founder,
    investor,
    matchDetail,
    conversation
  });

  const queued = [];
  for (const candidate of candidates) {
    if (hasOpenTask(existing, candidate.title)) continue;
    const taskId = await queueTask({
      businessId,
      business,
      title: candidate.title,
      description: candidate.description,
      department: candidate.department,
      workflowKey: candidate.workflowKey,
      triggeredBy: 'agent',
      priority: candidate.priority
    });
    queued.push(taskId);
    existing.unshift({ id: taskId, title: candidate.title, status: 'queued' });
  }

  if (process.env.NODE_ENV === 'test') {
    return {
      queued,
      started: false,
      cycleId: null
    };
  }

  const cycle = queued.length ? startBusinessCycleIfIdle(business, 'marketplace_event') : { started: false };
  return {
    queued,
    started: !!cycle.started,
    cycleId: cycle.cycleId || cycle.running?.id || null
  };
}
