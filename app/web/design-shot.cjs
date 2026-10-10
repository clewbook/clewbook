// Screenshots a page at phone and desktop widths into runs/design-shots/. Usage: node design-shot.cjs <url> <name> [selector-to-click ...]
const { chromium } = require('./../vectors/js/node_modules/playwright');
(async () => {
  const [url, name] = process.argv.slice(2);
  const browser = await chromium.launch();
  const bad = [];
  for (const [w, h, tag] of [[390, 844, '390'], [1280, 900, '1280']]) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    page.on('pageerror', (e) => bad.push(String(e)));
    page.on('request', (r) => { if (!/^(http:\/\/127\.0\.0\.1|data:|blob:)/.test(r.url()) && !/zec\.rocks|chainsafe\.dev/.test(r.url())) bad.push('EXTERNAL ' + r.url()); });
    await page.goto(url); await page.waitForTimeout(1500);
    if (await page.$('#verdict')) await page.waitForFunction(() => document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 300000 });
    if (await page.$('#links')) await page.waitForSelector('#links:not([hidden])', { timeout: 60000 });
    if (await page.$('#live')) { await page.waitForSelector('#live:not([hidden])', { timeout: 60000 }); await page.waitForTimeout(4000); }
    await page.waitForTimeout(500);
    await page.screenshot({ path: `runs/design-shots/${name}-${tag}.png`, fullPage: true });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    console.log(`${name}-${tag}: horizontal overflow ${wide}`);
    await page.close();
  }
  console.log(bad.length ? 'PROBLEMS ' + bad.join(' | ') : 'no errors, no outside requests');
  await browser.close();
})();
