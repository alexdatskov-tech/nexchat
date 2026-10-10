// NexChat bot API — Supabase Edge Function (Deno). One deploy for every bot.
//
// Deploy:  supabase functions deploy bot-api --no-verify-jwt
//          (auth is checked inside, so the gateway must let requests through)
// Base URL: https://<project>.supabase.co/functions/v1/bot-api/v1
//
// Two kinds of credential:
//   1. Developer token  "Authorization: Bearer nxdev_..."
//      Made in Profile -> Developer. Manages bots only (create, list, delete).
//      It cannot send messages: bots act with their own login.
//   2. Bot session  "Authorization: Bearer <access_token>"
//      From POST /v1/auth/login with the bot's username + password. Every
//      chat call runs as the bot, so normal server permissions apply.
//
// Service-role access is used only for the bot admin routes and the rate
// limiter. Chat routes use the bot's own session, so RLS still applies.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BOT_EMAIL_DOMAIN = 'bots.nexchat.invalid';
const MAX_BOTS_PER_DEV = 10;
const LIMIT_API = 120;      // requests per minute, per bot
const LIMIT_DEV = 60;       // management requests per minute, per developer
const LIMIT_LOGIN = 10;     // login attempts per minute, per username

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
const fail = (status: number, error: string) => json({ error }, status);

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const asUser = (jwt: string) =>
  createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

const enc = new TextEncoder();
async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function newDevToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return 'nxdev_' + btoa(String.fromCharCode(...b)).replace(/[+/=]/g, '').slice(0, 43);
}

type Caller = { uid: string; jwt: string | null; viaDevToken: boolean };

async function who(req: Request): Promise<Caller | null> {
  const tok = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  if (tok.startsWith('nxdev_')) {
    const { data } = await admin.from('dev_tokens').select('user_id').eq('token_hash', await sha256(tok)).maybeSingle();
    if (!data) return null;
    await admin.from('dev_tokens').update({ last_used_at: new Date().toISOString() }).eq('user_id', data.user_id);
    return { uid: data.user_id, jwt: null, viaDevToken: true };
  }
  const { data, error } = await admin.auth.getUser(tok);
  if (error || !data.user) return null;
  return { uid: data.user.id, jwt: tok, viaDevToken: false };
}

async function isDeveloper(uid: string): Promise<boolean> {
  const { data } = await admin.from('profiles').select('is_developer').eq('id', uid).maybeSingle();
  return !!data?.is_developer;
}

async function limited(key: string, limit: number): Promise<boolean> {
  const { data, error } = await admin.rpc('bot_rate_take', { p_key: key, p_limit: limit });
  if (error) return false; // fail closed if the limiter is broken
  return data !== true;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try { return (await req.json()) ?? {}; } catch { return {}; }
}

