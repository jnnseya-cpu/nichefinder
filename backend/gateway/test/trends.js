// TRENDS test — the embedded Trend Intelligence control layer.
// Proves the spec's core invariants (§21 TI scenarios, adapted to this
// single-platform installation): deterministic scoring, idempotent ingest,
// Growth Brief validation, owned-surface CAS apply/rollback with idempotent
// receipts and crash recovery, approval binding + execution re-auth, expired
// briefs denied, prompt-injection cannot escalate, freeze, measurement. No
// network, no provider key — the keyless core.
import os from 'node:os';
import path from 'node:path';
process.env.TRENDS_STORE = path.join(os.tmpdir(), `trends.test.${process.pid}.json`);

const T = await import('../src/trends.js');

let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };
const threw = (fn, code) => { try { fn(); return false; } catch (e) { return code ? e.platformCode === code || e.code === code : true; } };

function setup() {
  T._resetTrends();
  T.setProfile({
    default_market: 'GB', default_locale: 'en-GB', policy_version: 1,
    enabled_channels: ['seo', 'organic_social'],
    approved_claims: { claim_01: 'Validate your niche with real country data.' },
    allowed_cta_ids: ['cta_view_guide'],
    fit_map: { 'niche validation': { fit: 95, intent: 85 } },
  });
}
function brief(over = {}) {
  const t = Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  return Object.assign({
    schema_version: 1, brief_id: 'gb_1', brief_version: 3, tenant_id: 'platform',
    platform_id: 'niche-finder', market: 'GB', locale: 'en-GB',
    topic_id: 'niche-validation', opportunity_score: 86.25, confidence: 83.5,
    valid_from: iso(t - 3600e3), expires_at: iso(t + 6 * 86400e3),
    evidence_ids: ['ev_1', 'ev_2'], audience: 'Founders validating a niche',
    intent: 'validate a niche idea', approved_claim_ids: ['claim_01'],
    cta_id: 'cta_view_guide', allowed_channels: ['seo', 'organic_social'],
    prohibited_claims: ['guaranteed ranking'], objective: 'qualified actions per session',
    experiment_id: 'exp_1', policy_version: 1,
  }, over);
}

// ── scoring (TI-03) ──────────────────────────────────────────────────────
console.log('— scoring —');
const opp = T.opportunityScore({ demand: 80, fit: 95, intent: 85, timing: 90, readiness: 80 });
const conf = T.confidenceScore({ source_quality: 90, corroboration: 80, coverage: 70, freshness: 90, independent_families: 2 });
check('opportunity score is exactly 86.25 (unrounded)', opp.score === 86.25, String(opp.score));
check('confidence is exactly 83.5 (unrounded)', conf.score === 83.5, String(conf.score));
check('clears to a reviewable brief', T.decide(opp.score, conf.score) === 'reviewable_brief');
const capped = T.confidenceScore({ source_quality: 100, corroboration: 0, coverage: 100, freshness: 100, independent_families: 1 });
check('single source family capped at 69', capped.capped && capped.score === 69);
check('readiness 0 vetoes activation', T.opportunityScore({ demand: 90, fit: 90, intent: 90, timing: 90, readiness: 0 }).vetoed);

// ── ingest idempotency (TI-01) ───────────────────────────────────────────
console.log('— ingest idempotency —');
setup();
const obs = { source_id: 's1', source_record_id: 'r1', source_family: 'first_party_search', observed_at: '2026-11-10T09:00:00Z', metric: 'searches', value: 30 };
check('first ingest accepted', T.ingestObservations([obs]).accepted === 1);
check('exact replay is a duplicate', T.ingestObservations([obs]).duplicate === 1);
check('same key, changed value -> 409 conflict', threw(() => T.ingestObservations([{ ...obs, value: 999 }]), 'observation_conflict'));
check('PII field rejected', threw(() => T.ingestObservations([{ ...obs, source_record_id: 'r2', email: 'x@y.z' }]), 'invalid_batch'));

