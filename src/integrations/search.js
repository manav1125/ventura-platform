// src/integrations/search.js
// Gives the agent live research capabilities:
//   - Web search (via Brave Search API — cheap, no scraping)
//   - Competitor research
//   - Lead discovery
//   - SEO keyword research

import { BRAVE_SEARCH_API_KEY } from '../config.js';

const BRAVE_BASE = 'https://api.search.brave.com/res/v1';

// ─── Core search ─────────────────────────────────────────────────────────────

export async function webSearch(query, count = 10) {
  if (!BRAVE_SEARCH_API_KEY) {
    console.log(`[Search] No API key — simulating search for: "${query}"`);
    return mockSearchResults(query);
  }

  const url = `${BRAVE_BASE}/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': BRAVE_SEARCH_API_KEY
    }
  });

  if (!res.ok) throw new Error(`Search API error: ${res.status}`);
  const data = await res.json();

  return (data.web?.results || []).map(r => ({
    title: r.title,
    url: r.url,
    description: r.description,
    published: r.age
  }));
}

// ─── Competitor research ──────────────────────────────────────────────────────

export async function researchCompetitors(businessName, businessType, targetCustomer) {
  const queries = [
    `best ${businessType} tools for ${targetCustomer}`,
    `${businessName} competitors alternatives`,
    `top ${businessType} startups 2024 2025`
  ];

  const results = await Promise.all(queries.map(q => webSearch(q, 5)));
  const flat = results.flat();

  // Deduplicate by domain
  const seen = new Set();
  return flat.filter(r => {
    try {
      const domain = new URL(r.url).hostname;
      if (seen.has(domain)) return false;
      seen.add(domain);
      return true;
    } catch { return true; }
  }).slice(0, 15);
}

// ─── SEO keyword research ─────────────────────────────────────────────────────

export async function getKeywordIdeas(niche, targetCustomer) {
  const results = await webSearch(`${niche} ${targetCustomer} how to guide best practices`, 8);
  // In production, wire to DataForSEO, Ahrefs, or Semrush API
  // Here we extract topics from search results
  const topics = results.map(r => r.title).filter(Boolean);
  return {
    seed_keywords: [niche, targetCustomer],
    content_ideas: topics.slice(0, 8),
    search_results: results
  };
}

// ─── Lead discovery ───────────────────────────────────────────────────────────

export async function findProspects(targetCustomer, niche) {
  // In production: integrate with Apollo.io, Hunter.io, or LinkedIn Sales Navigator
  // Search for people/companies matching the ICP (ideal customer profile)
  const results = await webSearch(`${targetCustomer} ${niche} contact email`, 5);
  return results.map(r => ({
    company: r.title?.split(' - ')[0],
    url: r.url,
    description: r.description
  }));
}

// ─── Mock results for dev ─────────────────────────────────────────────────────

function mockSearchResults(query) {
  return [
    { title: `Best practices for ${query}`, url: 'https://example.com/1', description: 'A comprehensive guide to getting started with your specific use case.', published: '2 days ago' },
    { title: `How to succeed with ${query} in 2025`, url: 'https://example.com/2', description: 'Updated strategies and tactics for modern businesses.', published: '1 week ago' },
    { title: `${query} — complete tutorial`, url: 'https://example.com/3', description: 'Step by step walkthrough with real examples.', published: '3 days ago' }
  ];
}
