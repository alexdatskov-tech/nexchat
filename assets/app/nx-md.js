/* Markdown for messages. Everything is HTML-escaped before any rule runs, so
   user text can never inject markup. Supports **bold**, *italic*, __underline__,
   ~~strike~~, ||spoilers||, `code`, ```fenced code```, > quotes, lists,
   # headings, tables, links and @mentions. */
window.MD = (function () {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Links are pulled out before the formatting rules so underscores and
  // asterisks inside URLs are left alone.
  function inline(t, ctx) {
    const links = [];
    const keep = (html) => `\u0001${links.push(html) - 1}\u0001`;
    t = t.replace(/\[([^\]\n\u0000\u0001]{1,200})\]\((https?:\/\/[^\s)\u0000\u0001]+)\)/g, (_, label, url) => keep(`<a href="${url}" target="_blank" rel="noopener noreferrer" title="${url}">${label}</a>`));
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<\u0000\u0001]+)/g, (_, pre, url) => {
      let trail = '';
      const m = url.match(/[.,!?;:)\]'"]+$/);
      if (m && !(m[0].includes(')') && url.includes('('))) { trail = m[0]; url = url.slice(0, -trail.length); }
      return pre + keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + trail;
    });
    t = t.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoil">$1</span>');
    t = t.replace(/\*\*\*([^\n*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*([^\n*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^\n_]+)__/g, '<u>$1</u>');
    t = t.replace(/~~([^\n~]+)~~/g, '<del>$1</del>');
    t = t.replace(/(^|[^*\w])\*([^\n*]+)\*(?!\w)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[\s(])_([^\n_]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^\w@])@([A-Za-z0-9_]{2,32})\b/g, (m, pre, user) => {
      const me = ctx?.me && user.toLowerCase() === ctx.me.toLowerCase();
      return `${pre}<span class="mention${me ? ' me' : ''}" data-mention="${user}">@${user}</span>`;
    });
    t = t.replace(/(^|[^\w])@(everyone|here)\b/g, '$1<span class="mention me" data-mention="$2">@$2</span>');
    return t.replace(/\u0001(\d+)\u0001/g, (_, i) => links[+i]);
  }

  function render(raw, ctx) {
    if (!raw) return '';
    let src = esc(raw);
    const fences = [];
    src = src.replace(/```([a-zA-Z0-9+#-]*)\n?([\s\S]*?)```/g, (_, lang, code) => `\u0000F${fences.push({ lang: lang.toLowerCase(), code: code.replace(/\n$/, '') }) - 1}\u0000`);
    const codes = [];
    src = src.replace(/`([^`\n]+)`/g, (_, c) => `\u0000C${codes.push(c) - 1}\u0000`);

    const lines = src.split('\n');
    let out = '', list = null, quote = false;
    const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
    const closeQuote = () => { if (quote) { out += '</blockquote>'; quote = false; } };
    const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (/^\s*\|.*\|\s*$/.test(ln) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
        closeList(); closeQuote();
        const head = cells(ln), rows = [];
        i++;
        while (/^\s*\|.*\|\s*$/.test(lines[i + 1] || '')) rows.push(cells(lines[++i]));
        out += '<table class="md-table"><thead><tr>' + head.map((h) => `<th>${inline(h, ctx)}</th>`).join('') + '</tr></thead><tbody>'
          + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c, ctx)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
        continue;
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(ln)) { closeList(); closeQuote(); out += '<hr class="md-hr">'; continue; }
      const h = ln.match(/^(#{1,3})\s+(.+)$/);
      if (h) { closeList(); closeQuote(); out += `<h${h[1].length} class="md-h">${inline(h[2], ctx)}</h${h[1].length}>`; continue; }
      const q = ln.match(/^&gt;\s?(.*)$/);
      if (q) { closeList(); if (!quote) { out += '<blockquote>'; quote = true; } out += `<div>${inline(q[1], ctx) || '<br>'}</div>`; continue; }
      closeQuote();
      const ul = ln.match(/^\s*[-*+]\s+(.*)$/), ol = ln.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { closeList(); out += `<${want} class="md-list">`; list = want; }
        out += `<li>${inline((ul || ol)[1], ctx)}</li>`;
        continue;
      }
      closeList();
      out += ln.trim() ? `<div>${inline(ln, ctx)}</div>` : '<div><br></div>';
    }
    closeList(); closeQuote();
    // Trailing blank lines add nothing.
    out = out.replace(/(<div><br><\/div>)+$/, '');
    out = out.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
    out = out.replace(/\u0000F(\d+)\u0000/g, (_, i) => {
      const f = fences[+i];
      return `<pre class="md-pre"${f.lang ? ` data-lang="${esc(f.lang)}"` : ''}><code>${f.code}</code></pre>`;
    });
    return out;
  }

  // Up to 3 emoji and nothing else: shown large.
  const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*|\p{Regional_Indicator}{2}|\s)+$/u;
  function isJumbo(raw) {
    if (!raw || raw.length > 40 || !EMOJI_ONLY.test(raw)) return false;
    const n = [...raw.replace(/\s/g, '').matchAll(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*|\p{Regional_Indicator}{2}/gu)].length;
    return n > 0 && n <= 3;
  }

  // Plain one-line preview (sidebar, notifications, reply bars).
  function plain(raw, max = 120) {
    let s = String(raw || '').replace(/```[\s\S]*?```/g, '[code]').replace(/\|\|[\s\S]*?\|\|/g, '[spoiler]')
      .replace(/[*_~`>#|]/g, '').replace(/\s+/g, ' ').trim();
    if (s.length > max) s = s.slice(0, max - 1) + '…';
    return s;
  }

  const mentions = (raw) => [...String(raw || '').matchAll(/(?:^|[^\w@])@([A-Za-z0-9_]{2,32})\b/g)].map((m) => m[1].toLowerCase());

  return { render, esc, isJumbo, plain, mentions };
})();
