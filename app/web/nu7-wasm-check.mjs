// The NU7 ticket check in a built browser module (not the Rust source): the two real tickets that `cargo test -p ll-web nu7_tests`
// writes with NU7_TICKETS_OUT go through the module's own verify_ticket, as contribute.js calls it, with the network on NU7 and on NU6.3.
// Usage: node app/web/nu7-wasm-check.mjs <pkg folder> <tickets.json> <work folder>   (prints PASS/FAIL lines and the checks as JSON)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [pkg, ticketsFile, work] = process.argv.slice(2);
fs.mkdirSync(work, { recursive: true });
// the glue is an ES module with a .js name; Node needs .mjs to load it as one
const glue = path.join(work, `ll_web-${path.basename(path.resolve(pkg, '..'))}-${Date.now()}.mjs`);
fs.copyFileSync(path.join(pkg, 'll_web.js'), glue);
const W = await import(pathToFileURL(glue).href);
W.initSync({ module: fs.readFileSync(path.join(pkg, 'll_web_bg.wasm')) });
const T = JSON.parse(fs.readFileSync(ticketsFile, 'utf8'));
const NU63 = '37a5165b', NU7 = '77190ad9';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const run = (t, now) => JSON.parse(W.verify_ticket(JSON.stringify({
  raw_hex: t.raw_hex, expected_txid: t.txid, ticket_branch: t.branch, contribution_nf: t.nf, fee_zat: 10000,
  current_branch: now, scanned_to: 3543415, spent: null, known_txids: [t.txid],
})));
const fails = (v) => v.checks.filter((c) => c.status === 'fail').map((c) => c.id);
const st = (v, id) => (v.checks.find((c) => c.id === id) || {}).status;
const out = {};
for (const [k, t] of Object.entries(T)) for (const now of [NU7, NU63]) out[`${k}@${now}`] = run(t, now);

const a = out[`nu7@${NU7}`];
check('network on NU7: the NU7 ticket passes', a.verdict === 'pass' && fails(a).length === 0, JSON.stringify(fails(a)));
const b = out[`nu6_3@${NU7}`];
check('network on NU7: the NU6.3 ticket fails the network version only', b.verdict === 'fail' && JSON.stringify(fails(b)) === '["network_version"]', JSON.stringify(fails(b)));
check('and it reads, matches the list, has the right shape and valid signatures (not a fake)', ['matches_list', 'shape', 'signatures', 'no_expiry', 'fee', 'spends_your_coin'].every((id) => st(b, id) === 'pass'));
// contribute.js renderTicketChecks: a failed network_version check adds this sentence
const special = b.checks.find((x) => x.id === 'network_version' && x.status === 'fail') ? ' This ticket is for an older network version; the campaign must reissue it.' : '';
check('so the page says it is for an older network version', special !== '', b.checks.find((x) => x.id === 'network_version').detail);
check('network on NU6.3: the NU6.3 ticket passes and the NU7 one fails the network version only', out[`nu6_3@${NU63}`].verdict === 'pass' && JSON.stringify(fails(out[`nu7@${NU63}`])) === '["network_version"]');
fs.writeFileSync(path.join(work, `checks-${path.basename(path.resolve(pkg, '..'))}.json`), JSON.stringify(out, null, 1));
fs.rmSync(glue);
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
