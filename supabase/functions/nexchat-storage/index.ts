// NexChat storage signer — Supabase Edge Function (Deno).
//
// Holds the S3/iDrive e2 credentials server-side and hands authenticated
// users short-lived presigned URLs, so the bucket secret never ships to a
// browser. Deploy:
//
//   supabase secrets set S3_HOST=s3.us-west-4.idrivee2.com S3_REGION=us-west-4 \
//     S3_BUCKET=robo-test S3_ACCESS_KEY=... S3_SECRET_KEY=...
//   supabase functions deploy nexchat-storage
//
// then set STORAGE_ENDPOINT in assets/js/config.js to
//   https://<project>.supabase.co/functions/v1/nexchat-storage
//
// Request body (POST, JSON, with the user's access token as Bearer):
//   { op: 'sign',   keys: string[] }        -> { urls: { [key]: url } }
//   { op: 'put',    key, type }             -> { url, headers }
//   { op: 'delete', key }                   -> { ok: true }
//
// Access follows the key layout the app writes:
//   nexchat/dm/<conversation>/...   participants of that DM
//   nexchat/<server>/<channel>/...  members of that server
//   nexchat/users/<uid>/...         read: anyone signed in, write: <uid>
//   nexchat/roles/<server>/...      read: anyone signed in, write: managers
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const env = (k: string) => Deno.env.get(k) ?? '';
const HOST = env('S3_HOST'), REGION = env('S3_REGION'), BUCKET = env('S3_BUCKET');
const AK = env('S3_ACCESS_KEY'), SK = env('S3_SECRET_KEY');
const DAY = 86400000, WEEK_S = 7 * 86400;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const te = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha = async (s: string) => hex(await crypto.subtle.digest('SHA-256', te.encode(s)));
async function hmac(k: ArrayBuffer | Uint8Array, m: string) {
  const ck = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', ck, te.encode(m));
}
const E = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg',
  wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', txt: 'text/plain', json: 'application/json',
};
const mimeOf = (k: string) => MIME[(k.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

// SigV4 query-string presign. GETs are signed from the start of the UTC day so
// a file's URL is stable (and cacheable) all day.
async function presign(method: 'GET' | 'PUT' | 'DELETE', key: string, expires: number, at: Date, extra: Record<string, string> = {}) {
  const amz = at.toISOString().replace(/[:-]/g, '').split('.')[0] + 'Z', date = amz.slice(0, 8);
  const scope = `${date}/${REGION}/s3/aws4_request`;
  const path = `/${BUCKET}/${key.split('/').map(E).join('/')}`;
  const q: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${AK}/${scope}`, 'X-Amz-Date': amz,
    'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host', ...extra,
  };
  const qs = Object.keys(q).sort().map((k) => `${E(k)}=${E(q[k])}`).join('&');
  const canon = `${method}\n${path}\n${qs}\nhost:${HOST}\n\nhost\nUNSIGNED-PAYLOAD`;
  const s2s = `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${await sha(canon)}`;
  let k = await hmac(te.encode('AWS4' + SK), date);
  k = await hmac(k, REGION); k = await hmac(k, 's3'); k = await hmac(k, 'aws4_request');
  return `https://${HOST}${path}?${qs}&X-Amz-Signature=${hex(await hmac(k, s2s))}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!HOST || !BUCKET || !AK || !SK) return json({ error: 'Storage secrets are not configured' }, 500);

  const auth = req.headers.get('authorization') ?? '';
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: auth } } });
  const { data: u } = await db.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
  const uid = u?.user?.id;
  if (!uid) return json({ error: 'Sign in first' }, 401);

  // Memoised per request: a batch of 30 keys from one DM costs one lookup.
  const memo = new Map<string, Promise<boolean>>();
  const once = (k: string, f: () => Promise<boolean>) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k)!; };
  const inDm = (cid: string) => once('dm:' + cid, async () =>
    !!(await db.from('dm_participants').select('user_id').eq('conversation_id', cid).eq('user_id', uid).maybeSingle()).data);
  const inServer = (sid: string) => once('s:' + sid, async () =>
    !!(await db.from('server_members').select('user_id').eq('server_id', sid).eq('user_id', uid).maybeSingle()).data);
  const manages = (sid: string) => once('m:' + sid, async () =>
    !!(await db.rpc('has_permission', { p_server_id: sid, p_user_id: uid, p_bit: 8 })).data);

  async function allowed(key: string, write: boolean) {
    if (!/^nexchat\/[\w.\-\/]+$/.test(key) || key.includes('..')) return false;
    const [, a, b] = key.split('/');
    if (a === 'dm') return inDm(b);
    if (a === 'users') return write ? b === uid : true;
    if (a === 'roles') return write ? manages(b) : true;
    return inServer(a);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

  if (body.op === 'sign') {
    const keys: string[] = Array.isArray(body.keys) ? body.keys.slice(0, 100) : [];
    const at = new Date(Math.floor(Date.now() / DAY) * DAY);
    const urls: Record<string, string> = {};
    await Promise.all(keys.map(async (k) => {
      if (await allowed(k, false)) {
        urls[k] = await presign('GET', k, WEEK_S, at, {
          'response-content-disposition': 'inline', 'response-content-type': mimeOf(k),
        });
      }
    }));
    return json({ urls });
  }

  if (body.op === 'put') {
    const key = String(body.key || '');
    if (!(await allowed(key, true))) return json({ error: 'Not allowed' }, 403);
    return json({ url: await presign('PUT', key, 900, new Date()), headers: {} });
  }

  if (body.op === 'delete') {
    const key = String(body.key || '');
    if (!(await allowed(key, true))) return json({ error: 'Not allowed' }, 403);
    const r = await fetch(await presign('DELETE', key, 300, new Date()), { method: 'DELETE' });
    return json({ ok: r.ok || r.status === 404 });
  }

  return json({ error: 'Unknown op' }, 400);
});
