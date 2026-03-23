import { v4 as uuid } from 'uuid';
import { getBusinessBlueprint, serializeBlueprint } from './blueprints.js';
import { getBusinessTrainingPack } from './training.js';

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

function normalizeDocument(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata, {})
  };
}

export function listIntelligenceDocuments(db, {
  businessId = null,
  scope = null,
  blueprintKey = null,
  limit = 50
} = {}) {
  const clauses = [];
  const params = [];
  if (businessId) {
    clauses.push('(business_id = ? OR (business_id IS NULL AND blueprint_key = ?))');
    params.push(businessId, blueprintKey || null);
  }
  if (scope) {
    clauses.push('scope = ?');
    params.push(scope);
  }
  if (!businessId && blueprintKey) {
    clauses.push('blueprint_key = ?');
    params.push(blueprintKey);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT *
    FROM intelligence_documents
    ${where}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(...params, limit).map(normalizeDocument);
}

export function createIntelligenceDocument(db, {
  businessId = null,
  authorUserId = null,
  scope = 'business',
  blueprintKey = null,
  workflowKey = null,
  kind = 'refinement_note',
  title,
  content,
  status = 'active',
  metadata = {}
}) {
  const id = uuid();
  db.prepare(`
    INSERT INTO intelligence_documents (
      id, business_id, author_user_id, scope, blueprint_key, workflow_key, kind, title, content, status, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    businessId,
    authorUserId,
    scope,
    blueprintKey,
    workflowKey,
    kind,
    clean(title),
    clean(content),
    status,
    JSON.stringify(metadata || {})
  );
  return normalizeDocument(db.prepare(`SELECT * FROM intelligence_documents WHERE id = ?`).get(id));
}

export function updateIntelligenceDocument(db, id, changes = {}) {
  const current = db.prepare(`SELECT * FROM intelligence_documents WHERE id = ?`).get(id);
  if (!current) return null;
  const mergedMetadata = {
    ...parseJson(current.metadata, {}),
    ...(changes.metadata || {})
  };
  db.prepare(`
    UPDATE intelligence_documents
    SET workflow_key = ?,
        kind = ?,
        title = ?,
        content = ?,
        status = ?,
        metadata = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    clean(changes.workflowKey) || current.workflow_key,
    clean(changes.kind) || current.kind,
    clean(changes.title) || current.title,
    clean(changes.content) || current.content,
    clean(changes.status) || current.status,
    JSON.stringify(mergedMetadata),
    id
  );
  return normalizeDocument(db.prepare(`SELECT * FROM intelligence_documents WHERE id = ?`).get(id));
}

export function getBusinessIntelligenceOverview(db, business) {
  const blueprint = getBusinessBlueprint(business);
  const training = getBusinessTrainingPack(business);
  const documents = listIntelligenceDocuments(db, {
    businessId: business.id,
    blueprintKey: blueprint.key,
    limit: 100
  });

  return {
    blueprint: serializeBlueprint(blueprint),
    training,
    documents,
    summary: {
      total_documents: documents.length,
      active_documents: documents.filter(item => item.status === 'active').length,
      blueprint_documents: documents.filter(item => item.kind === 'blueprint_refinement').length,
      playbook_documents: documents.filter(item => item.kind === 'playbook_note').length,
      operating_rules: documents.filter(item => item.kind === 'operating_rule').length
    }
  };
}

export function getPlatformIntelligenceOverview(db, { blueprintKey = null } = {}) {
  const documents = listIntelligenceDocuments(db, {
    scope: 'platform',
    blueprintKey,
    limit: 200
  });
  const grouped = documents.reduce((acc, item) => {
    const key = item.blueprint_key || 'platform';
    acc[key] = acc[key] || [];
    acc[key].push(item);
    return acc;
  }, {});
  return {
    documents,
    grouped,
    summary: {
      total_documents: documents.length,
      active_documents: documents.filter(item => item.status === 'active').length,
      blueprints_covered: Object.keys(grouped).length
    }
  };
}
