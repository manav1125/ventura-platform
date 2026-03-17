// src/agents/brain.js — Full agent brain with all tools
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, AGENT_MODEL, AGENT_MAX_TOKENS } from '../config.js';
import { getDb } from '../db/migrate.js';
import { logActivity } from './activity.js';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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

function buildSystemPrompt(business, memory) {
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

PRINCIPLES:
1. You are an OPERATOR. Bias for action. Execute, don't plan.
2. Every task must produce a tangible output: code deployed, email sent, content written, leads added.
3. Use web_search before making strategic decisions — get real data.
4. Update memory with every significant learning.
5. Emails must sound human and personal. Never spam.
6. Flag for review only when stakes are genuinely high (legal, >$100 financial commitment, PR risk).
7. Connect every action to the 90-day goal.

INVOLVEMENT: ${business.involvement === 'autopilot' ? 'Execute everything autonomously.' : business.involvement === 'review' ? 'Flag email sends and deployments for review.' : 'Flag major decisions for founder approval.'}

Execute the assigned task using your tools. Call task_complete when done.`;
}

export async function runTask(task, business) {
  const db = getDb();
  const memory = JSON.parse(business.agent_memory || '{}');
  const pendingFiles = [];

  const messages = [{
    role: 'user',
    content: `TASK: ${task.title}${task.description ? '\n\nDETAILS: ' + task.description : ''}\n\nExecute now.`
  }];

  let finalSummary = '';
  let nextSteps = [];
  const toolResults = [];
  let iterations = 0;

  while (iterations < 12) {
    iterations++;
    const response = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: AGENT_MAX_TOKENS,
      system: buildSystemPrompt(business, memory),
      tools: AGENT_TOOLS,
      messages
    });

    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolResultContent = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        let result;
        try {
          result = await executeTool(block.name, block.input, task, business, memory, pendingFiles);
          toolResults.push({ tool: block.name, result });
          if (block.name === 'task_complete') {
            finalSummary = block.input.summary;
            nextSteps = block.input.next_steps || [];
          }
        } catch (err) {
          result = { error: err.message };
        }
        toolResultContent.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResultContent });
      if (toolResults.some(r => r.tool === 'task_complete')) break;
    }
  }

  db.prepare('UPDATE businesses SET agent_memory=? WHERE id=?').run(JSON.stringify(memory), business.id);
  return { summary: finalSummary, toolResults, nextSteps };
}

async function executeTool(name, input, task, business, memory, pendingFiles) {
  const db = getDb();
  const bump = (col) => db.prepare(`INSERT INTO metrics (id,business_id,date,${col}) VALUES (?,?,date('now'),1) ON CONFLICT(business_id,date) DO UPDATE SET ${col}=${col}+1`).run(`m${Date.now()}`, business.id);

  switch (name) {

    case 'web_search': {
      const { webSearch } = await import('../integrations/search.js');
      const results = await webSearch(input.query, 8);
      await logActivity(business.id, { type: 'research', department: 'strategy', title: `Search: "${input.query}"`, detail: { results: results.slice(0,3) } });
      return { results, count: results.length };
    }

    case 'write_code': {
      pendingFiles.push({ path: input.file_path, content: input.content });
      await logActivity(business.id, { type: 'code', department: 'engineering', title: `Code staged: ${input.file_path}`, detail: { description: input.description } });
      return { staged: input.file_path, pending: pendingFiles.length };
    }

    case 'deploy_website': {
      const { deployFiles } = await import('../integrations/deploy.js');
      const files = input.files?.length ? input.files : pendingFiles.splice(0);
      if (!files.length) return { error: 'No files to deploy' };
      const result = await deployFiles(business.id, files, input.version_note);
      bump('deployments');
      return result;
    }

    case 'send_email': {
      if (business.involvement !== 'autopilot') {
        return executeTool('flag_for_review', { title: `Email to ${input.to}: ${input.subject}`, detail: input.body?.slice(0,300), urgency: 'medium' }, task, business, memory, pendingFiles);
      }
      const { sendEmail } = await import('../integrations/email.js');
      await sendEmail({ from: business.email_address, to: input.to, subject: input.subject, html: input.body });
      bump('emails_sent');
      await logActivity(business.id, { type: 'email_sent', department: ['cold_outreach','follow_up'].includes(input.type) ? 'marketing' : 'operations', title: `Email → ${input.to}: "${input.subject}"`, detail: { type: input.type } });
      return { success: true };
    }

    case 'post_social': {
      const { postTweet, postLinkedIn, postThread } = await import('../integrations/social.js');
      const r = {};
      if (['twitter','both'].includes(input.platform)) {
        const tweets = input.thread ? splitThread(input.content) : [input.content.slice(0,280)];
        r.twitter = tweets.length > 1 ? await postThread(business.id, tweets) : await postTweet(business.id, tweets[0]);
      }
      if (['linkedin','both'].includes(input.platform)) r.linkedin = await postLinkedIn(business.id, { text: input.content });
      return { success: true, results: r };
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
      return { success: true };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function splitThread(text, max = 270) {
  const parts = []; let cur = '';
  for (const s of (text.match(/[^.!?]+[.!?]+/g) || [text])) {
    if ((cur + s).length > max) { if (cur) parts.push(cur.trim()); cur = s; } else cur += ' ' + s;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.length ? parts : [text.slice(0, max)];
}
