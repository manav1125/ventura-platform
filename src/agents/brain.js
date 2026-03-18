// src/agents/brain.js — Full agent brain with all tools
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, AGENT_MODEL, AGENT_MAX_TOKENS } from '../config.js';
import { getDb } from '../db/migrate.js';
import { logActivity } from './activity.js';
import { createApproval } from './approvals.js';
import { runGuardedOperation } from './action-operations.js';
import {
  composeTaskBrief,
  formatTaskBrief,
  getWorkflowState,
  normalizeWorkflowKey,
  persistExecutionIntelligence
} from './execution-intelligence.js';
import { createArtifact, listArtifacts } from './artifacts.js';
import { logTaskEvent } from './task-events.js';
import { getWorkspacePromptContext } from '../integrations/workspace-sync.js';

let agentClient = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const AGENT_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web for market research, competitor intel, lead discovery, SEO keywords, or any current information.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, purpose: { type: 'string', enum: ['competitor_research','lead_discovery','market_research','seo_keywords','general'] } }, required: ['query','purpose'] }
  },
  {
    name: 'write_code',
    description: 'Write or modify a code/HTML/CSS/JS file for the business website. Files are staged until deploy_website is called.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' }, description: { type: 'string' } }, required: ['file_path','content','description'] }
  },
  {
    name: 'deploy_website',
    description: 'Deploy all staged code files to the live website. Call after one or more write_code calls.',
    input_schema: { type: 'object', properties: { version_note: { type: 'string' }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path','content'] } } }, required: ['version_note'] }
  },
  {
    name: 'send_email',
    description: 'Send an email from the business email address to a lead, customer, investor, or prospect.',
    input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, type: { type: 'string', enum: ['cold_outreach','follow_up','support','newsletter','investor'] } }, required: ['to','subject','body','type'] }
  },
  {
    name: 'post_social',
    description: 'Post content to Twitter/X and/or LinkedIn for the business.',
    input_schema: { type: 'object', properties: { platform: { type: 'string', enum: ['twitter','linkedin','both'] }, content: { type: 'string' }, thread: { type: 'boolean' } }, required: ['platform','content'] }
  },
  {
    name: 'add_lead',
    description: 'Add a new prospect or lead to the CRM.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, company: { type: 'string' }, source: { type: 'string', enum: ['cold_email','organic','referral','ad','social','other'] }, notes: { type: 'string' } }, required: ['email','source'] }
  },
  {
    name: 'create_content',
    description: 'Write a content piece: blog post, newsletter, ad copy, SEO page, proposal, or report.',
    input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['blog_post','newsletter','landing_page','ad_copy','email_template','proposal','seo_page','report','social_post'] }, title: { type: 'string' }, content: { type: 'string' }, target_keyword: { type: 'string' } }, required: ['type','title','content'] }
  },
  {
    name: 'update_memory',
    description: 'Persist a learning, insight, competitor note, or priority to agent memory across cycles.',
    input_schema: { type: 'object', properties: { key: { type: 'string' }, value: {} }, required: ['key','value'] }
  },
  {
    name: 'update_metrics',
    description: 'Update a business metric (MRR, active users, ARR).',
    input_schema: { type: 'object', properties: { field: { type: 'string', enum: ['mrr_cents','active_users','arr_cents'] }, value: { type: 'number' }, reason: { type: 'string' } }, required: ['field','value','reason'] }
  },
  {
    name: 'flag_for_review',
    description: 'Flag something high-stakes for the founder to review: legal, financial commitments >$100, PR risk, ambiguous decisions.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, urgency: { type: 'string', enum: ['low','medium','high'] } }, required: ['title','detail'] }
  },
  {
    name: 'task_complete',
    description: 'Mark the current task as done with a summary and optional recommended next steps.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' }, next_steps: { type: 'array', items: { type: 'string' } } }, required: ['summary'] }
  }
];