// ── syndication -> one family (TI-04) ────────────────────────────────────
setup();
for (const rid of ['a', 'b', 'c']) T.ingestObservations([{ source_id: 'news', source_record_id: rid, source_family: 'news_rss', observed_at: '2026-11-10T09:00:00Z', metric: 'm', value: 50 }]);
check('three syndications count as one source family', T.independentFamilyCount(['a', 'b', 'c']) === 1);

// ── brief validation (schema + runtime) ──────────────────────────────────
console.log('— brief validation —');
setup();
check('canonical brief is schema-valid', T.validateBriefSchema(brief()).length === 0);
check('unknown field rejected (closed object)', T.validateBriefSchema({ ...brief(), extra: 1 }).length > 0);
check('bad market rejected', T.validateBriefSchema({ ...brief(), market: 'GBR' }).length > 0);
check('expired brief fails runtime window', threw(() => T.validateBrief(brief({ valid_from: '2000-01-01T00:00:00Z', expires_at: '2000-01-02T00:00:00Z' })), 'invalid_brief'));
check('lifecycle channel (not enabled) rejected — no direct-marketing path (TI-12)', threw(() => T.validateBrief(brief({ allowed_channels: ['seo', 'lifecycle'] })), 'invalid_brief'));

// ── effective brief fresh vs expired (TI-05) ─────────────────────────────
console.log('— effective brief —');
setup();
T.createBrief(brief());
check('fresh approved brief resolves', !!T.effectiveBrief({ market: 'GB', locale: 'en-GB', topic_id: 'niche-validation' }));
check('expired brief resolves to baseline (null)', T.effectiveBrief({ market: 'GB', locale: 'en-GB', topic_id: 'niche-validation' }, { nowMs: Date.parse(brief().expires_at) + 1 }) === null);

// ── owned surface CAS + receipts (TI-07, TI-08) ──────────────────────────
console.log('— owned surface —');
setup();
T.createPage('asset_guide', { title: 'Niche guide', meta_description: 'Validate.', body_block: 'Start here.' }, { approved: true });
check('public render serves the approved revision', T.publicRender('asset_guide').revision === 1);
const ap = T.applyPatch('asset_guide', 1, { title: 'New title' }, 'k1');
check('apply advances revision to 2', ap.applied_revision === 2);
check('idempotent replay of same action key -> no second effect', T.applyPatch('asset_guide', 1, { title: 'New title' }, 'k1').idempotent_replay === true && T.getAsset('asset_guide').current_revision === 2);
check('stale expected revision -> conflict (TI-08)', threw(() => T.applyPatch('asset_guide', 1, { title: 'z' }, 'k2'), 'target_revision_conflict'));

// ── action lifecycle (propose/approve/execute/rollback) ──────────────────
console.log('— action lifecycle —');
setup();
T.createBrief(brief());
T.createPage('asset_guide', { title: 'Niche guide', meta_description: 'Validate.', body_block: 'Start here.' }, { approved: true });
const bdoc = brief();
check('unknown/privileged action kind rejected (TI-06)', threw(() => T.proposeAction({ briefDoc: bdoc, channel: 'seo', action_kind: 'grant_publish', target_id: 'asset_guide', expected_revision: 1, patch: { title: 'x' }, author: 'a' }), 'unknown_action_kind'));
const a1 = T.proposeAction({ briefDoc: bdoc, channel: 'seo', action_kind: 'seo_metadata_patch', target_id: 'asset_guide', expected_revision: 1, patch: { title: 'Validated niche in days' }, author: 'author_a' });
check('self-approval rejected', threw(() => T.approveAction(a1.action_id, { approver: 'author_a', payload_hash: a1.payload_hash }), 'self_approval'));
check('wrong payload hash rejected', threw(() => T.approveAction(a1.action_id, { approver: 'b', payload_hash: 'deadbeef' }), 'approval_mismatch'));
T.approveAction(a1.action_id, { approver: 'approver_b', payload_hash: a1.payload_hash });
const applied = T.executeAction(a1.action_id, { briefDoc: bdoc });
check('execute applies the patch (rev 2)', applied.state === 'applied' && applied.applied_revision === 2);
check('owned page now reflects the approved change', T.getAsset('asset_guide').fields.title === 'Validated niche in days');
const rb = T.rollbackAction(a1.action_id, { approver: 'approver_b' });
check('rollback restores the previous value', rb.state === 'rolled_back' && T.getAsset('asset_guide').fields.title === 'Niche guide');

