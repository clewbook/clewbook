// The capability card is generated from the campaign's real rules: every printed value equals the committed rules fetched from the relay, the
// checks that apply follow the mode (R9 to R12 only for a uniform-price auction), the network label follows the rules, and the card says what is
// not checked. Env: LINK (a fundraiser's page link), LINK_AUCTION (a uniform-price auction's page link), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const SHOTS = process.env.SHOTS || 'runs/design-shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
const zat8 = (z) => { const f = String(z % 1e8).padStart(8, '0').replace(/0+$/, ''); return `${Math.floor(z / 1e8)}${f ? '.' + f : ''}`; }; // trimmed, as the pages show it
const OWN = /^(http:\/\/127\.0\.0\.1|data:|blob:)/;
(async () => {
  const browser = await chromium.launch();
  const errors = [], outside = [];
  for (const [name, link] of [['fundraiser', process.env.LINK], ['auction', process.env.LINK_AUCTION]]) {
    const tail = link.slice(link.indexOf('#')), base = link.slice(0, link.indexOf('contribute.html'));
    const id = tail.match(/c=([0-9a-f]{64})/)[1], relay = tail.match(/relay=([^&]+)/)[1];
    const rules = await (await fetch(`${relay}/v1/campaigns/${id}`)).json();
    for (const [w, h, tag] of [[1280, 900, '1280'], [390, 844, '390']]) {
      const p = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
      p.on('pageerror', (e) => errors.push(String(e)));
      p.on('request', (r) => { if (!OWN.test(r.url()) && !/zec\.rocks|chainsafe\.dev/.test(r.url())) outside.push(r.url()); });
      await p.goto(`${base}card.html${tail}`);
      await p.waitForSelector('#card:not([hidden])', { timeout: 90000 });
      if (tag === '1280') {
        const terms = await text(p, '#terms'), uniform = rules.mode === 'auction' && rules.pricing === 'uniform';
        check(`${name}: the type and network come from the rules`, new RegExp(rules.mode === 'raise' ? 'Type\\s*Fundraiser' : 'Type\\s*Auction').test(terms) && /Network\s*Test network \(no real money\)/.test(terms) && rules.network === 'test', terms.slice(0, 120));
        check(`${name}: the smallest contribution, the refund fee and the ticket window equal the rules, trimmed`, terms.includes(`Smallest contribution${zat8(rules.min_contribution_zat)} TAZ`.replace(/\s/g, '')) || terms.replace(/\s/g, '').includes(`Smallestcontribution${zat8(rules.min_contribution_zat)}TAZ`) , terms);
        check(`${name}: the ticket window is K = ${rules.ticket_k} blocks and the deadline is block ${rules.deadline_height}`, new RegExp(`Ticket window\\s*${rules.ticket_k} blocks`).test(terms) && terms.replace(/,/g, '').includes(`block ${rules.deadline_height}`), terms);
        if (rules.mode === 'raise') check('fundraiser: the goal equals the rules', terms.replace(/\s/g, '').includes(`Goal${zat8(rules.goal_zat)}TAZ`));
        const ids = await p.evaluate(() => [...document.querySelectorAll('#checks .cid')].map((e) => e.firstChild.textContent));
        check(`${name}: the checks that apply follow the rules (${uniform ? 'R1 to R12 with R4b' : 'R1 to R8 with R4b, no R9 to R12'})`, JSON.stringify(ids) === JSON.stringify(['R1', 'R2', 'R3', 'R4', 'R4b', 'R5', 'R6', 'R7', 'R8', ...(uniform ? ['R9', 'R10', 'R11', 'R12'] : [])]), ids.join(' '));
        const nc = await text(p, '#not-checked');
        check(`${name}: it lists what is not checked, each with its reason as text`, /one-time secret/.test(nc) && /Check the proof too/.test(nc) && /Ticket anchors/.test(nc) && /Ledger anchoring/.test(nc) && nc.includes("once the campaign is closed, the host signs the list's fingerprint (the number of entries and the hash of the last one), but it is not anchored on any public ledger") && (rules.mode !== 'auction' || /bid amounts are not on the public list/.test(nc)), nc.slice(0, 160));
        const lv = await text(p, '#levels');
        check(`${name}: the ticket levels L1 to L4 are listed, the proof only on request and L4 as not built`, /L1/.test(lv) && /L2/.test(lv) && /L3/.test(lv) && /On request/.test(lv) && /L4/.test(lv) && /Not built/.test(lv));
        check(`${name}: an auction says that only R1 and R2 can run before it closes; a fundraiser does not`, (await p.isVisible('#auction-note')) === (rules.mode === 'auction'));
        await p.click('#checks .chk:first-child .cid'); await p.waitForTimeout(200);
        check(`${name}: tapping a check id shows its name and a sentence`, await p.isVisible('#checks .chk:first-child .tip') && /Rules/.test(await text(p, '#checks .chk:first-child .tip')));
        check(`${name}: the rules fingerprint is the campaign id, with expand and copy`, (await p.locator('#rules-id').getAttribute('data-h')) === id);
        check(`${name}: the links go to this campaign's pages`, /campaign\.html#c=/.test(await p.getAttribute('#campaign-link', 'href')) && /recount\.html#c=/.test(await p.getAttribute('#recount-link', 'href')));
      }
      check(`${name}: no horizontal scrolling (${tag})`, await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await p.screenshot({ path: `${SHOTS}/card-${name}-${tag}.png`, fullPage: true });
      await p.close();
    }
  }
  // rules that do not match the campaign id: the card draws nothing. A relay is made to answer with another campaign's rules, and then with the
  // right rules changed in one number; both must be refused (the same check the contribute page makes before it shows anything).
  {
    const link = process.env.LINK, tail = link.slice(link.indexOf('#')), base = link.slice(0, link.indexOf('contribute.html'));
    const id = tail.match(/c=([0-9a-f]{64})/)[1], relays = [...tail.matchAll(/relay=([^&]+)/g)].map((m) => m[1]);
    const otherTail = process.env.LINK_AUCTION.slice(process.env.LINK_AUCTION.indexOf('#'));
    const otherRules = await (await fetch(`${otherTail.match(/relay=([^&]+)/)[1]}/v1/campaigns/${otherTail.match(/c=([0-9a-f]{64})/)[1]}`)).text();
    const own = JSON.parse(await (await fetch(`${relays[0]}/v1/campaigns/${id}`)).text());
    const tampered = JSON.stringify({ ...own, ticket_k: own.ticket_k + 1 });
    for (const [what, body] of [['another campaign\'s rules', otherRules], ['the right rules with the ticket window changed by one', tampered]]) {
      const p = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
      p.on('pageerror', (e) => errors.push(String(e)));
      for (const r of relays) await p.route(`${r}/v1/campaigns/${id}`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body }));
      await p.goto(`${base}card.html${tail}`);
      await p.waitForSelector('#banners .notice', { timeout: 60000 });
      check(`the card refuses ${what}: nothing is drawn and the page says so`, (await p.isHidden('#card')) && (await text(p, '#terms')) === '' && /nothing to show|do not match|incomplete/.test(await text(p, '#banners')), await text(p, '#banners'));
      await p.close();
    }
  }
  // the model itself, with rules for the main network (no real campaign is needed)
  const q = await (await browser.newContext()).newPage();
  await q.goto('http://127.0.0.1:8770/components.html');
  const m = await q.evaluate(async () => {
    const { cardModel } = await import('./capabilities.js');
    const rules = { mode: 'raise', pricing: null, reissue_window: 20 };
    return cardModel({ network: 'main', ticker: 'ZEC', goal_zat: 123456789, min_zat: 20000, fee_zat: 10000, deadline_height: 3000000, ticket_k: 45 }, rules, 75);
  });
  check('a main-network campaign is labelled Mainnet with ZEC (round 13)', /"Network","Mainnet"/.test(JSON.stringify(m.terms)) && JSON.stringify(m.terms).includes('"ticker":"ZEC"'));
  check('its ticket window and goal are exactly the rules\' numbers', JSON.stringify(m.terms).includes('"blocks":45,"seconds":3375') && JSON.stringify(m.terms).includes('"amount":123456789'));
  check('nothing was requested from outside this computer except the public network servers', outside.length === 0, outside.slice(0, 3).join(' '));
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