const USERNAME = /^[a-z0-9_]{3,24}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // Platform switch (supabase/bot_api_switch.sql). Off means every route is
  // closed, including login. Missing row also counts as off.
  const { data: feat } = await admin.from('platform_features').select('enabled').eq('key', 'bot_api').maybeSingle();
  if (!feat?.enabled) return fail(503, 'The bot API is temporarily unavailable.');

  const url = new URL(req.url);
  // Last '/v1/' so the function's own /functions/v1/ prefix is skipped.
  const at = url.pathname.lastIndexOf('/v1/');
  const route = (at >= 0 ? url.pathname.slice(at) : url.pathname).replace(/\/+$/, '');
  const key = `${req.method} ${route}`;

  // Public: bot login. Returns a session the bot uses for chat calls.
  if (key === 'POST /v1/auth/login') {
    const b = await readBody(req);
    const username = String(b.username ?? '').trim().toLowerCase();
    const password = String(b.password ?? '');
    if (!USERNAME.test(username) || !password) return fail(400, 'Enter the bot username and password.');
    if (await limited('login:' + username, LIMIT_LOGIN)) return fail(429, 'Too many login attempts. Wait a minute.');
    const { data: prof } = await admin.from('profiles').select('id').eq('username', username).eq('is_bot', true).maybeSingle();
    if (!prof) return fail(401, 'Wrong username or password.');
    const { data: au } = await admin.auth.admin.getUserById(prof.id);
    if (!au?.user?.email) return fail(401, 'Wrong username or password.');
    const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await anon.auth.signInWithPassword({ email: au.user.email, password });
    if (error || !data.session) return fail(401, 'Wrong username or password.');
    return json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      user_id: prof.id,
    });
  }

  const me = await who(req);
  if (!me) return fail(401, 'Missing or invalid token.');

  // ---- developer management (developer token or a developer's session) ----
  if (route.startsWith('/v1/dev/') || route === '/v1/bots' || route.startsWith('/v1/bots/')) {
    if (await limited('dev:' + me.uid, LIMIT_DEV)) return fail(429, 'Too many requests. Wait a minute.');
  }

  // Make or rotate the developer token. Needs a normal session (not a token).
  if (key === 'POST /v1/dev/token') {
    if (me.viaDevToken) return fail(403, 'Sign in to the website to rotate the token.');
    const tok = newDevToken();
    const { error } = await admin.from('dev_tokens').upsert(
      { user_id: me.uid, token_hash: await sha256(tok), created_at: new Date().toISOString(), last_used_at: null },
      { onConflict: 'user_id' },
    );
    if (error) return fail(500, 'Could not save the token.');
    // Developer status only. This never grants platform admin rank.
    await admin.from('profiles').update({ is_developer: true }).eq('id', me.uid);
    return json({ token: tok, note: 'Shown once. Store it somewhere safe.' });
  }

  if (key === 'GET /v1/dev/status') {
    const { data } = await admin.from('dev_tokens').select('created_at,last_used_at').eq('user_id', me.uid).maybeSingle();
    return json({ is_developer: await isDeveloper(me.uid), has_token: !!data, token_created_at: data?.created_at ?? null, last_used_at: data?.last_used_at ?? null });
  }

  if (key === 'POST /v1/bots') {
    if (!(await isDeveloper(me.uid))) return fail(403, 'Turn on developer access in Profile -> Developer first.');
    const b = await readBody(req);
    const username = String(b.username ?? '').trim().toLowerCase();
    const password = String(b.password ?? '');
    const display = String(b.display_name ?? '').trim().slice(0, 40);
    if (!USERNAME.test(username)) return fail(400, 'Bot usernames are 3-24 characters: a-z, 0-9, underscore.');
    if (password.length < 10) return fail(400, 'Use a password of at least 10 characters.');

    const { data: taken } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
    if (taken) return fail(409, 'That username is taken.');
    const { count } = await admin.from('bots').select('id', { count: 'exact', head: true }).eq('owner_id', me.uid);
    if ((count ?? 0) >= MAX_BOTS_PER_DEV) return fail(403, `Developers can have up to ${MAX_BOTS_PER_DEV} bots.`);

    const email = `bot-${crypto.randomUUID()}@${BOT_EMAIL_DOMAIN}`;
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { username, is_bot: true },
    });
    if (cErr || !created.user) return fail(500, 'Could not create the bot account.');
    const botId = created.user.id;

    const undo = async () => { await admin.auth.admin.deleteUser(botId); };
    const { error: pErr } = await admin.from('profiles').upsert({
      id: botId, username, display_name: display || username, is_bot: true, bot_owner_id: me.uid,
    }, { onConflict: 'id' });
    if (pErr) { await undo(); return fail(500, 'Could not create the bot profile.'); }
    const { data: row, error: bErr } = await admin.from('bots')
      .insert({ user_id: botId, owner_id: me.uid }).select('id').single();
    if (bErr) { await undo(); return fail(500, 'Could not register the bot.'); }
    return json({ id: row.id, user_id: botId, username }, 201);
  }

  if (key === 'GET /v1/bots') {
    const { data, error } = await admin.from('bots')
      .select('id, user_id, created_at, profiles!user_id(username, display_name)')
      .eq('owner_id', me.uid).order('created_at');
    if (error) return fail(500, 'Could not load bots.');
    return json({ bots: data ?? [] });
  }

  if (key === 'POST /v1/bots/delete') {
    const b = await readBody(req);
    const { data: row } = await admin.from('bots').select('user_id').eq('id', String(b.bot_id ?? '')).eq('owner_id', me.uid).maybeSingle();
    if (!row) return fail(404, 'No such bot on your account.');
    await admin.auth.admin.deleteUser(row.user_id); // cascades to profile and bots row
    return json({ ok: true });
  }

  // ---- chat routes: run as the bot itself ----
  if (me.viaDevToken || !me.jwt) return fail(403, 'Chat calls need a bot session. Use POST /v1/auth/login.');
  if (await limited('api:' + me.uid, LIMIT_API)) return fail(429, 'Rate limit reached. Slow down.');
  const c = asUser(me.jwt);

  if (key === 'GET /v1/me') {
    const { data, error } = await c.from('profiles').select('id, username, display_name, is_bot').eq('id', me.uid).single();
    return error ? fail(404, 'Profile not found.') : json(data);
  }

  if (key === 'GET /v1/servers') {
    const { data, error } = await c.from('server_members').select('servers(id, name, description)').eq('user_id', me.uid);
    return error ? fail(500, error.message) : json({ servers: (data ?? []).map((r) => r.servers).filter(Boolean) });
  }

  const m1 = route.match(/^\/v1\/servers\/([0-9a-f-]{36})\/channels$/);
  if (key.startsWith('GET ') && m1) {
    const { data, error } = await c.from('channels').select('*').eq('server_id', m1[1]).order('position');
    return error ? fail(403, 'Not a member of that server.') : json({ channels: data ?? [] });
  }

  const m2 = route.match(/^\/v1\/channels\/([0-9a-f-]{36})\/messages$/);
  if (m2 && key.startsWith('GET ')) {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 100);
    const { data, error } = await c.from('messages')
      .select('id, content, created_at, author_id').eq('channel_id', m2[1])
      .order('created_at', { ascending: false }).limit(limit);
    return error ? fail(403, 'Cannot read that channel.') : json({ messages: data ?? [] });
  }
  if (m2 && key.startsWith('POST ')) {
    const b = await readBody(req);
    const content = String(b.content ?? '').trim();
    if (!content || content.length > 2000) return fail(400, 'Messages are 1-2000 characters.');
    const { data, error } = await c.from('messages')
      .insert({ channel_id: m2[1], author_id: me.uid, content }).select('id, created_at').single();
    return error ? fail(403, 'Cannot post in that channel.') : json(data, 201);
  }

  if (key === 'GET /v1/friends') {
    const { data, error } = await c.from('friendships').select('user_id, friend_id, status')
      .or(`user_id.eq.${me.uid},friend_id.eq.${me.uid}`);
    return error ? fail(500, error.message) : json({ friendships: data ?? [] });
  }

  if (key === 'POST /v1/friends') {
    const b = await readBody(req);
    const username = String(b.username ?? '').trim().toLowerCase();
    if (!USERNAME.test(username)) return fail(400, 'Give a username.');
    const { error } = await c.rpc('send_friend_request', { p_username: username });
    return error ? fail(400, error.message) : json({ ok: true });
  }

  if (key === 'POST /v1/friends/accept') {
    const b = await readBody(req);
    const { error } = await c.rpc('accept_friend_request', { p_from: String(b.user_id ?? '') });
    return error ? fail(400, error.message) : json({ ok: true });
  }

  return fail(404, `No route ${key}.`);
});
