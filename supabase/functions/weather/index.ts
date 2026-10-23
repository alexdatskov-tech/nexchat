// NexChat weather: Supabase Edge Function (Deno).
//
// One call from the app instead of a dozen: this asks every free, keyless
// source at once and sends back one answer, cached for 5 minutes so people
// near each other share it.
//   - Open-Meteo: the forecast and details, air quality, and eight models
//     (ECMWF, NOAA GFS, NOAA NBM, DWD ICON, GEM, UK Met Office,
//     Météo-France, JMA)
//   - MET Norway (yr.no) and wttr.in
//   - the US National Weather Service: the nearest station's latest reading
// With no coordinates, the place comes from the caller's IP address.
//
// Deploy: supabase functions deploy weather   (no secrets needed)
// Request (POST JSON, any signed-in user's token or the anon key):
//   { lat?, lon?, units?: 'f'|'c', cc?, name? }
// Response:
//   { place: { lat, lon, name, cc, src }, main, sources: [...], air, at }
//   main is Open-Meteo's forecast JSON in the requested units; source
//   temperatures are in °C, wind in km/h.

const UA = 'NexChat/3.1 (+https://github.com/alexdatskov-tech/nexchat)';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function get(url: string, ms = 7000, headers: Record<string, string> = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'application/json, application/geo+json', ...headers } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    // some models send bare NaN for places outside their area
    return JSON.parse((await r.text()).replace(/:\s*-?nan\b/gi, ':null'));
  } finally { clearTimeout(t); }
}

/* ---------- small caches (per function instance) ---------- */
const cache = new Map<string, { at: number; v: unknown }>();
function remember<T>(key: string, ttl: number, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.v as T);
  return make().then((v) => {
    cache.set(key, { at: Date.now(), v });
    if (cache.size > 2000) for (const k of [...cache.keys()].slice(0, 500)) cache.delete(k);
    return v;
  });
}
// A light limit per caller so the function can't be used as a free proxy.
const hits = new Map<string, number[]>();
function tooMany(ip: string) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 30;
}

/* ---------- codes ---------- */
function metCode(sym?: string) {
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
}
function textCode(t?: string) {
  const s = String(t || '').toLowerCase();
  if (/thunder|t-storm/.test(s)) return 95;
  if (/snow|sleet|flurr|ice pellets|blizzard/.test(s)) return 73;
  if (/freezing rain|freezing drizzle/.test(s)) return 66;
  if (/heavy rain|torrential/.test(s)) return 65;
  if (/shower/.test(s)) return 80;
  if (/rain|drizzle/.test(s)) return 61;
  if (/fog|mist|haze|smoke/.test(s)) return 45;
  if (/overcast/.test(s)) return 3;
  if (/mostly sunny|mostly clear/.test(s)) return 1;
  if (/partly/.test(s)) return 2;
  if (/cloudy/.test(s)) return 3;
  if (/clear|sunny|fair/.test(s)) return 0;
  return null;
}

/* ---------- place ---------- */
type Place = { lat: number; lon: number; name?: string; cc?: string; src?: string };
async function ipPlace(ip: string): Promise<Place | null> {
  if (!ip) return null;
  return remember('ip:' + ip, 6 * 3600_000, async () => {
    try {
      const r = await get(`https://get.geojs.io/v1/ip/geo/${encodeURIComponent(ip)}.json`, 4000);
      if (Number.isFinite(+r.latitude)) return { lat: +r.latitude, lon: +r.longitude, name: r.city || r.region || r.country, cc: r.country_code, src: 'ip' };
    } catch { /* fall through */ }
    try {
      const r = await get(`https://ipwho.is/${encodeURIComponent(ip)}`, 4000);
      if (r.success !== false && Number.isFinite(+r.latitude)) return { lat: +r.latitude, lon: +r.longitude, name: r.city || r.region || r.country, cc: r.country_code, src: 'ip' };
    } catch { /* nothing */ }
    return null;
  });
}
function placeName(lat: number, lon: number) {
  return remember(`rev:${lat.toFixed(2)},${lon.toFixed(2)}`, 7 * 86400_000, async () => {
    // Photon, then Nominatim (both OpenStreetMap, no key; cached a week per ~1 km)
    try {
      const r = await get(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=en`, 3000);
      const pr = r.features?.[0]?.properties;
      if (pr) return { name: pr.city || pr.town || pr.village || pr.name || pr.county || pr.state || 'Your location', cc: pr.countrycode ? String(pr.countrycode).toUpperCase() : undefined };
    } catch { /* try the next one */ }
    try {
      const r = await get(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=10&accept-language=en`, 4000);
      const a = r.address || {};
      return { name: a.city || a.town || a.village || a.suburb || a.county || a.state || 'Your location', cc: (a.country_code || '').toUpperCase() || undefined };
    } catch { return { name: 'Your location' } as { name: string; cc?: string }; }
  });
}