function buildSystemPrompt(business, memory, workflowState = null, workspace = null) {
  return `You are the autonomous AI operator for "${business.name}", a ${business.type} business on day ${business.day_count}.

CONTEXT:
- Description: ${business.description}
- Target customer: ${business.target_customer}
- 90-day goal: ${business.goal_90d}
- Current MRR: $${(business.mrr_cents / 100).toFixed(2)}
- Website: ${business.web_url}
- Email: ${business.email_address}
- Involvement: ${business.involvement}

MEMORY: ${JSON.stringify(memory, null, 2)}
WORKFLOW STATE: ${JSON.stringify(workflowState || {}, null, 2)}
WORKSPACE SNAPSHOT: ${JSON.stringify(workspace || {}, null, 2)}

PRINCIPLES:
1. You are an OPERATOR. Bias for action. Execute, don't plan.
2. Every task must produce a tangible output: code deployed, email sent, content written, leads added.
3. Use web_search before making strategic decisions — get real data.
4. Continue from existing workflow state instead of starting from scratch when context exists.
5. Update memory with every significant learning.
6. Emails must sound human and personal. Never spam.
7. Flag for review only when stakes are genuinely high (legal, >$100 financial commitment, PR risk).
8. Your work will be verified after completion. Do not claim success without concrete evidence.
9. Connect every action to the 90-day goal.
10. You must work inside Ventura. Never tell the founder to hire a developer, use Carrd, use Framer, or do the work manually when Ventura has a tool that can perform or queue the work.
11. If something cannot be completed because a provider credential or external dependency is missing, say exactly what is missing and still produce the best Ventura-native artifact possible.

INVOLVEMENT: ${business.involvement === 'autopilot' ? 'Execute everything autonomously.' : business.involvement === 'review' ? 'Flag email sends and deployments for review.' : 'Flag major decisions for founder approval.'}

Execute the assigned task using your tools. Call task_complete when done.`;
}

export async function runTask(task, business, cycleId = null) {
  const memory = JSON.parse(business.agent_memory || '{}');
  const workflowKey = normalizeWorkflowKey(task.workflow_key || task.department, task.department);
  const workflowState = getWorkflowState(business.id, workflowKey);
  const workspace = getWorkspacePromptContext(business.id);
  const brief = task.brief || composeTaskBrief({
    business,
    title: task.title,
    description: task.description,
    department: task.department,
    workflowKey,
    workflowState
  });
  const pendingFiles = [];
  const recentArtifacts = listArtifacts(business.id, { limit: 10 })
    .filter(item => item.kind !== 'site_file')
    .map(item => ({
      kind: item.kind,
      title: item.title,
      summary: item.summary,
      created_at: item.created_at
    }));

  const messages = [{
    role: 'user',
    content: [
      `TASK: ${task.title}${task.description ? `\n\nDETAILS: ${task.description}` : ''}`,
      brief ? `TASK BRIEF:\n${formatTaskBrief(brief)}` : '',
      workflowState ? `WORKFLOW CONTINUITY:\n${JSON.stringify({
        summary: workflowState.summary,
        open_loops: workflowState.open_loops,
        evidence: workflowState.evidence
      }, null, 2)}` : '',
      recentArtifacts.length ? `RECENT ARTIFACTS:\n${JSON.stringify(recentArtifacts, null, 2)}` : '',
      workspace ? `LIVE WORKSPACE DATA:\n${JSON.stringify(workspace, null, 2)}` : '',
      'Execute now.'
    ].filter(Boolean).join('\n\n')
  }];

  let finalSummary = '';
  let nextSteps = [];
  const toolResults = [];
  let iterations = 0;

  while (iterations < 12) {
    iterations++;
    const response = await getAgentClient().messages.create({
      model: AGENT_MODEL,
      max_tokens: AGENT_MAX_TOKENS,
      system: buildSystemPrompt(business, memory, workflowState, workspace),
      tools: AGENT_TOOLS,
      messages
    });

    const assistantContent = Array.isArray(response.content) ? response.content : [];
    const toolUses = assistantContent.filter(block => block.type === 'tool_use');
    const assistantText = extractAssistantText(assistantContent);

    messages.push({ role: 'assistant', content: assistantContent });

    if (response.stop_reason === 'end_turn') {
      if (!finalSummary && assistantText) {
        finalSummary = assistantText;
      }
      break;
    }

    if (!toolUses.length) {
      if (response.stop_reason === 'pause_turn') continue;
      throw new Error(`Agent stopped with "${response.stop_reason || 'unknown'}" before returning any tool calls.`);
    }

    const toolResultContent = [];
    let sawTaskComplete = false;

    for (const block of toolUses) {
      let result;
      let isError = false;

      try {
        logTaskEvent({
          businessId: business.id,
          taskId: task.id,
          cycleId,
          phase: 'tool_started',
          title: `${block.name} started`,
          detail: block.input?.description || block.input?.title || block.input?.query || block.input?.subject || 'Ventura is executing a tool step.',
          metadata: {
            tool: block.name
          }
        });
        result = await executeTool(block.name, block.input, task, business, memory, pendingFiles, cycleId);
        toolResults.push({ tool: block.name, result });
        if (block.name === 'task_complete') {
          sawTaskComplete = true;
          finalSummary = block.input.summary;
          nextSteps = block.input.next_steps || [];
        }
        logTaskEvent({
          businessId: business.id,
          taskId: task.id,
          cycleId,
          phase: 'tool_succeeded',
          title: `${block.name} finished`,
          detail: summarizeToolResult(block.name, result),
          metadata: {
            tool: block.name
          }
        });
      } catch (err) {
        isError = true;
        result = { error: err.message };
        logTaskEvent({
          businessId: business.id,
          taskId: task.id,
          cycleId,
          phase: 'tool_failed',
          title: `${block.name} failed`,
          detail: err.message,
          metadata: {
            tool: block.name
          }
        });
      }

      toolResultContent.push(formatToolResultBlock(block.id, result, { isError }));
    }

    if (!toolResultContent.length) {
      throw new Error('Agent requested tool use but no tool results were produced.');
    }

    messages.push({ role: 'user', content: toolResultContent });
    if (sawTaskComplete) break;
  }

  const executionResult = { summary: finalSummary, toolResults, nextSteps };
  const intelligence = await persistExecutionIntelligence({
    business,
    task,
    result: executionResult,
    cycleId
  });

  return {
    ...executionResult,
    verification: intelligence.verification,
    workflow: intelligence.workflowState,
    skill: intelligence.skill
  };
}

