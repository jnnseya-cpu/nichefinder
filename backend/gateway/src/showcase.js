// The "See the working" showcase — a single, operator-curated REAL example that
// the landing page auto-pulls the instant it exists. Until the operator publishes
// one (an explicit consent/privacy decision — see POST /v1/admin/showcase), the
// landing keeps its clearly-labelled illustrative example. Public content, so no
// encryption; one record, stored as plain JSON on disk.
import fs from 'node:fs';
import path from 'node:path';

const STORE = process.env.SHOWCASE_STORE || path.join(process.cwd(), 'data', 'showcase.json');

function read() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return null; }
}
function write(obj) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, STORE);
}

const str = (v, max) => String(v == null ? '' : v).slice(0, max);

/* Validate + normalise an operator-supplied example into the exact shape the
   landing renders. Throws on anything unusable so a malformed POST can't publish
   a broken card. */
export function normalizeShowcase(input) {
  if (!input || typeof input !== 'object') throw new Error('body must be an object');
  const rows = Array.isArray(input.rows) ? input.rows.slice(0, 6).map((r) => ({
    label: str(r && r.label, 80), value: str(r && r.value, 60), why: str(r && r.why, 240),
  })).filter((r) => r.label && r.value) : [];
  if (rows.length < 1) throw new Error('at least one derivation row {label,value,why} is required');
  const result = input.result && typeof input.result === 'object'
    ? { label: str(input.result.label, 80) || 'Result', value: str(input.result.value, 60), why: str(input.result.why, 240) }
    : null;
  if (!result || !result.value) throw new Error('a result {label,value,why} is required');
  return {
    real: true,
    title: str(input.title, 90) || 'Worked example',
    country: str(input.country, 60),
    metricLabel: str(input.metricLabel, 60) || 'Derivation',
    rows, result,
    note: str(input.note, 300),
    source: str(input.source, 120),
    updatedAt: Date.now(),
  };
}

// Public read: returns the current showcase, or null. Never throws.
export function getShowcase() { return read(); }

// Admin write: replace the showcase with a validated example.
export function setShowcase(input) { const clean = normalizeShowcase(input); write(clean); return clean; }

// Admin clear: revert the landing to its illustrative example.
export function clearShowcase() { try { fs.unlinkSync(STORE); } catch {} return { cleared: true }; }
