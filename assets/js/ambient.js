/* Ambient light colours (--amb-1..3) that follow the user's look instead of
   a fixed purple/teal/pink. Sources, best first:
     1. the wallpaper image, sampled on a tiny canvas,
     2. the colours named in a gradient preset,
     3. the accent (CSS default: --amb-* are derived from --accent).
   The last palette is remembered so the next page paints the right colours
   on its first frame, before the profile has even loaded. */
window.Ambient = (function () {
  const root = document.documentElement;
  const LAST = 'nx_amb_last', CACHE = 'nx_amb_cache_v1';
  let version = 0;

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  function rgb2hsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hsl2rgb(h, s, l) {
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  }
  const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  /* Pick up to three distinct, lively hues from weighted colour samples and
     tune them into glows: saturated enough to read as light, never neon. */
  function palette(samples) {
    const BINS = 24, bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0, h: 0 }));
    let satSum = 0, n = 0;
    for (const { c, w = 1 } of samples) {
      const [h, s, l] = rgb2hsl(c);
      if (l < 0.06 || l > 0.97) continue;
      satSum += s; n++;
      const wt = w * (0.08 + s) * (1 - Math.abs(l - 0.55));
      const bin = bins[Math.floor(h / (360 / BINS)) % BINS];
      bin.w += wt; bin.r += c[0] * wt; bin.g += c[1] * wt; bin.b += c[2] * wt;
    }
    if (!n) return null;
    const ranked = bins.filter((b) => b.w > 0).map((b) => {
      const c = [b.r / b.w, b.g / b.w, b.b / b.w];
      return { w: b.w, hsl: rgb2hsl(c) };
    }).sort((a, b) => b.w - a.w);
    const picks = [];
    for (const b of ranked) {
      if (picks.length === 3) break;
      if (picks.every((p) => hueDist(p.hsl[0], b.hsl[0]) > 38) && b.w > ranked[0].w * 0.08) picks.push(b);
    }
    // A near-monochrome wallpaper keeps its mood: stay close to its hue.
    const mono = satSum / n < 0.12;
    const base = picks[0].hsl;
    while (picks.length < 3) {
      const shift = picks.length === 1 ? -42 : 46;
      picks.push({ hsl: [(base[0] + shift + 360) % 360, base[1], base[2]] });
    }
    return picks.map(({ hsl: [h, s, l] }, i) => {
      const sat = mono ? Math.min(0.42, Math.max(0.22, s * 2.2)) : Math.min(0.9, Math.max(0.55, s * 1.15));
      const lig = Math.min(0.68, Math.max(0.52, l + (i ? 0.04 : 0)));
      return hsl2rgb(h, sat, lig);
    });
  }

  function paint(p) {
    if (!p) { for (let i = 1; i <= 3; i++) root.style.removeProperty('--amb-' + i); return; }
    p.forEach((c, i) => root.style.setProperty('--amb-' + (i + 1), `rgb(${c.join(' ')})`));
  }

  function fromImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        try {
          const S = 40, cv = document.createElement('canvas');
          cv.width = cv.height = S;
          const cx = cv.getContext('2d', { willReadFrequently: true });
          cx.drawImage(img, 0, 0, S, S);
          const d = cx.getImageData(0, 0, S, S).data, out = [];
          for (let i = 0; i < d.length; i += 4) out.push({ c: [d[i], d[i + 1], d[i + 2]] });
          resolve(palette(out));
        } catch { resolve(null); }   // tainted canvas: the host sent no CORS headers
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function fromCss(str) {
    const cx = document.createElement('canvas').getContext('2d');
    const toks = str.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)/gi) || [];
    const out = [];
    for (const t of toks) {
      cx.fillStyle = '#000'; cx.fillStyle = t;
      const v = cx.fillStyle;
      const m = v.startsWith('#') ? [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) : (v.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      if (m.length === 3) out.push({ c: m });
    }
    return out.length ? palette(out) : null;
  }

  /* bg: the CSS background value (url(...) or a gradient), id: a stable
     cache key (the wallpaper's storage key, never a signed URL). */
  async function from(bg, id) {
    const v = ++version;
    if (!bg) { paint(null); ls.set(LAST, null); return; }
    const key = String(id || bg).slice(0, 300);
    const cache = ls.get(CACHE) || {};
    if (cache[key]) { paint(cache[key]); ls.set(LAST, cache[key]); return; }
    const url = (bg.match(/^url\(\s*["']?(.*?)["']?\s*\)$/i) || [])[1];
    const p = url ? await fromImage(url) : fromCss(bg);
    if (v !== version) return;
    paint(p);
    ls.set(LAST, p);
    if (p) {
      const keys = Object.keys(cache);
      if (keys.length > 20) delete cache[keys[0]];
      cache[key] = p;
      ls.set(CACHE, cache);
    }
  }

  paint(ls.get(LAST));   // first frame already wears last visit's colours
  return { from, palette };
})();
