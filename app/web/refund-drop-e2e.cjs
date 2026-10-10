// "Refund me" against a flaky public server: the browser's FIRST SendTransaction is swallowed (the call looks
// successful but nothing reaches the network). The page must say it is waiting, send the very same bytes again after
// about ten blocks, and end up confirmed in a block, with the coin spent exactly once. Never "pay again".
// Env: LINK, BACKUP (a backup file of a contributor whose ticket exists), SHOTS
const { chromium } = require('./../vectors/js/node_modules/playwright');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const txt = async (p, s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const sends = []; // request bodies of every SendTransaction the page makes
  await page.route('**/*CompactTxStreamer/SendTransaction', async (route) => {
    const body = route.request().postDataBuffer();
    sends.push(Buffer.from(body).toString('hex'));
    if (sends.length === 1) {
      // the flaky server: reports success, sends nothing
      const trailer = Buffer.from('grpc-status:0\r\n');
      const frame = Buffer.concat([Buffer.from([0, 0, 0, 0, 0]), Buffer.from([0x80, 0, 0, 0, trailer.length]), trailer]);
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/grpc-web+proto', 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' }, body: frame });
    }
    return route.continue();
  });
  await page.goto(process.env.LINK);
  await page.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
  await page.setInputFiles('#restore', process.env.BACKUP);
  await page.waitForSelector('#refund-area:not([hidden])', { timeout: 180000 });
  check('"Refund me" is offered once the ticket is found', await page.isVisible('#refund-btn'));
  await page.click('#refund-btn'); await page.click('#refund-yes');
  await page.waitForFunction(() => !document.querySelector('#refund-result').hidden, null, { timeout: 30000 });
  check('after sending, the page says it is waiting to be mined (not "done")', /waiting to be mined/.test(await txt(page, '#refund-result')), await txt(page, '#refund-result'));
  check('the first send was made once and swallowed by the fake server', sends.length === 1);
  await page.screenshot({ path: `${process.env.SHOTS || 'runs/page/shots'}/50-refund-waiting.png`, fullPage: true });
  // about ten blocks later the page sends the same bytes again by itself
  await page.waitForFunction(() => /very same refund again/.test(document.querySelector('#refund-result').textContent) || /confirmed in block/.test(document.querySelector('#refund-result').textContent), null, { timeout: 900000, polling: 5000 });
  check('the page sent the SAME bytes again by itself', sends.length >= 2 && sends[1] === sends[0], `${sends.length} sends; identical: ${sends[1] === sends[0]}`);
  await page.screenshot({ path: `${process.env.SHOTS || 'runs/page/shots'}/51-refund-resent.png`, fullPage: true });
  await page.waitForFunction(() => /confirmed in block/.test(document.querySelector('#refund-result').textContent), null, { timeout: 600000, polling: 5000 });
  const final = await txt(page, '#refund-result');
  check('the page ends with "confirmed in block N"', /confirmed in block \d+/.test(final), final);
  check('the page never tells the person to pay again', !/pay again|send (the )?money again/i.test(await txt(page, 'body')));
  check('no more sends after it was mined', (await new Promise((r) => setTimeout(() => r(sends.length), 15000))) === sends.length);
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  console.log('SENDS', sends.length);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
