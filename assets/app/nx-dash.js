/* Home dashboard: a live clock and greeting, the weather where you are,
   announcements you can't miss, what changed in NexChat, who's around and
   your servers. Also shows new announcements once in a popup when the app
   opens. Weather comes from Open-Meteo (no key); the place is either your
   device's location or a city you pick, saved on this device only. */
(function () {
  const { esc, fmt } = NX;
  const D = () => NX.data;
  const P = () => NX.people;

  /* ---------- what's new ---------- */
  const VERSION = '3.1';
  const CHANGELOG = [
    {
      v: '3.1', date: '2026-10-22', title: 'Calls you can actually see, and a real home page',
      items: [
        ['fa-video', 'Video tiles keep the real shape of each camera, so nobody is zoomed in or cropped any more.'],
        ['fa-clone', 'One-to-one calls put the other person front and centre with you in a small corner preview. Tap it to swap, drag it to any corner.'],
        ['fa-display', 'Screen shares take the main stage with everyone else in a strip below, and the call controls stay put.'],
        ['fa-expand', 'Full screen is now real full screen on phones and desktops.'],
        ['fa-house', 'This page: a clock, the weather, announcements, what’s new and who’s around.'],
        ['fa-mobile-screen', 'The sidebar on phones is no longer greyed out behind its own shadow.'],
        ['fa-image', 'Very wide screenshots no longer leave an empty box under them.'],
        ['fa-ghost', 'Chats with accounts that were deleted show as “Deleted user” instead of “Unknown”.'],
      ],
    },
    {
      v: '3.0', date: '2026-10-21', title: 'The big rebuild',
      items: [
        ['fa-bolt', 'One app instead of separate pages: switching servers and chats is instant and calls keep going while you move around.'],
        ['fa-cloud-arrow-up', 'Much faster uploads: photos are shrunk before sending and several files go up at once.'],
        ['fa-wand-magic-sparkles', 'A new look with optional liquid glass, accent colours, compact mode and chat text size.'],
        ['fa-sliders', 'Settings rebuilt from scratch, with live previews.'],
        ['fa-gem', 'A smoother Nitro shop and vibrant, glowing name styles, including ASCII art names.'],
        ['fa-shield-halved', 'A new admin panel and a long list of security fixes.'],
        ['fa-reply', 'Replies, reactions, edits, deletes and typing indicators all update live.'],
      ],
    },
  ];

  /* ---------- weather ---------- */
  const WX = {
    0: ['Clear', 'fa-sun', 'fa-moon', 'clear'], 1: ['Mostly clear', 'fa-sun', 'fa-moon', 'clear'],
    2: ['Partly cloudy', 'fa-cloud-sun', 'fa-cloud-moon', 'cloud'], 3: ['Overcast', 'fa-cloud', 'fa-cloud', 'cloud'],
    45: ['Fog', 'fa-smog', 'fa-smog', 'fog'], 48: ['Freezing fog', 'fa-smog', 'fa-smog', 'fog'],
    51: ['Light drizzle', 'fa-cloud-rain', 'fa-cloud-rain', 'rain'], 53: ['Drizzle', 'fa-cloud-rain', 'fa-cloud-rain', 'rain'], 55: ['Heavy drizzle', 'fa-cloud-rain', 'fa-cloud-rain', 'rain'],
    56: ['Freezing drizzle', 'fa-cloud-rain', 'fa-cloud-rain', 'rain'], 57: ['Freezing drizzle', 'fa-cloud-rain', 'fa-cloud-rain', 'rain'],
    61: ['Light rain', 'fa-cloud-rain', 'fa-cloud-rain', 'rain'], 63: ['Rain', 'fa-cloud-showers-heavy', 'fa-cloud-showers-heavy', 'rain'], 65: ['Heavy rain', 'fa-cloud-showers-heavy', 'fa-cloud-showers-heavy', 'rain'],
    66: ['Freezing rain', 'fa-cloud-showers-heavy', 'fa-cloud-showers-heavy', 'rain'], 67: ['Freezing rain', 'fa-cloud-showers-heavy', 'fa-cloud-showers-heavy', 'rain'],
    71: ['Light snow', 'fa-snowflake', 'fa-snowflake', 'snow'], 73: ['Snow', 'fa-snowflake', 'fa-snowflake', 'snow'], 75: ['Heavy snow', 'fa-snowflake', 'fa-snowflake', 'snow'], 77: ['Snow grains', 'fa-snowflake', 'fa-snowflake', 'snow'],
    80: ['Showers', 'fa-cloud-sun-rain', 'fa-cloud-moon-rain', 'rain'], 81: ['Showers', 'fa-cloud-showers-heavy', 'fa-cloud-showers-heavy', 'rain'], 82: ['Violent showers', 'fa-cloud-showers-heavy', 'fa-cloud-showers-heavy', 'rain'],
    85: ['Snow showers', 'fa-snowflake', 'fa-snowflake', 'snow'], 86: ['Snow showers', 'fa-snowflake', 'fa-snowflake', 'snow'],
    95: ['Thunderstorm', 'fa-cloud-bolt', 'fa-cloud-bolt', 'storm'], 96: ['Thunderstorm, hail', 'fa-cloud-bolt', 'fa-cloud-bolt', 'storm'], 99: ['Thunderstorm, hail', 'fa-cloud-bolt', 'fa-cloud-bolt', 'storm'],
  };
  const wx = (code) => WX[code] || ['—', 'fa-cloud', 'fa-cloud', 'cloud'];
  const units = () => NX.ls.get('nx_wx_units') || (/^en-(US|LR|MM)\b/.test(navigator.language || '') || /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Indiana)/.test(Intl.DateTimeFormat().resolvedOptions().timeZone || '') ? 'f' : 'c');
  let wxState = { loading: false, data: null, error: '' };

  async function getJson(url, ms = 9000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async function loadWeather(force = false) {
    const loc = NX.ls.get('nx_wx_loc');
    if (!loc) { wxState = { loading: false, data: null, error: '' }; paintWeather(); return; }
    const u = units();
    const key = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)},${u}`;
    const cache = NX.ls.get('nx_wx_cache');
    if (!force && cache && cache.key === key && Date.now() - cache.at < 15 * 60e3) { wxState = { loading: false, data: cache.data, error: '' }; paintWeather(); return; }
    if (cache && cache.key === key) wxState.data = cache.data;
    wxState.loading = true; wxState.error = ''; paintWeather();
    try {
      const q = new URLSearchParams({
        latitude: loc.lat, longitude: loc.lon, timezone: 'auto', forecast_days: '6',
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day,precipitation',
        hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
        temperature_unit: u === 'f' ? 'fahrenheit' : 'celsius', wind_speed_unit: u === 'f' ? 'mph' : 'kmh',
      });
      const data = await getJson('https://api.open-meteo.com/v1/forecast?' + q);
      NX.ls.set('nx_wx_cache', { key, at: Date.now(), data });
      wxState = { loading: false, data, error: '' };
    } catch (e) {
      wxState.loading = false; wxState.error = 'Couldn’t reach the weather service.';
    }
    paintWeather();
  }
  async function useMyLocation() {
    if (!navigator.geolocation) return NX.toast('This browser can’t share its location. Pick a city instead.', { err: true });
    NX.toast('Finding you…', { icon: 'fa-location-crosshairs' });
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
      let name = 'Your location';
      try {
        const r = await getJson(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, 6000);
        name = r.city || r.locality || r.principalSubdivision || name;
      } catch {}
      NX.ls.set('nx_wx_loc', { lat, lon, name });
      loadWeather(true);
    }, () => {
      NX.toast('Location is blocked here. Pick a city instead.', { err: true });
      pickCity();
    }, { timeout: 10000, maximumAge: 30 * 60e3 });
  }
  async function pickCity() {
    const q = await NX.prompt({ title: 'Weather for…', label: 'City', placeholder: 'e.g. Raleigh', ok: 'Search' });
    if (!q || !q.trim()) return;
    let res;
    try { res = (await getJson('https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&name=' + encodeURIComponent(q.trim()))).results || []; }
    catch { return NX.toast('Couldn’t search for places right now.', { err: true }); }
    if (!res.length) return NX.toast(`No place called “${q.trim()}”.`, { err: true });
    const set = (r) => { NX.ls.set('nx_wx_loc', { lat: r.latitude, lon: r.longitude, name: r.name }); loadWeather(true); };
    if (res.length === 1) return set(res[0]);
    const anchor = document.querySelector('.dash-wx [data-w="city"]') || document.querySelector('.dash-hero');
    NX.menu(anchor, res.map((r) => ({ label: [r.name, r.admin1, r.country].filter(Boolean).join(', '), icon: 'fa-location-dot', onClick: () => set(r) })));
  }

  /* ---------- announcements ---------- */
  let anns = null;
  async function loadAnns() {
    const { data, error } = await window.db.from('announcements').select('*').order('pinned', { ascending: false }).order('created_at', { ascending: false }).limit(20);
    anns = error ? [] : (data || []).filter((a) => !a.expires_at || new Date(a.expires_at) > new Date());
    return anns;
  }
  const LV = { info: ['fa-circle-info', 'Info'], update: ['fa-rocket', 'Update'], warning: ['fa-triangle-exclamation', 'Heads up'], event: ['fa-calendar-days', 'Event'] };
  const seenAt = () => NX.ls.get('nx_ann_seen') || '';
  const isNew = (a) => a.created_at > seenAt();
  function annCard(a, big) {
    const lv = LV[a.level] || LV.info;
    return `<article class="dash-ann lv-${esc(a.level || 'info')}${big ? ' big' : ''}${isNew(a) ? ' new' : ''}">
      <div class="da-ico"><i class="fa-solid ${lv[0]}"></i></div>
      <div class="da-main"><div class="da-meta"><span class="da-tag">${lv[1]}</span>${a.pinned ? '<span class="da-pin"><i class="fa-solid fa-thumbtack"></i> Pinned</span>' : ''}${isNew(a) ? '<span class="da-new">New</span>' : ''}<span>${esc(fmt.ago(a.created_at))}</span></div>
        <h3>${esc(a.title)}</h3>${a.body ? `<div class="da-body m-text">${MD.render(a.body)}</div>` : ''}</div></article>`;
  }
  // New announcements pop up once when the app opens; after that they stay
  // on the home page.
  async function announceNew() {
    const list = await loadAnns();
    const fresh = list.filter(isNew);
    if (!fresh.length) return;
    const body = NX.h(`<div class="dash-ann-pop">${fresh.slice(0, 4).map((a) => annCard(a, true)).join('')}${fresh.length > 4 ? `<p class="muted" style="font-size:13px">and ${fresh.length - 4} more on the home page.</p>` : ''}</div>`);
    NX.modal({
      title: fresh.length === 1 ? 'Announcement' : `${fresh.length} new announcements`, body, wide: true,
      foot: [{ label: 'Got it', cls: 'btn-primary', onClick: () => markSeen() }],
      onClose: () => markSeen(),
    });
  }
  function markSeen() {
    const top = (anns || []).reduce((m, a) => (a.created_at > m ? a.created_at : m), seenAt());
    NX.ls.set('nx_ann_seen', top);
  }

  /* ---------- the page ---------- */
  let host = null, tick = null;
  function render(el) {
    host = el;
    el.innerHTML = `<div class="dash">
      <section class="dash-anns"></section>
      <section class="dash-hero" data-sky="clear">
        <div class="dh-fx" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="dh-left">
          <div class="dh-greet"></div>
          <div class="dh-clock"><span class="dh-hm mono"></span><span class="dh-s mono"></span><span class="dh-ap"></span></div>
          <div class="dh-date"></div>
          <div class="dh-day"><div class="dh-day-bar"><i></i></div><span></span></div>
          <div class="dh-chips"></div>
        </div>
        <div class="dash-wx"></div>
        <div class="dh-hours"></div>
      </section>
      <div class="dash-grid">
        <section class="dash-card dc-active"><h2><i class="fa-solid fa-signal"></i>Active now</h2><div class="dc-body"></div></section>
        <section class="dash-card dc-week"><h2><i class="fa-solid fa-calendar-week"></i>This week</h2><div class="dc-body"></div></section>
        <section class="dash-card dc-news"><h2><i class="fa-solid fa-wand-magic-sparkles"></i>What’s new<span class="grow"></span><span class="ver">v${VERSION}</span></h2><div class="dc-body"></div></section>
        <section class="dash-card dc-servers"><h2><i class="fa-solid fa-server"></i>Your servers</h2><div class="dc-body"></div></section>
      </div>
    </div>`;
    el.querySelector('.dash').addEventListener('click', onClick);
    clearInterval(tick);
    tick = setInterval(() => { if (!host?.isConnected) { clearInterval(tick); tick = null; return; } paintClock(); }, 1000);
    paintClock(); paintChips(); paintActive(); paintNews(); paintServers(); paintWeather();
    loadWeather();
    (anns ? Promise.resolve(anns) : loadAnns()).then(paintAnns);
    NX.ls.set('nx_seen_ver', VERSION);
  }
  const $d = (sel) => host?.querySelector(sel);

  function paintClock() {
    const now = new Date();
    const h = now.getHours();
    const greet = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Good night';
    const g = $d('.dh-greet');
    if (!g) return;
    const gt = `${greet}, ${P().nameText(NX.me)}`;
    if (g.dataset.t !== gt) { g.dataset.t = gt; g.innerHTML = `${greet}, <b>${P().nameText(NX.me)}</b>`; }
    const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).formatToParts(now);
    const pick = (t) => parts.find((p) => p.type === t)?.value || '';
    $d('.dh-hm').textContent = `${pick('hour')}:${pick('minute')}`;
    $d('.dh-s').textContent = pick('second');
    $d('.dh-ap').textContent = pick('dayPeriod');
    $d('.dh-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const pct = ((now - new Date(now).setHours(0, 0, 0, 0)) / 864e5) * 100;
    $d('.dh-day-bar i').style.width = pct.toFixed(2) + '%';
    $d('.dh-day span').textContent = `${Math.floor(pct)}% of today done`;
  }
  function paintChips() {
    const el = $d('.dh-chips');
    if (!el) return;
    const online = D().friendIds().filter((id) => P().isOnline(id)).length;
    const unread = D().dms.reduce((n, c) => n + (c.unread > 0 ? 1 : 0), 0);
    const live = window.Voice?.live?.() || new Map();
    const calls = D().dms.filter((c) => live.get('dm-' + c.id)).length;
    el.innerHTML = [
      `<button class="dh-chip" data-go="home/online"><i class="fa-solid fa-circle" style="color:var(--ok)"></i><b>${online}</b> ${online === 1 ? 'friend' : 'friends'} online</button>`,
      unread ? `<button class="dh-chip hot" data-go="${esc('dm/' + D().dms.find((c) => c.unread > 0).id)}"><i class="fa-solid fa-envelope"></i><b>${unread}</b> unread ${unread === 1 ? 'chat' : 'chats'}</button>` : '',
      calls ? `<span class="dh-chip live"><i class="fa-solid fa-phone-volume"></i><b>${calls}</b> ${calls === 1 ? 'call' : 'calls'} going on</span>` : '',
      D().incoming().length ? `<button class="dh-chip hot" data-go="home/pending"><i class="fa-solid fa-user-plus"></i><b>${D().incoming().length}</b> friend ${D().incoming().length === 1 ? 'request' : 'requests'}</button>` : '',
    ].join('');
  }
  function paintWeather() {
    const el = $d('.dash-wx'), hours = $d('.dh-hours'), week = $d('.dc-week .dc-body'), hero = $d('.dash-hero');
    if (!el) return;
    const loc = NX.ls.get('nx_wx_loc');
    const u = units() === 'f' ? '°F' : '°C';
    if (!loc) {
      el.innerHTML = `<div class="wx-setup"><i class="fa-solid fa-cloud-sun wx-big"></i><b>See the weather here</b><p>Your location stays on this device.</p>
        <div class="row" style="gap:8px;flex-wrap:wrap;justify-content:center"><button class="btn btn-primary btn-sm" data-w="locate"><i class="fa-solid fa-location-crosshairs"></i>Use my location</button><button class="btn btn-ghost btn-sm" data-w="city"><i class="fa-solid fa-magnifying-glass"></i>Pick a city</button></div></div>`;
      hours.innerHTML = '';
      if (week) week.innerHTML = '<p class="muted" style="font-size:13px">Set a place in the weather card to see the week ahead.</p>';
      return;
    }
    const d = wxState.data;
    if (!d) {
      el.innerHTML = `<div class="wx-setup">${wxState.error ? `<i class="fa-solid fa-triangle-exclamation wx-big"></i><b>${esc(wxState.error)}</b><button class="btn btn-ghost btn-sm" data-w="retry">Try again</button>` : '<span class="spinner"></span><p>Checking the sky…</p>'}</div>`;
      return;
    }
    const c = d.current;
    const day = c.is_day !== 0;
    const [label, sun, moon, sky] = wx(c.weather_code);
    hero.dataset.sky = sky + (day ? '' : '-night');
    const hi = Math.round(d.daily.temperature_2m_max[0]), lo = Math.round(d.daily.temperature_2m_min[0]);
    el.innerHTML = `<div class="wx-now">
        <i class="fa-solid ${day ? sun : moon} wx-big"></i>
        <div class="wx-temp">${Math.round(c.temperature_2m)}<small>${u}</small></div>
        <div class="wx-desc"><b>${esc(label)}</b><span>Feels like ${Math.round(c.apparent_temperature)}° · H ${hi}° L ${lo}°</span>
          <span><i class="fa-solid fa-wind"></i> ${Math.round(c.wind_speed_10m)} ${units() === 'f' ? 'mph' : 'km/h'} · <i class="fa-solid fa-droplet"></i> ${Math.round(c.relative_humidity_2m)}%</span></div>
      </div>
      <div class="wx-place"><button class="wx-link" data-w="city" title="Change place"><i class="fa-solid fa-location-dot"></i>${esc(loc.name || 'Your location')}</button>
        <button class="wx-link" data-w="units" title="Switch units">${u === '°F' ? '°C' : '°F'}</button>
        <button class="wx-link" data-w="retry" title="Refresh"><i class="fa-solid fa-rotate${wxState.loading ? ' fa-spin' : ''}"></i></button></div>`;
    // the next 12 hours from now
    const nowIdx = Math.max(0, d.hourly.time.findIndex((t) => new Date(t) > new Date()) - 1);
    hours.innerHTML = d.hourly.time.slice(nowIdx, nowIdx + 12).map((t, i) => {
      const k = nowIdx + i;
      const [, s, m] = wx(d.hourly.weather_code[k]);
      const p = d.hourly.precipitation_probability?.[k];
      return `<div class="wx-h${i === 0 ? ' now' : ''}"><span>${i === 0 ? 'Now' : new Date(t).toLocaleTimeString(undefined, { hour: 'numeric' })}</span><i class="fa-solid ${d.hourly.is_day?.[k] === 0 ? m : s}"></i><b>${Math.round(d.hourly.temperature_2m[k])}°</b>${p >= 20 ? `<small><i class="fa-solid fa-droplet"></i>${p}%</small>` : '<small></small>'}</div>`;
    }).join('');
    if (week) {
      const all = d.daily.temperature_2m_max.concat(d.daily.temperature_2m_min);
      const mn = Math.min(...all), mx = Math.max(...all), span = Math.max(1, mx - mn);
      week.innerHTML = d.daily.time.map((t, i) => {
        const [lab, s] = wx(d.daily.weather_code[i]);
        const a = d.daily.temperature_2m_min[i], b = d.daily.temperature_2m_max[i];
        const p = d.daily.precipitation_probability_max?.[i];
        return `<div class="wx-d"><span class="wd-n">${i === 0 ? 'Today' : new Date(t + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' })}</span><i class="fa-solid ${s}" title="${esc(lab)}"></i>
          <small class="wd-p">${p >= 20 ? p + '%' : ''}</small><span class="wd-lo">${Math.round(a)}°</span>
          <span class="wd-bar"><i style="left:${((a - mn) / span) * 100}%;right:${100 - ((b - mn) / span) * 100}%"></i></span><span class="wd-hi">${Math.round(b)}°</span></div>`;
      }).join('');
    }
  }
  function paintAnns() {
    const el = $d('.dash-anns');
    if (!el) return;
    const list = anns || [];
    el.innerHTML = list.length
      ? `<div class="dash-sect"><i class="fa-solid fa-bullhorn"></i>Announcements${list.some(isNew) ? `<span class="da-new">${list.filter(isNew).length} new</span>` : ''}</div>${list.slice(0, 6).map((a, i) => annCard(a, i === 0)).join('')}`
      : '';
    if (list.length) setTimeout(markSeen, 1500);
  }
  function paintActive() {
    const el = $d('.dc-active .dc-body');
    if (!el) return;
    const live = window.Voice?.live?.() || new Map();
    const calls = D().dms.filter((c) => live.get('dm-' + c.id));
    const online = D().friendIds().map((id) => P().get(id)).filter((p) => p && P().isOnline(p.id))
      .sort((a, b) => P().nameOf(a).localeCompare(P().nameOf(b))).slice(0, 10);
    el.innerHTML = calls.map((c) => `<div class="active-card" data-go="dm/${esc(c.id)}?join=1">${c.is_group ? '<span class="av" style="width:36px;height:36px;background:var(--accent)"><i class="fa-solid fa-user-group"></i></span>' : P().avatar(c.people[0], 36, { presence: true })}<div class="t"><b>${esc(D().dmTitle(c))}</b><small style="color:var(--ok)"><i class="fa-solid fa-phone-volume"></i> In a call · ${live.get('dm-' + c.id)}</small></div><button class="btn btn-ok btn-sm">Join</button></div>`).join('')
      + online.map((p) => `<div class="active-card" data-dm="${esc(p.id)}">${P().avatar(p, 36, { presence: true })}<div class="t"><b>${P().nameText(p)}</b><small>${esc(p.custom_status || P().STATUS_LABEL[P().presenceOf(p.id)])}</small></div><i class="fa-solid fa-message" style="color:var(--txt-3)"></i></div>`).join('')
      + (!calls.length && !online.length ? `<div class="dc-empty"><i class="fa-solid fa-moon"></i><b>It’s quiet right now</b><span>Friends who come online show up here.</span><button class="btn btn-ghost btn-sm" data-go="home/add"><i class="fa-solid fa-user-plus"></i>Add a friend</button></div>` : '');
  }
  function paintNews() {
    const el = $d('.dc-news .dc-body');
    if (!el) return;
    el.innerHTML = CHANGELOG.map((r, i) => `<details class="cl-rel"${i === 0 ? ' open' : ''}><summary><span class="cl-v">v${esc(r.v)}</span><b>${esc(r.title)}</b><small>${esc(new Date(r.date + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</small></summary>
      <ul>${r.items.map(([ic, t]) => `<li><i class="fa-solid ${ic}"></i><span>${esc(t)}</span></li>`).join('')}</ul></details>`).join('');
  }
  function paintServers() {
    const el = $d('.dc-servers .dc-body');
    if (!el) return;
    const list = D().servers.slice(0, 12);
    el.innerHTML = list.length
      ? `<div class="dc-srv">${list.map((s) => `<button class="dc-srv-i" data-go="s/${esc(s.id)}" title="${esc(s.name)}"><span class="ic">${s.icon_url ? `<img ${P().imgAttr(s.icon_url)} alt="">` : esc((s.name || '?')[0].toUpperCase())}</span><span class="nm">${esc(s.name)}</span>${s.unread ? '<span class="dot"></span>' : ''}</button>`).join('')}</div>`
      : `<div class="dc-empty"><i class="fa-solid fa-compass"></i><b>No servers yet</b><span>Start your own or join one with an invite.</span><div class="row" style="gap:8px"><button class="btn btn-primary btn-sm" data-f="create">Create</button><button class="btn btn-ghost btn-sm" data-f="join">Join</button></div></div>`;
  }

  function onClick(e) {
    const w = e.target.closest('[data-w]')?.dataset.w;
    if (w === 'locate') return useMyLocation();
    if (w === 'city') return pickCity();
    if (w === 'retry') return loadWeather(true);
    if (w === 'units') { NX.ls.set('nx_wx_units', units() === 'f' ? 'c' : 'f'); return loadWeather(true); }
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (f === 'create') return NX.addServerDialog();
    if (f === 'join') return NX.joinServerDialog();
    const g = e.target.closest('[data-go]'); if (g) return NX.go(g.dataset.go);
    const d = e.target.closest('[data-dm]'); if (d) return D().openDm(d.dataset.dm);
  }

  const repaint = NX.debounce(() => { if (!host?.isConnected) return; paintChips(); paintActive(); paintServers(); }, 60);
  ['presence', 'friends', 'dms', 'servers', 'unread', 'live', 'call'].forEach((ev) => NX.on(ev, repaint));
  NX.on('announcements', () => loadAnns().then(() => { if (host?.isConnected) paintAnns(); else announceNew(); }));

  NX.dash = { render, announceNew, loadAnns, VERSION };
})();
