// A person's own auction result, in one line, on the bid page, the contribute page and the campaign page: "You won. You paid X ZEC, Y ZEC
// came back to your wallet." or "Not won. Y ZEC came back to your wallet." It needs no transaction id from the person: the bids this
// browser holds (their nullifiers, saved by the bid and contribute pages, or restored there from a backup file) are matched with the public
// list once the auction has settled. Every auction type: blind bid (any pricing, void too) and open auction (one price or pay your bid).
import { grpcWeb } from './recount.js';
import { coin } from './public.js';

/** The bids this browser holds for a campaign: `{ nf, paidZat }` for each, from the bid page (`ll:sealed:<id>`) and the contribute page
 *  (`ll:<id>`, and the payment codes it set aside, `ll:<id>:earlier`). Only bids the host listed (they have a ticket) count. */
export function myBids(id) {
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const out = [];
  const add = (s, paid) => { if (s && s.ticket && /^[0-9a-f]{64}$/.test(s.ticket.nf || '') && !out.some((b) => b.nf === s.ticket.nf)) out.push({ nf: s.ticket.nf, paidZat: paid }); };
  const bid = read(`ll:sealed:${id}`);
  if (bid) add(bid, Number(bid.paidZat || bid.tranche) || null);
  const contribute = [read(`ll:${id}`), ...(Array.isArray(read(`ll:${id}:earlier`)) ? read(`ll:${id}:earlier`) : [])];
  for (const s of contribute) if (s) add(s, s.paidZat ?? s.amountZat ?? null);
  return out;
}

/** The result of these bids, or null while it is not final (no close yet, or a winner not settled yet). `c` is the campaign summary
 *  (campaign_summary), `entries` its public list. Each bid: won or not, what it paid, what came back and by which transaction. */
export function auctionResult(c, entries, bids) {
  if (!c || !(c.sealed || c.mode === 'auction') || !bids.length) return null;
  const close = entries.find((e) => e.kind === 'close');
  if (!close || !close.close) return null;
  const listed = (nf) => [...entries].reverse().find((e) => (e.kind === 'issue' || e.kind === 'reissue') && e.contribution && e.contribution.nf === nf);
  const settleOf = (nf) => entries.find((e) => e.kind === 'settle' && e.settle && e.settle.nf === nf);
  const winners = close.close.outcome === 'void' ? [] : close.close.winners || [];
  const payYourBid = !c.sealed && c.pricing !== 'uniform';
  const fee = c.fee_zat || 0;
  const rows = [];
  for (const b of bids) {
    const e = listed(b.nf);
    if (!e) continue; // not a bid on this list (rejected, or another campaign)
    const paid = b.paidZat ?? (e.contribution.value_zat ?? null);
    if (winners.includes(b.nf)) {
      if (payYourBid) { rows.push({ nf: b.nf, won: true, paidZat: paid, backZat: 0, txid: null }); continue; }
      const s = settleOf(b.nf);
      if (!s) return null; // the host is still settling: not final
      rows.push({ nf: b.nf, won: true, paidZat: s.settle.price_zat, backZat: s.settle.excess_zat, txid: s.settle.txid });
    } else {
      if (paid == null) return null;
      // a losing bid comes back minus the fee: a blind bid by the host's signed refund, an open auction's by its own refund ticket
      rows.push({ nf: b.nf, won: false, paidZat: 0, backZat: Math.max(0, paid - fee), txid: c.sealed ? e.refund || null : (e.ticket && e.ticket.txid) || null });
    }
  }
  if (!rows.length) return null;
  const won = rows.filter((r) => r.won);
  return { rows, won: won.length, paidZat: won.reduce((t, r) => t + r.paidZat, 0), backZat: rows.reduce((t, r) => t + r.backZat, 0), items: c.items || 1, void: close.close.outcome === 'void', ticker: c.ticker || '' };
}

/** A blind bid this browser made (`ll:sealed:<id>`, with its memo and seed) for an auction that has settled, whose deposit is nowhere on
 *  the list: no ticket on the list opens with this bid's seed, and no reject or return names its memo. The page never sees the payment
 *  itself (the auction's key is private until after the close), so this says only what the list shows. False whenever a list server does
 *  not give a ticket: then nothing is said rather than something wrong. */
export async function unlistedBid({ c, entries, id, W, relays }) {
  if (!c || !c.sealed || !W || !relays || !relays.length) return false;
  const close = entries.find((e) => e.kind === 'close');
  if (!close || !close.close) return false;
  const winners = close.close.outcome === 'void' ? [] : close.close.winners || [];
  if (!winners.every((nf) => entries.some((e) => e.kind === 'settle' && e.settle && e.settle.nf === nf))) return false;
  let s = null;
  try { s = JSON.parse(localStorage.getItem(`ll:sealed:${id}`)); } catch { return false; }
  if (!s || !s.memo || !s.seed || (s.ticket && s.ticket.nf)) return false;
  const h = W.memo_hash(s.memo);
  if (entries.some((e) => (e.kind === 'reject' || e.kind === 'late_return') && e.blob_hash === h)) return false;
  for (const e of entries.filter((x) => x.kind === 'issue' && x.contribution)) {
    let blob = null;
    for (const r of relays) {
      try { const res = await fetch(`${r}/v1/campaigns/${id}/tickets/${e.contribution.nf}`, { cache: 'no-store' }); if (res.ok) { blob = new Uint8Array(await res.arrayBuffer()); break; } } catch { /* the next list server */ }
    }
    if (!blob) return false;
    if (W.blob_is_mine(s.seed, blob)) return false;
  }
  return true;
}

