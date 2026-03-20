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

  return {
    counts,
    founders,
    investors,
    matches,
    stage_mix: stageMix
  };
}
