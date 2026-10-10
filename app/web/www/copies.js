// Copies of a campaign's list that a person keeps, and what this browser remembers of it. Everything here only reads: it never sends anything anywhere.
//  * buildCopy / downloadCopy: the full list as the file the saved-copy recount reads (kind "ledger-export"), with the host's signed fingerprint record if one exists.
//  * memory: for each campaign the browser keeps the number of entries and the hash of the last entry it saw; a later list is checked against it.
//  * compareLists: a saved copy against the current list: entries missing, extra or changed, in plain words.
import * as W from './pkg/ll_web.js';

// ---------- the file ----------
export function buildCopy({ rulesText, id, entries, finalText, challenges }) {
  let final = null;
  try { final = finalText ? JSON.parse(finalText) : null; } catch { final = null; }
  return {
    kind: 'ledger-export', version: 1, campaign: id, rules: JSON.parse(rulesText), ledger: entries, challenges: challenges || [], final,
    savedAt: new Date().toISOString(),
    note: 'A copy of the full public list of this campaign, saved by a person. It holds no key and nothing private.',
  };
}

export function downloadCopy(copy) {
  const blob = new Blob([JSON.stringify(copy)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `campaign-${copy.campaign.slice(0, 8)}-list-${copy.ledger.length}-entries.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** The host's final record from the relays (the one covering the most entries), or ''. */
export async function fetchFinal(relays, id) {
  let best = null;
  await Promise.all(relays.map(async (u) => {
    try {
      const res = await fetch(`${u}/v1/campaigns/${id}/final`, { cache: 'no-store' });
      const text = await res.text();
      if (!res.ok) return;
      const n = JSON.parse(text).entries || 0;
      if (!best || n > best.n) best = { n, text };
    } catch { /* none from this relay */ }
  }));
  return best ? best.text : '';
}

// ---------- what this browser remembers ----------
const KEY = (id) => `cb:seen:${id}`;
function store() { try { const s = window.localStorage; const k = '__cb_probe__'; s.setItem(k, '1'); s.removeItem(k); return s; } catch { return null; } }

/** Compares a list's entry hashes with what was remembered. Returns {state, ...}: blocked | first | same | grew | cut_off | changed. Does not write. */
export function checkMemory(id, hashes) {
  const s = store();
  if (!s) return { state: 'blocked' };
  let m = null;
  try { m = JSON.parse(s.getItem(KEY(id))); } catch { m = null; }
  if (!m || typeof m.count !== 'number') return { state: 'first', count: hashes.length };
  const at = m.at ? new Date(m.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'an earlier visit';
  if (hashes.length < m.count) return { state: 'cut_off', was: m.count, now: hashes.length, at };
  if (hashes[m.count - 1] !== m.last && m.count > 0) return { state: 'changed', position: m.count - 1, was: m.count, now: hashes.length, at };
  return hashes.length === m.count ? { state: 'same', count: m.count, at } : { state: 'grew', was: m.count, now: hashes.length, at };
}

/** Remembers a list (only call it for a list that passed the checks). Returns false when the browser will not store it. */
export function remember(id, hashes) {
  const s = store();
  if (!s) return false;
  try { s.setItem(KEY(id), JSON.stringify({ count: hashes.length, last: hashes.length ? hashes[hashes.length - 1] : '', at: Date.now() })); return true; } catch { return false; }
}
export function forget(id) { const s = store(); if (s) try { s.removeItem(KEY(id)); } catch { /* ignore */ } }

/** The words for a memory check. kind: 'hint' | 'warn' | 'bad'. */
export function memoryWords(r) {
  // one short sentence each (the page copy rules): what happened, and what to do when something is wrong
  const n = (k) => `${k} ${k === 1 ? 'entry' : 'entries'}`;
  switch (r.state) {
    case 'blocked': return { kind: 'warn', text: 'This browser cannot remember this list, so save a copy to compare later.' };
    case 'first': return { kind: 'hint', text: `This browser will remember this list (${n(r.count)}) to compare next time.` };
    case 'same': return { kind: 'hint', text: `The same list as on your last visit (${n(r.count)}, seen ${r.at}).` };
    case 'grew': return { kind: 'hint', text: `${r.now - r.was} new ${r.now - r.was === 1 ? 'entry' : 'entries'} since your last visit (${r.at}); nothing you saw before changed.` };
    case 'cut_off': return { kind: 'bad', text: `This list is shorter than on ${r.at}: ${r.was} entries then, ${r.now} now; compare a saved copy.` };
    case 'changed': return { kind: 'bad', text: `Entry ${r.position + 1} differs from what you saw on ${r.at}; compare a saved copy.` };
    default: return null;
  }
}

// ---------- a saved copy against the current list ----------
/** Two lists, as arrays of entries and of their hashes. Entries are matched by position (their number in the chain). */
export function compareLists(saved, savedHashes, current, currentHashes) {
  const missing = [], changed = [], extra = [];
  const n = Math.max(saved.length, current.length);
  for (let i = 0; i < n; i++) {
    if (i >= current.length) missing.push(i);
    else if (i >= saved.length) extra.push(i);
    else if (savedHashes[i] !== currentHashes[i]) changed.push(i);
  }
  return { missing, changed, extra, savedCount: saved.length, currentCount: current.length };
}

const ranges = (xs) => {
  const out = [];
  for (let i = 0; i < xs.length;) { let j = i; while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++; out.push(i === j ? `${xs[i] + 1}` : `${xs[i] + 1} to ${xs[j] + 1}`); i = j + 1; }
  return out.length > 6 ? `${out.slice(0, 6).join(', ')} and ${out.length - 6} more places` : out.join(', ');
};

/** Plain sentences for a comparison; `saved` and `current` are the entry arrays (for the kinds). */
export function describeComparison(c, saved, current) {
  const lines = [];
  const count = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;
  lines.push(`Your saved copy has ${count(c.savedCount)}; the current list has ${count(c.currentCount)}.`);
  if (!c.missing.length && !c.changed.length && !c.extra.length) { lines.push('They are identical.'); return { lines, same: true }; }
  if (c.missing.length) lines.push(`Missing from the current list: ${count(c.missing.length)} that you have (number ${ranges(c.missing)}; ${[...new Set(c.missing.map((i) => saved[i].kind))].join(', ')}). They were in the list when you saved your copy and are not in it now.`);
  if (c.changed.length) lines.push(`Changed: ${count(c.changed.length)} at number ${ranges(c.changed)} are different from the ones in your copy (yours: ${[...new Set(c.changed.map((i) => saved[i].kind))].join(', ')}; now: ${[...new Set(c.changed.map((i) => current[i].kind))].join(', ')}). The two lists do not tell the same story from that place on.`);
  if (c.extra.length) lines.push(`Extra in the current list: ${count(c.extra.length)} that your copy does not have (number ${ranges(c.extra)}; ${[...new Set(c.extra.map((i) => current[i].kind))].join(', ')}). That is normal if they came after you saved your copy.`);
  return { lines, same: false };
}

export function hashesOf(entries) { return JSON.parse(W.list_hashes(JSON.stringify(entries))); }
