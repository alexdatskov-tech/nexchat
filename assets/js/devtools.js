// Profile -> Developer: developer token, bot creation and bot list.
// Talks to the bot-api Edge Function (supabase/functions/bot-api).
(() => {
  const BASE = window.NEXCHAT_CONFIG.SUPABASE_URL + '/functions/v1/bot-api/v1';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    finally { btn.disabled = false; }
  };

  window.addEventListener('load', refresh);
})();
