// Says so when a page cannot finish loading. Every page loads this small plain script first, and its own scripts after. The page's scripts mark the
// page as "started" (they all loaded and ran) and "ready" (the first answer from the campaign's servers has arrived). If that has not happened after
// 20 seconds, a message appears with a Reload button; it disappears by itself if the page becomes ready later. Add ?lg=3 to the address to try it fast.
(function () {
  var d = document.documentElement;
  var secs = Math.max(2, Number(new URLSearchParams(location.search).get('lg')) || 20);
  var shown = null;
  function say(kind) {
    var text = kind === 'load'
      ? 'This page could not load all of its files. Your connection, or the address this page is served from, may be down for the moment. Nothing was sent or changed.'
      : "This is taking longer than usual. The servers this page asks have not answered yet. The page keeps trying; nothing was sent or changed.";
    if (!shown) {
      shown = document.createElement('div');
      shown.id = 'loadguard'; shown.setAttribute('role', 'alert'); shown.className = 'notice bad';
      shown.style.cssText = 'margin:16px;max-width:60rem';
      var p = document.createElement('p'); p.id = 'loadguard-text'; shown.appendChild(p);
      var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Reload'; b.style.marginTop = '8px';
      b.onclick = function () { location.reload(); }; shown.appendChild(b);
      (document.body || d).insertBefore(shown, (document.body || d).firstChild);
    }
    shown.querySelector('#loadguard-text').textContent = text;
    shown.dataset.kind = kind;
  }
  setTimeout(function check() {
    if (d.dataset.ready === '1') return;
    say(d.dataset.started === '1' ? 'wait' : 'load');
    var t = setInterval(function () { if (d.dataset.ready === '1' && shown) { shown.remove(); shown = null; clearInterval(t); } }, 1000);
  }, secs * 1000);
})();