function requiresApproval(actionName, business) {
  if (business.involvement === 'daily') return ['deploy_website', 'send_email', 'post_social'].includes(actionName);
  if (business.involvement === 'review') return ['deploy_website', 'send_email'].includes(actionName);
  return false;
}

async function executeTool(name, input, task, business, memory, pendingFiles, cycleId = null) {
  const db = getDb();
  const bump = (col) => db.prepare(`INSERT INTO metrics (id,business_id,date,${col}) VALUES (?,?,date('now'),1) ON CONFLICT(business_id,date) DO UPDATE SET ${col}=${col}+1`).run(`m${Date.now()}`, business.id);

  switch (name) {

    case 'web_search': {
      const { webSearch } = await import('../integrations/search.js');
      const results = await webSearch(input.query, 8);
      await logActivity(business.id, { type: 'research', department: 'strategy', title: `Search: "${input.query}"`, detail: { results: results.slice(0,3) } });
      createArtifact({
        businessId: business.id,
        taskId: task.id,
        cycleId,
        department: task.department,
        kind: 'research',
        title: `Research: ${input.query}`,
        summary: `${results.length} live sources collected for this task.`,
        content: results.map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.snippet || ''}`).join('\n\n'),
        metadata: {
          purpose: input.purpose || 'general',
          query: input.query
        }
      });
      return { results, count: results.length };
    }

    case 'write_code': {
      pendingFiles.push({ path: input.file_path, content: input.content });
      await logActivity(business.id, { type: 'code', department: 'engineering', title: `Code staged: ${input.file_path}`, detail: { description: input.description } });
      createArtifact({
        businessId: business.id,
        taskId: task.id,
        cycleId,
        department: 'engineering',
        kind: 'site_file',
        title: input.file_path,
        summary: input.description || 'Draft file staged by Ventura.',
        path: input.file_path,
        content: input.content,
        contentType: input.file_path.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : input.file_path.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : input.file_path.endsWith('.js')
              ? 'application/javascript; charset=utf-8'
              : 'text/plain; charset=utf-8',
        status: 'draft',
        metadata: {
          staged: true,
          description: input.description || ''
        }
      });
      return { staged: input.file_path, pending: pendingFiles.length };
    }

    case 'deploy_website': {
      const files = input.files?.length ? input.files : pendingFiles.splice(0);
      if (!files.length) return { error: 'No files to deploy' };
      if (requiresApproval('deploy_website', business)) {
        const approval = await createApproval({
          businessId: business.id,
          taskId: task.id,
          actionType: 'deploy_website',
          title: `Deploy website changes`,
          summary: input.version_note,
          payload: { files, versionNote: input.version_note }
        });
        return { queuedForReview: true, approvalId: approval.id, files: files.length };
      }
      const { deployFiles } = await import('../integrations/deploy.js');
      const { result, replayed, operation } = await runGuardedOperation({
        businessId: business.id,
        taskId: task.id,
        actionType: 'deploy_website',
        summary: input.version_note || `Deploy ${files.length} file changes`,
        payload: { files, version_note: input.version_note },
        execute: () => deployFiles(business.id, files, input.version_note)
      });
      bump('deployments');
      return { ...result, replayed: !!replayed, operationId: operation?.id || null };
    }

    case 'send_email': {
      if (requiresApproval('send_email', business)) {
        const approval = await createApproval({
          businessId: business.id,
          taskId: task.id,
          actionType: 'send_email',
          title: `Email to ${input.to}: ${input.subject}`,
          summary: `Founder review required before Ventura sends this email.`,
          payload: {
            from: business.email_address,
            to: input.to,
            subject: input.subject,
            body: input.body,
            type: input.type
          }
        });
        return { queuedForReview: true, approvalId: approval.id };
      }
      const { sendEmail } = await import('../integrations/email.js');
      const { replayed, operation } = await runGuardedOperation({
        businessId: business.id,
        taskId: task.id,
        actionType: 'send_email',
        summary: `${input.subject} → ${input.to}`,
        payload: {
          from: business.email_address,
          to: input.to,
          subject: input.subject,
          body: input.body,
          type: input.type
        },
        execute: () => sendEmail({ from: business.email_address, to: input.to, subject: input.subject, html: input.body })
      });
      bump('emails_sent');
      await logActivity(business.id, { type: 'email_sent', department: ['cold_outreach','follow_up'].includes(input.type) ? 'marketing' : 'operations', title: `Email → ${input.to}: "${input.subject}"`, detail: { type: input.type } });
      createArtifact({
        businessId: business.id,
        taskId: task.id,
        cycleId,
        department: ['cold_outreach', 'follow_up'].includes(input.type) ? 'marketing' : 'operations',
        kind: 'email',
        title: input.subject,
        summary: `Sent to ${input.to}`,
        content: input.body,
        contentType: 'text/html; charset=utf-8',
        metadata: {
          to: input.to,
          from: business.email_address,
          type: input.type
        }
      });
      return { success: true, replayed: !!replayed, operationId: operation?.id || null };
    }

    case 'post_social': {
      if (requiresApproval('post_social', business)) {
        const approval = await createApproval({
          businessId: business.id,
          taskId: task.id,
          actionType: 'post_social',
          title: `Social post for ${business.name}`,
          summary: `Founder review required before publishing to ${input.platform}.`,
          payload: {
            platform: input.platform,
            content: input.thread ? splitThread(input.content) : input.content,
            thread: !!input.thread
          }
        });
        return { queuedForReview: true, approvalId: approval.id };
      }
      const { postTweet, postLinkedIn, postThread } = await import('../integrations/social.js');
      const { result, replayed, operation } = await runGuardedOperation({
        businessId: business.id,
        taskId: task.id,
        actionType: 'post_social',
        summary: `Publish to ${input.platform}`,
        payload: {
          platform: input.platform,
          content: input.content,
          thread: !!input.thread
        },
        execute: async () => {
          const r = {};
          if (['twitter','both'].includes(input.platform)) {
            const tweets = input.thread ? splitThread(input.content) : [input.content.slice(0,280)];
            r.twitter = tweets.length > 1 ? await postThread(business.id, tweets) : await postTweet(business.id, tweets[0]);
          }
          if (['linkedin','both'].includes(input.platform)) r.linkedin = await postLinkedIn(business.id, { text: input.content });
          return { success: true, results: r };
        }
      });
      createArtifact({
        businessId: business.id,
        taskId: task.id,
        cycleId,
        department: 'marketing',
        kind: 'social_post',
        title: `Social post (${input.platform})`,
        summary: input.thread ? 'Thread prepared/published by Ventura.' : 'Post prepared/published by Ventura.',
        content: input.content,
        metadata: {
          platform: input.platform,
          thread: !!input.thread,
          operationId: operation?.id || null
        }
      });
      return { ...result, replayed: !!replayed, operationId: operation?.id || null };
    }

    case 'add_lead': {
      const id = `lead_${Date.now()}`;
      db.prepare('INSERT INTO leads (id,business_id,name,email,company,source,notes) VALUES (?,?,?,?,?,?,?)').run(id, business.id, input.name||null, input.email, input.company||null, input.source, input.notes||null);
      bump('leads');
      await logActivity(business.id, { type: 'lead', department: 'sales', title: `Lead: ${input.name||input.email}${input.company?' @ '+input.company:''}`, detail: input });
      return { success: true, leadId: id };
    }

    case 'create_content': {
      await logActivity(business.id, { type: 'content', department: 'marketing', title: `${input.type}: "${input.title}"`, detail: { chars: input.content.length, keyword: input.target_keyword } });
      createArtifact({
        businessId: business.id,
        taskId: task.id,
        cycleId,
        department: task.department,
        kind: 'content',
        title: input.title,
        summary: `${input.type} created by Ventura.`,
        content: input.content,
        metadata: {
          type: input.type,
          target_keyword: input.target_keyword || null
        }
      });
      return { success: true, type: input.type, chars: input.content.length };
    }

    case 'update_memory': {
      memory[input.key] = input.value;
      return { success: true };
    }

    case 'update_metrics': {
      db.prepare(`UPDATE businesses SET ${input.field}=?,updated_at=datetime('now') WHERE id=?`).run(input.value, business.id);
      await logActivity(business.id, { type: 'metrics', department: 'finance', title: `${input.field} → ${input.value}`, detail: { reason: input.reason } });
      return { success: true };
    }

    case 'flag_for_review': {
      await logActivity(business.id, { type: 'alert', department: null, title: `⚑ Review: ${input.title}`, detail: { detail: input.detail, urgency: input.urgency||'medium' } });
      try {
        const user = db.prepare('SELECT u.email,u.name FROM users u JOIN businesses b ON b.user_id=u.id WHERE b.id=?').get(business.id);
        if (user) { const { sendAlertEmail } = await import('../integrations/email.js'); await sendAlertEmail(user.email, business.name, input.title, input.detail); }
      } catch {}
      return { flagged: true };
    }

    case 'task_complete':
      createArtifact({
        businessId: business.id,
        taskId: task.id,
        cycleId,
        department: task.department,
        kind: 'task_summary',
        title: task.title,
        summary: input.summary,
        content: [
          `Summary: ${input.summary}`,
          (input.next_steps || []).length ? `Next steps:\n- ${(input.next_steps || []).join('\n- ')}` : ''
        ].filter(Boolean).join('\n\n'),
        metadata: {
          next_steps: input.next_steps || []
        }
      });
      return { success: true };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function summarizeToolResult(name, result = {}) {
  if (!result || typeof result !== 'object') return `${name} finished`;
  if (result.error) return result.error;
  if (name === 'web_search') return `${result.count || 0} live sources collected`;
  if (name === 'write_code') return `${result.staged || 'File'} staged for deploy`;
  if (name === 'deploy_website') return result.version ? `Published ${result.version}` : 'Deployment completed';
  if (name === 'send_email') return 'Outbound email sent';
  if (name === 'post_social') return 'Social content published';
  if (name === 'add_lead') return 'Lead added to pipeline';
  if (name === 'create_content') return `${result.type || 'Content'} created`;
  if (name === 'update_memory') return 'Agent memory updated';
  if (name === 'update_metrics') return 'Business metrics updated';
  if (name === 'task_complete') return 'Task handed off as complete';
  return `${name} finished`;
}

function splitThread(text, max = 270) {
  const parts = []; let cur = '';
  for (const s of (text.match(/[^.!?]+[.!?]+/g) || [text])) {
    if ((cur + s).length > max) { if (cur) parts.push(cur.trim()); cur = s; } else cur += ' ' + s;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.length ? parts : [text.slice(0, max)];
}

function getAgentClient() {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is missing');
  }
  if (!agentClient) {
    agentClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return agentClient;
}

function extractAssistantText(blocks = []) {
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function formatToolResultBlock(toolUseId, result, { isError = false } = {}) {
  const payload = typeof result === 'string'
    ? result
    : JSON.stringify(result ?? {});

  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [
      {
        type: 'text',
        text: payload
      }
    ],
    ...(isError ? { is_error: true } : {})
  };
}

export function __setAgentClientForTests(mockClient) {
  agentClient = mockClient;
}

export function __resetAgentClientForTests() {
  agentClient = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
}
