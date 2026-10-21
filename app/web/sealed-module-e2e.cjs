// The sealed bid auction functions of the browser module (app/web/src/sealed.rs), run in a real browser against a fixture from the private
// regtest chain (app/web/testdata/sealed-late.json: auction N of app/regtest/check-sealed-close.sh, first payer; throwaway keys).
// The late ticket opens, checks (refund output, lock, coin, signatures), its anchor is the chain's note tree root at the stated height,
// its proof verifies in the proof module, and it signs; every altered expectation is refused. The bid payment and the coin finder work,
// and the payment refuses bids the auction would not count. Plain files from app/web/www on a spare port; no chain server, no relay,
// no money. Run from the repository root: node app/web/sealed-module-e2e.cjs (env PORT, default 8811).
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const PORT = process.env.PORT || '8811', BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const F = JSON.parse(fs.readFileSync('app/web/testdata/sealed-late.json', 'utf8'));

// RawTransaction { data = 1 (bytes), height = 2 (uint64) } as protobuf bytes, the way a light wallet server answers GetTransaction
function varint(n) { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return out; }
function rawTxProto(hex, height) {
  const data = Buffer.from(hex, 'hex');
  return [0x0a, ...varint(data.length), ...data, 0x10, ...varint(height)];
}

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', 'app/web/www'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
  let browser;
  try {
    browser = await chromium.launch();
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${BASE}/brand.js`);
    const out = await p.evaluate(async ({ F, coinProto }) => {
      const W = await import('/pkg/ll_web.js');
      await W.default();
      const r = {};
      const tryIt = (f) => { try { return { ok: true, v: f() }; } catch (e) { return { ok: false, e: String(e.message || e) }; } };
      const blob = Uint8Array.from(F.blob_hex.match(/../g).map((h) => parseInt(h, 16)));
      const entry = JSON.stringify(F.coin_entry);
      r.pageKey = W.page_key_hex(F.seed_hex);
      r.opened = JSON.parse(W.open_late(F.seed_hex, entry, blob));
      r.wrongSeed = tryIt(() => W.open_late('11'.repeat(32), entry, blob));
      const e = {
        deposit_nf: F.coin_entry.coin.nf, coin_txid: F.coin_entry.coin.txid, coin_index: F.coin_entry.coin.index, coin_value_zat: F.coin_entry.coin.value_zat,
        lock_time: F.rules.sealed.claim_after, refund_address: F.refund_address, refund_zat: F.paid_zat - F.rules.refund_fee_zat, deposit_zat: F.paid_zat,
        current_branch: '77190ad9',
      };
      const chk = (x) => tryIt(() => JSON.parse(W.check_late(F.seed_hex, r.opened.raw_hex, r.opened.ovk_hex, JSON.stringify(x))));
      r.good = chk(e);
      const t = F.ironwood_trees[String(r.opened.anchor_height)];
      r.root = t ? W.ironwood_root_hex(t.state) : null;
      r.bad = {
        lock: chk({ ...e, lock_time: e.lock_time + 1 }),
        refund: chk({ ...e, refund_zat: e.refund_zat + 1 }),
        deposit_l1: chk({ ...e, deposit_zat: e.deposit_zat - 1000 }),
        coin_index: chk({ ...e, coin_index: e.coin_index + 1 }),
        coin_value: chk({ ...e, coin_value_zat: e.coin_value_zat + 1 }),
        deposit: chk({ ...e, deposit_nf: '00'.repeat(32) }),
      };
      // a damaged binding signature (the last 64 bytes of a version 6 transaction with an Ironwood part)
      const raw = r.opened.raw_hex;
      const flipped = raw.slice(0, raw.length - 2) + (raw.slice(-2) === '00' ? '01' : '00');
      r.badSig = tryIt(() => W.check_late(F.seed_hex, flipped, r.opened.ovk_hex, JSON.stringify(e)));
      r.signed = tryIt(() => W.sign_late(F.seed_hex, raw, JSON.stringify(e)));
      r.signWrongKey = tryIt(() => W.sign_late('22'.repeat(32), raw, JSON.stringify(e)));
      r.coin = JSON.parse(W.find_coin(Uint8Array.from(coinProto), r.pageKey));
      r.otherCoin = JSON.parse(W.find_coin(Uint8Array.from(coinProto), '02' + '33'.repeat(32)));
      // the proof, in the proof module
      const P = await import('/proof/ll_proofcheck.js');
      await P.default();
      r.proof = new P.Checker().verify(raw, '77190ad9');
      // the bid payment
      const rules = JSON.stringify(F.rules);
      const seed = W.generate_seed();
      r.pay = tryIt(() => JSON.parse(W.sealed_bid_payment(rules, seed, F.refund_address, 10000000, 7000000)));
      // M1: on the test and main networks the page refuses a round or a late ticket block far later than the plan for the deadline gives
      {
        const t = JSON.parse(rules); t.network = 'test';
        const at = 1692803367 + (t.sealed.drand_round - 1) * 3; // the round's own time: the plan from then needs a later round, so this one is not too late
        r.planOk = JSON.parse(W.sealed_plan_check(JSON.stringify(t), at));
        r.planLate = JSON.parse(W.sealed_plan_check(JSON.stringify({ ...t, sealed: { ...t.sealed, claim_after: t.sealed.claim_after + 1300000 } }), at));
        r.planRound = JSON.parse(W.sealed_plan_check(JSON.stringify({ ...t, sealed: { ...t.sealed, drand_round: t.sealed.drand_round + 28800 } }), at));
      }
      // M4: an auction made with the long tag gets the bound kind of memo, exactly 512 bytes
      { const lt = JSON.parse(rules); lt.sealed.long_tag = true; r.payLong = tryIt(() => JSON.parse(W.sealed_bid_payment(JSON.stringify(lt), seed, F.refund_address, 10000000, 7000000))); }
      r.payTooHigh = tryIt(() => W.sealed_bid_payment(rules, seed, F.refund_address, 10000000, 9995000));
      r.payNoTranche = tryIt(() => W.sealed_bid_payment(rules, seed, F.refund_address, 20000000, 7000000));
      r.payBelowReserve = tryIt(() => W.sealed_bid_payment(rules, seed, F.refund_address, 10000000, 500000));
      r.windowLate = JSON.parse(W.sealed_bid_window(rules, F.rules.deadline_height - 5, 1800000000));
      return r;
    }, { F, coinProto: rawTxProto(F.coin_tx.hex, F.coin_tx.height) });

    check('the late ticket opens with the payer\'s secret and is the one the list names', out.opened.txid === F.coin_entry.late, out.opened.txid);
    check('another secret cannot open it', !out.wrongSeed.ok, out.wrongSeed.e);
    check('the honest late ticket passes every check', out.good.ok && out.good.v.txid === F.coin_entry.late, out.good.ok ? '' : out.good.e);
    check('its anchor is the chain\'s Ironwood note tree root at the stated height', out.good.ok && out.root === out.good.v.anchor_hex, `height ${out.opened.anchor_height}`);
    for (const [k, v] of Object.entries(out.bad)) check(`an altered expectation is refused: ${k}`, !v.ok, v.e ? v.e.slice(0, 110) : '');
    check('a damaged signature is refused', !out.badSig.ok, out.badSig.e ? out.badSig.e.slice(0, 110) : '');
    check('its proof verifies in the proof module', out.proof === true);
    check('the page signs its coin input', out.signed.ok && out.signed.v.length > out.opened.raw_hex.length + 200, out.signed.ok ? `${out.opened.raw_hex.length / 2} -> ${out.signed.v.length / 2} bytes` : out.signed.e);
    check('a key that is not the coin\'s cannot sign', !out.signWrongKey.ok, out.signWrongKey.e);
    check('the coin is found at the page\'s address', out.coin && out.coin.index === F.coin_entry.coin.index && out.coin.value_zat === 5000 && out.coin.height === F.coin_tx.height, JSON.stringify(out.coin));
    check('another key finds no coin', out.otherCoin === null);
    check('M1: the honest round and late ticket block pass the page\'s timing check', out.planOk.ok, out.planOk.reason || '');
    check('M1: a late ticket block a year after the plan is refused', !out.planLate.ok && /late tickets work later/.test(out.planLate.reason), out.planLate.reason || '');
    check('M1: a round a day after the plan is refused', !out.planRound.ok && /the bids open later/.test(out.planRound.reason), out.planRound.reason || '');
    check('M4: with the long tag the memo is the bound kind and exactly fills 512 bytes', out.payLong.ok && out.payLong.v.memo.startsWith('LL3:') && Buffer.byteLength(out.payLong.v.memo) === 512, out.payLong.ok ? `${out.payLong.v.memo.length} characters` : out.payLong.e);
    check('a bid payment: memo version 3 within 512 bytes, paying the tranche', out.pay.ok && out.pay.v.memo.startsWith('LL3:') && out.pay.v.memo.length <= 512 && out.pay.v.amount_zat === 10000000, out.pay.ok ? `${out.pay.v.memo.length} characters` : out.pay.e);
    check('a bid above the tranche minus the fee is refused', !out.payTooHigh.ok, out.payTooHigh.e);
    check('a deposit size that is not a tranche is refused', !out.payNoTranche.ok, out.payNoTranche.e);
    check('a bid below the reserve is refused', !out.payBelowReserve.ok, out.payBelowReserve.e);
    check('no new deposit in the last blocks before the deadline', out.windowLate.ok === false, out.windowLate.reason);
  } catch (e) {
    check('run', false, String(e));
  } finally {
    if (browser) await browser.close();
    srv.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
