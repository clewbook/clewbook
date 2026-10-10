// Opens the recount page in headless Chromium for each bundle and endpoint, and compares
// the page's report with the CLI output stored in the bundle.
// Usage: node browser-check.cjs <page base url> <name>... (Playwright from app/vectors/js)
const { chromium } = require('../vectors/js/node_modules/playwright');
const fs = require('fs');
const ENDPOINTS = ['https://zjs.zec.rocks/testnet', 'https://zcash-testnet.chainsafe.dev', 'http://127.0.0.1:8799,https://zjs.zec.rocks/testnet'];
(async () => {
  const [page_base, ...names] = process.argv.slice(2);
  const browser = await chromium.launch();
  console.log('browser:', browser.version());
  let ok = true;
  for (const name of names) {
    const expected = JSON.parse(fs.readFileSync(`www/bundles/${name}.json`)).expected;
    for (const ep of ENDPOINTS) {
      const page = await browser.newPage();
      const errors = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      const t0 = Date.now();
      await page.goto(`${page_base}/recount-bundle.html?campaign=${name}${ep.split(',').map((e) => '&endpoint=' + encodeURIComponent(e)).join('')}`);
      await page.waitForSelector('#out[data-done]', { timeout: 300000 });
      const report = await page.textContent('#out');
      const stats = await page.getAttribute('#out', 'data-stats');
      const events = await page.getAttribute('#out', 'data-events');
      const same = report === expected;
      ok &&= same;
      console.log(`== ${name} via ${ep}: ${same ? 'IDENTICAL to CLI' : 'DIFFERENT'} in ${Date.now() - t0} ms`, stats ?? '', events && events !== '[]' ? '\n   failover: ' + events : '', errors.join(' | '));
      if (!same) console.log(report);
      await page.close();
    }
  }
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