/* ---------- sources ---------- */
const MODELS: [string, string, string][] = [
  ['ncep_nbm_conus', 'NOAA NBM', 'US National Blend'], ['ecmwf_ifs025', 'ECMWF', 'European Centre'], ['gfs_seamless', 'NOAA GFS', 'US global model'],
  ['icon_seamless', 'DWD ICON', 'German Weather Service'], ['gem_seamless', 'GEM', 'Environment Canada'], ['ukmo_seamless', 'UK Met Office', 'UKMO'],
  ['meteofrance_seamless', 'Météo-France', 'ARPEGE / AROME'], ['jma_seamless', 'JMA', 'Japan Meteorological Agency'],
];
const usLike = (p: Place) => p.lat > 18 && p.lat < 72 && p.lon > -180 && p.lon < -64 && (!p.cc || /^(US|PR|GU|VI)$/i.test(p.cc));

function main(p: Place, f: boolean) {
  const q = new URLSearchParams({
    latitude: p.lat.toFixed(4), longitude: p.lon.toFixed(4), timezone: 'auto', forecast_days: '7',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,uv_index,precipitation,is_day',
    minutely_15: 'precipitation',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max,wind_speed_10m_max',
    temperature_unit: f ? 'fahrenheit' : 'celsius', wind_speed_unit: f ? 'mph' : 'kmh', precipitation_unit: f ? 'inch' : 'mm',
  });
  return get('https://api.open-meteo.com/v1/forecast?' + q);
}
async function models(p: Place) {
  const q = new URLSearchParams({
    latitude: p.lat.toFixed(4), longitude: p.lon.toFixed(4), timezone: 'auto', past_hours: '1', forecast_hours: '2',
    hourly: 'temperature_2m,weather_code', temperature_unit: 'celsius',
    models: MODELS.filter((m) => m[0] !== 'ncep_nbm_conus' || usLike(p)).map((m) => m[0]).join(','),
  });
  const d = await get('https://api.open-meteo.com/v1/forecast?' + q);
  const now = Date.now() + (d.utc_offset_seconds || 0) * 1000;
  const times: number[] = d.hourly.time.map((t: string) => Date.parse(t + 'Z'));
  let i = times.findIndex((t) => t > now) - 1;
  if (i < 0) i = 0;
  const frac = times[i + 1] ? Math.min(1, Math.max(0, (now - times[i]) / (times[i + 1] - times[i]))) : 0;
  return MODELS.map(([id, name, sub]) => {
    const a = d.hourly['temperature_2m_' + id]?.[i], b = d.hourly['temperature_2m_' + id]?.[i + 1];
    if (a == null) return null;
    return { id, name, sub, tempC: b == null ? a : a + (b - a) * frac, code: d.hourly['weather_code_' + id]?.[i] ?? null };
  }).filter(Boolean);
}
async function met(p: Place) {
  const d = await get(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}`);
  const ts = d.properties.timeseries;
  const now = Date.now();
  let best = ts[0];
  for (const t of ts.slice(0, 4)) if (Math.abs(Date.parse(t.time) - now) < Math.abs(Date.parse(best.time) - now)) best = t;
  const x = best.data.instant.details;
  return { id: 'metno', name: 'MET Norway', sub: 'yr.no forecast', tempC: x.air_temperature, code: metCode(best.data.next_1_hours?.summary?.symbol_code), humidity: x.relative_humidity, windKmh: x.wind_speed != null ? x.wind_speed * 3.6 : null };
}
async function wttr(p: Place) {
  const d = await get(`https://wttr.in/${p.lat.toFixed(3)},${p.lon.toFixed(3)}?format=j1`, 6000);
  const c = d.current_condition[0];
  const txt = c.weatherDesc?.[0]?.value?.trim();
  return { id: 'wttr', name: 'wttr.in', sub: 'World Weather Online', tempC: +c.temp_C, feelsC: +c.FeelsLikeC, code: textCode(txt), text: txt, humidity: +c.humidity, windKmh: +c.windspeedKmph };
}
async function nws(p: Place) {
  if (!usLike(p)) return null;
  const stations = await remember(`st:${p.lat.toFixed(2)},${p.lon.toFixed(2)}`, 7 * 86400_000, async () => {
    const pt = await get(`https://api.weather.gov/points/${p.lat.toFixed(4)},${p.lon.toFixed(4)}`);
    const list = await get(pt.properties.observationStations);
    return (list.features || []).slice(0, 4).map((f: { properties: { stationIdentifier: string; name: string } }) => ({ id: f.properties.stationIdentifier, name: f.properties.name }));
  });
  const reads = await Promise.allSettled(stations.map((st: { id: string; name: string }) =>
    get(`https://api.weather.gov/stations/${st.id}/observations/latest`, 6000).then((r) => ({ st, o: r.properties }))));
  for (const r of reads) {
    if (r.status !== 'fulfilled') continue;
    const { st, o } = r.value;
    const at = Date.parse(o.timestamp);
    if (o.temperature?.value == null || !(Date.now() - at < 90 * 60_000)) continue;
    return {
      id: 'nws', name: 'Weather station', sub: String(st.name || '').split(',').pop()!.trim() + ' (' + st.id + ')', observed: true, at,
      tempC: o.temperature.value, feelsC: o.windChill?.value ?? o.heatIndex?.value ?? o.temperature.value, code: textCode(o.textDescription), text: o.textDescription,
      humidity: o.relativeHumidity?.value, windKmh: o.windSpeed?.value, gustKmh: o.windGust?.value, dirDeg: o.windDirection?.value,
    };
  }
  return null;
}
const air = (p: Place) => get(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${p.lat.toFixed(4)}&longitude=${p.lon.toFixed(4)}&current=us_aqi,european_aqi,pm2_5,pm10,ozone&timezone=auto`).then((d) => d.current);

/* ---------- handler ---------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  if (tooMany(ip || 'unknown')) return json({ error: 'Too many weather requests. Try again in a minute.' }, 429);
  let body: { lat?: number; lon?: number; units?: string; cc?: string; name?: string } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const f = body.units !== 'c';

  let place: Place | null = null;
  let naming: Promise<{ name: string; cc?: string }> | null = null;
  if (Number.isFinite(body.lat) && Number.isFinite(body.lon) && Math.abs(body.lat!) <= 90 && Math.abs(body.lon!) <= 180) {
    place = { lat: +body.lat!, lon: +body.lon!, cc: typeof body.cc === 'string' ? body.cc.slice(0, 3) : undefined, name: typeof body.name === 'string' ? body.name.slice(0, 80) : undefined };
    if (!place.name || !place.cc) naming = placeName(place.lat, place.lon);   // runs alongside the weather
  } else {
    place = await ipPlace(ip);
    if (!place) return json({ error: 'Could not work out where you are. Pick a city instead.' }, 422);
  }

  const key = `wx:${place.lat.toFixed(2)},${place.lon.toFixed(2)},${f ? 'f' : 'c'}`;
  const named = async () => { if (naming) { const nm = await naming; place = { ...place!, cc: place!.cc || nm.cc, name: place!.name || nm.name }; } return place!; };
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return json({ place: await named(), ...(hit.v as object), cached: true });
  const p = place;
  const NAMES = ['nws', 'metno', 'wttr', 'models', 'air'];
  const jobs = [nws(p), met(p), wttr(p), models(p), air(p)];
  const done: (PromiseSettledResult<unknown> | undefined)[] = jobs.map(() => undefined);
  jobs.forEach((j, i) => j.then((v) => { done[i] = { status: 'fulfilled', value: v }; }, (e) => { done[i] = { status: 'rejected', reason: e }; }));
  const build = (m: unknown) => {
    const val = (i: number) => (done[i]?.status === 'fulfilled' ? (done[i] as PromiseFulfilledResult<unknown>).value : null);
    const ms = val(3) as unknown[] | null;
    return {
      main: m, sources: [val(0), val(1), val(2), ...(ms || [])].filter(Boolean), air: val(4), at: Date.now(),
      waiting: NAMES.filter((_, i) => !done[i]),
      failed: NAMES.filter((_, i) => done[i]?.status === 'rejected').map((n) => n + ': ' + String((done[NAMES.indexOf(n)] as PromiseRejectedResult).reason).slice(0, 120)),
    };
  };
  try {
    const [m] = await Promise.all([main(p, f), named()]);
    await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 1200))]);
    const out = build(m);
    if (!out.waiting.length) cache.set(key, { at: Date.now(), v: out });
    else {
      // let the slow ones finish in the background and cache the full answer
      const rest = Promise.allSettled(jobs).then(() => cache.set(key, { at: Date.now(), v: build(m) }));
      // deno-lint-ignore no-explicit-any
      (globalThis as any).EdgeRuntime?.waitUntil?.(rest);
    }
    return json({ place: await named(), ...out });
  } catch (e) {
    return json({ error: 'The weather services did not answer.', detail: String(e) }, 502);
  }
});
