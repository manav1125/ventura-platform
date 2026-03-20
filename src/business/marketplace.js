import { v4 as uuid } from 'uuid';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value.map(item => clean(item)).filter(Boolean);
  }
  return clean(value)
    .split(/[,|]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function overlapScore(left = [], right = []) {
  const leftSet = new Set(splitList(left).map(item => item.toLowerCase()));
  const rightSet = new Set(splitList(right).map(item => item.toLowerCase()));
  if (!leftSet.size || !rightSet.size) return 0;
  let overlaps = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) overlaps += 1;
  }
  return overlaps / Math.max(leftSet.size, rightSet.size);
}

function checkSizeScore(founder, investor) {
  const raise = Number(founder.raise_target_cents || 0);
  const min = Number(investor.check_size_min_cents || 0);
  const max = Number(investor.check_size_max_cents || 0);
  if (!raise || !min || !max) return 0.5;
  if (raise >= min && raise <= max * 4) return 1;
  if (raise < min) return 0.4;
  return 0.2;
}

function stageScore(founder, investor) {
  const founderStage = clean(founder.stage).toLowerCase();
  const focus = splitList(investor.stage_focus).map(item => item.toLowerCase());
  if (!founderStage || !focus.length) return 0.5;
  return focus.includes(founderStage) ? 1 : 0.15;
}

function geographyScore(founder, investor) {
  const founderGeo = clean(founder.geography).toLowerCase();
  const focus = splitList(investor.geography_focus).map(item => item.toLowerCase());
  if (!founderGeo || !focus.length) return 0.6;
  return focus.includes(founderGeo) ? 1 : 0.35;
}

function buildMatchRationale(founder, investor, score) {
  const reasons = [];
  if (splitList(founder.sectors).length && splitList(investor.sector_focus).length) {
    const sectorScore = overlapScore(founder.sectors, investor.sector_focus);
    if (sectorScore > 0.4) reasons.push('sector fit is strong');
  }
  if (stageScore(founder, investor) > 0.8) reasons.push(`stage fit aligns around ${founder.stage}`);
  if (geographyScore(founder, investor) > 0.8 && clean(founder.geography)) reasons.push(`geography aligns around ${founder.geography}`);
  if (checkSizeScore(founder, investor) > 0.8 && founder.raise_target_cents) reasons.push('target raise fits the investor check-size band');
  if (!reasons.length) reasons.push('core fundraising profile overlaps enough to justify a human review');
  return `Ventura scored this match at ${(score * 100).toFixed(0)}% because ${reasons.join(', ')}.`;
}

export function scoreMarketplaceMatch(founder, investor) {
  const score = (
    overlapScore(founder.sectors, investor.sector_focus) * 0.35 +
    stageScore(founder, investor) * 0.25 +
    geographyScore(founder, investor) * 0.15 +
    checkSizeScore(founder, investor) * 0.25
  );
  return Number(score.toFixed(2));
}

function serializeFounder(row) {
  if (!row) return null;
  return {
    ...row,
    sectors: parseJson(row.sectors, []),
    metadata: parseJson(row.metadata, {})
  };
}

function serializeInvestor(row) {
  if (!row) return null;
  return {
    ...row,
    stage_focus: parseJson(row.stage_focus, []),
    sector_focus: parseJson(row.sector_focus, []),
    geography_focus: parseJson(row.geography_focus, []),
    metadata: parseJson(row.metadata, {})
  };
}

function serializeMatch(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata, {})
  };
}

function serializeReview(row) {
  if (!row) return null;
  return {
    ...row
  };
}

function serializeConversation(row) {
  if (!row) return null;
  return {
    ...row
  };
}

