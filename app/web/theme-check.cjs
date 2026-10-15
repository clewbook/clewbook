// Static check of the Theme control (no browser, no network): every page we ship carries the same small theme script at the top of its head
// (before any stylesheet, so there is no flash), the page server and the hosted copy allow exactly that inline script by its hash, and every
// page mounts the control (Light, Dark) through ui.js, except the badge, which is shown inside other sites and only follows the theme.
// Usage: node app/web/theme-check.cjs [built static folder, for the demo pages too]      Exit status 1 when a check fails.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const WWW = path.join(__dirname, 'www');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const SNIP_RE = /<script>(\(function\(\)\{var c='system';try\{c=localStorage\.getItem\('cb-theme'\)[^<]*)<\/script>/;
const hash = (body) => `sha256-${crypto.createHash('sha256').update(body).digest('base64')}`;

// the pages: the page server's list, the dashboard's two pages, and the demo pages of a built static folder
const serve = fs.readFileSync(path.join(__dirname, 'serve.py'), 'utf8');
const pages = [...serve.match(/PAGES = \{([^}]*)\}/)[1].matchAll(/"([^"]+)"/g)].map((m) => path.join(WWW, m[1]));
pages.push(path.join(WWW, 'dashboard.html'), path.join(WWW, 'setup.html'));
const built = process.argv[2];
if (built) pages.push(path.join(built, 'index.html'), path.join(built, 'proofs', 'index.html'));

let body = null;
for (const p of pages) {
  const html = fs.readFileSync(p, 'utf8');
  const name = path.relative(path.join(__dirname, '..', '..'), p);
  const m = html.match(SNIP_RE);
  const head = html.split(/<\/head>|<body/)[0];
  check(`${name}: the theme script is in the head`, !!m && head.includes(m[0]));
  if (!m) continue;
  body = body || m[1];
  check(`${name}:   ... it is the same script as on every other page`, m[1] === body);
  const firstCss = html.indexOf('rel="stylesheet"');
  check(`${name}:   ... and it comes before the first stylesheet`, firstCss < 0 || html.indexOf(m[0]) < firstCss);
  // the control: a page script that calls setup() from ui.js, or the demo pages' theme-mount.js
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((x) => x[1]);
  const viaSetup = scripts.some((s) => { const f = path.join(path.dirname(p), s.replace(/^\/demo\//, '').replace(/^\//, '')); return fs.existsSync(f) && /from '\.\/ui\.js'/.test(fs.readFileSync(f, 'utf8')) && /\bsetup\(/.test(fs.readFileSync(f, 'utf8')); });
  const viaMount = scripts.some((s) => /theme-mount\.js$/.test(s));
  if (/badge\.html$/.test(p)) check(`${name}:   ... the badge follows the theme without its own control`, /themeControl: false/.test(fs.readFileSync(path.join(WWW, 'badge.js'), 'utf8')));
  else check(`${name}:   ... and the page mounts the Theme control`, viaSetup || viaMount, scripts.join(' '));
}
const h = hash(body || '');
check('the page server allows exactly that script by its hash', serve.includes(`'${h}'`), h);
const vercel = fs.readFileSync(path.join(__dirname, 'vercel.json'), 'utf8');
check('the hosted copy (vercel.json) allows it too, in both of its policies', vercel.split(`'${h}'`).length - 1 === 2);
check('no page server policy allows inline scripts in general', !/script-src[^;]*'unsafe-inline'/.test(serve.replace(/\+ \(" 'unsafe-inline'" if DEV else ""\)/, '')));
const ui = fs.readFileSync(path.join(WWW, 'ui.js'), 'utf8');
check('ui.js: setup() mounts the control, which offers Light and Dark only and is labelled Theme', /if \(themeControl\) mountTheme\(\)/.test(ui) && /const THEMES = \[\['light', 'Light'\], \['dark', 'Dark'\]\];/.test(ui) && !/'System'/.test(ui) && /setAttribute\('aria-label', 'Theme'\)/.test(ui));
check('ui.js: the choice is saved in try/catch under the same key', /const THEME_KEY = 'cb-theme'/.test(ui) && /try \{ localStorage\.setItem\(THEME_KEY, c\); \} catch/.test(ui));
check('ui.js: the control shows the theme in use (a saved "system" or no choice follows the device)', /b\.dataset\.theme === root\.dataset\.theme/.test(ui) && /return c === 'light' \|\| c === 'dark' \? c : 'system'/.test(ui));
check('ui.js: with no choice the page follows the device setting while it is open', /addEventListener\('change', follow\)/.test(ui));
if (built) check('the built folder has theme-mount.js for its two own pages', fs.existsSync(path.join(built, 'theme-mount.js')));
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
