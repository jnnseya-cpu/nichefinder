// Claude provider self-healing param degradation (B1 hardening). A live API or a
// specific model/account can reject an advanced param (adaptive thinking,
// effort, structured-output schema). generate() must strip the offending param
// and retry rather than hard-failing a user's paid run. This tests the pure
// decision logic (buildParams / degradeFor) without hitting the network.
// Run: node test/claude-degrade.js
import Anthropic from '@anthropic-ai/sdk';
import { buildParams, degradeFor } from '../src/providers/claude.js';

let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

const badRequest = (message) => Object.assign(Object.create(Anthropic.BadRequestError.prototype), { message, status: 400 });
const REQ = { messages: [{ role: 'user', content: 'hi' }], jsonSchema: { type: 'object' }, effort: 'high' };

// --- buildParams shapes ---
const full = buildParams(REQ, {});
check('full params carry adaptive thinking', full.thinking && full.thinking.type === 'adaptive');
check('full params carry effort', full.output_config && full.output_config.effort === 'high');
check('full params carry json_schema format', full.output_config.format && full.output_config.format.type === 'json_schema');

const noThink = buildParams(REQ, { dropThinking: true });
check('dropThinking removes thinking', !noThink.thinking && !!noThink.output_config);

const noOC = buildParams(REQ, { dropOutputConfig: true });
check('dropOutputConfig removes output_config entirely', !noOC.output_config);

const noSchema = buildParams(REQ, { dropSchema: true });
check('dropSchema keeps effort but removes format', noSchema.output_config.effort === 'high' && !noSchema.output_config.format);

check('effort defaults to high for an invalid value', buildParams({ ...REQ, effort: 'bogus' }, {}).output_config.effort === 'high');
check('a request without a schema has no format', !buildParams({ messages: REQ.messages }, {}).output_config.format);

// --- degradeFor: target the named param, then terminate ---
check('400 naming thinking → drop thinking', JSON.stringify(degradeFor(badRequest('thinking: unsupported'), {})) === JSON.stringify({ dropThinking: true }));
check('400 naming output_config → drop output_config', degradeFor(badRequest('output_config not allowed'), {}).dropOutputConfig === true);
check('400 naming effort → drop output_config', degradeFor(badRequest('effort is invalid'), {}).dropOutputConfig === true);
check('400 naming schema → drop output_config', degradeFor(badRequest('structured output schema rejected'), {}).dropOutputConfig === true);

const generic = degradeFor(badRequest('something went wrong'), {});
check('generic 400 strips both advanced params', generic.dropThinking === true && generic.dropOutputConfig === true);

check('degrade terminates once both are already stripped', degradeFor(badRequest('still broken'), { dropThinking: true, dropOutputConfig: true }) === null);
check('a non-400 error never degrades (goes to failover)', degradeFor(Object.assign(new Error('boom'), { status: 500 }), {}) === null);

// A realistic full ladder terminates in a bounded number of steps.
let opts = {}; let steps = 0;
while (steps < 10) { const n = degradeFor(badRequest('thinking and output_config bad'), opts); if (!n) break; opts = n; steps++; }
check('degrade ladder is bounded (≤3 steps)', steps <= 3, `steps=${steps}`);

console.log(failures === 0 ? '\nCLAUDE-DEGRADE: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
