// Opens the contribute page, builds a real payment, and saves its QR as the page draws it (phone-sized
// screen, 3x pixel density) together with the real payment link, for scanning tests.
// Env: LINK, REFUND_ADDR, OUT (directory)
const { chromium } = require('../vectors/js/node_modules/playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })).newPage();
  await p.goto(process.env.LINK);
  await p.waitForSelector('#form-card:not([hidden])', { timeout: 30000 });
  await p.fill('#amount', '0.01'); await p.fill('#refund', process.env.REFUND_ADDR);
  await p.click('#create'); await p.waitForSelector('#qr svg');
  const href = await p.getAttribute('#paylink', 'href');
  const box = await p.locator('#qr svg').boundingBox();
  const modules = await p.evaluate(() => { const v = document.querySelector('#qr svg').getAttribute('viewBox').split(' '); return Number(v[2]); });
  await p.locator('#qr').screenshot({ path: `${process.env.OUT}/qr-real.png` });
  fs.writeFileSync(`${process.env.OUT}/qr-real.json`, JSON.stringify({ uri: href, uri_length: href.length, css_width: box.width, grid_with_quiet_zone: modules }, null, 1));
  console.log(`payment link: ${href.length} characters; QR drawn ${Math.round(box.width)} px wide, ${modules} modules across (including the quiet zone)`);
  await b.close();
})();
