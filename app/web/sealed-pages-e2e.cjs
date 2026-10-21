// The campaign and recount pages for sealed bid auctions, in a headless browser, against the four auctions of the private chain check of
// phase 7 (app/regtest/check-sealed-close.sh): U (uniform price), S (second price) and P (pay your bid), closed by their hosts, and N, whose
// host never closed. The recount page scans the private chain itself (through the test bridge in app/web/tools) and reads the relay.
// Started by app/regtest/check-pages.sh, which sets IDS (JSON: {U, S, P, N}), RELAY, ENDPOINT and WEB.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const IDS = JSON.parse(process.env.IDS), { RELAY, ENDPOINT, WEB } = process.env;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const link = (id) => `c=${id}&relay=${RELAY}&endpoint=${ENDPOINT}`;

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = async () => { const p = await (await browser.newContext()).newPage(); p.on('pageerror', (e) => errors.push(String(e))); return p; };
  const recount = async (id) => {
    const p = await page();
    await p.goto(`${WEB}/recount.html#${link(id)}`);
    await p.waitForFunction(() => !/Working|Reading/.test(document.querySelector('#verdict-title').textContent), null, { timeout: 600000 });
    const out = {
      title: await p.textContent('#verdict-title'), text: await p.textContent('#verdict-text'),
      sealed: await p.$eval('#sealed-card', (e) => (e.hidden ? '' : e.textContent)),
      sources: await p.textContent('#sources'),
      fails: await p.$$eval('#rules .fail, #rules [data-status=fail]', (x) => x.length).catch(() => -1),
    };
    await p.context().close();
    return out;
  };
  try {
    const u = await recount(IDS.U);
    check('recount U (uniform): all checks pass', /All checks pass/.test(u.title), `${u.title} ${u.text.slice(0, 80)} | ${u.sources.slice(0, 300)}`);
    check('U shows the opened bids, the winners and the one price', /bid 0\.2 TAZ, WINS, pays 0\.08 TAZ/.test(u.sealed) && /bid 0\.08 TAZ, WINS, pays 0\.08 TAZ/.test(u.sealed) && /bid 0\.05 TAZ/.test(u.sealed) && /each pays 0\.08 TAZ/.test(u.sealed), u.sealed.replace(/\s+/g, ' ').slice(0, 220));
    const s = await recount(IDS.S);
    check('recount S (second price): all checks pass, every winner pays the highest losing bid', /All checks pass/.test(s.title) && /WINS, pays 0\.05 TAZ/.test(s.sealed) && /highest losing bid/.test(s.sealed), s.title);
    const p = await recount(IDS.P);
    check('recount P (pay your bid): all checks pass, each winner pays their own bid', /All checks pass/.test(p.title) && /bid 0\.2 TAZ, WINS, pays 0\.2 TAZ/.test(p.sealed) && /bid 0\.08 TAZ, WINS, pays 0\.08 TAZ/.test(p.sealed), p.title);
    const n = await recount(IDS.N);
    check('recount N: the host did not finish', /did not finish/.test(n.title) && /did not finish/.test(n.sealed), `${n.title}: ${n.text.slice(0, 100)}`);

    // the campaign pages
    const c = await page();
    await c.goto(`${WEB}/campaign.html#${link(IDS.U)}`);
    await c.waitForSelector('#entries tr', { timeout: 120000 });
    const title = await c.textContent('#title'), rows = await c.textContent('#entries');
    check('campaign U: the type and pricing in the title', title === 'BLIND BID AUCTION · ONE PRICE FOR EVERY WINNER', title);
    check('campaign U: deposits, small payments, the opened bids and the viewing key on the list', /Deposit/.test(rows) && /Small payment/.test(rows) && /Bids opened at block/.test(rows) && /Viewing key/.test(rows) && /Won/.test(rows));
    const rules = await c.textContent('#view');
    check('campaign U: the rules show the deposit sizes, round R and the late ticket block', /Deposit sizes/.test(rules) && /drand round 33187201/.test(rules) && /Late tickets/.test(rules));
    await c.goto(`${WEB}/campaign.html#${link(IDS.N)}`);
    await c.reload();
    await c.waitForFunction(() => /Host did not finish/.test(document.querySelector('#view').textContent), null, { timeout: 120000 }).catch(() => {});
    check('campaign N: the outcome says the host did not finish', /Host did not finish/.test(await c.textContent('#view')));
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  } catch (e) {
    check('run', false, String(e).slice(0, 300));
  } finally {
    await browser.close();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
