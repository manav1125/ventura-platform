import { ImapFlow } from 'imapflow';
import ical from 'node-ical';
import Stripe from 'stripe';
import { STRIPE_SECRET_KEY } from '../config.js';
import { isMockStripeAccount } from './stripe.js';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function titleCase(value) {
  return cleanString(value)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatCurrencyAmount(amountCents, currency = 'usd') {
  return `${(Number(amountCents || 0) / 100).toFixed(2)} ${String(currency || 'usd').toUpperCase()}`;
}

function emailFromAddressObject(address) {
  if (!address) return '';
  return cleanString(address.address || address.mailbox || '');
}

function nameFromAddressObject(address) {
  return cleanString(address?.name || emailFromAddressObject(address));
}

function inboxStatusFromFlags(flags = []) {
  const normalized = Array.from(flags || []).map(flag => String(flag));
  return normalized.includes('\\Seen') ? 'waiting' : 'attention';
}

function inferCalendarType(event = {}) {
  const haystack = `${cleanString(event.summary)} ${cleanString(event.description)}`.toLowerCase();
  if (haystack.includes('demo') || haystack.includes('prospect') || haystack.includes('sales')) return 'sales_demo';
  if (haystack.includes('launch') || haystack.includes('release')) return 'launch';
  return 'ops_review';
}

export async function loadInboxProviderRecords({ business, integration, fallback }) {
  if (integration.provider !== 'imap') return fallback();

  const config = integration.config || {};
  const secrets = integration.secrets || {};
  const host = cleanString(config.imap_host);
  const port = parseInteger(config.imap_port, config.imap_secure ? 993 : 143);
  const secure = !!config.imap_secure;
  const mailbox = cleanString(config.imap_mailbox) || 'INBOX';
  const username = cleanString(config.imap_username || secrets.imap_username);
  const password = cleanString(secrets.imap_password);

  if (!host || !username || !password) {
    throw new Error('IMAP inbox sync needs a host, username, and password.');
  }

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user: username, pass: password },
    logger: false
  });

  let lock;
  try {
    await client.connect();
    lock = await client.getMailboxLock(mailbox);
    const total = Number(client.mailbox?.exists || 0);
    if (!total) return [];

    const start = Math.max(1, total - 7);
    const range = `${start}:${total}`;
    const records = [];

    for await (const message of client.fetch(range, {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true
    })) {
      const envelope = message.envelope || {};
      const from = envelope.from?.[0];
      const to = envelope.to?.[0];
      records.push({
        externalId: `imap-${message.uid || message.seq || records.length + 1}`,
        status: inboxStatusFromFlags(message.flags),
        title: cleanString(envelope.subject) || `Inbox thread from ${nameFromAddressObject(from) || 'unknown sender'}`,
        summary: `${nameFromAddressObject(from) || 'A sender'} emailed ${business.name} via IMAP inbox sync.`,
        owner: emailFromAddressObject(to) || business.email_address || username,
        metadata: {
          channel: 'email',
          requires_reply: inboxStatusFromFlags(message.flags) === 'attention',
          sentiment: 'neutral',
          source: 'imap'
        },
        payload: {
          from: emailFromAddressObject(from) || null,
          to: emailFromAddressObject(to) || business.email_address || username,
          thread_state: inboxStatusFromFlags(message.flags) === 'attention' ? 'awaiting_reply' : 'waiting_on_founder'
        },
        occurredAt: message.internalDate ? new Date(message.internalDate).toISOString() : new Date().toISOString()
      });
    }

    return records.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  } finally {
    if (lock) lock.release();
    await client.logout().catch(() => client.close());
  }
}

export async function loadCalendarProviderRecords({ business, integration, fallback }) {
  if (integration.provider !== 'ics') return fallback();

  const icsUrl = cleanString(integration.secrets?.ics_url);
  if (!icsUrl) {
    throw new Error('ICS calendar sync needs a feed URL.');
  }

  const calendar = await ical.async.fromURL(icsUrl);
  const now = Date.now();
  const upcoming = Object.values(calendar)
    .filter(item => item?.type === 'VEVENT' && item.start)
    .map(event => ({
      event,
      startsAt: new Date(event.start).getTime(),
      endsAt: event.end ? new Date(event.end).getTime() : new Date(event.start).getTime()
    }))
    .filter(({ endsAt }) => endsAt >= now - (2 * 60 * 60 * 1000))
    .sort((a, b) => a.startsAt - b.startsAt)
    .slice(0, 8);

  return upcoming.map(({ event, startsAt, endsAt }) => ({
    externalId: cleanString(event.uid) || `ics-${startsAt}`,
    status: startsAt > now ? 'upcoming' : 'draft',
    title: cleanString(event.summary) || `${business.name} calendar event`,
    summary: cleanString(event.description) || `Synced from ICS calendar feed for ${business.name}.`,
    owner: cleanString(integration.config?.owner_email) || business.email_address || null,
    metadata: {
      location: cleanString(event.location) || null,
      attendee_count: Array.isArray(event.attendee) ? event.attendee.length : 0,
      type: inferCalendarType(event)
    },
    payload: {
      starts_at: new Date(startsAt).toISOString(),
      ends_at: new Date(endsAt).toISOString()
    },
    occurredAt: new Date(startsAt).toISOString()
  }));
}

export async function loadAccountingProviderRecords({ business, integration, fallback }) {
  if (integration.provider !== 'stripe') return fallback();
  if (!STRIPE_SECRET_KEY) {
    throw new Error('Stripe ledger sync needs STRIPE_SECRET_KEY.');
  }
  if (!stripe) {
    throw new Error('Stripe ledger sync could not initialize Stripe.');
  }

  const accountId = cleanString(
    integration.config?.account_external_id
    || (integration.config?.use_business_stripe_account === false ? '' : business.stripe_account_id)
  );
  if (!accountId || isMockStripeAccount(accountId)) {
    throw new Error('Stripe ledger sync needs a live Connect account.');
  }

  const transactions = await stripe.balanceTransactions.list(
    { limit: 8 },
    { stripeAccount: accountId }
  );

  return transactions.data.map(tx => ({
    externalId: tx.id,
    status: tx.status === 'pending' ? 'pending' : 'posted',
    title: `${titleCase(tx.type || 'transaction')} ${tx.amount >= 0 ? 'captured' : 'recorded'}`,
    summary: cleanString(tx.description)
      || `Stripe ${tx.type || 'transaction'} of ${formatCurrencyAmount(Math.abs(tx.amount || 0), tx.currency)} synced from the business ledger.`,
    owner: cleanString(integration.config?.account_label) || `${business.name} Stripe ledger`,
    metadata: {
      amount_cents: Math.abs(tx.amount || 0),
      net_cents: Math.abs(tx.net || 0),
      currency: tx.currency || 'usd',
      category: tx.type || 'transaction'
    },
    payload: {
      direction: tx.amount >= 0 ? 'income' : 'expense',
      amount_cents: Math.abs(tx.amount || 0),
      fee_cents: Math.abs((tx.fee || 0))
    },
    occurredAt: tx.created ? new Date(tx.created * 1000).toISOString() : new Date().toISOString()
  }));
}
