// NexChat CloudGate proxy: Supabase Edge Function (Deno).
//
// Holds the CloudGate logins server-side, so they stop shipping to every
// browser (today anyone can read them from config.js or storage_client_config
// and delete every stored file). The browser sends the CloudGate call it wants
// to make; this function checks who is asking and what they're touching, adds
// the login, and forwards it.
//
// Deploy (Supabase CLI):
//   supabase link --project-ref xqzibelnvjlmavgrpyve
//   # Fallback endpoints for before storage groups are set up (JSON list):
//   supabase secrets set CLOUDGATE_ENDPOINTS='[{"id":"cfg-0","base":"https://alexd-us1-s3.wasmer.app","user":"admin","pass":"NEW-PASSWORD"}]'
//   supabase secrets set CLOUDGATE_CATEGORY=nexchats-us1
//   supabase functions deploy cloudgate-proxy
// Then in assets/js/config.js set CLOUDGATE.proxy to
//   'https://xqzibelnvjlmavgrpyve.supabase.co/functions/v1/cloudgate-proxy'
// remove the user/pass from CLOUDGATE.endpoints, change the CloudGate password,
// and run supabase/nexchat_v3_storage_lockdown.sql.
//
// Request (POST, JSON, the user's access token as Bearer):
//   { endpoint_id, path, method, body?, query? }   -> CloudGate's response
// Rules:
//   - uploads go to <category>/attachments/... (anyone signed in) or to
//     <category>/vault/<own user id>/... (the caller's private drive)
//   - deleting/renaming a file: inside your own vault, a file you uploaded
//     (storage_objects.owner_id), or staff
//   - browsing and folders: inside your own vault only
//   - /api/stats: staff who manage storage endpoints
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const env = (k: string) => Deno.env.get(k) ?? '';
const SUPABASE_URL = env('SUPABASE_URL');
const ANON = env('SUPABASE_ANON_KEY');
const SERVICE = env('SUPABASE_SERVICE_ROLE_KEY');
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const ROUTES = new Set([
  'POST /api/upload/presign', 'POST /api/upload/multipart/create', 'POST /api/upload/multipart/complete',
  'POST /api/upload/multipart/abort', 'DELETE /api/files', 'POST /api/files/rename', 'GET /api/files/exists',
  'GET /api/browse', 'POST /api/folders', 'POST /api/folders/rename', 'DELETE /api/folders', 'GET /api/download',
  'GET /api/stats', 'GET /ping',
]);

