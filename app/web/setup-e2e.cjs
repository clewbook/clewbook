// The set-up page (where a host creates a campaign), end to end on testnet: refusals in calm notices, the real fields only, a block-time
// estimate that comes from a measurement, the terms preview with 8-decimal amounts, and a real campaign created and shown on the dashboard.
// Needs `ll-host serve` on 127.0.0.1:8780 with an empty runs folder. Env: SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const fs = require('fs');
const BASE = `http://127.0.0.1:${process.env.DASH_PORT || 8780}`, SHOTS = process.env.SHOTS || 'runs/design-shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
const OWN = /^(http:\/\/127\.0\.0\.1|data:|blob:)/;
fs.mkdirSync(SHOTS, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const errors = [], outside = [];
  const open = async (w, h) => {
    const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('request', (r) => { if (!OWN.test(r.url()) && !/zec\.rocks|chainsafe\.dev/.test(r.url())) outside.push(r.url()); });
    await page.goto(`${BASE}/setup.html`);
    await page.waitForFunction(() => /Test network|Main network/.test(document.querySelector('#net-note').textContent), null, { timeout: 20000 });
    return page;
  };
  let page = await open(1280, 900);
  check('the page uses the shared look: self-hosted fonts load', await page.evaluate(async () => { await document.fonts.ready; return ['700 16px "Archivo"', '400 16px "Chivo Mono"'].every((f) => document.fonts.check(f)); })); // design round 2 fonts
  // real fields only
  const fields = await page.evaluate(() => [...document.querySelectorAll('#setup-form input, #setup-form textarea')].map((e) => e.id || e.name).filter((n) => n !== 'confirm-mainnet')); // the real-money box exists only on the main network
  check('only the fields the engine supports: name, type, goal, hard cap, early close, items, how winners pay, reserve, smallest contribution, deadline, ticket window, relays', JSON.stringify(fields.sort()) === JSON.stringify(['campaign-name', 'cap', 'deadline', 'early-close', 'goal', 'items', 'minimum', 'mode', 'mode', 'pricing', 'pricing', 'relays', 'reserve', 'ticketk']), fields.join(','));
  check('a fundraiser offers "Allow closing early once the goal is met", off unless ticked', await page.isVisible('#early-close') && !(await page.isChecked('#early-close')) && /Allow closing early once the goal is met/.test(await text(page, '#early-row')));
  check('a fundraiser shows the goal and hides the items', await page.isVisible('#goal') && await page.isHidden('#items'));
  check('the smallest contribution hint is the engine\'s floor with 8 decimals', /0\.00020000 TAZ/.test(await text(page, '#minimum-hint')), await text(page, '#minimum-hint'));
  await page.waitForFunction(() => /measured over the last \d+ blocks/.test(document.querySelector('#deadline-hint').textContent), null, { timeout: 60000 }).catch(() => {});
  const hint = await text(page, '#deadline-hint');
  check('the deadline hint gives a time from a measured block time (not a fixed number)', /≈\d+ seconds, measured over the last \d+ blocks/.test(hint), hint);
  await page.fill('#goal', '0.05'); await page.fill('#deadline', '100');
  const terms = await text(page, '#terms');
  check('the terms preview shows the goal with 8 decimals and the deadline block', /Goal\s*0\.05000000 TAZ/.test(terms) && /Deadline\s*about block [\d,]+ \(now [\d,]+, plus 100\)/.test(terms), terms);
  check('the campaign key notice says what is created and where', /new wallet and key/.test(await text(page, '.notice.info')) && /Back up the campaign folder/.test(await text(page, '.notice.info')));
  check('the ticket window defaults to 30 blocks and its hint says what it is for', (await page.inputValue('#ticketk')) === '30' && /refund ticket within this many blocks/.test(await text(page, '#ticketk-hint')) && /Ticket window\s*30 blocks/.test(await text(page, '#terms')), await text(page, '#ticketk-hint'));
  await page.screenshot({ path: `${SHOTS}/setup-filled-1280.png`, fullPage: true });

  // refusals: calm notices
  const submit = async () => { await page.click('#create-btn'); await page.waitForSelector('#setup-error:not([hidden])', { timeout: 8000 }); return text(page, '#setup-error'); };
  await page.fill('#goal', ''); let e = await submit();
  check('refuses a missing goal', /goal/i.test(e), e);
  check('the refusal is a notice with a kicker, in the failure style, not a raw error', await page.evaluate(() => { const n = document.querySelector('#setup-error'); return n.classList.contains('notice') && n.classList.contains('bad') && /Check this/.test(n.textContent) && !!n.querySelector('.k'); }));
  await page.fill('#goal', '0.05'); await page.fill('#minimum', '0.00005'); e = await submit();
  check('refuses a smallest contribution below twice the fee', /0\.0002|at least/i.test(e), e);
  await page.fill('#minimum', '0.0002'); await page.fill('#deadline', '5'); e = await submit();
  check('refuses a deadline that is too close', /20 blocks/.test(e), e);
  await page.fill('#deadline', '500'); await page.fill('#ticketk', '5'); e = await submit();
  check('refuses a ticket window outside 10 to 1000 blocks', /ticket window/i.test(e) && /10 to 1000/.test(e), e);
  await page.fill('#ticketk', '30');
  await page.check('input[value=auction]'); await page.fill('#deadline', '500'); await page.fill('#items', '');
  check('an auction shows the items and hides the goal', await page.isVisible('#items') && await page.isHidden('#goal'));
  check('an auction cannot be set to close early (the option is not shown)', await page.isHidden('#early-close'));
  check('an auction preselects "everyone who wins pays the same price"', await page.isChecked('input[name=pricing][value=uniform]') && await page.isVisible('#reserve'));
  const pr = await text(page, '#pricing-row');
  check('  ... and explains both ways with a worked example', /lowest winning bid/.test(pr) && /whoever bid 1\.0 gets 0\.4 back/.test(pr) && /Each winner pays their own bid/.test(pr) && !/\w-\w|—|–/.test(pr), pr.slice(0, 160));
  e = await submit();
  check('an auction needs a number of items', /how many items/i.test(e), e);
  await page.fill('#items', '1'); await page.fill('#reserve', ''); e = await submit();
  check('a uniform price auction needs a reserve price', /reserve price/i.test(e), e);
  await page.check('input[name=pricing][value=pay_your_bid]');
  check('choosing "each winner pays their own bid" hides the reserve', await page.isHidden('#reserve'));
  await page.check('input[name=pricing][value=uniform]');
  // a real uniform price auction: the treasury wallet is made in the campaign folder
  await page.fill('#reserve', '0.001'); await page.fill('#items', '2'); await page.fill('#deadline', '100');
  await page.click('#create-btn');
  await page.waitForURL(`${BASE}/`, { timeout: 300000 });
  await page.waitForSelector('#live:not([hidden])', { timeout: 60000 });
  const aid = await page.inputValue('#campaign-select');
  const ast = await (await fetch(`${BASE}/api/campaigns/${aid}`)).json();
  check('the dashboard made a uniform price auction (2 items) by default', ast.mode === 'auction' && ast.pricing === 'uniform' && ast.items === 2, JSON.stringify({ mode: ast.mode, pricing: ast.pricing, items: ast.items }));
  await page.goto(`${BASE}/setup.html`); await page.waitForFunction(() => /Test network|Main network/.test(document.querySelector('#net-note').textContent), null, { timeout: 20000 });
  await page.check('input[value=auction]');
  await page.screenshot({ path: `${SHOTS}/setup-error-1280.png`, fullPage: true });
  await page.check('input[value=raise]');

  // a real campaign (that allows an early close once its goal is met)
  await page.fill('#goal', '0.05'); await page.fill('#deadline', '100'); await page.fill('#ticketk', '40');
  await page.check('#early-close');
  check('the terms preview says the campaign may close early', /Early close\s*Allowed once the goal is met/.test(await text(page, '#terms')), await text(page, '#terms'));
  await page.click('#create-btn');
  await page.waitForURL(`${BASE}/`, { timeout: 300000 });
  await page.waitForSelector('#live:not([hidden])', { timeout: 60000 });
  const facts = await text(page, '#facts');
  check('creating a campaign goes to the dashboard, which shows it (type, goal, minimum)', /Fundraiser/.test(facts) && /Goal0\.05000000 TAZ/.test(facts) && /Smallest contribution0\.00020000 TAZ/.test(facts), facts.slice(0, 200));
  const id = await page.inputValue('#campaign-select');
  const st = await (await fetch(`${BASE}/api/campaigns/${id}`)).json();
  check('the campaign has the goal and a deadline about 100 blocks from the block the page measured', st.goal_zat === 5000000 && st.ticket_k === 40 && st.deadline_height - st.tip >= 90 && st.deadline_height - st.tip <= 140, `${st.deadline_height} - ${st.tip}`);
  check('  ... and allows an early close, which is not possible yet (no contributions)', st.early_close === true && st.can_close_early === false && /goal is not met yet/.test(st.close_early_reason || ''), JSON.stringify({ e: st.early_close, c: st.can_close_early, r: st.close_early_reason }));
  fs.writeFileSync(`${SHOTS}/.setup-created-id`, id);

  // a phone
  await page.close();
  page = await open(390, 844);
  await page.fill('#goal', '0.05');
  check('no horizontal scrolling on a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${SHOTS}/setup-390.png`, fullPage: true });
  check('nothing was requested from outside this computer except the public network servers', outside.length === 0, outside.slice(0, 3).join(' '));
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
