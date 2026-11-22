// SEARCHSTORE test — durable, account-scoped storage of search runs, so a paid
// search's results survive a cache clear / new device and can be re-opened.
// Run: node test/searchstore.js
import os from 'node:os';
import path from 'node:path';
process.env.SEARCHES_STORE = path.join(os.tmpdir(), `nf-searches.test.${process.pid}.json`);

const S = await import('../src/searchstore.js');

let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };
const threw = (fn, code) => { try { fn(); return false; } catch (e) { return code ? (e.code === code) : true; } };

const U = 'op_searchuser01';
const niches = [
  { t: 'Compliance automation for UK letting agents', m: 'UK · Digital', s: 84, p: 'Automate right-to-rent checks.', scores: { prs: 84, cs: 80, pss: 82, bps: 78, msp: 82, ppp: 80 } },
  { t: 'Niche B', m: 'UK · Digital', s: 79, p: 'Second idea.', scores: { prs: 79 } },
];

console.log('— save / list / get —');
const r = S.saveSearchRun({ user: U, run: { id: 'run_abc', country: 'United Kingdom', routing: 'breakthrough_concepts', budget: 500, risk: 'Balanced', live: true, niches } });
check('save returns the run id', r.saved === true && r.id === 'run_abc', JSON.stringify(r));
const list = S.listSearchRuns({ user: U });
check('list returns the run summary', list.length === 1 && list[0].id === 'run_abc' && list[0].count === 2);
check('list is light — no niche bodies leaked', list[0].niches === undefined);
const full = S.getSearchRun({ user: U, id: 'run_abc' });
check('get returns the full run with niches', full && full.niches.length === 2 && full.niches[0].t.indexOf('Compliance') === 0);
check('niche scores normalised (missing → 0)', full.niches[1].scores.cs === 0);

console.log('— idempotent re-save, ordering, cap —');
S.saveSearchRun({ user: U, run: { id: 'run_abc', country: 'UK', routing: 'balanced', live: true, niches } });
check('re-saving the same id does not duplicate', S.listSearchRuns({ user: U }).length === 1);
S.saveSearchRun({ user: U, run: { id: 'run_def', country: 'UK', routing: 'balanced', live: true, niches } });
check('newest run is first', S.listSearchRuns({ user: U })[0].id === 'run_def');

console.log('— isolation / validation —');
check('another account sees nothing', S.listSearchRuns({ user: 'op_othergyuser9' }).length === 0);
check('invalid account id rejected', threw(() => S.saveSearchRun({ user: 'nope', run: { niches } }), 'invalid_user_id'));
check('empty niches rejected', threw(() => S.saveSearchRun({ user: U, run: { id: 'x', niches: [] } }), 'empty_run'));
check('get for unknown id is null', S.getSearchRun({ user: U, id: 'missing' }) === null);

console.log('— per-user cap (keeps newest 50) —');
for (let i = 0; i < 60; i++) S.saveSearchRun({ user: 'op_capuser0001', run: { id: 'r' + i, country: 'UK', niches } });
const capped = S.listSearchRuns({ user: 'op_capuser0001' });
check('at most 50 runs retained', capped.length === 50, 'len=' + capped.length);
check('oldest runs evicted, newest kept', capped[0].id === 'r59' && !capped.some((x) => x.id === 'r0'));

console.log('— erasure —');
const removed = S.deleteUserSearches(U);
check('deleteUserSearches removes the account\'s runs', removed === 2 && S.listSearchRuns({ user: U }).length === 0);

console.log(failures === 0 ? '\nSEARCHSTORE: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
