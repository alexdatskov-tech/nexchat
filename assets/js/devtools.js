// Profile -> Developer: developer token, bot creation and bot list.
// Talks to the bot-api Edge Function (supabase/functions/bot-api).
//
// The whole bot platform sits behind one owner switch (platform_features,
// key 'bot_api'). While it is off, the section is greyed out and nothing is
// sent. The owner sees a switch to turn it on or off.
(() => {
  const BASE = window.NEXCHAT_CONFIG.SUPABASE_URL + '/functions/v1/bot-api/v1';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let enabled = false, isOwner = false;

  async function api(route, method = 'GET', body) {
    const { data } = await window.db.auth.getSession();
    const res = await fetch(BASE + route, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (data.session?.access_token || '') },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'Request failed (' + res.status + ').');
    return j;
  }

  // Greys out the section and disables its controls while the platform is off.
  function paintSwitch() {
    $('botPlatform').classList.toggle('feature-off', !enabled);
    $('botOffNote').classList.toggle('hidden', enabled);
    $('botOffNote').textContent = 'Temporarily unavailable. The bot platform is switched off by the owner. Bot API by andrew.';
    ['devTokenBtn', 'botMake'].forEach((id) => { $(id).disabled = !enabled; });
    ['botUser', 'botName', 'botPass'].forEach((id) => { $(id).disabled = !enabled; });
    $('botOwner').classList.toggle('hidden', !isOwner);
    $('botSwitch').checked = enabled;
    // Off: show the Bots block greyed out, so people can see what is coming back.
    if (!enabled) $('botBlock').classList.remove('hidden');
  }

  async function loadBots() {
    const list = $('botList');
    const { data, error } = await window.db.from('bots')
      .select('id, created_at, profiles!user_id(username, display_name)').order('created_at');
    if (error) { list.innerHTML = '<div class="bsub">Could not load bots: ' + esc(error.message) + '</div>'; return; }
    if (!data?.length) { list.innerHTML = '<div class="bsub">No bots yet.</div>'; return; }
    list.innerHTML = data.map((b) => `
      <div class="set-row" data-bot="${esc(b.id)}">
        <div class="info"><b>${esc(b.profiles?.display_name || b.profiles?.username || 'bot')}</b>
          <small>@${esc(b.profiles?.username || '')} &middot; created ${new Date(b.created_at).toLocaleDateString()}</small></div>
        <button class="btn btn-quiet btn-sm" data-del="${esc(b.id)}">Delete</button>
      </div>`).join('');
    list.querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Delete this bot account? Its messages stay, but it can no longer log in.')) return;
        try { await api('/bots/delete', 'POST', { bot_id: btn.dataset.del }); loadBots(); }
        catch (e) { $('botErr').textContent = e.message; }
      };
    });
  }

  async function refresh() {
    if (!enabled) return;
    try {
      const s = await api('/dev/status');
      $('devStatus').textContent = s.has_token
        ? 'Developer access is on. The token was last used ' + (s.last_used_at ? new Date(s.last_used_at).toLocaleString() : 'never') + '.'
        : 'Developer access is off. Create a token to turn it on.';
      $('botBlock').classList.toggle('hidden', !s.is_developer);
      if (s.is_developer) loadBots();
    } catch (e) {
      $('devStatus').textContent = 'Could not check developer status: ' + e.message;
    }
  }

  $('devTokenBtn').onclick = async () => {
    $('devErr').textContent = '';
    if (!confirm('Create a new developer token? Any old token stops working.')) return;
    try {
      const { token } = await api('/dev/token', 'POST', {});
      $('devTokenVal').textContent = token;
      $('devTokenBox').classList.remove('hidden');
      refresh();
    } catch (e) { $('devErr').textContent = e.message; }
  };

  $('botForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!enabled) return;
    $('botErr').textContent = '';
    const btn = $('botMake'); btn.disabled = true;
    try {
      await api('/bots', 'POST', {
        username: $('botUser').value.trim(),
        display_name: $('botName').value.trim(),
        password: $('botPass').value,
      });
      $('botForm').reset();
      loadBots();
    } catch (err) { $('botErr').textContent = err.message; }
    finally { btn.disabled = !enabled; }
  };

  // Owner only. The database checks the role again; this just shows the switch.
  $('botSwitch').onchange = async (e) => {
    const want = e.target.checked;
    try {
      const { error } = await window.db.rpc('set_platform_feature', { p_key: 'bot_api', p_enabled: want });
      if (error) throw error;
      enabled = want;
      paintSwitch();
      if (enabled) refresh();
      window.UI?.toast('Bot API ' + (enabled ? 'is on.' : 'is off.'));
    } catch (err) {
      e.target.checked = enabled;
      window.UI?.toast(err.message || 'Could not change the switch.', true);
    }
  };

  async function init() {
    try {
      const { data: sess } = await window.db.auth.getSession();
      const uid = sess.session?.user?.id;
      const [{ data: flag }, { data: prof }] = await Promise.all([
        window.db.from('platform_features').select('enabled').eq('key', 'bot_api').maybeSingle(),
        uid ? window.db.from('profiles').select('platform_role').eq('id', uid).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      enabled = !!flag?.enabled;
      isOwner = prof?.platform_role === 'owner';
    } catch { enabled = false; }
    paintSwitch();
    if (enabled) refresh();
    else $('devStatus').textContent = 'The bot platform is temporarily unavailable.';
  }

  window.addEventListener('load', init);
})();
