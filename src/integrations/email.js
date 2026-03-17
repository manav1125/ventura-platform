// src/integrations/email.js
// Email sending via SMTP (Resend / SendGrid / any provider)
// Also includes email templates for platform notifications

import nodemailer from 'nodemailer';
import { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, NODE_ENV } from '../config.js';

let transporter;

function getTransporter() {
  if (transporter) return transporter;

  if (NODE_ENV === 'test') {
    transporter = nodemailer.createTransport({ jsonTransport: true });
    return transporter;
  }

  if (NODE_ENV === 'development' && !SMTP_HOST) {
    transporter = nodemailer.createTransport({ jsonTransport: true });
    console.log('📧 Email: using JSON transport (dev mode — emails not delivered)');
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  return transporter;
}

// ─── Core send function ───────────────────────────────────────────────────────

export async function sendEmail({ from, to, subject, html, text }) {
  const t = getTransporter();
  const info = await t.sendMail({
    from: from || SMTP_FROM,
    to,
    subject,
    html,
    text: text || htmlToPlainText(html || '')
  });

  if (NODE_ENV !== 'production') {
    console.log(`📧 Email sent to ${to}: "${subject}"`);
  }

  return info;
}

// ─── Platform email templates ─────────────────────────────────────────────────

export async function sendPasswordReset(email, resetUrl) {
  return sendEmail({
    to: email,
    subject: 'Reset your Ventura password',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;color:#0a0a0a">
        <h2 style="font-size:24px;margin-bottom:16px">Reset your password</h2>
        <p style="color:#6b6459;line-height:1.6;margin-bottom:24px">
          We received a request to reset your Ventura password. Click the link below — it expires in 1 hour.
        </p>
        <a href="${resetUrl}" style="background:#e8440a;color:white;padding:12px 24px;text-decoration:none;border-radius:2px;display:inline-block">
          Reset password →
        </a>
        <p style="margin-top:24px;font-size:12px;color:#aaa">If you didn't request this, ignore this email.</p>
      </div>
    `
  });
}

export async function sendCycleDigest(userEmail, userName, businesses) {
  const summaries = businesses.map(b => `
    <div style="padding:16px;background:#f5f2eb;border-radius:4px;margin-bottom:12px">
      <strong>${b.name}</strong> — Day ${b.day_count}<br>
      <span style="color:#6b6459">${b.lastSummary || 'No summary yet.'}</span>
    </div>
  `).join('');

  return sendEmail({
    to: userEmail,
    subject: `Ventura daily digest — ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;color:#0a0a0a">
        <h2 style="font-size:22px;margin-bottom:6px">Morning, ${userName}.</h2>
        <p style="color:#6b6459;margin-bottom:24px">Here's what your agents did overnight:</p>
        ${summaries}
        <a href="https://ventura.ai/dashboard" style="background:#e8440a;color:white;padding:12px 24px;text-decoration:none;border-radius:2px;display:inline-block;margin-top:8px">
          Open dashboard →
        </a>
      </div>
    `
  });
}

export async function sendAlertEmail(userEmail, businessName, alertTitle, alertDetail) {
  return sendEmail({
    to: userEmail,
    subject: `⚑ Action needed: ${alertTitle} — ${businessName}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;color:#0a0a0a">
        <div style="background:#fff3cd;border:1px solid #e8c84b;border-radius:4px;padding:16px;margin-bottom:24px">
          <strong>⚑ Your agent flagged something for your review</strong>
        </div>
        <h3 style="margin-bottom:8px">${alertTitle}</h3>
        <p style="color:#6b6459;line-height:1.6">${alertDetail}</p>
        <a href="https://ventura.ai/dashboard" style="background:#0a0a0a;color:white;padding:12px 24px;text-decoration:none;border-radius:2px;display:inline-block;margin-top:20px">
          Review in dashboard →
        </a>
      </div>
    `
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function htmlToPlainText(html) {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
