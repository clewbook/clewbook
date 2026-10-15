// A junk ticket must give the right red notice and never be shown as received and checked.
// Args: mode=backupfile ...  Env: LINK, SHOTS
const { chromium } = require('./../vectors/js/node_modules/playwright');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const txt = async (p, s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();
const parts = (s) => { const [ck, nck = ''] = s.split('Not checked:'); return [ck, nck]; }; // the ticket checks: one per line, then "Not checked:" and those lines
const EXPECT = {
  badsig: /its signatures are valid/, wrongversion: /it is for the network version in use now.*must re-issue it/,
  payshost: /it pays you/, badproof: /its proof does not verify/, mismatch: /it pays you/, spent: /not used by anything else.*already spent/, othercoin: /it spends your contribution/,
};
// a server that claims the network now runs another version (gRPC-web LightdInfo: consensus_branch_id = field 6, block_height = field 7)
function fakeLightdInfo() {
  const branch = Buffer.from('deadbeef');
  const msg = Buffer.concat([Buffer.from([0x32, branch.length]), branch, Buffer.from([0x38, 0xc0, 0xa7, 0xb4, 0x02])]);
  const head = Buffer.alloc(5); head.writeUInt32BE(msg.length, 1);
  const trailer = Buffer.from('grpc-status:0\r\n'); const th = Buffer.alloc(5); th[0] = 0x80; th.writeUInt32BE(trailer.length, 1);
  return Buffer.concat([head, msg, th, trailer]);
}
(async () => {
  const browser = await chromium.launch();
  for (const arg of process.argv.slice(2)) {
    const [mode, file] = arg.split('=');
    const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    if (mode === 'wrongversion') await page.route('**/*CompactTxStreamer/GetLightdInfo', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'application/grpc-web+proto', 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' }, body: fakeLightdInfo() }));
    await page.goto(process.env.LINK);
    await page.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    await page.setInputFiles('#restore', file);
    if (mode === 'proof' || mode === 'cancel' || mode === 'badproof') {
      // level 3: the proof is checked only when asked, in the background, and can be cancelled
      await page.waitForFunction(() => /passed the checks below/.test(document.querySelector('#s-ticket').textContent), null, { timeout: 240000 });
      check(`${mode}: before pressing, the proof is listed as not checked, with no red notice`, /(^|\.)\s?The proof\./.test(parts(await txt(page, '#tc-summary'))[1]) && await page.isHidden('#tc-bad'), (await txt(page, '#tc-summary')).slice(-160));
      check(`${mode}: the button "Check the proof too" is offered`, await page.isVisible('#proof-btn'));
      const before = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /ll_proofcheck/.test(r.name)).length);
      check(`${mode}: the proof checker is NOT downloaded before the button is pressed`, before === 0);
      await page.click('#proof-btn');
      await page.waitForSelector('#proof-progress:not([hidden])', { timeout: 10000 });
      check(`${mode}: a progress message and a cancel button appear`, (await txt(page, '#proof-progress')).length > 0 && await page.isVisible('#proof-cancel'), await txt(page, '#proof-progress'));
      if (mode === 'cancel') {
        await page.waitForTimeout(1500);
        await page.click('#proof-cancel');
        check('cancel: it says it stopped and the proof stays "not checked"', /Stopped/.test(await txt(page, '#proof-progress')) && /(^|\.)\s?The proof\./.test(parts(await txt(page, '#tc-summary'))[1]));
        check('cancel: the button is offered again and no red notice appeared', await page.isVisible('#proof-btn') && await page.isHidden('#tc-bad'));
        continue;
      }
      if (mode === 'proof') {
        await page.waitForFunction(() => /(^|\.)\s?The proof is valid\./.test(document.querySelector('#tc-summary').textContent.replace(/\s+/g, ' ').split('Not checked:')[0]), null, { timeout: 300000 });
        check('proof: after a pass it says "Checked: the proof is valid" and the proof is no longer listed as not checked', !/(^|\.)\s?The proof\./.test(parts(await txt(page, '#tc-summary'))[1]) && await page.isHidden('#tc-bad') && await page.isHidden('#proof-btn'), (await txt(page, '#tc-summary')).slice(0, 400));
        const after = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /ll_proofcheck/.test(r.name)).map((r) => ({ name: r.name.split('/').pop(), bytes: r.transferSize || r.encodedBodySize })));
        console.log('proof module loaded only now:', JSON.stringify(after));
        await page.screenshot({ path: `${process.env.SHOTS || 'runs/page/shots'}/63-proof-valid.png`, fullPage: true });
        continue;
      }
      // badproof: the red notice only appears after the proof is checked
      await page.waitForSelector('#tc-bad:not([hidden])', { timeout: 300000 });
      const bad = await txt(page, '#tc-bad');
      check('badproof: the notice says plainly that the proof does not verify (and never "the proof is valid")', /did not pass a check: its proof does not verify\./.test(bad) && !/the proof is valid/.test(bad), bad.slice(0, 200));
      check('badproof: never shown as received and checked', /did NOT pass a check/.test(await txt(page, '#s-ticket')));
      await page.screenshot({ path: `${process.env.SHOTS || 'runs/page/shots'}/64-badproof.png`, fullPage: true });
      continue;
    }
    if (mode === 'oldformat') {
      // issued in the old format: passes its other checks, says plainly that "that it pays you" was not checked, never a failure
      await page.waitForFunction(() => /passed the checks below/.test(document.querySelector('#s-ticket').textContent), null, { timeout: 240000 });
      const sum = await txt(page, '#tc-summary');
      check('oldformat: no red notice, passes its other checks', await page.isHidden('#tc-bad'));
      check('oldformat: says "Not checked: that it pays you" (never a failure, never "it pays you" as checked)', /That it pays you/.test(parts(sum)[1]) && !/(^|\.)\s?It pays you \(/.test(parts(sum)[0]), sum.slice(0, 300));
      await page.screenshot({ path: `${process.env.SHOTS || 'runs/page/shots'}/62-oldformat.png`, fullPage: true });
      continue;
    }
    if (mode === 'spent' || mode === 'othercoin') {
      // wait for the page to have found and passed the good ticket, then change what the page believes and look again
      await page.waitForFunction(() => /passed the checks below/.test(document.querySelector('#s-ticket').textContent), null, { timeout: 240000 });
      await page.evaluate((m) => {
        const k = Object.keys(localStorage).find((x) => /^ll:[0-9a-f]{64}$/.test(x));
        const st = JSON.parse(localStorage.getItem(k));
        if (m === 'spent') st.coin = { scanned: 99999999, spent: { txid: 'ab'.repeat(32), height: 4470000 } };
        else { st.ticket.nf = 'cd'.repeat(32); st.ticket.entry.contribution.nf = 'cd'.repeat(32); }
        localStorage.setItem(k, JSON.stringify(st));
      }, mode);
      await page.reload();
    }
    if (mode === 'good') {
      await page.waitForFunction(() => /passed the checks below/.test(document.querySelector('#s-ticket').textContent), null, { timeout: 240000 });
      const sum = await txt(page, '#tc-summary');
      check('good: a valid ticket is shown as passing the listed checks, with no red notice', await page.isHidden('#tc-bad'));
      check('good: a version 2 ticket lists "it pays you" as checked, and still lists the proof and the anchor as not checked', /Its signatures are valid\..*It pays you \(its refund output pays the address you gave\)\./.test(parts(sum)[0]) && /The proof\..*Its chain state\./.test(parts(sum)[1]) && !/That it pays you/.test(parts(sum)[1]), sum.slice(0, 300));
      await page.screenshot({ path: `${process.env.SHOTS || 'runs/page/shots'}/61-good.png`, fullPage: true });
      continue;
    }
    await page.waitForSelector('#tc-bad:not([hidden])', { timeout: 240000 }).catch(() => {});
    await page.waitForTimeout(500);
    const bad = await txt(page, '#tc-bad');
    check(`${mode}: a red notice names the failed check`, (await page.isVisible('#tc-bad')) && /did not pass a check/.test(bad) && EXPECT[mode].test(bad), bad.slice(0, 200));
    check(`${mode}: never shown as received and checked`, !(await page.evaluate(() => document.querySelector('#s-ticket').classList.contains('done'))) && /did NOT pass a check/.test(await txt(page, '#s-ticket')), await txt(page, '#s-ticket'));
    check(`${mode}: the progress note says so plainly`, /did not pass a check/.test(await txt(page, '#progress-note')));
    check(`${mode}: no errors in the browser console`, errors.length === 0, errors.join(' | ').slice(0, 160));
    await page.screenshot({ path: `${process.env.SHOTS || 'runs/page/shots'}/60-junk-${mode}.png`, fullPage: true });
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
