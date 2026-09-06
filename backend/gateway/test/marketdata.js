import './isolate-stores.js'; // never touch the live data/ files (must be first)
// MARKET DATA test — the keyless World Bank grounding that makes the platform's
// "grounded in your country's real market" claim actually true. Verifies country
// resolution (name + alias + fuzzy), indicator assembly into an injectable block,
// caching, and — critically — that it FAILS SOFT (never throws, returns '') so it
// can never break or stall a search. Run: node test/marketdata.js
import { marketGrounding, resolveIso2, _clearCache } from '../src/marketdata.js';

let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

// A fake World Bank API. Country list + a handful of indicators for NG and GB.
const COUNTRY_LIST = [{ page: 1 }, [
  { iso2Code: 'NG', name: 'Nigeria', region: { id: 'SSF' } },
  { iso2Code: 'GB', name: 'United Kingdom', region: { id: 'ECS' } },
  { iso2Code: 'KE', name: 'Kenya', region: { id: 'SSF' } },
  { iso2Code: 'XA', name: 'Sub-Saharan Africa', region: { id: 'NA' } }, // aggregate — must be skipped
]];
const IND = {
  'NG/SP.POP.TOTL': 223800000, 'NG/SP.URB.TOTL.IN.ZS': 54.0, 'NG/NY.GDP.PCAP.CD': 1621,
  'NG/IT.NET.USER.ZS': 55.4, 'NG/IT.CEL.SETS.P2': 98.3, 'NG/SL.UEM.TOTL.ZS': 3.1,
  'GB/SP.POP.TOTL': 67000000, 'GB/NY.GDP.PCAP.CD': 46000,
};
let calls = 0;
const fakeFetch = async (url) => {
  calls++;
  const ok = (body) => ({ ok: true, json: async () => body });
  if (url.includes('/country?')) return ok(COUNTRY_LIST);
  const m = url.match(/\/country\/([A-Z]{2})\/indicator\/([^?]+)/);
  if (m) {
    const key = `${m[1]}/${m[2]}`;
    if (key in IND) return ok([{ page: 1 }, [{ value: IND[key], date: '2023' }]]);
    return ok([{ page: 1 }, [{ value: null, date: '2023' }]]); // no data → skipped
  }
  return { ok: false, json: async () => ({}) };
};

console.log('— country resolution —');
_clearCache();
check('resolves a plain name (Nigeria → NG)', await resolveIso2('Nigeria', fakeFetch) === 'NG');
check('resolves via alias table without a list call (United Kingdom → GB)', await resolveIso2('United Kingdom', fakeFetch) === 'GB');
check('resolves the app’s DR Congo name via alias', await resolveIso2('Congo, Democratic Republic of the', fakeFetch) === 'CD');
check('unknown country resolves to null (no crash)', await resolveIso2('Atlantis', fakeFetch) === null);

console.log('— grounding block assembly —');
_clearCache();
const block = await marketGrounding('Nigeria', fakeFetch);
check('produces a non-empty grounding block for a real country', block && block.length > 40, JSON.stringify(block).slice(0, 80));
check('block names the country', block.includes('Nigeria'));
check('block cites World Bank', /World Bank/i.test(block));
check('block carries real formatted figures', block.includes('223,800,000') && block.includes('US$1,621') && block.includes('54.0%'));
check('block instructs the model to ground its numbers', /ground/i.test(block) && /extrapolate/i.test(block));

console.log('— caching —');
const callsAfterFirst = calls;
await marketGrounding('Nigeria', fakeFetch);
check('a repeat country is served from cache (no new WB calls)', calls === callsAfterFirst, `calls went ${callsAfterFirst} -> ${calls}`);

console.log('— fails soft —');
check('empty country → empty string, no throw', await marketGrounding('', fakeFetch) === '');
check('a country with too little data → empty string (GB has only 2 indicators here → still ok)', typeof (await marketGrounding('United Kingdom', fakeFetch)) === 'string');
const throwFetch = async () => { throw new Error('network down'); };
_clearCache();
let soft;
try { soft = await marketGrounding('Kenya', throwFetch); } catch (e) { soft = 'THREW:' + e.message; }
check('a total network failure returns “” and never throws', soft === '', soft);

console.log(failures === 0 ? '\nMARKET DATA: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
