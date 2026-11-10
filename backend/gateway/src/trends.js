// Trend Intelligence — embedded control layer for Niche Finder's own SEO and
// marketing. This is NOT a separate service: it runs inside the gateway, reuses
// the platform's rails (auth/admin gate, connector wrapper, article renderer as
// the owned surface, audit), and is scoped to THIS platform installation.
//
// Loop (spec v2.3, §1): read demand signals -> score opportunity & confidence
// -> emit a versioned, time-limited Growth Brief -> SEO/marketing drafting adapts
// to the brief -> gated activation on an owned page -> measure -> continue /
// revise / roll back. 100% keyless: detection, scoring, templates, review and the
// owned-surface activation need no new third-party key. Host AI (the platform's
// already-configured providers) is reused for richer drafts when available;
// deterministic templates keep the workflow alive during any model outage.
//
// Persistence follows the platform's feature-module pattern (own JSON file with a
// debounced atomic write + flush), exactly like articles.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GatewayError } from './errors.js';

const STORE_PATH = process.env.TRENDS_STORE || path.join(process.cwd(), 'data', 'trends.json');

/* ── persistence (mirrors articles.js) ──────────────────────────────────── */
let store = load();
let timer = null;

function freshStore() {
  return {
    profile: defaultProfile(),
    sources: {},
    observations: {},
    briefs: {},
    actions: {},
    receipts: {},   // actionKey -> { assetId, appliedRevision, status }
    assets: {},     // native owned-surface pages
    outcomes: {},
    audit: [],
    frozen: false,
    seq: 0,
  };
}
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return Object.assign(freshStore(), s);
  } catch { return freshStore(); }
}
function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
      const tmp = `${STORE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, STORE_PATH);
    } catch (err) { console.error('[trends] persist failed:', err.message); }
  }, 50);
}
export function flushTrends() {
  if (timer) { clearTimeout(timer); timer = null; }
  try { fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true }); fs.writeFileSync(STORE_PATH, JSON.stringify(store)); } catch { /* best effort */ }
}
// Test-only: reset to a clean store (isolate-stores style).
export function _resetTrends() { store = freshStore(); flushTrends(); }

/* ── helpers ────────────────────────────────────────────────────────────── */
const now = () => Date.now();
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
function canonical(obj) { return stableStringify(obj); }
function stableStringify(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}
function hash(obj) { return crypto.createHash('sha256').update(canonical(obj)).digest('hex'); }
function newId(prefix) { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }
function audit(stage, detail) {
  store.audit.push({ stage, detail, ts: nowIso() });
  if (store.audit.length > 2000) store.audit = store.audit.slice(-2000);
  persist();
}
function bad(message, code = 'bad_request', status = 400, extra = {}) {
  throw new GatewayError(message, { status, code, platformCode: code, ...extra });
}

/* ── §5/§17 scoring (deterministic, keyless) ────────────────────────────── */
export const OPP_W = { demand: 0.25, fit: 0.25, intent: 0.20, timing: 0.15, readiness: 0.15 };
export const CONF_W = { source_quality: 0.35, corroboration: 0.25, coverage: 0.20, freshness: 0.20 };
const SINGLE_FAMILY_CAP = 69;

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function logLift(c, b) { return Math.log((c + 1) / (b + 1)); }
export function robustZ(c, history) {
  if (!history.length) return 0;
  const logs = history.map((x) => Math.log1p(x));
  const med = median(logs);
  const mad = median(logs.map((v) => Math.abs(v - med)));
  const scale = Math.max(1.4826 * mad, 0.2);
  return (Math.log1p(c) - med) / scale;
}
export function corroborationValue(independentFamilies) {
  if (independentFamilies <= 1) return 0;
  if (independentFamilies === 2) return 80;
  return 100;
}
export function opportunityScore({ demand, fit, intent, timing, readiness }, vetoes = []) {
  const reasons = [...vetoes];
  if (readiness <= 0) reasons.push('readiness_zero');
  const score = OPP_W.demand * demand + OPP_W.fit * fit + OPP_W.intent * intent
    + OPP_W.timing * timing + OPP_W.readiness * readiness;
  return { score, vetoed: reasons.length > 0, veto_reasons: reasons,
    breakdown: { demand, fit, intent, timing, readiness, weights: OPP_W } };
}
export function confidenceScore({ source_quality, corroboration, coverage, freshness, independent_families = 1 }) {
  const raw = CONF_W.source_quality * source_quality + CONF_W.corroboration * corroboration
    + CONF_W.coverage * coverage + CONF_W.freshness * freshness;
  let score = raw, capped = false;
  if (independent_families <= 1 && raw > SINGLE_FAMILY_CAP) { score = SINGLE_FAMILY_CAP; capped = true; }
  return { score, capped, breakdown: { source_quality, corroboration, coverage, freshness, independent_families, raw, weights: CONF_W } };
}
// §5 decision bands. External actions still require policy + channel approval.
export function decide(score, confidence, { vetoed = false, tenantAutoOptin = false } = {}) {
  if (vetoed) return (score >= 60 && confidence >= 55) ? 'watch' : 'archive';
  if (score < 60 || confidence < 55) return 'archive';
  if (score >= 85 && confidence >= 85 && tenantAutoOptin) return 'auto_eligible';
  if (score >= 75 && confidence >= 75) return 'reviewable_brief';
  return 'watch';
}

/* ── profile (§9/§14): THIS platform's configuration, data-driven ───────── */
function defaultProfile() {
  return {
    platform_slug: 'niche-finder',
    default_market: 'GB',
    default_locale: 'en-GB',
    policy_version: 1,
    allowed_channels: ['seo', 'organic_social'],
    enabled_channels: ['seo', 'organic_social'],
    approved_claims: {},        // claim_id -> text
    allowed_cta_ids: [],
    allowed_asset_ids: [],
    outcome: { conversion: 'qualified_action', denominator: 'eligible_session' },
    forbidden_topics: [],
    fit_map: {},                // topic -> { fit, intent }
  };
}
export function getProfile() { return JSON.parse(JSON.stringify(store.profile)); }
export function setProfile(patch) {
  store.profile = Object.assign(getProfile(), patch || {});
  store.profile.policy_version = (store.profile.policy_version || 1);
  audit('profile.updated', { keys: Object.keys(patch || {}) });
  persist();
  return getProfile();
}
function fitIntentFor(topic) {
  const m = store.profile.fit_map[topic];
  if (!m) return { fit: 0, intent: 0 };
  return { fit: Number(m.fit) || 0, intent: Number(m.intent) || 0 };
}

/* ── source registry (§3) ───────────────────────────────────────────────── */
export const PUBLIC_KEYLESS = 'public_keyless';
export const HOST_MEDIATED = 'host_mediated';
export const FILE_IMPORT = 'file_import';
export function registerSource(id, { access_path, family, available = true }) {
  if (!id) bad('source id required');
  store.sources[id] = { access_path, family, available: !!available };
  persist();
  return store.sources[id];
}
export function sourceAvailable(id) { return !!(store.sources[id] && store.sources[id].available); }
export function listSources() {
  return Object.keys(store.sources).sort().map((id) => ({ source_id: id, ...store.sources[id] }));
}

/* ── observation ingest (§5 schema, TI-01) ──────────────────────────────── */
const OBS_REQUIRED = ['source_id', 'source_record_id', 'source_family', 'observed_at', 'metric', 'value'];
const OBS_PII = ['email', 'phone', 'full_name', 'ip', 'device_id'];
export function ingestObservations(observations) {
  const items = Array.isArray(observations) ? observations : [];
  if (items.length > 500) bad('batch exceeds 500 items', 'batch_too_large', 413);
  const errors = [];
  const registered = Object.keys(store.sources);
  items.forEach((o, i) => {
    if (!o || typeof o !== 'object') { errors.push({ index: i, error: 'not an object' }); return; }
    const missing = OBS_REQUIRED.filter((k) => !(k in o));
    if (missing.length) errors.push({ index: i, error: `missing ${missing.join(',')}` });
    else if (OBS_PII.some((k) => k in o)) errors.push({ index: i, error: 'PII field rejected' });
    else if (registered.length && !registered.includes(o.source_id)) errors.push({ index: i, error: 'unregistered source' });
  });
  if (errors.length) bad('batch validation failed', 'invalid_batch', 422, { errors });

  let accepted = 0, duplicate = 0;
  for (const o of items) {
    const revision = Number.isInteger(o.revision) ? o.revision : 1;
    const key = `${o.source_id}|${o.source_record_id}|${revision}`;
    const h = hash(o);
    const existing = store.observations[key];
    if (existing) {
      if (existing.hash === h) { duplicate += 1; continue; }
      bad('source version exists with a different content hash', 'observation_conflict', 409,
        { source_id: o.source_id, source_record_id: o.source_record_id, revision });
    }
    store.observations[key] = {
      source_id: o.source_id, source_record_id: o.source_record_id, revision,
      source_family: o.source_family, hash: h, value: o.value,
      observed_at: o.observed_at, ingested_at: nowIso(),
    };
    accepted += 1;
  }
  persist();
  return { accepted, duplicate, rejected: 0 };
}
export function independentFamilyCount(sourceRecordIds) {
  const ids = new Set(sourceRecordIds || []);
  const fams = new Set();
  for (const k of Object.keys(store.observations)) {
    const o = store.observations[k];
    if (ids.has(o.source_record_id)) fams.add(o.source_family);
  }
  return fams.size;
}

/* ── score a topic (profile-driven) ─────────────────────────────────────── */
export function scoreTopic({ topic, demand, timing, readiness, sourceRecordIds = [],
  sourceQuality, coverage, freshness, vetoes = [] }) {
  const { fit, intent } = fitIntentFor(topic);
  const opp = opportunityScore({ demand, fit, intent, timing, readiness }, vetoes);
  const families = independentFamilyCount(sourceRecordIds);
  const conf = confidenceScore({ source_quality: sourceQuality,
    corroboration: corroborationValue(families), coverage, freshness,
    independent_families: families });
  const decision = decide(opp.score, conf.score, { vetoed: opp.vetoed });
  return {
    topic, opportunity_score: opp.score, confidence: conf.score, decision,
    vetoed: opp.vetoed, veto_reasons: opp.veto_reasons, independent_families: families,
    confidence_capped: conf.capped, opportunity_breakdown: opp.breakdown,
    confidence_breakdown: conf.breakdown,
  };
}

/* ── Growth Brief v1 (§6 / Appendix A) — closed object + runtime rules ──── */
const BRIEF_REQUIRED = ['schema_version', 'brief_id', 'brief_version', 'tenant_id', 'platform_id',
  'market', 'locale', 'topic_id', 'opportunity_score', 'confidence', 'valid_from', 'expires_at',
  'evidence_ids', 'audience', 'intent', 'approved_claim_ids', 'cta_id', 'allowed_channels',
  'prohibited_claims', 'objective', 'experiment_id', 'policy_version'];
const CHANNEL_ENUM = new Set(['seo', 'organic_social', 'sales_enablement', 'owned_placement', 'lifecycle', 'paid']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function validateBriefSchema(b) {
  const errs = [];
  if (!b || typeof b !== 'object') return ['brief must be an object'];
  for (const k of Object.keys(b)) if (!BRIEF_REQUIRED.includes(k)) errs.push(`unknown field ${k}`);
  for (const k of BRIEF_REQUIRED) if (!(k in b)) errs.push(`missing ${k}`);
  if (errs.length) return errs;
  if (b.schema_version !== 1) errs.push('schema_version must be 1');
  for (const k of ['brief_id', 'tenant_id', 'platform_id', 'topic_id', 'cta_id', 'experiment_id'])
    if (!ID_RE.test(String(b[k]))) errs.push(`${k} invalid id`);
  for (const k of ['brief_version', 'policy_version'])
    if (!Number.isInteger(b[k]) || b[k] < 1) errs.push(`${k} must be integer >= 1`);
  if (!/^[A-Z]{2}$/.test(String(b.market))) errs.push('market must be 2 upper letters');
  if (!(typeof b.locale === 'string' && b.locale.length >= 2 && b.locale.length <= 35)) errs.push('locale 2..35');
  for (const k of ['opportunity_score', 'confidence'])
    if (typeof b[k] !== 'number' || b[k] < 0 || b[k] > 100) errs.push(`${k} 0..100`);
  for (const k of ['audience', 'intent', 'objective'])
    if (!(typeof b[k] === 'string' && b[k].length >= 1 && b[k].length <= 500)) errs.push(`${k} short_text`);
  for (const k of ['evidence_ids', 'approved_claim_ids']) {
    const v = b[k];
    if (!Array.isArray(v) || v.length > 64 || new Set(v).size !== v.length) errs.push(`${k} unique id_list`);
    else if (!v.every((x) => ID_RE.test(String(x)))) errs.push(`${k} non-id member`);
  }
  if (Array.isArray(b.evidence_ids) && b.evidence_ids.length < 1) errs.push('evidence_ids >=1');
  const ch = b.allowed_channels;
  if (!Array.isArray(ch) || ch.length < 1 || ch.length > 6 || new Set(ch).size !== ch.length || !ch.every((c) => CHANNEL_ENUM.has(c)))
    errs.push('allowed_channels 1..6 unique enum');
  const pc = b.prohibited_claims;
  if (!Array.isArray(pc) || pc.length > 32 || new Set(pc).size !== pc.length) errs.push('prohibited_claims <=32 unique');
  for (const k of ['valid_from', 'expires_at'])
    if (!(typeof b[k] === 'string' && /Z$/.test(b[k]) && !isNaN(Date.parse(b[k])))) errs.push(`${k} must be RFC3339 UTC`);
  return errs;
}
export function validateBriefRuntime(b, { nowMs = now() } = {}) {
  const errs = [];
  const vf = Date.parse(b.valid_from), ex = Date.parse(b.expires_at);
  if (!(vf < ex)) errs.push('valid_from must be < expires_at');
  if (!(vf <= nowMs && nowMs < ex)) errs.push('brief not in validity window');
  if (b.market !== store.profile.default_market) errs.push('market mismatch with active profile');
  if (b.policy_version !== store.profile.policy_version) errs.push('policy_version mismatch');
  const enabled = new Set(store.profile.enabled_channels);
  const notEnabled = b.allowed_channels.filter((c) => !enabled.has(c));
  if (notEnabled.length) errs.push(`channels not enabled: ${notEnabled.join(',')}`);
  return errs;
}
export function validateBrief(b, opts) {
  const s = validateBriefSchema(b);
  if (s.length) bad('brief schema invalid: ' + s.join('; '), 'invalid_brief', 422, { errors: s });
  const r = validateBriefRuntime(b, opts);
  if (r.length) bad('brief runtime invalid: ' + r.join('; '), 'invalid_brief', 422, { errors: r });
}

export function createBrief(briefDoc, { status = 'approved' } = {}) {
  validateBrief(briefDoc);
  const scopeKey = `${briefDoc.market}|${briefDoc.locale}|${briefDoc.topic_id}`;
  // Enforce one active brief per (market, locale, topic).
  for (const id of Object.keys(store.briefs)) {
    const b = store.briefs[id];
    if (b.active && `${b.doc.market}|${b.doc.locale}|${b.doc.topic_id}` === scopeKey) b.active = false;
  }
  store.briefs[briefDoc.brief_id] = { doc: briefDoc, status, active: true, created_at: nowIso() };
  audit('brief.created', { brief_id: briefDoc.brief_id, status });
  persist();
  return briefDoc;
}
// §16 effective-brief: one approved, fresh brief, else null (caller uses baseline).
export function effectiveBrief({ market, locale, topic_id }, { nowMs = now() } = {}) {
  for (const id of Object.keys(store.briefs)) {
    const b = store.briefs[id];
    if (!b.active || b.status !== 'approved') continue;
    const d = b.doc;
    if (d.market === market && d.locale === locale && d.topic_id === topic_id) {
      if (nowMs >= Date.parse(d.expires_at)) return null; // expired -> baseline
      return d;
    }
  }
  return null;
}

/* ── native owned surface (§18): CAS apply/rollback + idempotent receipts ─ */
const ALLOWED_PATCH_FIELDS = new Set(['title', 'meta_description', 'body_block', 'headline', 'cta_copy']);
const FORBIDDEN_PATCH_FIELDS = new Set(['url', 'redirects', 'canonical', 'robots', 'structured_data', 'permissions', 'template_code']);
function checkFields(fields) {
  if (!fields || typeof fields !== 'object' || !Object.keys(fields).length) bad('fields must be a non-empty object');
  const forb = Object.keys(fields).filter((k) => FORBIDDEN_PATCH_FIELDS.has(k));
  if (forb.length) bad(`fields out of scope for v1 automation: ${forb.join(',')}`, 'forbidden_fields', 422);
  const unknown = Object.keys(fields).filter((k) => !ALLOWED_PATCH_FIELDS.has(k));
  if (unknown.length) bad(`fields not in allowlist: ${unknown.join(',')}`, 'unknown_fields', 422);
}
export function createPage(assetId, fields, { approved = false } = {}) {
  checkFields(fields);
  if (store.assets[assetId]) bad('asset already exists', 'asset_exists', 409);
  store.assets[assetId] = {
    asset_id: assetId, current_revision: 1, active_revision: approved ? 1 : 0,
    fields: { ...fields }, content_hash: hash(fields), approved: !!approved,
  };
  audit('surface.page_created', { asset_id: assetId, approved: !!approved });
  persist();
  return getAsset(assetId);
}
export function approvePage(assetId) {
  const a = store.assets[assetId];
  if (!a) bad('asset not found', 'not_found', 404);
  a.approved = true; a.active_revision = a.current_revision;
  persist();
  return getAsset(assetId);
}
export function getAsset(assetId) {
  const a = store.assets[assetId];
  if (!a) bad('asset not found', 'not_found', 404);
  return JSON.parse(JSON.stringify(a));
}
export function applyPatch(assetId, expectedRevision, fields, actionKey) {
  checkFields(fields);
  const rec = store.receipts[actionKey];
  if (rec) return { status: rec.status, applied_revision: rec.appliedRevision, idempotent_replay: true };
  const a = store.assets[assetId];
  if (!a) bad('asset not found', 'not_found', 404);
  if (a.current_revision !== expectedRevision)
    bad('target changed after approval', 'target_revision_conflict', 409, { expected: expectedRevision, current: a.current_revision });
  a.fields = { ...a.fields, ...fields };
  a.current_revision += 1;
  a.content_hash = hash(a.fields);
  if (a.approved) a.active_revision = a.current_revision;
  store.receipts[actionKey] = { assetId, appliedRevision: a.current_revision, status: 'applied' };
  persist();
  return { status: 'applied', applied_revision: a.current_revision, idempotent_replay: false };
}
export function getReceipt(actionKey) {
  const r = store.receipts[actionKey];
  return r ? { status: r.status, applied_revision: r.appliedRevision, asset_id: r.assetId } : { status: 'not_found' };
}
export function restorePatch(assetId, expectedAppliedRevision, previousFields, rollbackKey) {
  const rec = store.receipts[rollbackKey];
  if (rec) return { status: 'applied', applied_revision: rec.appliedRevision, idempotent_replay: true };
  const a = store.assets[assetId];
  if (!a) bad('asset not found', 'not_found', 404);
  if (a.current_revision !== expectedAppliedRevision)
    bad('asset changed since applied revision; manual resolution', 'target_revision_conflict', 409, { expected: expectedAppliedRevision, current: a.current_revision });
  a.fields = { ...a.fields, ...previousFields };
  a.current_revision += 1;
  a.content_hash = hash(a.fields);
  if (a.approved) a.active_revision = a.current_revision;
  store.receipts[rollbackKey] = { assetId, appliedRevision: a.current_revision, status: 'applied' };
  persist();
  return { status: 'applied', applied_revision: a.current_revision, idempotent_replay: false };
}
export function publicRender(assetId) {
  const a = store.assets[assetId];
  if (!a || !a.approved) bad('no public (approved) revision', 'not_found', 404);
  return { asset_id: assetId, revision: a.active_revision, fields: a.fields };
}

/* ── action lifecycle (§6/§18): approval binding + execution re-auth ────── */
export const V1_LIVE_ACTION_KINDS = new Set(['seo_metadata_patch', 'owned_content_patch']);
function deriveIdemKey({ brief_version, channel, action_kind, target_id, base_revision, patch }) {
  return hash({ bv: brief_version, c: channel, k: action_kind, t: target_id, r: base_revision, p: patch }).slice(0, 40);
}
function briefRef(doc, { revoked = false } = {}) {
  return { brief_id: doc.brief_id, brief_version: doc.brief_version,
    expires_ms: Date.parse(doc.expires_at), policy_version: doc.policy_version, revoked };
}
function assertFresh(ref, nowMs) {
  if (ref.revoked) bad('brief revoked', 'brief_revoked', 409);
  if (nowMs >= ref.expires_ms) bad('brief expired', 'brief_expired', 409);
}
export function proposeAction({ briefDoc, channel, action_kind, target_id, expected_revision, patch, author }, { nowMs = now() } = {}) {
  if (!V1_LIVE_ACTION_KINDS.has(action_kind)) bad(`unknown or non-live action kind: ${action_kind}`, 'unknown_action_kind', 422);
  const ref = briefRef(briefDoc);
  assertFresh(ref, nowMs);
  getAsset(target_id); // must exist
  const idem = deriveIdemKey({ brief_version: ref.brief_version, channel, action_kind, target_id, base_revision: expected_revision, patch });
  for (const id of Object.keys(store.actions)) if (store.actions[id].idempotency_key === idem) return store.actions[id];
  const payload = { channel, action_kind, target_id, expected_revision, patch,
    brief_id: ref.brief_id, brief_version: ref.brief_version, policy_version: ref.policy_version };
  const action_id = newId('act');
  store.actions[action_id] = {
    action_id, state: 'validated', author, approver: null, ...payload,
    payload_hash: hash(payload), approved_hash: null, idempotency_key: idem,
    applied_revision: null, receipt: null, previous_fields: null, created_at: nowIso(),
  };
  audit('action.proposed', { action_id, kind: action_kind });
  persist();
  return store.actions[action_id];
}
function loadAction(id) { const a = store.actions[id]; if (!a) bad('action not found', 'not_found', 404); return a; }
export function approveAction(action_id, { approver, payload_hash }) {
  const a = loadAction(action_id);
  if (!['validated', 'pending_approval'].includes(a.state)) bad(`cannot approve from ${a.state}`, 'bad_state', 409);
  if (a.author === approver) bad('author and approver must differ', 'self_approval', 403);
  if (payload_hash !== a.payload_hash) bad('approval payload hash mismatch; re-approve required', 'approval_mismatch', 409);
  a.state = 'approved'; a.approver = approver; a.approved_hash = payload_hash;
  audit('action.approved', { action_id, approver });
  persist();
  return a;
}
export function executeAction(action_id, { briefDoc } = {}, { nowMs = now() } = {}) {
  const a = loadAction(action_id);
  if (a.state !== 'approved') bad(`cannot execute from ${a.state}`, 'bad_state', 409);
  if (store.frozen) bad('installation frozen: new live work rejected', 'frozen', 403);
  // Resolve the brief from the stored brief_id unless one was passed explicitly.
  if (!briefDoc) {
    const b = store.briefs[a.brief_id];
    if (!b) bad('brief for action not found', 'brief_missing', 409);
    briefDoc = b.doc;
  }
  const ref = briefRef(briefDoc);
  assertFresh(ref, nowMs);
  if (ref.brief_version !== a.brief_version) bad('brief version changed since approval', 'brief_changed', 409);
  if (ref.policy_version !== a.policy_version) bad('policy changed since approval', 'policy_changed', 409);
  if (a.approved_hash !== a.payload_hash) bad('approval does not bind current payload', 'approval_mismatch', 409);
  const before = getAsset(a.target_id);
  a.previous_fields = {};
  for (const k of Object.keys(a.patch)) a.previous_fields[k] = before.fields[k];
  a.state = 'executing';
  let res;
  try {
    res = applyPatch(a.target_id, a.expected_revision, a.patch, a.idempotency_key);
  } catch (err) {
    if (err && err.code === 'target_revision_conflict') { a.state = 'reconciliation_required'; persist(); }
    throw err;
  }
  a.applied_revision = res.applied_revision; a.receipt = a.idempotency_key; a.state = 'applied';
  audit('action.applied', { action_id, applied_revision: res.applied_revision });
  persist();
  return a;
}
// Recover from an ambiguous completion using the receipt keyed by the idem key.
export function reconcileAction(action_id) {
  const a = loadAction(action_id);
  const rec = getReceipt(a.idempotency_key);
  if (rec.status === 'applied') {
    a.applied_revision = rec.applied_revision; a.receipt = a.idempotency_key; a.state = 'applied';
    persist();
  }
  return a;
}
export function rollbackAction(action_id, { approver }) {
  const a = loadAction(action_id);
  if (a.state !== 'applied') bad('only an applied action can be rolled back', 'bad_state', 409);
  if (a.author === approver) bad('rollback author and approver must differ', 'self_approval', 403);
  const rollbackKey = hash({ rollback: a.idempotency_key }).slice(0, 40);
  const res = restorePatch(a.target_id, a.applied_revision, a.previous_fields, rollbackKey);
  a.state = 'rolled_back'; a.rolled_back_to_revision = res.applied_revision;
  audit('action.rolled_back', { action_id, revision: res.applied_revision });
  persist();
  return a;
}
export function getAction(id) { return JSON.parse(JSON.stringify(loadAction(id))); }

/* ── freeze switch (§8 emergency freeze) ────────────────────────────────── */
export function setFreeze(on) { store.frozen = !!on; audit('freeze.' + (on ? 'on' : 'off'), {}); persist(); return store.frozen; }
export function isFrozen() { return store.frozen; }

/* ── native measurement (§18) ───────────────────────────────────────────── */
export function recordOutcome(outcome_id, { denominator = 'eligible_session', variant = null, revision_id = null, conversion = null } = {}) {
  if (store.outcomes[outcome_id]) return false; // dedup
  store.outcomes[outcome_id] = { outcome_id, denominator, variant, revision_id, conversion, created_at: nowIso() };
  persist();
  return true;
}
export function measurementReport() {
  const rows = Object.values(store.outcomes);
  const eligible = rows.filter((r) => r.conversion == null).length;
  const conversions = rows.filter((r) => r.conversion != null).length;
  return {
    eligible_sessions: eligible, conversions,
    conversion_rate: eligible ? conversions / eligible : null,
    sample_status: eligible >= 1 ? 'sufficient' : 'insufficient',
  };
}

/* ── deterministic draft (keyless) + claim safety (§7/§8) ───────────────── */
export function templateDraft(briefDoc, { purpose = 'seo_draft' } = {}) {
  const claims = briefDoc.approved_claim_ids.map((id) => store.profile.approved_claims[id] || '').filter(Boolean);
  const claimText = claims[0] || '';
  const cta = String(briefDoc.cta_id || '').replace(/^cta_/, '').replace(/_/g, ' ');
  const topic = String(briefDoc.topic_id || '').replace(/-/g, ' ');
  if (purpose === 'social_draft') {
    return { action_kind: 'organic_social_draft', channel: 'organic_social',
      fields: { post: `${claimText} ${cta}`.trim().slice(0, 280) },
      claim_refs: briefDoc.approved_claim_ids, locale: briefDoc.locale };
  }
  return { action_kind: 'seo_page_draft', channel: 'seo',
    fields: {
      title: `${topic} — ${briefDoc.audience}`.slice(0, 60),
      meta_description: `${claimText} ${cta}`.trim().slice(0, 155),
      body_block: `People in ${briefDoc.market} are looking to ${briefDoc.intent}. ${claimText} ${cta}`.trim(),
    },
    claim_refs: briefDoc.approved_claim_ids, locale: briefDoc.locale };
}
export function claimSafety(draft, briefDoc) {
  const violations = [];
  const prohibited = briefDoc.prohibited_claims || [];
  for (const v of Object.values(draft.fields || {})) {
    if (typeof v !== 'string') continue;
    const low = v.toLowerCase();
    for (const p of prohibited) if (low.includes(String(p).toLowerCase())) violations.push(`prohibited claim: ${p}`);
  }
  for (const cid of draft.claim_refs || [])
    if (!(cid in store.profile.approved_claims)) violations.push(`unapproved claim ref: ${cid}`);
  return violations;
}

/* ── third-party external write is not available in v1 (TI-20/TI-22) ───── */
export function thirdPartyWrite(destination) {
  return { destination, status: 'unavailable',
    reason: 'no authorised host integration; use the owned surface or export a draft' };
}

/* ── dashboard summary for the admin console ────────────────────────────── */
export function trendsDashboard() {
  const briefs = Object.values(store.briefs).map((b) => ({
    brief_id: b.doc.brief_id, topic_id: b.doc.topic_id, market: b.doc.market,
    locale: b.doc.locale, status: b.status, active: b.active,
    opportunity_score: b.doc.opportunity_score, confidence: b.doc.confidence,
    expires_at: b.doc.expires_at,
  }));
  const actions = Object.values(store.actions).map((a) => ({
    action_id: a.action_id, state: a.state, action_kind: a.action_kind,
    channel: a.channel, target_id: a.target_id, applied_revision: a.applied_revision,
  }));
  return {
    profile: { platform_slug: store.profile.platform_slug, market: store.profile.default_market,
      locale: store.profile.default_locale, policy_version: store.profile.policy_version,
      enabled_channels: store.profile.enabled_channels },
    frozen: store.frozen,
    sources: listSources(),
    observations: Object.keys(store.observations).length,
    briefs, actions,
    pages: Object.values(store.assets).map((a) => ({ asset_id: a.asset_id, revision: a.current_revision, approved: a.approved })),
    report: measurementReport(),
    audit: store.audit.slice(-40).reverse(),
  };
}

export function trendsHealth() {
  return { keyless_core: true, frozen: store.frozen, autopilot: !!_scheduler,
    briefs: Object.keys(store.briefs).length, actions: Object.keys(store.actions).length,
    observations: Object.keys(store.observations).length, pages: Object.keys(store.assets).length };
}

/* ── invisible background operation (§7 pilot: auto drafts only) ─────────── */
// Runs detection/scoring on the operator-configured autopilot topics and, when
// a topic clears the reviewable-brief band, records a SHADOW (draft) brief. It
// NEVER creates a live/approved brief or performs any live write — those stay
// operator-approval-gated. No model, no new key, no user-visible output: this is
// the "works invisibly" path. Nothing happens until the operator configures
// `autopilot_topics` on the profile, so it is a safe no-op by default.
let _scheduler = null;

export function runDetectionCycle() {
  if (store.frozen) return { skipped: 'frozen', drafted: 0 };
  const topics = store.profile.autopilot_topics || [];
  let drafted = 0, evaluated = 0;
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  for (const t of topics) {
    evaluated += 1;
    const scored = scoreTopic({
      topic: t.topic, demand: t.demand, timing: t.timing, readiness: t.readiness,
      sourceRecordIds: t.sourceRecordIds || [], sourceQuality: t.sourceQuality,
      coverage: t.coverage, freshness: t.freshness, vetoes: t.vetoes || [],
    });
    if (scored.decision !== 'reviewable_brief') continue;
    // Record a shadow (draft) brief for operator review — never live.
    const topicId = slugifyTopic(t.topic);
    const briefId = `gb_auto_${topicId}`;
    const t0 = now();
    const doc = {
      schema_version: 1, brief_id: briefId, brief_version: 1, tenant_id: 'platform',
      platform_id: store.profile.platform_slug, market: store.profile.default_market,
      locale: store.profile.default_locale, topic_id: topicId,
      opportunity_score: scored.opportunity_score, confidence: scored.confidence,
      valid_from: iso(t0), expires_at: iso(t0 + 7 * 86400e3),
      evidence_ids: t.evidence_ids && t.evidence_ids.length ? t.evidence_ids : ['ev_auto'],
      audience: t.audience || 'Interested visitors', intent: t.intent || t.topic,
      approved_claim_ids: t.approved_claim_ids || [], cta_id: t.cta_id || (store.profile.allowed_cta_ids[0] || 'cta_default'),
      allowed_channels: store.profile.enabled_channels.slice(0, 2),
      prohibited_claims: t.prohibited_claims || [], objective: store.profile.outcome.conversion + ' per ' + store.profile.outcome.denominator,
      experiment_id: t.experiment_id || `exp_auto_${topicId}`, policy_version: store.profile.policy_version,
    };
    const schemaErrs = validateBriefSchema(doc);
    if (schemaErrs.length) { audit('autopilot.skip', { topic: t.topic, errors: schemaErrs }); continue; }
    store.briefs[briefId] = { doc, status: 'draft', active: false, created_at: nowIso() };
    audit('autopilot.shadow_brief', { brief_id: briefId, topic_id: topicId, score: scored.opportunity_score, confidence: scored.confidence });
    drafted += 1;
  }
  persist();
  return { evaluated, drafted };
}

function slugifyTopic(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'topic';
}

export function startTrendsScheduler({ intervalMs = 15 * 60 * 1000 } = {}) {
  if (_scheduler) return _scheduler;
  if (process.env.TRENDS_AUTOPILOT === '0') return null; // operator opt-out
  _scheduler = setInterval(() => {
    try { runDetectionCycle(); } catch (err) { console.error('[trends] detection cycle failed:', err.message); }
  }, Math.max(60 * 1000, intervalMs));
  if (_scheduler.unref) _scheduler.unref(); // never keep the process alive
  return _scheduler;
}
export function stopTrendsScheduler() { if (_scheduler) { clearInterval(_scheduler); _scheduler = null; } }
