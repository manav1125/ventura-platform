// src/integrations/deploy.js
// Website deployment per business.
// Uses Vercel API to:
//   - Create a project per business on first deploy
//   - Deploy file changes via the Vercel API
//   - Assign custom subdomain  
// Falls back to a local "file store" in dev mode.

import { getDb } from '../db/migrate.js';
import { VERCEL_TOKEN, VERCEL_TEAM_ID, PLATFORM_DOMAIN, NODE_ENV } from '../config.js';
import { logActivity } from '../agents/activity.js';

const VERCEL_API = 'https://api.vercel.com';

// ─── Bootstrap a Vercel project for a new business ───────────────────────────

export async function createVercelProject(businessId, slug) {
  if (!VERCEL_TOKEN) {
    console.log(`[Deploy] No Vercel token — using local deploy for ${slug}`);
    return { projectId: `local_${slug}`, url: `https://${slug}.${PLATFORM_DOMAIN}` };
  }

  const headers = {
    'Authorization': `Bearer ${VERCEL_TOKEN}`,
    'Content-Type': 'application/json'
  };

  // Create project
  const projectRes = await fetch(`${VERCEL_API}/v9/projects${VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : ''}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: `ventura-${slug}`,
      framework: null, // static HTML
      publicSource: false
    })
  });

  if (!projectRes.ok) throw new Error(`Vercel project creation failed: ${await projectRes.text()}`);
  const project = await projectRes.json();

  // Assign subdomain
  await fetch(`${VERCEL_API}/v9/projects/${project.id}/domains${VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : ''}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: `${slug}.${PLATFORM_DOMAIN}` })
  });

  const db = getDb();
  db.prepare('UPDATE businesses SET web_url=? WHERE id=?')
    .run(`https://${slug}.${PLATFORM_DOMAIN}`, businessId);

  return { projectId: project.id, url: `https://${slug}.${PLATFORM_DOMAIN}` };
}

// ─── Deploy files to a business website ──────────────────────────────────────

export async function deployFiles(businessId, files, versionNote) {
  const db = getDb();
  const biz = db.prepare('SELECT * FROM businesses WHERE id=?').get(businessId);
  if (!biz) throw new Error('Business not found');

  if (!VERCEL_TOKEN || NODE_ENV === 'development') {
    return localDeploy(businessId, biz.slug, files, versionNote);
  }

  const headers = {
    'Authorization': `Bearer ${VERCEL_TOKEN}`,
    'Content-Type': 'application/json'
  };

  // Build Vercel deployment payload
  const deploymentFiles = files.map(f => ({
    file: f.path,
    data: f.content,
    encoding: 'utf-8'
  }));

  const deployRes = await fetch(`${VERCEL_API}/v13/deployments${VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : ''}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: `ventura-${biz.slug}`,
      files: deploymentFiles,
      projectSettings: { framework: null },
      meta: { ventura_business_id: businessId, note: versionNote }
    })
  });

  if (!deployRes.ok) throw new Error(`Vercel deployment failed: ${await deployRes.text()}`);
  const deployment = await deployRes.json();

  const version = `v${Date.now()}`;

  db.prepare(`
    INSERT INTO deployments (id, business_id, version, description, files_changed, status)
    VALUES (?, ?, ?, ?, ?, 'live')
  `).run(`dep_${Date.now()}`, businessId, version, versionNote, files.length);

  await logActivity(businessId, {
    type: 'deploy',
    department: 'engineering',
    title: `Deployed ${version}: ${versionNote}`,
    detail: { version, files: files.map(f => f.path), vercel_url: deployment.url }
  });

  return { version, url: biz.web_url, deploymentId: deployment.id };
}

// ─── Local deploy (dev mode) ──────────────────────────────────────────────────

async function localDeploy(businessId, slug, files, versionNote) {
  const { mkdirSync, writeFileSync } = await import('fs');
  const { join } = await import('path');

  const dir = join('./sites', slug);
  mkdirSync(dir, { recursive: true });

  for (const file of files) {
    const filePath = join(dir, file.path);
    const fileDir = filePath.split('/').slice(0, -1).join('/');
    if (fileDir) mkdirSync(fileDir, { recursive: true });
    writeFileSync(filePath, file.content, 'utf-8');
  }

  const version = `v${Date.now()}`;
  const db = getDb();
  db.prepare(`
    INSERT INTO deployments (id, business_id, version, description, files_changed, status)
    VALUES (?, ?, ?, ?, ?, 'live')
  `).run(`dep_${Date.now()}`, businessId, version, versionNote, files.length);

  console.log(`[Deploy] Local deploy for ${slug}: ${files.length} files → ./sites/${slug}/`);
  await logActivity(businessId, {
    type: 'deploy',
    department: 'engineering',
    title: `Deployed ${version}: ${versionNote}`,
    detail: { version, files: files.map(f => f.path), local: true }
  });
  return { version, url: `http://localhost:8080/${slug}`, local: true };
}

// ─── Get deployment history ───────────────────────────────────────────────────

export function getDeployments(businessId, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM deployments WHERE business_id=? ORDER BY created_at DESC LIMIT ?
  `).all(businessId, limit);
}
