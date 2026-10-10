// Compiles docs/*.md into styled standalone pages (docs/*.html).
//
//   npm i --no-save markdown-it@14 markdown-it-anchor@9
//   node tools/build-docs.js
//
// markdown-it is a CommonMark-compliant compiler. Raw HTML inside the
// Markdown is turned off (html: false), so the docs can't inject markup.
const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');
const anchor = require('markdown-it-anchor');

const root = path.resolve(__dirname, '..');
const docsDir = path.join(root, 'docs');

const md = new MarkdownIt({ html: false, linkify: true, typographer: true })
  .use(anchor, {
    level: [2, 3], // no # link on the page title
    permalink: anchor.permalink.ariaHidden({ placement: 'after', symbol: '#' }),
    slugify: (s) => s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-'),
  });

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0b0d12; color: #e6e8ee; font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 40px 22px 80px; }
header.top { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 22px; border-bottom: 1px solid #1f232d; font-size: 14px; }
header.top a { color: #9aa3b5; text-decoration: none; } header.top a:hover { color: #fff; }
h1, h2, h3, h4 { line-height: 1.25; letter-spacing: -.01em; }
h1 { font-size: 2.1em; margin: .2em 0 .4em; }
h2 { font-size: 1.5em; margin: 2.2em 0 .6em; padding-bottom: .3em; border-bottom: 1px solid #1f232d; }
h3 { font-size: 1.15em; margin: 1.8em 0 .5em; }
a { color: #8fb3ff; }
a.header-anchor { color: #4d5566; text-decoration: none; margin-left: .35em; opacity: 0; }
h2:hover a.header-anchor, h3:hover a.header-anchor { opacity: 1; }
code { font: 13.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #171b24; border: 1px solid #222838; border-radius: 6px; padding: .1em .38em; }
pre { background: #0f121a; border: 1px solid #222838; border-radius: 10px; padding: 14px 16px; overflow-x: auto; }
pre code { background: none; border: 0; padding: 0; font-size: 13px; }
table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 14.5px; display: block; overflow-x: auto; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1f232d; vertical-align: top; }
th { color: #aab3c5; font-weight: 600; background: #11141c; }
blockquote { margin: 1em 0; padding: .4em 1em; border-left: 3px solid #3b4a6b; color: #b5bdcc; background: #10131b; border-radius: 0 8px 8px 0; }
hr { border: 0; border-top: 1px solid #1f232d; margin: 2em 0; }
.hidden { display: none !important; }
.down { max-width: 860px; margin: 0 auto; padding: 60px 22px; }
.down h1 { font-size: 1.8em; }
footer.credit { margin-top: 3em; padding-top: 1em; border-top: 1px solid #1f232d; color: #7d8699; font-size: 13px; }
ul, ol { padding-left: 1.4em; } li { margin: .25em 0; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · NexChat</title>
<style>${CSS}</style>
</head>
<body>
<header class="top"><a href="../portal.html">← NexChat</a><span>Developer docs</span></header>
<div id="docDown" class="hidden down">
  <h1>Bot API docs are temporarily unavailable</h1>
  <p>The owner has switched the bot platform off for now. Bot API by andrew. Check back later.</p>
</div>
<main id="docMain" class="hidden">
${body}
<footer class="credit">Bot API by andrew</footer>
</main>
<script src="../assets/js/config.js"></script>
<script>
// The docs follow the same owner switch as the API (platform_features, key bot_api).
// Fails closed: if the check cannot run, the notice shows instead of the docs.
(async () => {
  const c = window.NEXCHAT_CONFIG || {};
  let on = false;
  try {
    const r = await fetch(c.SUPABASE_URL + '/rest/v1/platform_features?key=eq.bot_api&select=enabled', {
      headers: { apikey: c.SUPABASE_ANON_KEY, authorization: 'Bearer ' + c.SUPABASE_ANON_KEY },
    });
    const rows = await r.json();
    on = !!(rows && rows[0] && rows[0].enabled);
  } catch (_) { on = false; }
  document.getElementById('docMain').classList.toggle('hidden', !on);
  document.getElementById('docDown').classList.toggle('hidden', on);
})();
</script>
</body>
</html>
`;
}

let built = 0;
for (const f of fs.readdirSync(docsDir)) {
  if (!f.endsWith('.md')) continue;
  const src = fs.readFileSync(path.join(docsDir, f), 'utf8');
  const title = (src.match(/^#\s+(.+)$/m) || [null, f])[1].trim();
  const out = path.join(docsDir, f.replace(/\.md$/, '.html'));
  fs.writeFileSync(out, page(title, md.render(src)));
  console.log('built', path.relative(root, out));
  built++;
}
if (!built) { console.error('No .md files in docs/'); process.exit(1); }
