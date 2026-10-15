// Draws the real payment code on a phone-sized page (full and simpler), decodes each screenshot with jsQR,
// and checks the decoded link matches. Env: LINK, REFUND_ADDR, OUT
const { chromium } = require('../vectors/js/node_modules/playwright');
const jsQR = require('../vectors/js/node_modules/jsqr'); const { PNG } = require('../vectors/js/node_modules/pngjs'); const fs = require('fs');
const dec = (f) => { const png = PNG.sync.read(fs.readFileSync(f)); const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height); return r && r.data; };
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })).newPage();
  await p.goto(process.env.LINK); await p.waitForSelector('#form-card:not([hidden])', { timeout: 30000 });
  await p.fill('#amount', '0.01'); await p.fill('#refund', process.env.REFUND_ADDR);
  await p.click('#create'); await p.waitForSelector('#pay-card:not([hidden])'); if (await p.isVisible('#to-pay')) await p.click('#to-pay'); // design round 2: Continue to pay after the Backup step
  await p.waitForSelector('#qr svg');
  const full = await p.getAttribute('#paylink', 'href');
  const box = await p.locator('#qr svg').boundingBox();
  await p.locator('#qr').screenshot({ path: `${process.env.OUT}/qr-full.png` });
  await p.click('#qr-toggle');
  const light = await p.getAttribute('#paylink', 'href');
  await p.locator('#qr').screenshot({ path: `${process.env.OUT}/qr-light.png` });
  await p.screenshot({ path: `${process.env.OUT}/qr-page.png` });
  console.log('full  :', full.length, 'chars, drawn', Math.round(box.width), 'px, decodes to same link:', dec(`${process.env.OUT}/qr-full.png`) === full);
  console.log('light :', light.length, 'chars, decodes to same link:', dec(`${process.env.OUT}/qr-light.png`) === light, light.startsWith('zcash:utest1'));
  await b.close();
})();
