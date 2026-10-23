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
        ['fa-house', 'This page: a clock, the weather where you are, announcements, what’s new, who’s around and big server cards.'],
        ['fa-cloud-sun-rain', 'Colourful animated weather icons (Meteocons by Bas Milius). They hold still if you turn on Reduce motion.'],
        ['fa-tower-broadcast', 'Weather uses your exact location (or a city you pick), and in the US “now” is the real reading from the nearest weather station, refreshed every 10 minutes.'],
        ['fa-clock-rotate-left', 'Miss the old look? Settings → Appearance → Interface → Classic brings back the original NexChat style, rebuilt on the new app.'],
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
  // Animated, colourful icons: Meteocons by Bas Milius (MIT), kept in
  // assets/wx; the still versions are used when Reduce motion is on.
  const ICON = {
    0: ['clear-day', 'clear-night'], 1: ['clear-day', 'clear-night'], 2: ['partly-cloudy-day', 'partly-cloudy-night'], 3: ['cloudy', 'cloudy'],
    45: ['fog-day', 'fog-night'], 48: ['fog-day', 'fog-night'],
    51: ['partly-cloudy-day-drizzle', 'partly-cloudy-night-drizzle'], 53: ['drizzle', 'drizzle'], 55: ['drizzle', 'drizzle'], 56: ['sleet', 'sleet'], 57: ['sleet', 'sleet'],
    61: ['rain', 'rain'], 63: ['rain', 'rain'], 65: ['extreme-rain', 'extreme-rain'], 66: ['sleet', 'sleet'], 67: ['sleet', 'sleet'],
    71: ['partly-cloudy-day-snow', 'partly-cloudy-night-snow'], 73: ['snow', 'snow'], 75: ['extreme-snow', 'extreme-snow'], 77: ['snow', 'snow'],
    80: ['partly-cloudy-day-rain', 'partly-cloudy-night-rain'], 81: ['rain', 'rain'], 82: ['extreme-rain', 'extreme-rain'], 85: ['partly-cloudy-day-snow', 'partly-cloudy-night-snow'], 86: ['extreme-snow', 'extreme-snow'],
    95: ['thunderstorms-day-rain', 'thunderstorms-night-rain'], 96: ['hail', 'hail'], 99: ['hail', 'hail'],
  };
  const still = () => document.body.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const iconSrc = (name) => `assets/wx/${still() ? 'still/' : ''}${name}.svg`;
  const wxImg = (code, night, cls = '', title = '') => {
    const name = (ICON[code] || ['not-available', 'not-available'])[night ? 1 : 0];
    return `<img class="wx-ic ${cls}" src="${iconSrc(name)}" alt="${esc(title || wx(code)[0])}" draggable="false">`;
  };
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
  /* Where: a city you picked wins; otherwise your device's exact location
     (asked once, then used silently); your IP address is only the fallback
     while that isn't available. */
  async function ipLocation() {
    const tries = [
      ['https://get.geojs.io/v1/ip/geo.json', (r) => ({ lat: +r.latitude, lon: +r.longitude, name: r.city || r.region || r.country, cc: r.country_code })],
      ['https://ipwho.is/', (r) => (r.success === false ? null : { lat: +r.latitude, lon: +r.longitude, name: r.city || r.region || r.country, cc: r.country_code })],
    ];
    for (const [url, pick] of tries) {
      try {
        const loc = pick(await getJson(url, 6000));
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) return { ...loc, name: loc.name || 'Your area', src: 'ip', at: Date.now() };
      } catch {}
    }
    return null;
  }
  const gpsState = async () => { try { return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { return 'prompt'; } };
  function gpsFix(timeout = 12000) {
    return new Promise((ok, no) => {
      if (!navigator.geolocation) return no(new Error('no geolocation'));
      navigator.geolocation.getCurrentPosition((p) => ok(p.coords), no, { enableHighAccuracy: true, timeout, maximumAge: 10 * 60e3 });
    });
  }
  async function placeName(lat, lon) {
    try {
      const r = await getJson(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, 6000);
      return { name: r.city || r.locality || r.principalSubdivision || 'Your location', cc: r.countryCode };
    } catch { return { name: 'Your location' }; }
  }
  async function gpsLocation(ask) {
    const st = await gpsState();
    if (st === 'denied' || (st !== 'granted' && !ask)) return null;
    try {
      const c = await gpsFix();
      const old = NX.ls.get('nx_wx_loc');
      const moved = !old || old.src !== 'gps' || Math.hypot(old.lat - c.latitude, old.lon - c.longitude) > 0.01;
      const where = moved ? await placeName(c.latitude, c.longitude) : { name: old.name, cc: old.cc };
      return { lat: c.latitude, lon: c.longitude, ...where, src: 'gps', acc: Math.round(c.accuracy || 0), at: Date.now() };
    } catch { return null; }
  }
  async function resolvePlace() {
    let loc = NX.ls.get('nx_wx_loc');
    if (loc?.src === 'city') return loc;
    const asked = NX.ls.get('nx_wx_asked');
    const gps = await gpsLocation(!asked);
    if (!asked) NX.ls.set('nx_wx_asked', 1);
    if (gps) { NX.ls.set('nx_wx_loc', gps); return gps; }
    if (!loc || loc.src === 'gps' || Date.now() - (loc.at || 0) > 12 * 36e5) {
      const ip = await ipLocation();
      if (ip) { NX.ls.set('nx_wx_loc', ip); loc = ip; }
    }
    return loc || null;
  }

  /* In the US, "now" is the latest real reading from the nearest National
     Weather Service station (within the last 90 minutes); elsewhere, and if
     no station has reported, it's Open-Meteo's current conditions. */
  const textCode = (t) => {
    t = String(t || '').toLowerCase();
    if (/thunder|t-storm/.test(t)) return 95;
    if (/snow|sleet|flurr|ice pellets/.test(t)) return 73;
    if (/freezing rain|freezing drizzle/.test(t)) return 66;
    if (/heavy rain|showers/.test(t)) return 63;
    if (/rain|drizzle/.test(t)) return 61;
    if (/fog|mist|haze|smoke/.test(t)) return 45;
    if (/overcast/.test(t)) return 3;
    if (/mostly cloudy|cloudy/.test(t)) return 3;
    if (/mostly sunny|mostly clear/.test(t)) return 1;
    if (/partly/.test(t)) return 2;
    if (/clear|sunny|fair/.test(t)) return 0;
    return null;
  };
  async function nwsNow(loc) {
    if (!(loc.lat > 18 && loc.lat < 72 && loc.lon > -180 && loc.lon < -64) || (loc.cc && !/^(US|PR|GU|VI)$/i.test(loc.cc))) return null;
    const key = 'nx_wx_st:' + loc.lat.toFixed(2) + ',' + loc.lon.toFixed(2);
    let stations = NX.ls.get(key);
    try {
      if (!stations) {
        const pt = await getJson(`https://api.weather.gov/points/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`, 8000);
        const list = await getJson(pt.properties.observationStations, 8000);
        stations = (list.features || []).slice(0, 4).map((f) => ({ id: f.properties.stationIdentifier, name: f.properties.name }));
        NX.ls.set(key, stations);
      }
      for (const st of stations) {
        try {
          const o = (await getJson(`https://api.weather.gov/stations/${st.id}/observations/latest`, 8000)).properties;
          const age = Date.now() - Date.parse(o.timestamp);
          if (o.temperature?.value == null || !(age < 90 * 60e3)) continue;
          const feels = o.windChill?.value ?? o.heatIndex?.value ?? o.temperature.value;
          return { tempC: o.temperature.value, feelsC: feels, humidity: o.relativeHumidity?.value, windKmh: o.windSpeed?.value, text: o.textDescription, code: textCode(o.textDescription), station: st, at: Date.parse(o.timestamp) };
        } catch {}
      }
    } catch {}
    return null;
  }

  let wxTimer = null;
  async function loadWeather(force = false) {
    if (!NX.ls.get('nx_wx_loc')) { wxState = { loading: true, data: null, error: '' }; paintWeather(); }
    const loc = await resolvePlace();
    if (!loc) { wxState = { loading: false, data: null, error: '' }; paintWeather(); return; }
    const u = units();
    const key = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)},${u}`;
    const cache = NX.ls.get('nx_wx_cache');
    if (!force && cache && cache.key === key && Date.now() - cache.at < 10 * 60e3) { wxState = { loading: false, data: cache.data, obs: cache.obs, error: '' }; paintWeather(); return; }
    if (cache && cache.key === key) { wxState.data = cache.data; wxState.obs = cache.obs; }
    wxState.loading = true; wxState.error = ''; paintWeather();
    try {
      const q = new URLSearchParams({
        latitude: loc.lat.toFixed(4), longitude: loc.lon.toFixed(4), timezone: 'auto', forecast_days: '7',
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day,precipitation',
        hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
        temperature_unit: u === 'f' ? 'fahrenheit' : 'celsius', wind_speed_unit: u === 'f' ? 'mph' : 'kmh',
      });
      const [data, obs] = await Promise.all([getJson('https://api.open-meteo.com/v1/forecast?' + q), nwsNow(loc)]);
      NX.ls.set('nx_wx_cache', { key, at: Date.now(), data, obs });
      wxState = { loading: false, data, obs, error: '' };
    } catch (e) {
      wxState.loading = false; wxState.error = 'Couldn’t reach the weather service.';
    }
    paintWeather();
  }
  async function useMyLocation() {
    if (!navigator.geolocation) return NX.toast('This browser can’t share its location. Pick a city instead.', { err: true });
    NX.toast('Finding you…', { icon: 'fa-location-crosshairs' });
    const gps = await gpsLocation(true);
    if (!gps) { NX.toast('Location is blocked here. Pick a city instead.', { err: true }); return pickCity(); }
    NX.ls.set('nx_wx_loc', gps);
    loadWeather(true);
  }
  async function pickCity() {
    const q = await NX.prompt({ title: 'Weather for…', label: 'City', placeholder: 'e.g. Raleigh', ok: 'Search' });
    if (!q || !q.trim()) return;
    let res;
    try { res = (await getJson('https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&name=' + encodeURIComponent(q.trim()))).results || []; }
    catch { return NX.toast('Couldn’t search for places right now.', { err: true }); }
    if (!res.length) return NX.toast(`No place called “${q.trim()}”.`, { err: true });
    const set = (r) => { NX.ls.set('nx_wx_loc', { lat: r.latitude, lon: r.longitude, name: r.name, cc: r.country_code, src: 'city' }); loadWeather(true); };
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
          <div class="dh-hey"></div>
          <div class="dh-clock"><span class="dh-hm mono"></span><span class="dh-s mono"></span><span class="dh-ap"></span></div>
          <div class="dh-date"></div>
          <div class="dh-day"><div class="dh-day-bar"><i></i></div><span></span></div>
          <div class="dh-chips"></div>
        </div>
        <div class="dash-wx"></div>
        <div class="dh-hours"></div>
      </section>
      <section class="dash-servers"><div class="ds-head"><h2><i class="fa-solid fa-server"></i>Your servers<span class="ds-n"></span></h2><span class="grow"></span>
        <button class="btn btn-ghost btn-sm" data-f="join"><i class="fa-solid fa-right-to-bracket"></i>Join</button><button class="btn btn-primary btn-sm" data-f="create"><i class="fa-solid fa-plus"></i>Create</button></div>
        <div class="ds-row"></div></section>
      <div class="dash-grid">
        <section class="dash-card dc-active"><h2><i class="fa-solid fa-signal"></i>Active now</h2><div class="dc-body"></div></section>
        <section class="dash-card dc-week"><h2><i class="fa-solid fa-calendar-week"></i>This week</h2><div class="dc-body"></div></section>
        <section class="dash-card dc-news"><h2><i class="fa-solid fa-wand-magic-sparkles"></i>What’s new<span class="grow"></span><span class="ver">v${VERSION}</span></h2><div class="dc-body"></div></section>
      </div>

    </div>`;
    el.querySelector('.dash').addEventListener('click', onClick);
    clearInterval(tick);
    tick = setInterval(() => { if (!host?.isConnected) { clearInterval(tick); tick = null; return; } paintClock(); }, 1000);
    paintClock(); paintChips(); paintActive(); paintNews(); paintServers(); paintWeather();
    loadWeather();
    clearInterval(wxTimer);
    wxTimer = setInterval(() => { if (!host?.isConnected) { clearInterval(wxTimer); wxTimer = null; return; } if (!document.hidden) loadWeather(); }, 10 * 60e3);
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
    if (g.dataset.t !== gt) {
      g.dataset.t = gt; g.innerHTML = `${greet}, <b>${P().nameText(NX.me)}</b>`;
      // the classic portal's hero: "Hey, name 👋" with a line for the time of day
      const sub = h < 5 ? 'Still up? Somebody’s always around.' : h < 12 ? 'Fresh start. See who’s up.' : h < 17 ? 'Afternoon check-in.' : h < 22 ? 'Evening hangout time.' : 'Winding down? Say goodnight.';
      const phrase = h < 5 ? 'Up late?' : greet;
      $d('.dh-hey').innerHTML = `<div class="dh-hey-top">${P().avatar(NX.me, 22, { halo: false, deco: false })}<span>${esc(phrase)}</span></div><h1>Hey, <span class="dh-hey-n">${P().nameText(NX.me)}</span> <span class="wave">👋</span></h1><p>${esc(sub)}</p>`;
    }
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
    if (!loc && wxState.loading) { el.innerHTML = '<div class="wx-setup"><span class="spinner"></span><p>Finding your weather…</p></div>'; return; }
    if (!loc) {
      el.innerHTML = `<div class="wx-setup"><img class="wx-ic wx-big" src="${iconSrc('partly-cloudy-day')}" alt=""><b>See the weather here</b><p>Your location stays on this device.</p>
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
    const F = units() === 'f';
    const t = (cel) => (F ? cel * 9 / 5 + 32 : cel);
    // a real station reading if there is one, otherwise the model's
    const o = wxState.obs && Date.now() - wxState.obs.at < 90 * 60e3 ? wxState.obs : null;
    const temp = o ? t(o.tempC) : c.temperature_2m;
    const feels = o ? t(o.feelsC) : c.apparent_temperature;
    const wind = o && o.windKmh != null ? (F ? o.windKmh / 1.609 : o.windKmh) : c.wind_speed_10m;
    const hum = o && o.humidity != null ? o.humidity : c.relative_humidity_2m;
    const code = o && o.code != null ? o.code : c.weather_code;
    const [label, , , sky] = wx(code);
    hero.dataset.sky = sky + (day ? '' : '-night');
    const hi = Math.round(Math.max(d.daily.temperature_2m_max[0], temp)), lo = Math.round(Math.min(d.daily.temperature_2m_min[0], temp));
    const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60e3)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
    const src = o ? `Measured at ${esc(String(o.station.name || '').split(',').pop().trim() || o.station.id)} (${esc(o.station.id)}) · ${ago(o.at)}` : `Forecast model · updated ${ago(NX.ls.get('nx_wx_cache')?.at || Date.now())}`;
    const pin = loc.src === 'gps' ? 'location-crosshairs' : loc.src === 'city' ? 'location-dot' : 'wifi';
    const how = loc.src === 'gps' ? `Your exact location${loc.acc ? ` (±${loc.acc < 1000 ? loc.acc + ' m' : Math.round(loc.acc / 1000) + ' km'})` : ''}. Tap to change.`
      : loc.src === 'city' ? 'A city you picked. Tap to change.' : 'Approximate, from your internet connection. Tap to use your exact location.';
    el.innerHTML = `<div class="wx-now">
        ${wxImg(code, !day, 'wx-big', label)}
        <div class="wx-temp">${Math.round(temp)}<small>${u}</small></div>
        <div class="wx-desc"><b>${esc(o?.text || label)}</b><span>Feels like ${Math.round(feels)}° · H ${hi}° L ${lo}°</span>
          <span class="wx-meta"><img class="wx-mini" src="${iconSrc('wind')}" alt="Wind">${Math.round(wind)} ${F ? 'mph' : 'km/h'}<img class="wx-mini" src="${iconSrc('humidity')}" alt="Humidity">${Math.round(hum)}%</span></div>
      </div>
      <div class="wx-src"><i class="fa-solid fa-${o ? 'tower-broadcast' : 'satellite'}"></i>${src}</div>
      <div class="wx-place"><button class="wx-link" data-w="place" title="${esc(how)}"><i class="fa-solid fa-${pin}"></i>${esc(loc.name || 'Your location')}${loc.src === 'ip' ? '<small>approx.</small>' : ''}</button>
        <button class="wx-link" data-w="units" title="Switch units">${u === '°F' ? '°C' : '°F'}</button>
        <button class="wx-link" data-w="retry" title="Refresh"><i class="fa-solid fa-rotate${wxState.loading ? ' fa-spin' : ''}"></i></button></div>`;
    // The next 12 hours. Open-Meteo gives times on the place's own clock, so
    // "now" is worked out on that clock too (your device may be elsewhere).
    const placeNow = Date.now() + (d.utc_offset_seconds || 0) * 1000;
    const wall = (s) => Date.parse(s + 'Z');
    const nowIdx = Math.max(0, d.hourly.time.findIndex((s) => wall(s) > placeNow) - 1);
    const hourLabel = (s) => new Date(wall(s)).toLocaleTimeString(undefined, { hour: 'numeric', timeZone: 'UTC' });
    hours.innerHTML = d.hourly.time.slice(nowIdx, nowIdx + 12).map((ts, i) => {
      const k = nowIdx + i;
      const p = d.hourly.precipitation_probability?.[k];
      const night = i === 0 ? !day : d.hourly.is_day?.[k] === 0;
      return `<div class="wx-h${i === 0 ? ' now' : ''}"><span>${i === 0 ? 'Now' : hourLabel(ts)}</span>${wxImg(i === 0 ? code : d.hourly.weather_code[k], night)}<b>${Math.round(i === 0 ? temp : d.hourly.temperature_2m[k])}°</b>${p >= 20 ? `<small><i class="fa-solid fa-droplet"></i>${p}%</small>` : '<small></small>'}</div>`;
    }).join('');
    if (week) {
      const all = d.daily.temperature_2m_max.concat(d.daily.temperature_2m_min);
      const mn = Math.min(...all), mx = Math.max(...all), span = Math.max(1, mx - mn);
      week.innerHTML = d.daily.time.map((t, i) => {
        const [lab] = wx(d.daily.weather_code[i]);
        const a = d.daily.temperature_2m_min[i], b = d.daily.temperature_2m_max[i];
        const p = d.daily.precipitation_probability_max?.[i];
        return `<div class="wx-d"><span class="wd-n">${i === 0 ? 'Today' : new Date(Date.parse(t + 'T12:00Z')).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })}</span>${wxImg(d.daily.weather_code[i], false, '', lab)}
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
  // Descriptions, banners and member counts aren't in the inbox, so they're
  // fetched once per set of servers.
  const srvInfo = new Map();
  let srvInfoKey = '';
  async function loadServerInfo(ids) {
    const key = ids.slice().sort().join(',');
    if (!ids.length || key === srvInfoKey) return false;
    srvInfoKey = key;
    const { data } = await window.db.from('servers').select('id,description,banner_url,server_members(count)').in('id', ids);
    (data || []).forEach((r) => srvInfo.set(r.id, { description: r.description, banner_url: r.banner_url, members: r.server_members?.[0]?.count ?? null }));
    return true;
  }
  function srvGradient(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const a = Math.round((h * 137.508) % 360), b = (a + 48) % 360;
    return `radial-gradient(120% 140% at 0% 0%, hsl(${a} 70% 48%) 0%, transparent 62%), radial-gradient(100% 120% at 100% 100%, hsl(${b} 65% 40%) 0%, transparent 60%), linear-gradient(135deg, hsl(${b} 45% 22%), hsl(${a} 35% 12%))`;
  }
  function paintServers() {
    const row = $d('.ds-row');
    if (!row) return;
    const list = D().servers;
    $d('.ds-n').textContent = list.length ? ` · ${list.length}` : '';
    if (!list.length) {
      row.innerHTML = `<div class="dc-empty" style="grid-column:1/-1"><i class="fa-solid fa-compass"></i><b>No servers yet</b><span>Start your own, or join one with an invite link.</span></div>`;
      return;
    }
    row.innerHTML = list.map((s) => {
      const info = srvInfo.get(s.id) || {};
      const nameStyle = NX.serverNameStyle ? NX.serverNameStyle(s.theme) : '';
      const ini = esc(((s.name || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] || '').join('') || '?').toUpperCase());
      return `<button class="ds-card${s.unread ? ' unread' : ''}" data-go="s/${esc(s.id)}">
        <span class="ds-banner" style="background:${srvGradient(s.id)}" data-banner="${esc(info.banner_url || '')}"></span>
        <span class="ds-ic">${s.icon_url ? `<img ${P().imgAttr(s.icon_url)} alt="">` : ini}</span>
        ${s.unread ? '<span class="ds-new">New</span>' : ''}
        <span class="ds-body"><b class="ds-name" style="${esc(nameStyle)}">${esc(s.name)}</b>
          <span class="ds-desc">${info.description ? esc(info.description) : '<i>No description yet</i>'}</span>
          <span class="ds-foot">${info.members != null ? `<span><i class="fa-solid fa-user-group"></i>${NX.fmt.plural(info.members, 'member')}</span>` : '<span></span>'}${s.owner_id === NX.me.id ? '<span class="ds-own"><i class="fa-solid fa-crown"></i>Owner</span>' : ''}</span></span>
      </button>`;
    }).join('') + `<button class="ds-card ds-add" data-f="add-srv"><span class="ds-add-ic"><i class="fa-solid fa-plus"></i></span><b>Create or join</b><span>Start a server or use an invite</span></button>`;
    row.querySelectorAll('.ds-banner[data-banner]').forEach((b) => {
      const u = b.dataset.banner;
      if (u) NX.files.resolved(u).then((x) => { b.style.background = `url("${x}") center / cover`; }).catch(() => {});
    });
    loadServerInfo(list.map((s) => s.id)).then((changed) => { if (changed && host?.isConnected) paintServers(); }).catch(() => {});
  }

  function onClick(e) {
    const w = e.target.closest('[data-w]')?.dataset.w;
    if (w === 'locate') return useMyLocation();
    if (w === 'city') return pickCity();
    if (w === 'place') {
      return NX.menu(e.target.closest('[data-w]'), [
        { label: 'Use my exact location', icon: 'fa-location-crosshairs', onClick: useMyLocation },
        { label: 'Pick a city…', icon: 'fa-magnifying-glass', onClick: pickCity },
        { label: 'Follow where I am', icon: 'fa-location-arrow', onClick: async () => { NX.ls.del('nx_wx_loc'); NX.ls.del('nx_wx_cache'); loadWeather(true); } },
      ]);
    }
    if (w === 'retry') return loadWeather(true);
    if (w === 'units') { NX.ls.set('nx_wx_units', units() === 'f' ? 'c' : 'f'); return loadWeather(true); }
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (f === 'create' || f === 'add-srv') return NX.addServerDialog();
    if (f === 'join') return NX.joinServerDialog();
    const g = e.target.closest('[data-go]'); if (g) return NX.go(g.dataset.go);
    const d = e.target.closest('[data-dm]'); if (d) return D().openDm(d.dataset.dm);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && host?.isConnected) loadWeather(); });
  const repaint = NX.debounce(() => { if (!host?.isConnected) return; paintChips(); paintActive(); paintServers(); }, 60);
  ['presence', 'friends', 'dms', 'servers', 'unread', 'live', 'call'].forEach((ev) => NX.on(ev, repaint));
  NX.on('announcements', () => loadAnns().then(() => { if (host?.isConnected) paintAnns(); else announceNew(); }));

  NX.dash = { render, announceNew, loadAnns, VERSION };
})();