/** Whether every transaction that brings money back is mined: true, false (at least one is not yet), or null (no server answered). */
export async function backArrived(W, servers, txids) {
  const ids = txids.filter(Boolean);
  if (!ids.length) return true;
  for (const s of servers) {
    try {
      let all = true;
      for (const t of ids) {
        const [raw] = await grpcWeb(s, 'GetTransaction', W.tx_filter_request(t));
        let h = null;
        for (let i = 0; raw && i < raw.length;) { // RawTransaction: data (1), height (2)
          let key = 0, sh = 0, x; do { x = raw[i++]; key |= (x & 0x7f) << sh; sh += 7; } while (x & 0x80);
          if ((key & 7) === 2) { let n = 0, s2 = 0; do { x = raw[i++]; n |= (x & 0x7f) << s2; s2 += 7; } while (x & 0x80); i += n; continue; }
          let v = 0, m = 1; do { x = raw[i++]; v += (x & 0x7f) * m; m *= 128; } while (x & 0x80);
          if (key >>> 3 === 2) h = v;
        }
        if (!(h > 0 && h < 0xffffffff)) all = false;
      }
      return all;
    } catch { /* the next server */ }
  }
  return null;
}

/** The one line. `arrived`: true says "came back", anything else "is coming back". */
export function resultLine(r, arrived) {
  const t = r.ticker, back = arrived === true ? 'came back to your wallet' : 'is coming back to your wallet';
  if (!r.won) return `Not won. ${coin(r.backZat)} ${t} ${back}.`;
  const what = r.items > 1 ? `You won ${r.won} ${r.won === 1 ? 'item' : 'items'}.` : 'You won.';
  return r.backZat > 0 ? `${what} You paid ${coin(r.paidZat)} ${t}, ${coin(r.backZat)} ${t} ${back}.` : `${what} You paid ${coin(r.paidZat)} ${t}.`;
}

/** Draws the line and its "more" into `box` (hidden when there is nothing final to say). Returns the nullifiers of this browser's bids,
 *  for the public list's "Yours" mark. */
export async function showResult(box, { c, entries, id, W, servers, relays, recount }) {
  const bids = myBids(id);
  const r = auctionResult(c, entries, bids);
  box.hidden = !r;
  if (!r) {
    // a bid made in this browser with no deposit on the settled list: one line, and where to compare with the wallet
    if (await unlistedBid({ c, entries, id, W, relays }).catch(() => false)) {
      const line = Object.assign(document.createElement('p'), { className: 'my-result-line', id: 'my-result-line', textContent: 'This browser made a bid for this auction, but no deposit with its message is on the list. If you paid without the memo, it counts as a donation.' });
      const more = document.createElement('details'); more.className = 'my-result-more';
      const sum = Object.assign(document.createElement('summary'), { textContent: 'more' });
      const note = Object.assign(document.createElement('p'), { textContent: 'The recount page lists the payments that had no message, with their transaction ids, so you can compare them with your wallet. ' });
      if (recount) note.append(Object.assign(document.createElement('a'), { href: recount, textContent: 'Open the recount' }));
      more.append(sum, note);
      box.replaceChildren(line, more);
      box.hidden = false;
    }
    return new Set(bids.map((b) => b.nf));
  }
  const arrived = W ? await backArrived(W, servers || [], r.rows.map((x) => x.txid)).catch(() => null) : null;
  const line = document.createElement('p'); line.className = 'my-result-line'; line.id = 'my-result-line'; line.textContent = resultLine(r, arrived);
  const more = document.createElement('details'); more.className = 'my-result-more';
  const sum = document.createElement('summary'); sum.textContent = 'more';
  const ul = document.createElement('ul');
  for (const x of r.rows) {
    const li = document.createElement('li');
    li.textContent = `Bid ${x.nf.slice(0, 8)}…: ${x.won ? `won, paid ${coin(x.paidZat)} ${r.ticker}` : 'not won'}${x.backZat > 0 ? `, ${coin(x.backZat)} ${r.ticker} back` : ''}${x.txid ? ` in transaction ${x.txid.slice(0, 8)}…${x.txid.slice(-5)}` : ''}.`;
    if (x.txid) li.title = x.txid;
    ul.append(li);
  }
  const note = document.createElement('p');
  note.textContent = r.void ? 'The auction was void: no bid counts, every deposit goes back minus the network fee.'
    : 'Matched by this browser\'s own bids in the public list. What came back is minus the network fee.';
  more.append(sum, ul, note);
  box.replaceChildren(line, more);
  box.hidden = false;
  return new Set(bids.map((b) => b.nf));
}
