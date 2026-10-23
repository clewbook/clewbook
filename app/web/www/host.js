// The host page is plain text; this gives it the shared look's brand name, shows each card's NEW tag until its date, and tells the load guard
// that it started.
import { setup, markReady } from './ui.js';

// The NEW tags, one place: each shows through the end of its day (UTC), then it is gone. The tags are hidden in the page itself, so a page
// that cannot run this never shows an old one. Hard cap: shipped 14 Oct 2026, one month. Blind bid auction: live on mainnet, to 23 Nov 2026.
const NEW_UNTIL = { 'hard-cap': '2026-11-14', 'blind-bid': '2026-11-23' };

export function showNewTags(now = Date.now()) {
  for (const el of document.querySelectorAll('.hbadge.new[data-new]')) {
    const until = NEW_UNTIL[el.dataset.new];
    el.hidden = !until || now >= Date.parse(`${until}T00:00:00Z`) + 86_400_000;
  }
}

setup('Host', { netbar: false });
showNewTags();
markReady();
