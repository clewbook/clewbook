// Runs the browser module in Node and compares with the CLI's output for each bundle.
// Usage: node node-check.mjs <endpoint> <bundle.json>...
import { readFileSync } from 'node:fs';
import { runRecount } from './recount.js';
const [base, ...files] = process.argv.slice(2);
const wasm = readFileSync(new URL('./pkg/ll_web_bg.wasm', import.meta.url));
let ok = true;
for (const f of files) {
  const bundle = JSON.parse(readFileSync(f));
  const { report, stats, events } = await runRecount(base.split(','), bundle, { wasm });
  if (events.length) console.log('   failover:', events.join(' | '));
  const same = report === bundle.expected;
  ok &&= same;
  console.log(`== ${f}: ${same ? 'IDENTICAL to CLI' : 'DIFFERENT from CLI'}`, JSON.stringify(stats));
  if (!same) { console.log('--- wasm:\n' + report + '--- cli:\n' + bundle.expected); }
}
process.exit(ok ? 0 : 1);
