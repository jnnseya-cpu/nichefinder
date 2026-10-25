/* ============================================================================
   Niche Finder — Agent Registry (manifest + validator).

   Formalises the platform's AI "agents" as typed specs (the AgentSpec shape from
   docs/AI-OS-ARCHITECTURE.md §5). This is the registry the v1.0 blueprint and the
   v2.0 reconciliation call for — built HONESTLY: each entry carries a `status`
   (live | partial | proposed) and, when live, an `impl` pointer to the real code
   that backs it. Today's "agents" are role-specialised prompts + deterministic
   functions behind the one provider gateway, not autonomous processes — the
   registry records exactly that, so nobody mistakes a prompt for an autonomous
   worker. New agents are added here with their real status; nothing is invented.

   Safety law (enforced elsewhere, declared here): every agent acts through the
   same ACU-gated, ledgered, permission-checked APIs as humans. No agent holds
   provider keys, and none may take an irreversible/outbound action without human
   approval. `autonomy` records how far each agent may act on its own.
   ============================================================================ */
import { GatewayError } from './errors.js';

/** @typedef {'executive'|'product'|'engineering'|'quality'|'security'|'revenue'|'customer'|'compliance'|'platform'|'intelligence'} Tier */
/** @typedef {'live'|'partial'|'proposed'} Status */
/** @typedef {'recommend_only'|'approval_gated'|'runbook_only'|'autonomous_safe'} Autonomy */

const TIERS = new Set(['executive', 'product', 'engineering', 'quality', 'security', 'revenue', 'customer', 'compliance', 'platform', 'intelligence']);
const STATUSES = new Set(['live', 'partial', 'proposed']);
const AUTONOMY = new Set(['recommend_only', 'approval_gated', 'runbook_only', 'autonomous_safe']);
const PROVIDERS = new Set(['claude', 'gemini', 'openai', 'deterministic', 'none']);

