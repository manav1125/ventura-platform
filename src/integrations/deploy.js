// src/integrations/deploy.js
// Website deployment per business.
// Uses Vercel API to:
//   - Create a project per business on first deploy
//   - Deploy file changes via the Vercel API
//   - Assign custom subdomain  
// Falls back to a local "file store" in dev mode.

import { getDb } from '../db/migrate.js';
import { BASE_URL, VERCEL_TOKEN, VERCEL_TEAM_ID, PLATFORM_DOMAIN } from '../config.js';
import { logActivity } from '../agents/activity.js';
import { createArtifact, isMeaningfulSiteContent, publishSiteFiles } from '../agents/artifacts.js';

const VERCEL_API = 'https://api.vercel.com';

function validateDeployableFiles(files = []) {
  const normalizedFiles = Array.isArray(files)
    ? files
        .map(file => ({
          path: String(file?.path || 'index.html').trim() || 'index.html',
          content: String(file?.content || '')
        }))
        .filter(file => file.path)
    : [];

  if (!normalizedFiles.length) {
    throw new Error('Website deploy rejected: no files were provided.');
  }

  const htmlFiles = normalizedFiles.filter(file => file.path.toLowerCase().endsWith('.html'));
  if (!htmlFiles.length) {
    throw new Error('Website deploy rejected: no HTML page was provided.');
  }

  const invalidHtml = htmlFiles.find(file => !isMeaningfulSiteContent(file.content, file.path));
  if (invalidHtml) {
    throw new Error(`Website deploy rejected: ${invalidHtml.path} is empty or placeholder content.`);
  }

  return normalizedFiles;
}

// ─── Bootstrap a Vercel project for a new business ───────────────────────────

export async function createVercelProject(businessId, slug) {
  if (!VERCEL_TOKEN) {
    console.log(`[Deploy] No Vercel token — using Ventura hosted site for ${slug}`);
    const url = `${BASE_URL.replace(/\/$/, '')}/sites/${slug}`;
    const db = getDb();
    db.prepare('UPDATE businesses SET web_url=? WHERE id=?')
      .run(url, businessId);
    return { projectId: `internal_${slug}`, url };
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
  const validatedFiles = validateDeployableFiles(files);

  if (!VERCEL_TOKEN) {
    return internalDeploy(businessId, biz.slug, validatedFiles, versionNote);
  }

  const headers = {
    'Authorization': `Bearer ${VERCEL_TOKEN}`,
    'Content-Type': 'application/json'
  };

  // Build Vercel deployment payload
  const deploymentFiles = validatedFiles.map(f => ({
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
  `).run(`dep_${Date.now()}`, businessId, version, versionNote, validatedFiles.length);
  publishSiteFiles({
    businessId,
    taskId: null,
    files: validatedFiles,
    summary: versionNote || `Published ${validatedFiles.length} files`
  });
  createArtifact({
    businessId,
    department: 'engineering',
    kind: 'deployment_release',
    title: version,
    summary: versionNote,
    content: validatedFiles.map(file => `- ${file.path}`).join('\n'),
    metadata: {
      files_changed: validatedFiles.length,
      provider: 'vercel',
      live_url: biz.web_url
    }
  });

  await logActivity(businessId, {
    type: 'deploy',
    department: 'engineering',
    title: `Deployed ${version}: ${versionNote}`,
    detail: { version, files: validatedFiles.map(f => f.path), vercel_url: deployment.url }
  });

  return { version, url: biz.web_url, deploymentId: deployment.id };
}

// ─── Ventura-hosted deploy (fallback when no external deploy provider exists) ─

async function internalDeploy(businessId, slug, files, versionNote) {
  const version = `v${Date.now()}`;
  const db = getDb();
  const liveUrl = `${BASE_URL.replace(/\/$/, '')}/sites/${slug}`;
  const validatedFiles = validateDeployableFiles(files);
  db.prepare('UPDATE businesses SET web_url=? WHERE id=?').run(liveUrl, businessId);
  db.prepare(`
    INSERT INTO deployments (id, business_id, version, description, files_changed, status)
    VALUES (?, ?, ?, ?, ?, 'live')
  `).run(`dep_${Date.now()}`, businessId, version, versionNote, validatedFiles.length);

  publishSiteFiles({
    businessId,
    files: validatedFiles,
    summary: versionNote || `Published ${validatedFiles.length} files`
  });
  createArtifact({
    businessId,
    department: 'engineering',
    kind: 'deployment_release',
    title: version,
    summary: versionNote || 'Ventura internal deploy',
    content: validatedFiles.map(file => `- ${file.path}`).join('\n'),
    metadata: {
      files_changed: validatedFiles.length,
      provider: 'ventura-hosted',
      live_url: liveUrl
    }
  });

  console.log(`[Deploy] Ventura hosted deploy for ${slug}: ${validatedFiles.length} files → ${liveUrl}`);
  await logActivity(businessId, {
    type: 'deploy',
    department: 'engineering',
    title: `Deployed ${version}: ${versionNote}`,
    detail: { version, files: validatedFiles.map(f => f.path), hosted_by: 'ventura' }
  });
  return { version, url: liveUrl, internal: true };
}

// ─── Get deployment history ───────────────────────────────────────────────────

export function getDeployments(businessId, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM deployments WHERE business_id=? ORDER BY created_at DESC LIMIT ?
  `).all(businessId, limit);
}