type Ep = { id: string; base: string; user: string; pass: string };
const clean = (p: unknown) => String(p ?? '').split('/').filter(Boolean).join('/');
// CloudGate keys look like public/<account>/<category>/<path...>
const inCategory = (key: string, category: string) => {
  const parts = String(key || '').split('/');
  return parts[2] === category ? parts.slice(3).join('/') : null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const authz = req.headers.get('authorization') || '';
  const asUser = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authz } } });
  const { data: who } = await asUser.auth.getUser();
  const uid = who?.user?.id;
  if (!uid) return json({ error: 'Sign in first.' }, 401);

  let r: { endpoint_id?: string; path?: string; method?: string; body?: Record<string, unknown>; query?: Record<string, string>; test?: { base: string; user: string; pass: string } };
  try { r = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const method = String(r.method || 'GET').toUpperCase();
  const path = String(r.path || '');
  if (!ROUTES.has(`${method} ${path}`)) return json({ error: 'Not allowed' }, 403);
  if (path === '/ping') return json({ ok: true });

  const admin = createClient(SUPABASE_URL, SERVICE);
  const { data: banned } = await admin.from('profiles').select('is_banned').eq('id', uid).maybeSingle();
  if (banned?.is_banned) return json({ error: 'Account banned.' }, 403);
  const can = async (perm: string) => !!(await asUser.rpc('nx_can', { p_perm: perm })).data;

  // which storage, and its login
  const { data: settings } = await admin.from('storage_settings').select('category, confirmed').eq('id', 1).maybeSingle();
  const category = (settings?.confirmed && settings.category) || env('CLOUDGATE_CATEGORY') || 'nexchats-us1';
  let ep: Ep | null = null;
  if (path === '/api/stats' && r.test) {
    if (!(await can('manage_storage_endpoints'))) return json({ error: 'Not allowed' }, 403);
    ep = { id: 'test', base: String(r.test.base || '').replace(/\/+$/, ''), user: r.test.user, pass: r.test.pass };
    if (!/^https:\/\//.test(ep.base)) return json({ error: 'Endpoint must be https' }, 400);
  } else if (r.endpoint_id && /^[0-9a-f-]{36}$/i.test(r.endpoint_id)) {
    const { data } = await admin.from('storage_endpoints').select('id, base_url, username, password').eq('id', r.endpoint_id).maybeSingle();
    if (data) ep = { id: data.id, base: String(data.base_url).replace(/\/+$/, ''), user: data.username, pass: data.password };
  } else {
    let list: Ep[] = [];
    try { list = JSON.parse(env('CLOUDGATE_ENDPOINTS') || '[]'); } catch { /* none */ }
    ep = list.find((e) => e.id === r.endpoint_id) || list[0] || null;
    if (ep) ep.base = String(ep.base).replace(/\/+$/, '');
  }
  if (!ep?.base || !ep.user || !ep.pass) return json({ error: 'Storage is not configured.' }, 503);

  // authorisation
  const body = { ...(r.body || {}) };
  const query = { ...(r.query || {}) };
  const vault = `vault/${uid}`;
  const mine = (p: string | null) => !!p && (p === vault || p.startsWith(vault + '/'));
  const ownsKey = async (key: string) => {
    if (mine(inCategory(key, category))) return true;
    const { data } = await admin.from('storage_objects').select('owner_id').eq('key', key).maybeSingle();
    if (data?.owner_id === uid) return true;
    return await can('delete_messages');
  };
  if (path === '/api/stats') {
    if (!r.test && !(await can('manage_storage_endpoints')) && !(await can('manage_storage'))) return json({ error: 'Not allowed' }, 403);
  } else if (path === '/api/upload/presign' || path === '/api/upload/multipart/create') {
    body.category = category;
    const p = clean(body.path);
    if (!(p === 'attachments' || p.startsWith('attachments/') || mine(p))) return json({ error: 'You can’t upload there.' }, 403);
    body.path = p;
  } else if (path === '/api/upload/multipart/complete' || path === '/api/upload/multipart/abort') {
    const rel = inCategory(String(body.key || ''), category);
    if (!rel || !(rel.startsWith('attachments/') || mine(rel))) return json({ error: 'Not allowed' }, 403);
  } else if (path === '/api/files' || path === '/api/files/rename') {
    if (!(await ownsKey(String(body.key || '')))) return json({ error: 'That isn’t your file.' }, 403);
  } else if (path === '/api/files/exists' || path === '/api/download') {
    const rel = inCategory(String(query.key || ''), category);
    if (!rel) return json({ error: 'Not allowed' }, 403);
    // attachments are public on the CDN anyway; vault files only for their owner
    if (rel.startsWith('vault/') && !mine(rel)) return json({ error: 'Not allowed' }, 403);
  } else if (path === '/api/browse') {
    query.category = category;
    if (!mine(clean(query.path))) return json({ error: 'Not allowed' }, 403);
  } else if (path.startsWith('/api/folders')) {
    body.category = category;
    if (!mine(clean(body.path))) return json({ error: 'Not allowed' }, 403);
  }

  // forward
  const url = new URL(ep.base + path);
  Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)));
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: 'Basic ' + btoa(`${ep.user}:${ep.pass}`), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
      body: method !== 'GET' ? JSON.stringify(body) : undefined,
    });
  } catch {
    return json({ error: 'Storage unreachable' }, 502);
  }
  // Remember who uploaded what, so only they (or staff) can delete it later.
  if (res.ok && (path === '/api/upload/presign' || path === '/api/upload/multipart/create')) {
    const out = await res.clone().json().catch(() => null);
    if (out?.key) {
      await admin.from('storage_objects').upsert({ key: out.key, owner_id: uid, size: Number(body.size) || 0, endpoint_id: /^[0-9a-f-]{36}$/i.test(ep.id) ? ep.id : null }, { onConflict: 'key', ignoreDuplicates: true });
    }
  }
  const headers = new Headers(CORS);
  const ct = res.headers.get('content-type');
  if (ct) headers.set('content-type', ct);
  return new Response(res.body, { status: res.status, headers });
});
