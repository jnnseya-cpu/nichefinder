// AGENTS test — the agent registry manifest is well-formed and honest.
import { AGENTS, validateRegistry, validateAgent, agentById, agentsByStatus, registrySummary } from '../src/agents.manifest.js';

let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

check('registry validates (unique ids, every spec well-formed)', validateRegistry() === true);
check('has a meaningful number of agents', AGENTS.length >= 15, 'count=' + AGENTS.length);

// honesty: every LIVE agent must point at real code; proposed ones must not be mislabelled
const live = agentsByStatus('live');
check('all live agents carry an impl pointer (no fake "shipped")', live.every((a) => a.impl), live.filter((a) => !a.impl).map((a) => a.id).join(','));
check('proposed agents exist and are not claimed live', agentsByStatus('proposed').length >= 5);

// spot-check a known-live agent maps to reality
const pay = agentById('payment');
check('payment agent is live + revenue tier + autonomous_safe', pay && pay.status === 'live' && pay.tier === 'revenue' && pay.autonomy === 'autonomous_safe');
const gov = agentById('ai-governance');
check('ai-governance escalates to a human (mandatory)', gov && /human/i.test(gov.escalation.to));

// a malformed spec is rejected
let threw = false;
try { validateAgent({ id: 'x', tier: 'nope', status: 'live', autonomy: 'recommend_only', purpose: '', inputs: [], outputs: [], permissions: [], triggers: [], providers: [], acuPolicy: {}, escalation: {} }); }
catch { threw = true; }
check('a bad tier is rejected by the validator', threw);

let threw2 = false;
try { validateAgent({ id: 'y', tier: 'revenue', status: 'live', autonomy: 'autonomous_safe', purpose: 'p', inputs: [], outputs: [], permissions: [], triggers: [], providers: ['deterministic'], acuPolicy: {}, escalation: {} }); }
catch { threw2 = true; }
check('a live agent with no impl pointer is rejected', threw2);

const sum = registrySummary();
check('registry summary reports status/tier/autonomy breakdowns', sum.total === AGENTS.length && sum.byStatus.live > 0 && sum.byStatus.proposed > 0, JSON.stringify(sum.byStatus));

console.log(failures === 0 ? '\nAGENTS: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
