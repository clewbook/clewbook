// Level 4: a ticket's chain state (anchor) must be the Ironwood note tree root of a real block, or the network refuses the ticket. The
// anchor is read from the ticket's own transaction; the block is not stated anywhere, so the page looks for it from the block the payment
// was mined in (the tree must hold the payment) up to the chain's tip, starting at the block the ticket was issued at and going down, then
// up. Every block is asked of each chain server. The answer is given only when it is sure:
//   { seen: 'found', height, servers }  the root of that block, said by every server that answered it (servers: how many);
//   { seen: 'absent', from, to }        no block in the whole range has it, and every server answered every block with the same root;
//   null                                anything else (a server did not answer, the servers disagree, more than `max` blocks, or the
//                                       anchor could not be read from the ticket): not checked.
import { grpcWeb } from './recount.js';

const ask = (W, server, h) => Promise.race([
  grpcWeb(server, 'GetTreeState', W.tree_state_request(h)).then((m) => (m[0] ? W.ironwood_root(m[0]) : undefined)),
  new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 20000)),
]).catch(() => undefined);

export async function findAnchor(W, servers, anchorOf, from, issued, tip, max = 300) {
  if (from == null || tip == null || from > tip || !servers.length) return null;
  let anchorHex;
  try { anchorHex = anchorOf(); } catch { return null; } // a ticket whose anchor cannot be read: not checked here (its other checks say why)
  const start = Math.min(Math.max(issued ?? tip, from), tip);
  const order = [];
  for (let h = start; h >= from && order.length < max; h--) order.push(h);
  for (let h = start + 1; h <= tip && order.length < max; h++) order.push(h);
  let sure = order.length === tip - from + 1;
  for (const h of order) {
    const roots = await Promise.all(servers.map((s) => ask(W, s, h)));
    const got = roots.filter((r) => r !== undefined);
    if (got.length < servers.length) sure = false;
    if (new Set(got).size > 1) { sure = false; continue; }
    if (got.length && got[0] === anchorHex) return { seen: 'found', height: h, servers: got.length };
  }
  return sure ? { seen: 'absent', from, to: tip } : null;
}