export const AGENTS = [
  // ── LIVE: backed by real code shipping today ────────────────────────────────
  { id: 'onboarding', tier: 'customer', status: 'live', autonomy: 'autonomous_safe',
    purpose: 'Create a new operator: account, wallet {paid:0, free:100 welcome}, welcome ledger entry, referral attribution.',
    inputs: ['auth.signup', 'referral_code'], outputs: ['user', 'wallet', 'WELCOME ledger row'],
    permissions: ['wallet:create'], triggers: ['POST /v1/auth/signup'], providers: ['deterministic'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'support', when: 'verification failure' },
    impl: 'auth.js signup + wallet.js credit' },

  { id: 'niche-discovery', tier: 'product', status: 'live', autonomy: 'approval_gated',
    purpose: 'Country-grounded opportunities under the capital cap; discovery modes; World Bank market grounding.',
    inputs: ['SearchRequest', 'country macro signals', 'user memory'], outputs: ['ranked NicheResult[]'],
    permissions: ['generate:structured'], triggers: ['POST /v1/generate (jsonSchema)'], providers: ['claude', 'gemini', 'openai'],
    acuPolicy: { billedTo: 'user', action: 'niche_search' }, escalation: { to: 'quality', when: 'no usable result' },
    impl: 'server.js /v1/generate + marketdata.js + providers/*' },

  { id: 'scoring', tier: 'intelligence', status: 'partial', autonomy: 'autonomous_safe',
    purpose: 'Venture scoring on a fixed, published rubric (PRS/CS/PSS). Free homepage score is a PURE function; paid search is model-scored against the same rubric + real data (not bit-reproducible — tracked as D-02).',
    inputs: ['idea', 'country', 'evidence'], outputs: ['ScoreBundle', 'decision label'],
    permissions: [], triggers: ['inline with discovery', 'homepage free score'], providers: ['deterministic', 'claude'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'none', when: 'never' },
    impl: 'frontend/index.html (free, pure) + search.html NICHE_SCHEMA (paid)' },

  { id: 'document-studio', tier: 'product', status: 'live', autonomy: 'approval_gated',
    purpose: 'Investor-grade asset generation (validation, forecast, P&L, risk heatmap, business plan, pitch deck, GTM, investor pack) from one evidence base.',
    inputs: ['project context', 'docType'], outputs: ['structured document', 'generated_asset'],
    permissions: ['generate:document'], triggers: ['POST /v1/document'], providers: ['claude', 'gemini', 'openai'],
    acuPolicy: { billedTo: 'user', action: 'per price list' }, escalation: { to: 'quality', when: 'incomplete output' },
    impl: 'server.js /v1/document + output-guard' },

  { id: 'support-concierge', tier: 'customer', status: 'live', autonomy: 'approval_gated',
    purpose: 'In-context help on pricing/scoring/build questions; escalates to a human when needed.',
    inputs: ['chat turn', 'user memory'], outputs: ['answer', 'support_case'],
    permissions: ['generate:chat'], triggers: ['support message'], providers: ['claude', 'gemini', 'openai'],
    acuPolicy: { billedTo: 'user', action: 'support_message' }, escalation: { to: 'human support', when: 'low confidence / repeat unresolved' },
    impl: 'nf-support.js + gateway' },

  { id: 'payment', tier: 'revenue', status: 'live', autonomy: 'autonomous_safe',
    purpose: 'Settle verified card (Stripe) and mobile-money (KODA) payments; credit the wallet idempotently; receipts + conversion events.',
    inputs: ['provider webhook'], outputs: ['wallet credit', 'TOP_UP ledger row', 'receipt'],
    permissions: ['wallet:credit'], triggers: ['POST /v1/payments/*-webhook'], providers: ['none'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'finance_admin', when: 'reconciliation mismatch' },
    impl: 'payments.js + koda.js (bitripay.js when live)' },

  { id: 'growth-partner', tier: 'revenue', status: 'live', autonomy: 'autonomous_safe',
    purpose: 'Referral attribution, commission crediting (ACU) with a lifetime cap, reversal on refund.',
    inputs: ['referral links', 'paid purchases'], outputs: ['commission credit', 'referral records'],
    permissions: ['wallet:credit'], triggers: ['onPaidPurchase'], providers: ['deterministic'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'finance_admin', when: 'cap/abuse anomaly' },
    impl: 'referrals.js' },

  { id: 'sentinel-security', tier: 'security', status: 'live', autonomy: 'autonomous_safe',
    purpose: 'Attack-pattern screen (traversal/XSS/injection/prompt-injection) + per-IP rate limit + IP strike bans; proof-of-work human gate on auth.',
    inputs: ['every request'], outputs: ['block/allow', 'strike', 'ban'],
    permissions: ['request:screen'], triggers: ['every /v1/* request'], providers: ['deterministic'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'super_admin', when: 'sustained attack' },
    impl: 'server.js screenInstructions + rate limiter + human.js PoW' },

  { id: 'denial-of-wallet-guard', tier: 'security', status: 'live', autonomy: 'autonomous_safe',
    purpose: 'Cap free (welcome-funded) previews per IP and globally to stop guest-wallet rotation farming provider spend.',
    inputs: ['preview requests', 'ip'], outputs: ['allow/429 free_preview_limit'],
    permissions: [], triggers: ['POST /v1/generate preview path'], providers: ['deterministic'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'super_admin', when: 'global breaker trips' },
    impl: 'server.js freePreviewGuard' },

  { id: 'seo-content', tier: 'revenue', status: 'partial', autonomy: 'approval_gated',
    purpose: 'Publish/unpublish SEO blog articles; IndexNow ping; (autonomous content pipeline is the roadmap item).',
    inputs: ['admin publish', 'keyword intel'], outputs: ['published article', 'search-engine ping'],
    permissions: ['articles:publish'], triggers: ['Admin → Content & SEO'], providers: ['deterministic'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'admin', when: 'publish review' },
    impl: 'articles.js + admin-console.html + indexnow-submit.mjs' },

  { id: 'system-health', tier: 'platform', status: 'live', autonomy: 'runbook_only',
    purpose: 'Uptime/latency/error watchdog; alert, de-dup, recover; auto-deploy with 2-gate rollback; backups + restore drill.',
    inputs: ['health probes', 'metrics'], outputs: ['alerts', 'rollback', 'incident record'],
    permissions: ['ops:runbook'], triggers: ['nf-monitor.timer', 'nf-deploy.timer'], providers: ['none'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'super_admin', when: 'runbook does not resolve' },
    impl: 'scripts/nf-monitor.* + vps-autodeploy.sh + nf-backup.*' },

  // ── PROPOSED: designed, not yet built (honest) ──────────────────────────────
  { id: 'analyst', tier: 'intelligence', status: 'proposed', autonomy: 'recommend_only',
    purpose: 'Data analysis, reporting, forecasting, benchmark comparisons over the event ledger.',
    inputs: ['event ledger', 'ledger cohorts'], outputs: ['insights', 'reports'],
    permissions: ['read:events'], triggers: ['cron', 'command centre'], providers: ['claude'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'human', when: 'always (recommend-only)' }, impl: null },

  { id: 'research', tier: 'intelligence', status: 'proposed', autonomy: 'recommend_only',
    purpose: 'Market/competitor/industry intelligence sweeps feeding discovery quality filters.',
    inputs: ['country/sector', 'public data'], outputs: ['intelligence briefs'],
    permissions: ['read:connectors'], triggers: ['pre-discovery', 'cron'], providers: ['claude', 'gemini'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'human', when: 'always' }, impl: null },

  { id: 'pricing', tier: 'revenue', status: 'proposed', autonomy: 'approval_gated',
    purpose: 'Margin-floor enforcement + dynamic multiplier within policy bounds (changes require Finance Admin approval).',
    inputs: ['provider cost telemetry', 'ledger'], outputs: ['pricing recommendations'],
    permissions: ['read:ledger'], triggers: ['nightly cron', 'margin breach'], providers: ['deterministic'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'finance_admin', when: 'price change > ±10%' }, impl: null },

  { id: 'fraud', tier: 'security', status: 'proposed', autonomy: 'approval_gated',
    purpose: 'Welcome-credit farming, device clustering, velocity/top-up anomalies, scored holds with human release.',
    inputs: ['auth events', 'ledger', 'device fingerprints'], outputs: ['fraud scores', 'holds'],
    permissions: ['read:events', 'wallet:hold'], triggers: ['every wallet mutation'], providers: ['deterministic'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'finance_admin', when: '≥ threshold' }, impl: null },

  { id: 'predictive-growth', tier: 'intelligence', status: 'proposed', autonomy: 'recommend_only',
    purpose: 'LTV, churn risk, top-up forecasting, cohort trends; win-back interventions (approval-gated).',
    inputs: ['ledger', 'engagement events'], outputs: ['growth briefs', 'intervention tasks'],
    permissions: ['read:events'], triggers: ['daily cron'], providers: ['deterministic', 'claude'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'human', when: 'always' }, impl: null },

  { id: 'auto-repair', tier: 'platform', status: 'proposed', autonomy: 'runbook_only',
    purpose: 'Execute PRE-APPROVED runbooks only (restart, cache flush, provider re-route, rollback); anything novel pages a human.',
    inputs: ['health alerts', 'error clusters'], outputs: ['runbook execution', 'incident record'],
    permissions: ['ops:runbook'], triggers: ['SLO breach', 'error cluster'], providers: ['none'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'super_admin', when: 'no matching runbook' }, impl: null },

  { id: 'ai-governance', tier: 'platform', status: 'proposed', autonomy: 'approval_gated',
    purpose: 'Prompt/policy versioning, permission enforcement, model-router overrides; the only agent whose escalation is mandatory-human.',
    inputs: ['agent logs', 'policies'], outputs: ['governance report', 'blocked-action log'],
    permissions: ['read:agent_logs'], triggers: ['continuous'], providers: ['none'],
    acuPolicy: { billedTo: 'platform' }, escalation: { to: 'super_admin (human)', when: 'any high-impact action' }, impl: null },
];

