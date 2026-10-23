/* Weather for the home page, fetched by the Supabase Edge Function
   "weather" in one call (the browser asks the sources itself if the
   function can't be reached). Free public sources, no keys:
     - Open-Meteo: the forecast, details, air quality, and eight separate
       weather models (ECMWF, NOAA GFS, NOAA NBM, DWD ICON, GEM, UK Met
       Office, Météo-France, JMA)
     - MET Norway (the yr.no forecast) and wttr.in
     - the US National Weather Service: the latest real reading from the
       nearest weather station
   "Now" is the station's measurement when there is a fresh one, otherwise
   the middle value of every source. Cached weather shows instantly and is
   refreshed in the background; the place follows your exact location (asked
   once), a city you pick, or your IP address as a fallback.
   Icons: Meteocons by Bas Milius (MIT), in assets/wx. */
(function () {
  const { esc } = NX;

  /* ---------- codes, icons, units ---------- */
  const WX = {
    0: ['Clear', 'clear'], 1: ['Mostly clear', 'clear'], 2: ['Partly cloudy', 'cloud'], 3: ['Overcast', 'cloud'],
    45: ['Fog', 'fog'], 48: ['Freezing fog', 'fog'],
    51: ['Light drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Heavy drizzle', 'rain'], 56: ['Freezing drizzle', 'rain'], 57: ['Freezing drizzle', 'rain'],
    61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'], 66: ['Freezing rain', 'rain'], 67: ['Freezing rain', 'rain'],
    71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'],
    80: ['Showers', 'rain'], 81: ['Showers', 'rain'], 82: ['Violent showers', 'rain'], 85: ['Snow showers', 'snow'], 86: ['Snow showers', 'snow'],
    95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm, hail', 'storm'], 99: ['Thunderstorm, hail', 'storm'],
  };
  const ICON = {
    0: ['clear-day', 'clear-night'], 1: ['clear-day', 'clear-night'], 2: ['partly-cloudy-day', 'partly-cloudy-night'], 3: ['cloudy', 'cloudy'],
    45: ['fog-day', 'fog-night'], 48: ['fog-day', 'fog-night'],
    51: ['partly-cloudy-day-drizzle', 'partly-cloudy-night-drizzle'], 53: ['drizzle', 'drizzle'], 55: ['drizzle', 'drizzle'], 56: ['sleet', 'sleet'], 57: ['sleet', 'sleet'],
    61: ['rain', 'rain'], 63: ['rain', 'rain'], 65: ['extreme-rain', 'extreme-rain'], 66: ['sleet', 'sleet'], 67: ['sleet', 'sleet'],
    71: ['partly-cloudy-day-snow', 'partly-cloudy-night-snow'], 73: ['snow', 'snow'], 75: ['extreme-snow', 'extreme-snow'], 77: ['snow', 'snow'],
    80: ['partly-cloudy-day-rain', 'partly-cloudy-night-rain'], 81: ['rain', 'rain'], 82: ['extreme-rain', 'extreme-rain'], 85: ['partly-cloudy-day-snow', 'partly-cloudy-night-snow'], 86: ['extreme-snow', 'extreme-snow'],
    95: ['thunderstorms-day-rain', 'thunderstorms-night-rain'], 96: ['hail', 'hail'], 99: ['hail', 'hail'],
  };
  const label = (code) => (WX[code] || ['—'])[0];
  const skyOf = (code) => (WX[code] || [, 'cloud'])[1];
  const still = () => document.body.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const iconSrc = (name) => `assets/wx/${still() ? 'still/' : ''}${name}.svg`;
  const img = (code, night, cls = '', title = '') => {
    const name = (ICON[code] || ['not-available', 'not-available'])[night ? 1 : 0];
    return `<img class="wx-ic ${cls}" src="${iconSrc(name)}" alt="${esc(title || label(code))}" draggable="false">`;
  };
  // MET Norway symbol codes → the WMO codes above
  const metCode = (sym) => {
    const s = String(sym || '').replace(/_(day|night|polartwilight)$/, '');
    if (/thunder/.test(s)) return 95;
    if (/heavysnow/.test(s)) return 75;
    if (/snow/.test(s)) return /showers/.test(s) ? 85 : 73;
    if (/sleet/.test(s)) return 66;
    if (/heavyrain/.test(s)) return 65;
    if (/lightrain/.test(s)) return /showers/.test(s) ? 80 : 61;
    if (/rain/.test(s)) return /showers/.test(s) ? 81 : 63;
    if (s === 'fog') return 45;
    if (s === 'cloudy') return 3;
    if (s === 'partlycloudy') return 2;
    if (s === 'fair') return 1;
    if (s === 'clearsky') return 0;
    return null;
  };
  // Words (NWS, wttr.in) → WMO codes
  const textCode = (t) => {
    t = String(t || '').toLowerCase();
    if (/thunder|t-storm/.test(t)) return 95;
    if (/snow|sleet|flurr|ice pellets|blizzard/.test(t)) return 73;
    if (/freezing rain|freezing drizzle/.test(t)) return 66;
    if (/heavy rain|torrential/.test(t)) return 65;
    if (/shower/.test(t)) return 80;
    if (/rain|drizzle/.test(t)) return 61;
    if (/fog|mist|haze|smoke/.test(t)) return 45;
    if (/overcast/.test(t)) return 3;
    if (/mostly sunny|mostly clear/.test(t)) return 1;
    if (/partly/.test(t)) return 2;
    if (/cloudy/.test(t)) return 3;
    if (/clear|sunny|fair/.test(t)) return 0;
    return null;
  };
  const units = () => NX.ls.get('nx_wx_units') || (/^en-(US|LR|MM)\b/.test(navigator.language || '') || /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Indiana|Boise|Kentucky)/.test(Intl.DateTimeFormat().resolvedOptions().timeZone || '') ? 'f' : 'c');
  const F = () => units() === 'f';
  const cToU = (c) => (c == null ? null : F() ? c * 9 / 5 + 32 : c);
  const kmhToU = (k) => (k == null ? null : F() ? k / 1.609 : k);
  const median = (a) => { const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (deg) => (deg == null ? '' : COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);
  const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60e3)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };

  async function getJson(url, ms = 7000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  /* ---------- where ---------- */
  const saved = () => NX.ls.get('nx_wx_loc');
  async function ipLocation() {
    const tries = [
      ['https://get.geojs.io/v1/ip/geo.json', (r) => ({ lat: +r.latitude, lon: +r.longitude, name: r.city || r.region || r.country, cc: r.country_code })],
      ['https://ipwho.is/', (r) => (r.success === false ? null : { lat: +r.latitude, lon: +r.longitude, name: r.city || r.region || r.country, cc: r.country_code })],
    ];
    for (const [url, pick] of tries) {
      try {
        const loc = pick(await getJson(url, 4000));
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) return { ...loc, name: loc.name || 'Your area', src: 'ip', at: Date.now() };
      } catch {}
    }
    return null;
  }
  const gpsState = async () => { try { return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { return 'prompt'; } };
  const gpsFix = (timeout) => new Promise((ok, no) => {
    if (!navigator.geolocation) return no(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition((p) => ok(p.coords), no, { enableHighAccuracy: false, timeout, maximumAge: 30 * 60e3 });
  });
  async function placeName(lat, lon) {
    try {
      const r = await getJson(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, 4000);
      return { name: r.city || r.locality || r.principalSubdivision || 'Your location', cc: r.countryCode };
    } catch { return { name: 'Your location' }; }
  }
  async function gpsLocation(ask) {
    const st = await gpsState();
    if (st === 'denied' || (st !== 'granted' && !ask)) return null;
    try {
      const c = await gpsFix(ask ? 15000 : 8000);
      const old = saved();
      const near = old && old.src === 'gps' && Math.hypot(old.lat - c.latitude, old.lon - c.longitude) < 0.02;
      const where = near ? { name: old.name, cc: old.cc } : await placeName(c.latitude, c.longitude);
      return { lat: c.latitude, lon: c.longitude, ...where, src: 'gps', acc: Math.round(c.accuracy || 0), at: Date.now() };
    } catch { return null; }
  }
  const far = (a, b) => !a || !b || Math.hypot(a.lat - b.lat, a.lon - b.lon) > 0.02;   // ~2 km
  // Checks in the background whether you've moved; reloads if you have.
  async function refreshPlace() {
    const cur = saved();
    if (cur?.src === 'city') return;
    const asked = NX.ls.get('nx_wx_asked');
    const gps = await gpsLocation(!asked);
    if (!asked) NX.ls.set('nx_wx_asked', 1);
    let next = gps;
    if (!next && (!cur || cur.src === 'ip') && (!cur || Date.now() - (cur.at || 0) > 12 * 36e5)) next = await ipLocation();
    if (next && (far(next, cur) || next.src !== cur?.src)) {
      NX.ls.set('nx_wx_loc', next);
      if (far(next, cur)) load(true);
      else paint();
    }
  }

  /* ---------- fetching ---------- */
  const MODELS = [
    ['ncep_nbm_conus', 'NOAA NBM', 'US National Blend'], ['ecmwf_ifs025', 'ECMWF', 'European Centre'], ['gfs_seamless', 'NOAA GFS', 'US global model'],
    ['icon_seamless', 'DWD ICON', 'German Weather Service'], ['gem_seamless', 'GEM', 'Environment Canada'], ['ukmo_seamless', 'UK Met Office', 'UKMO'],
    ['meteofrance_seamless', 'Météo-France', 'ARPEGE / AROME'], ['jma_seamless', 'JMA', 'Japan Meteorological Agency'],
  ];
  const usLike = (loc) => loc.lat > 18 && loc.lat < 72 && loc.lon > -180 && loc.lon < -64 && (!loc.cc || /^(US|PR|GU|VI)$/i.test(loc.cc));
  function mainUrl(loc) {
    const q = new URLSearchParams({
      latitude: loc.lat.toFixed(4), longitude: loc.lon.toFixed(4), timezone: 'auto', forecast_days: '7',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,uv_index,precipitation,is_day',
      minutely_15: 'precipitation',
      hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max,wind_speed_10m_max',
      temperature_unit: F() ? 'fahrenheit' : 'celsius', wind_speed_unit: F() ? 'mph' : 'kmh', precipitation_unit: F() ? 'inch' : 'mm',
    });
    return 'https://api.open-meteo.com/v1/forecast?' + q;
  }
  async function fetchModels(loc) {
    const q = new URLSearchParams({
      latitude: loc.lat.toFixed(4), longitude: loc.lon.toFixed(4), timezone: 'auto', past_hours: '1', forecast_hours: '2',
      hourly: 'temperature_2m,weather_code', models: MODELS.map((m) => m[0]).join(','), temperature_unit: 'celsius',
    });
    const d = await getJson('https://api.open-meteo.com/v1/forecast?' + q);
    const now = Date.now() + (d.utc_offset_seconds || 0) * 1000;
    const times = d.hourly.time.map((t) => Date.parse(t + 'Z'));
    let i = times.findIndex((t) => t > now) - 1;
    if (i < 0) i = 0;
    const frac = times[i + 1] ? Math.min(1, Math.max(0, (now - times[i]) / (times[i + 1] - times[i]))) : 0;
    return MODELS.map(([id, name, sub]) => {
      const a = d.hourly['temperature_2m_' + id]?.[i], b = d.hourly['temperature_2m_' + id]?.[i + 1];
      if (a == null) return null;
      const c = b == null ? a : a + (b - a) * frac;   // between the two hours either side of now
      return { id, name, sub, tempC: c, code: d.hourly['weather_code_' + id]?.[i] };
    }).filter(Boolean);
  }
  async function fetchMet(loc) {
    const d = await getJson(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${loc.lat.toFixed(4)}&lon=${loc.lon.toFixed(4)}`);
    const ts = d.properties.timeseries;
    const now = Date.now();
    let best = ts[0];
    for (const t of ts.slice(0, 4)) if (Math.abs(Date.parse(t.time) - now) < Math.abs(Date.parse(best.time) - now)) best = t;
    const x = best.data.instant.details;
    const sym = best.data.next_1_hours?.summary?.symbol_code;
    return { id: 'metno', name: 'MET Norway', sub: 'yr.no forecast', tempC: x.air_temperature, code: metCode(sym), humidity: x.relative_humidity, windKmh: x.wind_speed != null ? x.wind_speed * 3.6 : null };
  }
  async function fetchWttr(loc) {
    const d = await getJson(`https://wttr.in/${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}?format=j1`, 6000);
    const c = d.current_condition[0];
    const txt = c.weatherDesc?.[0]?.value?.trim();
    return { id: 'wttr', name: 'wttr.in', sub: 'World Weather Online', tempC: +c.temp_C, feelsC: +c.FeelsLikeC, code: textCode(txt), text: txt, humidity: +c.humidity, windKmh: +c.windspeedKmph };
  }
  async function fetchNws(loc) {
    if (!usLike(loc)) return null;
    const key = 'nx_wx_st:' + loc.lat.toFixed(2) + ',' + loc.lon.toFixed(2);
    let stations = NX.ls.get(key);
    if (!stations) {
      const pt = await getJson(`https://api.weather.gov/points/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`);
      const list = await getJson(pt.properties.observationStations);
      stations = (list.features || []).slice(0, 4).map((f) => ({ id: f.properties.stationIdentifier, name: f.properties.name }));
      NX.ls.set(key, stations);
    }
    // ask the nearest stations at once and take the closest fresh reading
    const reads = await Promise.allSettled(stations.map((st) => getJson(`https://api.weather.gov/stations/${st.id}/observations/latest`, 6000).then((r) => ({ st, o: r.properties }))));
    for (const r of reads) {
      if (r.status !== 'fulfilled') continue;
      const { st, o } = r.value;
      const at = Date.parse(o.timestamp);
      if (o.temperature?.value == null || !(Date.now() - at < 90 * 60e3)) continue;
      return {
        id: 'nws', name: 'Weather station', sub: String(st.name || '').split(',').pop().trim() + ' (' + st.id + ')', observed: true, at,
        tempC: o.temperature.value, feelsC: o.windChill?.value ?? o.heatIndex?.value ?? o.temperature.value, code: textCode(o.textDescription), text: o.textDescription,
        humidity: o.relativeHumidity?.value, windKmh: o.windSpeed?.value, gustKmh: o.windGust?.value, dirDeg: o.windDirection?.value,
      };
    }
    return null;
  }
  async function fetchAir(loc) {
    const d = await getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.lat.toFixed(4)}&longitude=${loc.lon.toFixed(4)}&current=us_aqi,european_aqi,pm2_5,pm10,ozone&timezone=auto`);
    return d.current;
  }

  let state = { main: null, sources: [], air: null, at: 0, loading: false, error: '' };
  let root = null, timer = null, loadSeq = 0;
  const cacheKey = (loc) => `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)},${units()}`;

  // The Supabase Edge Function "weather" (supabase/functions/weather) does the
  // fetching server-side in one call; if it can't be reached, the browser
  // asks the sources itself.
  async function viaFunction(loc) {
    if (!window.db?.functions) throw new Error('no functions client');
    const body = { units: units() };
    if (loc) Object.assign(body, { lat: +loc.lat.toFixed(4), lon: +loc.lon.toFixed(4), name: loc.name, cc: loc.cc });
    const call = window.db.functions.invoke('weather', { body });
    const r = await Promise.race([call, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 6000))]);
    if (r.error || !r.data?.main) throw r.error || new Error(r.data?.error || 'no data');
    return r.data;
  }
  async function viaBrowser(loc) {
    const extras = Promise.allSettled([fetchNws(loc), fetchMet(loc), fetchWttr(loc), fetchModels(loc), fetchAir(loc)]);
    const main = await getJson(mainUrl(loc));
    const [nws, met, wttr, models, air] = await extras;
    const val = (r) => (r.status === 'fulfilled' ? r.value : null);
    return { main, sources: [val(nws), val(met), val(wttr), ...(val(models) || [])].filter(Boolean), air: val(air) };
  }

  async function load(force = false) {
    const seq = ++loadSeq;
    let loc = saved();
    if (loc && !force) refreshPlace();
    const key = loc ? cacheKey(loc) : null;
    const cache = NX.ls.get('nx_wx_cache2');
    if (key && cache?.key === key) {
      state = { ...state, ...cache.state };
      paint();
      if (!force && Date.now() - cache.at < 10 * 60e3) return;
    } else state = { main: null, sources: [], air: null, at: 0, loading: true, error: '' };
    state.loading = true; state.error = ''; paint();
    let got = null;
    try {
      got = await viaFunction(loc);
      // first visit: the function worked out the place from the IP address
      if (!loc && got.place) { loc = { ...got.place, src: 'ip', at: Date.now() }; NX.ls.set('nx_wx_loc', loc); refreshPlace(); }
    } catch {
      try {
        if (!loc) { loc = await ipLocation(); if (loc) NX.ls.set('nx_wx_loc', loc); refreshPlace(); }
        if (loc) got = await viaBrowser(loc);
      } catch { /* both ways failed */ }
    }
    if (seq !== loadSeq) return;
    state.loading = false;
    if (got?.main) {
      state.main = got.main; state.sources = got.sources || []; state.air = got.air || null; state.at = Date.now();
      NX.ls.set('nx_wx_cache2', { key: cacheKey(loc), at: Date.now(), state: { main: state.main, sources: state.sources, air: state.air, at: state.at } });
    } else if (!state.main) state.error = loc ? 'Couldn’t reach the weather service.' : '';
    paint();
  }

  /* ---------- the numbers shown ---------- */
  function now() {
    const m = state.main;
    if (!m) return null;
    const c = m.current;
    const obs = state.sources.find((s) => s.observed && Date.now() - s.at < 90 * 60e3);
    const forecasts = state.sources.filter((s) => !s.observed).map((s) => s.tempC);
    const modelTemp = cToU(median(forecasts));
    const temp = obs ? cToU(obs.tempC) : modelTemp != null ? modelTemp : c.temperature_2m;
    const codes = state.sources.map((s) => s.code).filter((x) => x != null);
    const code = obs?.code ?? c.weather_code ?? codes[0];
    const all = state.sources.map((s) => cToU(s.tempC)).filter(Number.isFinite);
    return {
      temp, code, obs, day: c.is_day !== 0,
      feels: obs ? cToU(obs.feelsC) : c.apparent_temperature + (temp - c.temperature_2m),
      humidity: obs?.humidity ?? c.relative_humidity_2m,
      wind: obs?.windKmh != null ? kmhToU(obs.windKmh) : c.wind_speed_10m,
      gust: obs?.gustKmh != null ? kmhToU(obs.gustKmh) : c.wind_gusts_10m,
      dir: obs?.dirDeg ?? c.wind_direction_10m,
      text: obs?.text || label(code),
      spread: all.length > 1 ? Math.max(...all) - Math.min(...all) : null, count: state.sources.length,
    };
  }
  // On the place's own clock (Open-Meteo times are local to the place).
  const placeNow = () => Date.now() + (state.main?.utc_offset_seconds || 0) * 1000;
  const wall = (s) => Date.parse(s.length === 10 ? s + 'T12:00Z' : s + 'Z');
  const clock = (s) => new Date(wall(s)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  function rainSoon() {
    const m = state.main?.minutely_15;
    if (!m) return null;
    const t0 = placeNow();
    const idx = m.time.findIndex((t) => wall(t) + 15 * 60e3 > t0);
    if (idx < 0) return null;
    const slots = m.time.slice(idx, idx + 8).map((t, i) => ({ t: wall(t), p: m.precipitation[idx + i] || 0 }));
    const wet = (x) => x.p >= (F() ? 0.004 : 0.1);
    if (wet(slots[0])) {
      const end = slots.findIndex((x) => !wet(x));
      return { now: true, txt: end < 0 ? 'Rain for at least the next 2 hours' : `Rain stopping in about ${Math.max(15, Math.round((slots[end].t - t0) / 60e3 / 5) * 5)} min` };
    }
    const start = slots.findIndex(wet);
    return start < 0 ? { now: false, txt: 'No rain in the next 2 hours' } : { now: false, soon: true, txt: `Rain starting in about ${Math.max(5, Math.round((slots[start].t - t0) / 60e3 / 5) * 5)} min` };
  }

  /* ---------- painting ---------- */
  const $r = (sel) => root?.querySelector(sel);
  function paint() {
    if (!root?.isConnected) return;
    const card = $r('.dash-wx'), hours = $r('.dh-hours'), week = $r('.dc-week .dc-body'), det = $r('.dc-wxd .dc-body'), srcs = $r('.dc-wxs .dc-body'), hero = $r('.dash-hero');
    if (!card) return;
    const loc = saved();
    const n = now();
    if (!n) {
      card.innerHTML = state.error
        ? `<div class="wx-setup"><img class="wx-ic wx-big" src="${iconSrc('not-available')}" alt=""><b>${esc(state.error)}</b><button class="btn btn-ghost btn-sm" data-w="retry">Try again</button></div>`
        : !loc && !state.loading
          ? `<div class="wx-setup"><img class="wx-ic wx-big" src="${iconSrc('partly-cloudy-day')}" alt=""><b>See the weather here</b><p>Your location stays on this device.</p><div class="row" style="gap:8px;flex-wrap:wrap;justify-content:center"><button class="btn btn-primary btn-sm" data-w="locate"><i class="fa-solid fa-location-crosshairs"></i>Use my location</button><button class="btn btn-ghost btn-sm" data-w="city"><i class="fa-solid fa-magnifying-glass"></i>Pick a city</button></div></div>`
          : `<div class="wx-setup"><img class="wx-ic wx-big" src="${iconSrc('partly-cloudy-day')}" alt=""><p>Checking the sky…</p></div>`;
      if (hours) hours.innerHTML = '';
      [week, det, srcs].forEach((el) => { if (el) el.innerHTML = '<div class="wx-skel"></div><div class="wx-skel"></div><div class="wx-skel"></div>'; });
      return;
    }
    const m = state.main, d = m.daily, u = F() ? '°F' : '°C';
    hero.dataset.sky = skyOf(n.code) + (n.day ? '' : '-night');
    const hi = Math.round(Math.max(d.temperature_2m_max[0], n.temp)), lo = Math.round(Math.min(d.temperature_2m_min[0], n.temp));
    const rain = rainSoon();
    const pin = loc?.src === 'gps' ? 'location-crosshairs' : loc?.src === 'city' ? 'location-dot' : 'wifi';
    const how = loc?.src === 'gps' ? `Your exact location${loc.acc ? ` (±${loc.acc < 1000 ? loc.acc + ' m' : Math.round(loc.acc / 1000) + ' km'})` : ''}. Tap to change.`
      : loc?.src === 'city' ? 'A city you picked. Tap to change.' : 'Approximate, from your internet connection. Tap to use your exact location.';
    const src = n.obs ? `Measured at ${esc(n.obs.sub)} · ${ago(n.obs.at)}` : n.count ? `Middle of ${n.count} forecast sources · ${ago(state.at)}` : `Open-Meteo · ${ago(state.at)}`;
    card.innerHTML = `<div class="wx-now">
        ${img(n.code, !n.day, 'wx-big', n.text)}
        <div class="wx-temp">${Math.round(n.temp)}<small>${u}</small></div>
        <div class="wx-desc"><b>${esc(n.text)}</b><span>Feels like ${Math.round(n.feels)}° · H ${hi}° L ${lo}°</span>
          <span class="wx-meta"><img class="wx-mini" src="${iconSrc('wind')}" alt="Wind">${Math.round(n.wind)} ${F() ? 'mph' : 'km/h'} ${compass(n.dir)}<img class="wx-mini" src="${iconSrc('humidity')}" alt="Humidity">${Math.round(n.humidity)}%</span></div>
      </div>
      ${rain ? `<div class="wx-rain${rain.now || rain.soon ? ' wet' : ''}"><img class="wx-mini" src="${iconSrc(rain.now || rain.soon ? 'raindrop' : 'clear-day')}" alt="">${esc(rain.txt)}</div>` : ''}
      <div class="wx-src"><i class="fa-solid fa-${n.obs ? 'tower-broadcast' : 'layer-group'}"></i>${src}</div>
      <div class="wx-place"><button class="wx-link" data-w="place" title="${esc(how)}"><i class="fa-solid fa-${pin}"></i>${esc(loc?.name || 'Your location')}${loc?.src === 'ip' ? '<small>approx.</small>' : ''}</button>
        <button class="wx-link" data-w="units" title="Switch units">${F() ? '°C' : '°F'}</button>
        <button class="wx-link" data-w="retry" title="Refresh"><i class="fa-solid fa-rotate${state.loading ? ' fa-spin' : ''}"></i></button></div>`;

    // next 12 hours
    const h = m.hourly, t0 = placeNow();
    const i0 = Math.max(0, h.time.findIndex((t) => wall(t) > t0) - 1);
    hours.innerHTML = h.time.slice(i0, i0 + 12).map((ts, i) => {
      const k = i0 + i, p = h.precipitation_probability?.[k];
      const night = i === 0 ? !n.day : h.is_day?.[k] === 0;
      return `<div class="wx-h${i === 0 ? ' now' : ''}"><span>${i === 0 ? 'Now' : new Date(wall(ts)).toLocaleTimeString(undefined, { hour: 'numeric', timeZone: 'UTC' })}</span>${img(i === 0 ? n.code : h.weather_code[k], night)}<b>${Math.round(i === 0 ? n.temp : h.temperature_2m[k])}°</b>${p >= 20 ? `<small><i class="fa-solid fa-droplet"></i>${p}%</small>` : '<small></small>'}</div>`;
    }).join('');

    // the week
    if (week) {
      const all = d.temperature_2m_max.concat(d.temperature_2m_min);
      const mn = Math.min(...all), mx = Math.max(...all), span = Math.max(1, mx - mn);
      week.innerHTML = d.time.map((t, i) => {
        const a = d.temperature_2m_min[i], b = d.temperature_2m_max[i], p = d.precipitation_probability_max?.[i];
        return `<div class="wx-d"><span class="wd-n">${i === 0 ? 'Today' : new Date(wall(t)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })}</span>${img(d.weather_code[i], false, '', label(d.weather_code[i]))}
          <small class="wd-p">${p >= 20 ? p + '%' : ''}</small><span class="wd-lo">${Math.round(a)}°</span>
          <span class="wd-bar"><i style="left:${((a - mn) / span) * 100}%;right:${100 - ((b - mn) / span) * 100}%"></i></span><span class="wd-hi">${Math.round(b)}°</span></div>`;
      }).join('');
    }

    // details
    if (det) {
      const c = m.current;
      const uv = c.uv_index, uvMax = d.uv_index_max?.[0];
      const uvLv = (x) => (x == null ? ['—', ''] : x < 3 ? ['Low', 'ok'] : x < 6 ? ['Moderate', 'warn'] : x < 8 ? ['High', 'hot'] : x < 11 ? ['Very high', 'bad'] : ['Extreme', 'bad']);
      const aqi = state.air?.us_aqi;
      const aqLv = aqi == null ? ['—', ''] : aqi <= 50 ? ['Good', 'ok'] : aqi <= 100 ? ['Moderate', 'warn'] : aqi <= 150 ? ['Unhealthy for some', 'hot'] : aqi <= 200 ? ['Unhealthy', 'bad'] : aqi <= 300 ? ['Very unhealthy', 'bad'] : ['Hazardous', 'bad'];
      const vis = c.visibility, visTxt = vis == null ? '—' : F() ? (vis / 1609).toFixed(vis < 16090 ? 1 : 0) + ' mi' : (vis / 1000).toFixed(vis < 10000 ? 1 : 0) + ' km';
      const pres = c.pressure_msl, presTxt = pres == null ? '—' : F() ? (pres * 0.02953).toFixed(2) + ' inHg' : Math.round(pres) + ' hPa';
      // after dark, the next sunrise is tomorrow's
      const sunset = d.sunset?.[0];
      const afterDark = sunset && wall(sunset) < t0;
      const sunrise = afterDark ? d.sunrise?.[1] : d.sunrise?.[0];
      const dayLeft = sunset ? Math.round((wall(sunset) - t0) / 60e3) : null;
      const tile = (icon, k, v, sub = '', cls = '') => `<div class="wxd ${cls}"><img class="wxd-ic" src="${iconSrc(icon)}" alt=""><span class="wxd-k">${k}</span><b class="wxd-v">${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
      det.innerHTML = `<div class="wxd-grid">
        ${tile('uv-index', 'UV index', uv != null ? Math.round(uv) + ' · ' + uvLv(uv)[0] : '—', uvMax != null ? 'Peak today ' + Math.round(uvMax) : '', uvLv(uv)[1])}
        ${tile('dust', 'Air quality', aqi != null ? aqi + ' · ' + aqLv[0] : '—', state.air?.pm2_5 != null ? `PM2.5 ${Math.round(state.air.pm2_5)} µg/m³` : 'US AQI', aqLv[1])}
        ${tile('wind', 'Wind', `${Math.round(n.wind)} ${F() ? 'mph' : 'km/h'} <span class="wxd-arrow" style="transform:rotate(${(n.dir || 0) + 180}deg)">↑</span>`, n.gust != null ? `Gusts ${Math.round(n.gust)} · from the ${compass(n.dir) || '—'}` : '')}
        ${tile('humidity', 'Humidity', Math.round(n.humidity) + '%', c.dew_point_2m != null ? `Dew point ${Math.round(c.dew_point_2m)}°` : '')}
        ${tile('barometer', 'Pressure', presTxt)}
        ${tile('mist', 'Visibility', visTxt)}
        ${tile('cloudy', 'Clouds', c.cloud_cover != null ? Math.round(c.cloud_cover) + '%' : '—')}
        ${tile('raindrops', 'Rain today', d.precipitation_sum?.[0] != null ? `${(+d.precipitation_sum[0]).toFixed(F() ? 2 : 1)} ${F() ? 'in' : 'mm'}` : '—', d.precipitation_probability_max?.[0] != null ? `Chance ${d.precipitation_probability_max[0]}%` : '')}
        ${tile('sunrise', afterDark ? 'Sunrise tomorrow' : 'Sunrise', sunrise ? clock(sunrise) : '—')}
        ${tile('sunset', 'Sunset', sunset ? clock(sunset) : '—', dayLeft > 0 ? `${Math.floor(dayLeft / 60)}h ${dayLeft % 60}m of daylight left` : '')}
      </div>`;
    }

    // sources
    if (srcs) {
      const list = state.sources.slice().sort((a, b) => (b.observed ? 1 : 0) - (a.observed ? 1 : 0));
      if (!list.length) { srcs.innerHTML = `<p class="muted" style="font-size:13px">${state.loading ? 'Asking every source…' : 'Only the main forecast answered this time.'}</p>`; }
      else {
        const temps = list.map((s) => cToU(s.tempC));
        const lo2 = Math.min(...temps) - 1, hi2 = Math.max(...temps) + 1, span2 = Math.max(1, hi2 - lo2);
        const head = n.spread != null ? `<p class="wxs-agree">${list.length} sources ${n.spread <= 3 ? 'agree' : 'roughly agree'}: <b>within ${Math.round(n.spread)}°</b>${n.obs ? ', and the station reading is a real measurement' : ''}.</p>` : '';
        srcs.innerHTML = head + list.map((s) => {
          const t = cToU(s.tempC);
          return `<div class="wxs${s.observed ? ' obs' : ''}"><span class="wxs-n"><b>${esc(s.name)}</b><small>${esc(s.sub || '')}</small></span>
            ${s.code != null ? img(s.code, !n.day, 'wxs-ic', label(s.code)) : '<span class="wxs-ic"></span>'}
            <span class="wxs-bar"><i style="left:${((t - lo2) / span2) * 100}%"></i></span><b class="wxs-t">${Math.round(t)}°</b></div>`;
        }).join('');
      }
    }
  }

  /* ---------- actions ---------- */
  async function useMyLocation() {
    if (!navigator.geolocation) return NX.toast('This browser can’t share its location. Pick a city instead.', { err: true });
    NX.toast('Finding you…', { icon: 'fa-location-crosshairs' });
    const gps = await gpsLocation(true);
    if (!gps) { NX.toast('Location is blocked here. Pick a city instead.', { err: true }); return pickCity(); }
    NX.ls.set('nx_wx_loc', gps);
    load(true);
  }
  async function pickCity() {
    const q = await NX.prompt({ title: 'Weather for…', label: 'City', placeholder: 'e.g. Raleigh', ok: 'Search' });
    if (!q || !q.trim()) return;
    let res;
    try { res = (await getJson('https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&name=' + encodeURIComponent(q.trim()))).results || []; }
    catch { return NX.toast('Couldn’t search for places right now.', { err: true }); }
    if (!res.length) return NX.toast(`No place called “${q.trim()}”.`, { err: true });
    const set = (r) => { NX.ls.set('nx_wx_loc', { lat: r.latitude, lon: r.longitude, name: r.name, cc: r.country_code, src: 'city' }); load(true); };
    if (res.length === 1) return set(res[0]);
    NX.menu($r('[data-w="place"]') || $r('.dash-wx'), res.map((r) => ({ label: [r.name, r.admin1, r.country].filter(Boolean).join(', '), icon: 'fa-location-dot', onClick: () => set(r) })));
  }
  function onClick(e) {
    const b = e.target.closest('[data-w]');
    if (!b) return;
    const w = b.dataset.w;
    if (w === 'locate') return useMyLocation();
    if (w === 'city') return pickCity();
    if (w === 'retry') return load(true);
    if (w === 'units') { NX.ls.set('nx_wx_units', F() ? 'c' : 'f'); return load(true); }
    if (w === 'place') {
      NX.menu(b, [
        { label: 'Use my exact location', icon: 'fa-location-crosshairs', onClick: useMyLocation },
        { label: 'Pick a city…', icon: 'fa-magnifying-glass', onClick: pickCity },
        { label: 'Follow where I am', icon: 'fa-location-arrow', onClick: () => { NX.ls.del('nx_wx_loc'); NX.ls.del('nx_wx_cache2'); load(true); } },
      ]);
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && root?.isConnected) load(); });

  // Draws the weather into the dashboard element and keeps it fresh.
  function mount(el) {
    root = el;
    el.addEventListener('click', onClick);
    paint();
    load();
    clearInterval(timer);
    timer = setInterval(() => { if (!root?.isConnected) { clearInterval(timer); timer = null; return; } if (!document.hidden) load(); }, 10 * 60e3);
  }

  NX.weather = { mount, load, img };
})();
