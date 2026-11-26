// LENDER PACK test — the 8-asset bundle costs 10% less than buying the parts,
// and a purchase grants prepaid credits so each component generates once free,
// refunded if a generation fails. Run: node test/lender-pack.js
import os from 'node:os';
import path from 'node:path';
process.env.BUNDLES_STORE = path.join(os.tmpdir(), `nf-bundles.test.${process.pid}.json`);

import '../../../shared/nf-economy.js';
const E = globalThis.NF_ECONOMY;
const B = await import('../src/bundlestore.js');

let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };
const threw = (fn, code) => { try { fn(); return false; } catch (e) { return code ? e.code === code : true; } };

console.log('— pricing (10% off the sum) —');
const sum = E.LENDER_PACK.reduce((t, c) => t + E.COSTS[c === 'export' ? 'excel_model' : c], 0);
check('components sum to 3070', sum === 3070, 'sum=' + sum);
check('lender_pack is exactly 10% off (2763)', E.COSTS.lender_pack === 2763, String(E.COSTS.lender_pack));
check('the discount saves 307 ACU', sum - E.COSTS.lender_pack === 307);
check('all 8 lender documents are included', E.LENDER_PACK.length === 8 &&
  ['gtm', 'validation', 'forecast', 'pnl', 'riskmap', 'bizplan', 'pitch', 'export'].every((c) => E.LENDER_PACK.includes(c)));

console.log('— prepaid credits: grant / consume / refund —');
const U = 'op_bundleuser01', P = 'proj_1';
B.grantBundle({ user: U, project: P, components: E.LENDER_PACK });
check('grant creates a credit for every component', Object.keys(B.listBundleCredits({ user: U, project: P })).length === 8);
check('consume a component returns true', B.consumeBundleComponent({ user: U, project: P, type: 'validation' }) === true);
check('that component credit is now spent', B.consumeBundleComponent({ user: U, project: P, type: 'validation' }) === false);
check('other components are untouched', B.consumeBundleComponent({ user: U, project: P, type: 'gtm' }) === true);
B.refundBundleComponent({ user: U, project: P, type: 'validation' });
check('refund restores a failed component so it can generate again', B.consumeBundleComponent({ user: U, project: P, type: 'validation' }) === true);

console.log('— isolation / scoping —');
check('no credit for a different project', B.consumeBundleComponent({ user: U, project: 'proj_other', type: 'pitch' }) === false);
check('no credit for a different account', B.consumeBundleComponent({ user: 'op_strangerzz9', project: P, type: 'pitch' }) === false);
check('invalid account id rejected on grant', threw(() => B.grantBundle({ user: 'bad', project: P, components: ['gtm'] }), 'invalid_user_id'));

console.log('— erasure —');
B.grantBundle({ user: U, project: 'proj_2', components: ['gtm'] });
const removed = B.deleteUserBundles(U);
check('deleteUserBundles clears every project for the account', removed === 2 && Object.keys(B.listBundleCredits({ user: U, project: P })).length === 0);

console.log(failures === 0 ? '\nLENDER PACK: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