function moneyLabel(cents) {
  const value = Number(cents || 0);
  if (!value) return 'Not specified';
  return `$${(value / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function titleCaseWords(value) {
  return clean(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function createFounderProfile(db, businessId, payload) {
  const id = uuid();
  db.prepare(`
    INSERT INTO marketplace_founder_profiles (
      id, business_id, founder_name, founder_email, company_name, company_url, stage,
      sectors, geography, traction_summary, raise_summary, raise_target_cents,
      status, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    businessId,
    clean(payload.founderName),
    clean(payload.founderEmail),
    clean(payload.companyName),
    clean(payload.companyUrl) || null,
    clean(payload.stage) || null,
    JSON.stringify(splitList(payload.sectors)),
    clean(payload.geography) || null,
    clean(payload.tractionSummary) || null,
    clean(payload.raiseSummary) || null,
    payload.raiseTargetCents || null,
    clean(payload.status) || 'applied',
    JSON.stringify(payload.metadata || {})
  );
  return serializeFounder(db.prepare(`SELECT * FROM marketplace_founder_profiles WHERE id = ?`).get(id));
}

export function createInvestorProfile(db, businessId, payload) {
  const id = uuid();
  db.prepare(`
    INSERT INTO marketplace_investor_profiles (
      id, business_id, name, email, firm, title, stage_focus, sector_focus,
      geography_focus, check_size_min_cents, check_size_max_cents, thesis,
      status, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    businessId,
    clean(payload.name),
    clean(payload.email) || null,
    clean(payload.firm) || null,
    clean(payload.title) || null,
    JSON.stringify(splitList(payload.stageFocus)),
    JSON.stringify(splitList(payload.sectorFocus)),
    JSON.stringify(splitList(payload.geographyFocus)),
    payload.checkSizeMinCents || null,
    payload.checkSizeMaxCents || null,
    clean(payload.thesis) || null,
    clean(payload.status) || 'active',
    JSON.stringify(payload.metadata || {})
  );
  return serializeInvestor(db.prepare(`SELECT * FROM marketplace_investor_profiles WHERE id = ?`).get(id));
}

export function createMarketplaceMatch(db, businessId, payload) {
  const founder = serializeFounder(db.prepare(`
    SELECT *
    FROM marketplace_founder_profiles
    WHERE business_id = ? AND id = ?
  `).get(businessId, payload.founderProfileId));
  const investor = serializeInvestor(db.prepare(`
    SELECT *
    FROM marketplace_investor_profiles
    WHERE business_id = ? AND id = ?
  `).get(businessId, payload.investorProfileId));
  if (!founder || !investor) {
    throw new Error('Founder or investor profile not found for this marketplace.');
  }

  const score = scoreMarketplaceMatch(founder, investor);
  const rationale = clean(payload.rationale) || buildMatchRationale(founder, investor, score);
  const id = uuid();
  db.prepare(`
    INSERT INTO marketplace_matches (
      id, business_id, founder_profile_id, investor_profile_id, status, score,
      rationale, founder_summary, investor_summary, intro_draft, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    businessId,
    founder.id,
    investor.id,
    clean(payload.status) || 'candidate',
    score,
    rationale,
    clean(payload.founderSummary) || founder.traction_summary || founder.raise_summary || null,
    clean(payload.investorSummary) || investor.thesis || null,
    clean(payload.introDraft) || null,
    JSON.stringify(payload.metadata || {})
  );
  return serializeMatch(db.prepare(`SELECT * FROM marketplace_matches WHERE id = ?`).get(id));
}

export function getFounderProfile(db, businessId, founderProfileId) {
  return serializeFounder(db.prepare(`
    SELECT *
    FROM marketplace_founder_profiles
    WHERE business_id = ? AND id = ?
  `).get(businessId, founderProfileId));
}

export function getInvestorProfile(db, businessId, investorProfileId) {
  return serializeInvestor(db.prepare(`
    SELECT *
    FROM marketplace_investor_profiles
    WHERE business_id = ? AND id = ?
  `).get(businessId, investorProfileId));
}

export function getMarketplaceMatchDetail(db, businessId, matchId) {
  const row = db.prepare(`
    SELECT
      m.*,
      f.founder_name,
      f.founder_email,
      f.company_name,
      f.company_url,
      f.stage,
      f.sectors,
      f.geography,
      f.traction_summary,
      f.raise_summary,
      f.raise_target_cents,
      i.name AS investor_name,
      i.email AS investor_email,
      i.firm,
      i.title AS investor_title,
      i.stage_focus,
      i.sector_focus,
      i.geography_focus,
      i.check_size_min_cents,
      i.check_size_max_cents,
      i.thesis
    FROM marketplace_matches m
    JOIN marketplace_founder_profiles f ON f.id = m.founder_profile_id
    JOIN marketplace_investor_profiles i ON i.id = m.investor_profile_id
    WHERE m.business_id = ?
      AND m.id = ?
  `).get(businessId, matchId);
  if (!row) return null;
  return {
    ...serializeMatch(row),
    sectors: parseJson(row.sectors, []),
    stage_focus: parseJson(row.stage_focus, []),
    sector_focus: parseJson(row.sector_focus, []),
    geography_focus: parseJson(row.geography_focus, [])
  };
}

export function renderFounderBrief(founder, businessName = 'Ventura marketplace') {
  const sectors = splitList(founder?.sectors).join(', ') || 'Not specified';
  return [
    `# Founder application brief`,
    ``,
    `Business: ${businessName}`,
    `Founder: ${founder?.founder_name || 'Unknown founder'}`,
    `Company: ${founder?.company_name || 'Unnamed company'}`,
    `Status: ${titleCaseWords(founder?.status || 'applied')}`,
    ``,
    `## Snapshot`,
    `- Stage: ${founder?.stage || 'Not specified'}`,
    `- Geography: ${founder?.geography || 'Not specified'}`,
    `- Sectors: ${sectors}`,
    `- Raise target: ${moneyLabel(founder?.raise_target_cents)}`,
    `- Contact: ${founder?.founder_email || 'Not provided'}`,
    `${founder?.company_url ? `- URL: ${founder.company_url}` : '- URL: Not provided'}`,
    ``,
    `## Traction`,
    founder?.traction_summary || 'No traction summary was provided yet.',
    ``,
    `## Raise context`,
    founder?.raise_summary || 'No raise summary was provided yet.',
    ``,
    `## Ventura operator note`,
    `This founder profile is now part of the active marketplace pipeline and should be reviewed against investor fit, thesis alignment, and intro readiness.`
  ].join('\n');
}

export function renderInvestorBrief(investor, businessName = 'Ventura marketplace') {
  const stageFocus = splitList(investor?.stage_focus).join(', ') || 'Not specified';
  const sectorFocus = splitList(investor?.sector_focus).join(', ') || 'Not specified';
  const geographyFocus = splitList(investor?.geography_focus).join(', ') || 'Not specified';
  return [
    `# Investor profile brief`,
    ``,
    `Business: ${businessName}`,
    `Investor: ${investor?.name || 'Unknown investor'}`,
    `Firm: ${investor?.firm || 'Independent / not specified'}`,
    `Status: ${titleCaseWords(investor?.status || 'active')}`,
    ``,
    `## Fit bands`,
    `- Stage focus: ${stageFocus}`,
    `- Sector focus: ${sectorFocus}`,
    `- Geography focus: ${geographyFocus}`,
    `- Check size: ${moneyLabel(investor?.check_size_min_cents)} to ${moneyLabel(investor?.check_size_max_cents)}`,
    `- Contact: ${investor?.email || 'Not provided'}`,
    `${investor?.investor_title || investor?.title ? `- Title: ${investor.investor_title || investor.title}` : '- Title: Not provided'}`,
    ``,
    `## Thesis`,
    investor?.thesis || 'No written thesis has been captured yet.',
    ``,
    `## Ventura operator note`,
    `This investor profile is live in the roster and should be used for thesis matching, shortlisting, and intro readiness decisions.`
  ].join('\n');
}

export function renderMatchMemo(detail, businessName = 'Ventura marketplace') {
  const sectors = splitList(detail?.sectors).join(', ') || 'Not specified';
  const stageFocus = splitList(detail?.stage_focus).join(', ') || 'Not specified';
  const sectorFocus = splitList(detail?.sector_focus).join(', ') || 'Not specified';
  return [
    `# Match memo`,
    ``,
    `Business: ${businessName}`,
    `Status: ${titleCaseWords(detail?.status || 'candidate')}`,
    `Score: ${Math.round(Number(detail?.score || 0) * 100)}%`,
    ``,
    `## Founder`,
    `- ${detail?.company_name || 'Unnamed company'} · ${detail?.founder_name || 'Unknown founder'}`,
    `- Stage: ${detail?.stage || 'Not specified'}`,
    `- Sectors: ${sectors}`,
    `- Geography: ${detail?.geography || 'Not specified'}`,
    `- Raise target: ${moneyLabel(detail?.raise_target_cents)}`,
    ``,
    `## Investor`,
    `- ${detail?.investor_name || 'Unknown investor'}${detail?.firm ? ` · ${detail.firm}` : ''}`,
    `- Stage focus: ${stageFocus}`,
    `- Sector focus: ${sectorFocus}`,
    `- Geography focus: ${splitList(detail?.geography_focus).join(', ') || 'Not specified'}`,
    `- Check size: ${moneyLabel(detail?.check_size_min_cents)} to ${moneyLabel(detail?.check_size_max_cents)}`,
    ``,
    `## Ventura rationale`,
    detail?.rationale || 'Ventura has not stored a written rationale for this match yet.',
    ``,
    `## Founder summary`,
    detail?.founder_summary || detail?.traction_summary || 'No founder summary yet.',
    ``,
    `## Investor summary`,
    detail?.investor_summary || detail?.thesis || 'No investor summary yet.'
  ].join('\n');
}

export function renderIntroDraft(detail, businessName = 'Ventura marketplace') {
  const intro = clean(detail?.intro_draft);
  if (intro) return intro;
  return [
    `Subject: Intro — ${detail?.company_name || 'Founder'} x ${detail?.investor_name || 'Investor'}`,
    ``,
    `Hi ${detail?.investor_name || 'there'},`,
    ``,
    `I’d like to introduce ${detail?.founder_name || 'a founder'} from ${detail?.company_name || 'an early-stage company'}.`,
    `${detail?.company_name || 'The company'} is building in ${splitList(detail?.sectors).join(', ') || 'its target sector'} at the ${detail?.stage || 'early'} stage${detail?.geography ? ` with traction in ${detail.geography}` : ''}.`,
    ``,
    `${detail?.investor_name || 'You'} look like a fit because ${detail?.rationale || 'Ventura scored a strong match across thesis, stage, and sector focus.'}`,
    ``,
    `If helpful, I can share a short one-pager and coordinate a first call.`,
    ``,
    `Best,`,
    `${businessName}`
  ].join('\n');
}

export function renderConversationLog(detail, conversation, note = '') {
  return [
    `# Intro conversation log`,
    ``,
    `Match: ${detail?.company_name || 'Founder'} → ${detail?.investor_name || 'Investor'}`,
    `Channel: ${titleCaseWords(conversation?.channel || 'email')}`,
    `Status: ${titleCaseWords(conversation?.status || 'open')}`,
    `${conversation?.thread_subject ? `Thread: ${conversation.thread_subject}` : 'Thread: Not specified'}`,
    `${conversation?.last_message_at ? `Last message: ${conversation.last_message_at}` : 'Last message: Not recorded'}`,
    ``,
    `## Operator note`,
    clean(note) || 'No additional note recorded.'
  ].join('\n');
}

export function updateFounderProfileStatus(db, businessId, founderProfileId, payload = {}) {
  db.prepare(`
    UPDATE marketplace_founder_profiles
    SET status = ?,
        updated_at = datetime('now')
    WHERE business_id = ? AND id = ?
  `).run(clean(payload.status) || 'reviewing', businessId, founderProfileId);
  return serializeFounder(db.prepare(`
    SELECT *
    FROM marketplace_founder_profiles
    WHERE business_id = ? AND id = ?
  `).get(businessId, founderProfileId));
}

export function updateInvestorProfileStatus(db, businessId, investorProfileId, payload = {}) {
  db.prepare(`
    UPDATE marketplace_investor_profiles
    SET status = ?,
        updated_at = datetime('now')
    WHERE business_id = ? AND id = ?
  `).run(clean(payload.status) || 'active', businessId, investorProfileId);
  return serializeInvestor(db.prepare(`
    SELECT *
    FROM marketplace_investor_profiles
    WHERE business_id = ? AND id = ?
  `).get(businessId, investorProfileId));
}

export function updateMarketplaceMatch(db, businessId, matchId, payload = {}) {
  const existing = db.prepare(`
    SELECT *
    FROM marketplace_matches
    WHERE business_id = ? AND id = ?
  `).get(businessId, matchId);
  if (!existing) throw new Error('Marketplace match not found for this business.');

  const nextStatus = clean(payload.status) || existing.status;
  const nextIntroDraft = clean(payload.introDraft) || existing.intro_draft || null;
  const nextRationale = clean(payload.rationale) || existing.rationale || null;
  const metadata = {
    ...parseJson(existing.metadata, {}),
    ...(payload.metadata || {})
  };

  db.prepare(`
    UPDATE marketplace_matches
    SET status = ?,
        rationale = ?,
        intro_draft = ?,
        metadata = ?,
        updated_at = datetime('now')
    WHERE business_id = ? AND id = ?
  `).run(
    nextStatus,
    nextRationale,
    nextIntroDraft,
    JSON.stringify(metadata),
    businessId,
    matchId
  );

  if (['queued_intro', 'sent', 'accepted', 'declined'].includes(nextStatus)) {
    db.prepare(`
      UPDATE marketplace_founder_profiles
      SET status = CASE WHEN ? IN ('accepted', 'sent', 'queued_intro') THEN 'matched' ELSE status END,
          updated_at = datetime('now')
      WHERE id = (SELECT founder_profile_id FROM marketplace_matches WHERE id = ?)
    `).run(nextStatus, matchId);
  }

  return serializeMatch(db.prepare(`
    SELECT *
    FROM marketplace_matches
    WHERE business_id = ? AND id = ?
  `).get(businessId, matchId));
}

export function upsertMarketplaceReview(db, businessId, subjectType, subjectId, payload = {}) {
  const existing = db.prepare(`
    SELECT *
    FROM marketplace_reviews
    WHERE business_id = ? AND subject_type = ? AND subject_id = ?
  `).get(businessId, subjectType, subjectId);
  const decision = clean(payload.decision) || 'pending';
  const notes = clean(payload.notes) || null;
  const decidedBy = clean(payload.decidedBy) || null;

  if (existing) {
    db.prepare(`
      UPDATE marketplace_reviews
      SET decision = ?,
          notes = ?,
          decided_by = ?,
          decided_at = CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now') END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(decision, notes, decidedBy, decision, existing.id);
  } else {
    db.prepare(`
      INSERT INTO marketplace_reviews (
        id, business_id, subject_type, subject_id, decision, notes, decided_by, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now') END)
    `).run(uuid(), businessId, subjectType, subjectId, decision, notes, decidedBy, decision);
  }

  return serializeReview(db.prepare(`
    SELECT *
    FROM marketplace_reviews
    WHERE business_id = ? AND subject_type = ? AND subject_id = ?
  `).get(businessId, subjectType, subjectId));
}

export function upsertMarketplaceConversation(db, businessId, matchId, payload = {}) {
  const existing = db.prepare(`
    SELECT *
    FROM marketplace_conversations
    WHERE business_id = ? AND match_id = ?
  `).get(businessId, matchId);
  const status = clean(payload.status) || existing?.status || 'open';
  const channel = clean(payload.channel) || existing?.channel || 'email';
  const threadSubject = clean(payload.threadSubject) || existing?.thread_subject || null;
  const lastMessageAt = payload.lastMessageAt || new Date().toISOString();

  if (existing) {
    db.prepare(`
      UPDATE marketplace_conversations
      SET status = ?,
          channel = ?,
          thread_subject = ?,
          last_message_at = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(status, channel, threadSubject, lastMessageAt, existing.id);
  } else {
    db.prepare(`
      INSERT INTO marketplace_conversations (
        id, business_id, match_id, status, channel, thread_subject, last_message_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), businessId, matchId, status, channel, threadSubject, lastMessageAt);
  }

  return serializeConversation(db.prepare(`
    SELECT *
    FROM marketplace_conversations
    WHERE business_id = ? AND match_id = ?
  `).get(businessId, matchId));
}

export function getMarketplaceOverview(db, businessId) {
  const counts = {
    founders: Number(db.prepare(`SELECT COUNT(*) AS n FROM marketplace_founder_profiles WHERE business_id = ?`).get(businessId)?.n || 0),
    investors: Number(db.prepare(`SELECT COUNT(*) AS n FROM marketplace_investor_profiles WHERE business_id = ?`).get(businessId)?.n || 0),
    matches: Number(db.prepare(`SELECT COUNT(*) AS n FROM marketplace_matches WHERE business_id = ?`).get(businessId)?.n || 0),
    intros_sent: Number(db.prepare(`
      SELECT COUNT(*) AS n
      FROM marketplace_matches
      WHERE business_id = ?
        AND status IN ('queued_intro', 'sent', 'accepted')
    `).get(businessId)?.n || 0),
    pending_reviews: Number(db.prepare(`
      SELECT COUNT(*) AS n
      FROM marketplace_reviews
      WHERE business_id = ? AND decision = 'pending'
    `).get(businessId)?.n || 0),
    open_conversations: Number(db.prepare(`
      SELECT COUNT(*) AS n
      FROM marketplace_conversations
      WHERE business_id = ? AND status IN ('open', 'waiting', 'replied')
    `).get(businessId)?.n || 0)
  };

  const founders = db.prepare(`
    SELECT id, founder_name, founder_email, company_name, stage, geography, status, created_at
    FROM marketplace_founder_profiles
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT 8
  `).all(businessId);
  const investors = db.prepare(`
    SELECT id, name, firm, title, status, created_at
    FROM marketplace_investor_profiles
    WHERE business_id = ?
    ORDER BY created_at DESC
    LIMIT 8
  `).all(businessId);
  const matches = db.prepare(`
    SELECT m.id, m.status, m.score, m.rationale, m.created_at,
           f.company_name, f.founder_name, i.name AS investor_name, i.firm
    FROM marketplace_matches m
    JOIN marketplace_founder_profiles f ON f.id = m.founder_profile_id
    JOIN marketplace_investor_profiles i ON i.id = m.investor_profile_id
    WHERE m.business_id = ?
    ORDER BY m.created_at DESC
    LIMIT 10
  `).all(businessId);
  const stageMix = db.prepare(`
    SELECT stage, COUNT(*) AS count
    FROM marketplace_founder_profiles
    WHERE business_id = ?
      AND stage IS NOT NULL
      AND stage != ''
    GROUP BY stage
    ORDER BY count DESC, stage ASC
    LIMIT 6
  `).all(businessId);
  const reviews = db.prepare(`
    SELECT subject_type, subject_id, decision, notes, decided_at, updated_at
    FROM marketplace_reviews
    WHERE business_id = ?
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 12
  `).all(businessId);
  const conversations = db.prepare(`
    SELECT c.id, c.match_id, c.status, c.channel, c.thread_subject, c.last_message_at, c.updated_at,
           f.company_name, i.name AS investor_name
    FROM marketplace_conversations c
    JOIN marketplace_matches m ON m.id = c.match_id
    JOIN marketplace_founder_profiles f ON f.id = m.founder_profile_id
    JOIN marketplace_investor_profiles i ON i.id = m.investor_profile_id
    WHERE c.business_id = ?
    ORDER BY COALESCE(c.last_message_at, c.updated_at, c.created_at) DESC
    LIMIT 10
  `).all(businessId);

  return {
    counts,
    founders,
    investors,
    matches,
    stage_mix: stageMix,
    reviews: reviews.map(serializeReview),
    conversations: conversations.map(serializeConversation)
  };
}
