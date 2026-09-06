// Real, keyless country grounding via the World Bank Open Data API.
// Turns the platform's core promise — "grounded in your country's real market" —
// from a prompt instruction into actual verified indicators injected into the
// model's context. No API key required. Fails SOFT: if the data is unavailable
// or slow, generation proceeds ungrounded rather than erroring, and the model is
// simply not handed the extra facts.
//
// Data is cached in-memory per country (indicators change ~yearly), so at most a
// few World Bank calls per country for the life of the process, shared across all
// users. Every call is time-boxed so a slow upstream can never stall a search.

const WB_BASE = (process.env.WORLDBANK_API_BASE || 'https://api.worldbank.org/v2').replace(/\/$/, '');
const TTL_MS = Number(process.env.MARKETDATA_TTL_MS || 30 * 24 * 60 * 60 * 1000); // 30 days
const TIMEOUT_MS = Number(process.env.MARKETDATA_TIMEOUT_MS || 4000);
const ENABLED = process.env.MARKETDATA_DISABLED !== '1';

// The indicators worth grounding a venture model in — demand size, wealth,
// urbanisation, and the digital/mobile reality that shapes go-to-market.
const INDICATORS = [
  { code: 'SP.POP.TOTL', label: 'Population', kind: 'int' },
  { code: 'SP.URB.TOTL.IN.ZS', label: 'Urban population', kind: 'pct' },
  { code: 'NY.GDP.PCAP.CD', label: 'GDP per capita (current US$)', kind: 'usd' },
  { code: 'IT.NET.USER.ZS', label: 'Internet users', kind: 'pct' },
  { code: 'IT.CEL.SETS.P2', label: 'Mobile subscriptions per 100 people', kind: 'num' },
  { code: 'SL.UEM.TOTL.ZS', label: 'Unemployment', kind: 'pct' },
];

// App country names that differ from World Bank naming — mapped to ISO2 directly.
const ALIASES = {
  'congo democratic republic of the': 'CD', 'congo republic of the': 'CG',
  'united states': 'US', 'united kingdom': 'GB', 'russia': 'RU', 'south korea': 'KR',
  'north korea': 'KP', 'ivory coast': 'CI', 'cote d ivoire': 'CI', 'egypt': 'EG',
  'iran': 'IR', 'syria': 'SY', 'laos': 'LA', 'vietnam': 'VN', 'venezuela': 'VE',
  'tanzania': 'TZ', 'gambia': 'GM', 'bahamas': 'BS', 'kyrgyzstan': 'KG', 'slovakia': 'SK',
  'brunei': 'BN', 'cape verde': 'CV', 'cabo verde': 'CV', 'czechia': 'CZ', 'turkey': 'TR',
  'eswatini': 'SZ', 'micronesia': 'FM', 'moldova': 'MD', 'north macedonia': 'MK',
  'palestine': 'PS', 'saint kitts and nevis': 'KN', 'saint lucia': 'LC',
  'saint vincent and the grenadines': 'VC', 'sao tome and principe': 'ST', 'yemen': 'YE',
};

let _countryList = null; // { ts, byName: Map(normName -> iso2) }
const _cache = new Map(); // iso2 -> { ts, block }

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function getJson(url, fetchFn) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchFn(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// Build (and cache) a normalized World Bank country-name → ISO2 lookup.
async function countryIndex(fetchFn) {
  if (_countryList && Date.now() - _countryList.ts < TTL_MS) return _countryList.byName;
  const j = await getJson(`${WB_BASE}/country?format=json&per_page=400`, fetchFn);
  const rows = Array.isArray(j) && Array.isArray(j[1]) ? j[1] : [];
  const byName = new Map();
  for (const c of rows) {
    // Skip aggregates (regions/income groups): they have region.id === 'NA'.
    if (!c || !c.iso2Code || (c.region && c.region.id === 'NA')) continue;
    byName.set(norm(c.name), c.iso2Code);
  }
  if (byName.size) _countryList = { ts: Date.now(), byName };
  return byName;
}

export async function resolveIso2(countryName, fetchFn = fetch) {
  const n = norm(countryName);
  if (!n) return null;
  if (ALIASES[n]) return ALIASES[n];
  const idx = await countryIndex(fetchFn);
  if (!idx || !idx.size) return null;
  if (idx.has(n)) return idx.get(n);
  // best-effort: a WB name that contains, or is contained by, the app name
  for (const [name, iso2] of idx) {
    if (name === n) return iso2;
    if (name.includes(n) || n.includes(name)) return iso2;
  }
  return null;
}

function fmt(kind, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (kind === 'int') return Math.round(n).toLocaleString('en-US');
  if (kind === 'pct') return `${n.toFixed(1)}%`;
  if (kind === 'usd') return `US$${Math.round(n).toLocaleString('en-US')}`;
  return `${Math.round(n).toLocaleString('en-US')}`;
}

async function fetchIndicator(iso2, ind, fetchFn) {
  // mrnev=1 → most recent non-empty value, so we always get real data even when
  // the latest year is not yet reported.
  const j = await getJson(`${WB_BASE}/country/${iso2}/indicator/${ind.code}?format=json&per_page=1&mrnev=1`, fetchFn);
  const row = Array.isArray(j) && Array.isArray(j[1]) ? j[1][0] : null;
  if (!row || row.value == null) return null;
  const value = fmt(ind.kind, row.value);
  return value ? { label: ind.label, value, year: row.date } : null;
}

/* Returns a ready-to-inject grounding block for a country, or '' when nothing is
   available. Cached per country. Never throws. */
export async function marketGrounding(countryName, fetchFn = fetch) {
  if (!ENABLED || !countryName) return '';
  let iso2;
  try { iso2 = await resolveIso2(countryName, fetchFn); } catch { iso2 = null; }
  if (!iso2) return '';
  const cached = _cache.get(iso2);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.block;
  let rows;
  try { rows = await Promise.all(INDICATORS.map((ind) => fetchIndicator(iso2, ind, fetchFn))); }
  catch { rows = []; }
  const facts = (rows || []).filter(Boolean);
  if (facts.length < 2) { _cache.set(iso2, { ts: Date.now(), block: '' }); return ''; } // not enough real data to bother
  const lines = facts.map((f) => `- ${f.label}: ${f.value} (${f.year})`).join('\n');
  const block =
    `\n\nVERIFIED COUNTRY DATA for ${countryName} — World Bank Open Data, most recent reported year:\n${lines}\n` +
    `Ground every market-size, pricing, adoption and capacity assumption in these REAL figures and the local conditions they imply. ` +
    `When you extrapolate beyond them, say which figure you started from. Do not invent country statistics that contradict the above.`;
  _cache.set(iso2, { ts: Date.now(), block });
  return block;
}

// Config snapshot for the admin diag endpoint (no secrets — there are none).
export function marketDataStatus() {
  return { enabled: ENABLED, apiBase: WB_BASE, timeoutMs: TIMEOUT_MS, cachedCountries: _cache.size };
}

// Live reachability probe for diag: one quick call, time-boxed. { reachable, ms }.
export async function probe(fetchFn = fetch) {
  const t0 = Date.now();
  const j = await getJson(`${WB_BASE}/country/US/indicator/SP.POP.TOTL?format=json&per_page=1&mrnev=1`, fetchFn);
  const ok = Array.isArray(j) && Array.isArray(j[1]);
  return { reachable: ok, ms: Date.now() - t0 };
}

// test/diagnostic helper
export function _clearCache() { _countryList = null; _cache.clear(); }