// ── execution re-auth: expired brief denied (TI-05) ──────────────────────
setup();
T.createBrief(brief());
T.createPage('asset_guide', { title: 'G', meta_description: 'd', body_block: 'b' }, { approved: true });
const a2 = T.proposeAction({ briefDoc: brief(), channel: 'seo', action_kind: 'seo_metadata_patch', target_id: 'asset_guide', expected_revision: 1, patch: { title: 'T' }, author: 'a' });
T.approveAction(a2.action_id, { approver: 'b', payload_hash: a2.payload_hash });
check('expired brief denies a queued action', threw(() => T.executeAction(a2.action_id, { briefDoc: brief() }, { nowMs: Date.parse(brief().expires_at) + 1 }), 'brief_expired'));

// ── crash recovery: single side effect (TI-07) ───────────────────────────
setup();
T.createBrief(brief());
T.createPage('asset_guide', { title: 'G', meta_description: 'd', body_block: 'b' }, { approved: true });
const a3 = T.proposeAction({ briefDoc: brief(), channel: 'seo', action_kind: 'seo_metadata_patch', target_id: 'asset_guide', expected_revision: 1, patch: { title: 'Recovered' }, author: 'a' });
T.approveAction(a3.action_id, { approver: 'b', payload_hash: a3.payload_hash });
// Provider succeeded but the worker "crashed" before persisting: apply directly with the action's key.
T.applyPatch('asset_guide', 1, { title: 'Recovered' }, a3.idempotency_key);
const revAfter = T.getAsset('asset_guide').current_revision;
const recon = T.reconcileAction(a3.action_id);
check('reconcile recovers applied state from the receipt', recon.state === 'applied');
check('no second side effect after recovery', T.getAsset('asset_guide').current_revision === revAfter);

// ── freeze blocks execution (TI §8) ──────────────────────────────────────
setup();
T.createBrief(brief());
T.createPage('asset_guide', { title: 'G', meta_description: 'd', body_block: 'b' }, { approved: true });
const a4 = T.proposeAction({ briefDoc: brief(), channel: 'seo', action_kind: 'seo_metadata_patch', target_id: 'asset_guide', expected_revision: 1, patch: { title: 'T' }, author: 'a' });
T.approveAction(a4.action_id, { approver: 'b', payload_hash: a4.payload_hash });
T.setFreeze(true);
check('freeze rejects new live work', threw(() => T.executeAction(a4.action_id, { briefDoc: brief() }), 'frozen'));
T.setFreeze(false);

// ── drafts, claim safety, measurement, third-party ───────────────────────
console.log('— drafts / measurement —');
setup();
const d = T.templateDraft(brief());
check('template draft is a typed, closed structure (no privilege)', d.action_kind === 'seo_page_draft' && !('publish' in d));
check('claim safety flags a prohibited claim', T.claimSafety({ fields: { title: 'guaranteed ranking now' }, claim_refs: [] }, brief()).length > 0);
T.recordOutcome('v1'); T.recordOutcome('v2'); T.recordOutcome('c1', { conversion: 'qualified_action' });
const rep = T.measurementReport();
check('measurement counts eligible + conversions', rep.eligible_sessions === 2 && rep.conversions === 1);
check('third-party external write reported unavailable (no credential prompt)', T.thirdPartyWrite('external_cms').status === 'unavailable');

console.log(failures === 0 ? '\nTRENDS: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