/** Validate one agent spec; throws GatewayError on the first problem. */
export function validateAgent(a) {
  const req = ['id', 'tier', 'status', 'autonomy', 'purpose', 'inputs', 'outputs', 'permissions', 'triggers', 'providers', 'acuPolicy', 'escalation'];
  for (const k of req) if (a[k] === undefined) throw new GatewayError(`Agent "${a.id || '?'}" missing field: ${k}`, { status: 500, code: 'bad_agent_spec' });
  if (!TIERS.has(a.tier)) throw new GatewayError(`Agent "${a.id}" bad tier: ${a.tier}`, { status: 500, code: 'bad_agent_spec' });
  if (!STATUSES.has(a.status)) throw new GatewayError(`Agent "${a.id}" bad status: ${a.status}`, { status: 500, code: 'bad_agent_spec' });
  if (!AUTONOMY.has(a.autonomy)) throw new GatewayError(`Agent "${a.id}" bad autonomy: ${a.autonomy}`, { status: 500, code: 'bad_agent_spec' });
  for (const p of a.providers) if (!PROVIDERS.has(p)) throw new GatewayError(`Agent "${a.id}" bad provider: ${p}`, { status: 500, code: 'bad_agent_spec' });
  if (a.status === 'live' && !a.impl) throw new GatewayError(`Agent "${a.id}" is live but has no impl pointer`, { status: 500, code: 'bad_agent_spec' });
  return true;
}

/** Validate the whole registry (unique ids + each spec valid). */
export function validateRegistry(list = AGENTS) {
  const seen = new Set();
  for (const a of list) {
    if (seen.has(a.id)) throw new GatewayError(`Duplicate agent id: ${a.id}`, { status: 500, code: 'bad_agent_spec' });
    seen.add(a.id); validateAgent(a);
  }
  return true;
}

export const agentById = (id) => AGENTS.find((a) => a.id === id) || null;
export const agentsByTier = (tier) => AGENTS.filter((a) => a.tier === tier);
export const agentsByStatus = (status) => AGENTS.filter((a) => a.status === status);
/** Registry summary for the admin agent-governance board. */
export function registrySummary() {
  const by = (k) => AGENTS.reduce((m, a) => ((m[a[k]] = (m[a[k]] || 0) + 1), m), {});
  return { total: AGENTS.length, byStatus: by('status'), byTier: by('tier'), byAutonomy: by('autonomy') };
}
