import { v4 as uuid } from 'uuid';
import { extname } from 'node:path';
import { getDb } from '../db/migrate.js';

function normalizePath(value = '') {
  const cleaned = String(value || '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
  return cleaned || 'index.html';
}

function inferContentType(pathValue, fallback = 'text/markdown') {
  const ext = extname(pathValue || '').toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  if (ext === '.md') return 'text/markdown; charset=utf-8';
  return fallback;
}

function stripHtmlComments(content = '') {
  return String(content || '').replace(/<!--[\s\S]*?-->/g, ' ').trim();
}

function stripTags(content = '') {
  return String(content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function looksLikePlaceholder(content = '') {
  const normalized = String(content || '').trim().toLowerCase();
  if (!normalized) return true;
  return [
    '<!-- see staged file -->',
    'see staged file',
    '<!-- placeholder -->',
    'placeholder',
    'todo',
    'tbd'
  ].includes(normalized);
}

export function isMeaningfulSiteContent(content = '', pathValue = 'index.html') {
  const normalizedPath = normalizePath(pathValue);
  const raw = String(content || '').trim();
  if (!raw || looksLikePlaceholder(raw)) return false;

  if (normalizedPath.endsWith('.html')) {
    const withoutComments = stripHtmlComments(raw);
    const textContent = stripTags(withoutComments);
    const hasPageStructure = /<(html|body|main|section|div|header|footer)\b/i.test(withoutComments);
    const hasMeaningfulText = textContent.length >= 80;
    return withoutComments.length >= 120 && hasPageStructure && hasMeaningfulText;
  }

  if (normalizedPath.endsWith('.css') || normalizedPath.endsWith('.js')) {
    return raw.length >= 24 && !looksLikePlaceholder(raw);
  }

  return raw.length >= 16 && !looksLikePlaceholder(raw);
}

function hydrateArtifact(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: safeParse(row.metadata, {}),
  };
}

function safeParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function createArtifact({
  businessId,
  taskId = null,
  cycleId = null,
  department = null,
  kind,
  title,
  summary = '',
  path = null,
  content = '',
  contentType = 'text/markdown; charset=utf-8',
  status = 'published',
  metadata = {}
}) {
  const db = getDb();
  const id = uuid();
  db.prepare(`
    INSERT INTO artifacts (
      id, business_id, task_id, cycle_id, department, kind, title, summary,
      path, content, content_type, status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    businessId,
    taskId,
    cycleId,
    department,
    kind,
    title,
    summary || null,
    path,
    content || null,
    contentType,
    status,
    JSON.stringify(metadata || {})
  );

  return hydrateArtifact(db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id));
}

export function listArtifacts(businessId, { kind = null, taskId = null, limit = 50, status = null } = {}) {
  const db = getDb();
  const filters = ['business_id = ?'];
  const values = [businessId];

  if (kind) {
    filters.push('kind = ?');
    values.push(kind);
  }
  if (taskId) {
    filters.push('task_id = ?');
    values.push(taskId);
  }
  if (status) {
    filters.push('status = ?');
    values.push(status);
  }

  values.push(limit);
  return db.prepare(`
    SELECT *
    FROM artifacts
    WHERE ${filters.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...values).map(hydrateArtifact);
}

export function getLatestArtifactByKind(businessId, kind) {
  const db = getDb();
  return hydrateArtifact(db.prepare(`
    SELECT *
    FROM artifacts
    WHERE business_id = ?
      AND kind = ?
      AND status != 'archived'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(businessId, kind));
}

export function publishSiteFiles({
  businessId,
  taskId = null,
  cycleId = null,
  files = [],
  summary = 'Published website files'
}) {
  const db = getDb();
  const published = [];

  for (const file of files) {
    const pathValue = normalizePath(file.path);
    db.prepare(`
      UPDATE artifacts
      SET status = 'superseded', updated_at = datetime('now')
      WHERE business_id = ?
        AND kind = 'site_file'
        AND path = ?
        AND status = 'published'
    `).run(businessId, pathValue);

    published.push(createArtifact({
      businessId,
      taskId,
      cycleId,
      department: 'engineering',
      kind: 'site_file',
      title: pathValue,
      summary,
      path: pathValue,
      content: file.content || '',
      contentType: inferContentType(pathValue, 'text/plain; charset=utf-8'),
      status: 'published',
      metadata: {
        bytes: Buffer.byteLength(file.content || '', 'utf8'),
        deploy_summary: summary
      }
    }));
  }

  return published;
}

export function getPublishedSiteFile(businessId, pathValue = 'index.html') {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM artifacts
    WHERE business_id = ?
      AND kind = 'site_file'
      AND path = ?
      AND status = 'published'
    ORDER BY created_at DESC
    LIMIT 5
  `).all(businessId, normalizePath(pathValue)).map(hydrateArtifact);

  return rows.find(row => isMeaningfulSiteContent(row?.content, row?.path || pathValue)) || null;
}
