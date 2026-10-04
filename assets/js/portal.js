(function () {
  const $ = (id) => document.getElementById(id);
  let me = null;

  // Deterministic banner per server until an owner uploads one: a deep
  // two-tone gradient whose hue comes from the server id, so every card is
  // distinct but they all sit in the same dark, low-saturation family.
  function banner(s) {
    let h = 0;
    for (const ch of String(s.id || s.name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const a = Math.round((h * 137.508) % 360), b = (a + 48) % 360;   // golden-angle spread
    return `radial-gradient(120% 140% at 0% 0%, hsl(${a} 62% 42%) 0%, transparent 60%), linear-gradient(135deg, hsl(${b} 45% 24%), hsl(${a} 30% 12%))`;
  }

  // The wallpaper is shared with DMs and server channels, so the work lives in UI.
  const applyDashboardBg = (theme) => UI.applyBackground(theme);

  /* Each card carries its own server's name styling, so one global variable
     cannot be used here the way it is on a single-server page. */
  function nameStyle(theme) {
    const col = theme?.name_color;
    const safe = /^#[0-9a-fA-F]{6}$/.test(col || '') ? col : '#FFFFFF';
    return `color:${safe};font-family:${UI.resolveNameFont(theme)}`;
  }

  function card(s) {
    const count = s.server_members?.[0]?.count ?? 0;
    const owner = s.owner_id === me.id;
    const bg = s.banner_url ? `background-image:url('${UI.esc(s.banner_url)}')` : `background:${banner(s)}`;
    const ico = s.icon_url ? `<img ${window.Store ? Store.imgAttr(s.icon_url) : `src="${UI.esc(s.icon_url)}"`} alt="">` : UI.initial(s.name);
    return `
      <button class="scard" data-id="${s.id}">
        <div class="scard-banner" style="${bg};background-size:cover;"></div>
        <div class="scard-ico">${ico}</div>
        <div class="scard-body">
          <div class="scard-name" style="${UI.esc(nameStyle(s.theme))}">
            <span>${UI.esc(s.name)}</span>
            ${owner ? '<span class="badge badge-owner">Owner</span>' : ''}
          </div>
          <div class="scard-desc">${UI.esc(s.description || 'No description.')}</div>
          <div class="scard-meta"><i class="fa-solid fa-circle"></i> ${count} member${count === 1 ? '' : 's'}</div>
        </div>
      </button>`;
  }

  async function load() {
    const { data: mem, error } = await window.db.from('server_members').select('server_id').eq('user_id', me.id);
    $('skeleton').classList.add('hidden');
    if (error) return UI.toast('Could not load servers: ' + error.message, true);

    if (!mem.length) {
      $('empty').classList.remove('hidden');
      $('serverCount').textContent = 'No servers yet';
      return;
    }

    const { data: servers, error: e2 } = await window.db
      .from('servers').select('*, server_members(count)')
      .in('id', mem.map((m) => m.server_id))
      .order('created_at', { ascending: true });
    if (e2) return UI.toast('Could not load servers: ' + e2.message, true);

    $('serverCount').textContent = `${servers.length} server${servers.length === 1 ? '' : 's'}`;
    heroStats.servers = servers.length; paintHeroStats();
    const grid = $('grid');
    grid.innerHTML = servers.map((sv, i) => card(sv).replace('<button class="scard"', `<button style="--i:${i}" class="scard rise"`)).join('')
      + '<button class="scard add" id="addCard"><i class="fa-solid fa-plus"></i><b>Create or join</b></button>';
    grid.classList.remove('hidden');
    grid.querySelectorAll('.scard[data-id]').forEach((el) => {
      el.onclick = () => { UI.go(`server.html?id=${el.dataset.id}`); };
      el.onpointerenter = () => window.Nav?.warm?.(`server.html?id=${el.dataset.id}`);
    });
    $('addCard').onclick = openCreate;
  }

  /* ---------------- greeting card ----------------
     Live numbers that count up, a typewriter line built from the user's own
     data, and a card that leans toward the cursor with a moving spotlight. */
  const heroStats = { servers: 0, online: 0, ann: 0 };
  const shown = { servers: 0, online: 0, ann: 0 };
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function paintHeroStats() {
    for (const k of Object.keys(heroStats)) {
      const el = $({ servers: 'stServers', online: 'stOnline', ann: 'stAnn' }[k]);
      if (!el) continue;
      const from = shown[k], to = heroStats[k];
      if (from === to) { el.textContent = to; continue; }
      shown[k] = to;
      if (reduceMotion) { el.textContent = to; continue; }
      const t0 = performance.now(), dur = 700;
      const step = (t) => {
        const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(from + (to - from) * e);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      el.parentElement.classList.remove('bump'); void el.offsetWidth; el.parentElement.classList.add('bump');
    }
  }

  function heroLines() {
    const h = new Date().getHours();
    const lines = [];
    if (heroStats.online) lines.push(`${heroStats.online} friend${heroStats.online === 1 ? ' is' : 's are'} online right now.`);
    if (heroStats.servers) lines.push(`You're in ${heroStats.servers} server${heroStats.servers === 1 ? '' : 's'}. Pick one and jump in.`);
    if (heroStats.ann) lines.push(`${heroStats.ann} new announcement${heroStats.ann === 1 ? '' : 's'} from the team.`);
    lines.push(h < 5 ? 'Still up? Somebody’s always around.' : h < 12 ? 'Fresh start. Catch up on what you missed.'
      : h < 18 ? 'Afternoon check-in: see what’s new.' : 'Evening crew is getting online.');
    lines.push('Start a call, share your screen, or just say hi.');
    return lines;
  }

  function typer() {
    const el = $('heroLine');
    if (!el) return;
    if (reduceMotion) { el.textContent = heroLines()[0]; return; }
    let li = 0;
    const type = (text, i = 0) => {
      el.textContent = text.slice(0, i) || ' ';
      if (i < text.length) return setTimeout(() => type(text, i + 1), 28 + Math.random() * 40);
      setTimeout(() => erase(text, text.length), 3200);
    };
    const erase = (text, i) => {
      el.textContent = text.slice(0, i) || ' ';
      if (i > 0) return setTimeout(() => erase(text, i - 1), 14);
      const lines = heroLines(); li = (li + 1) % lines.length;
      setTimeout(() => type(lines[li]), 260);
    };
    setTimeout(() => type(heroLines()[0]), 500);
  }

  async function friendsOnline() {
    const { data } = await window.db.from('friendships').select('user_id,friend_id,status').or(`user_id.eq.${me.id},friend_id.eq.${me.id}`);
    const ids = (data || []).filter((f) => f.status === 'accepted').map((f) => (f.user_id === me.id ? f.friend_id : f.user_id));
    const count = () => { heroStats.online = ids.filter((id) => window.Presence?.isOnline(id)).length; paintHeroStats(); };
    window.Presence?.onChange(count);
    count();
  }

  function hero() {
    typer();
    friendsOnline().catch(() => {});
    const card = $('hero');
    if (!card || reduceMotion || !matchMedia('(hover: hover)').matches) return;
    const spot = card.querySelector('.hero-spot');
    let r = null;
    const tilt = UI.smooth({ rx: 0, ry: 0 }, (v, done) => {
      card.style.transform = done && !v.rx && !v.ry ? '' : `perspective(1200px) rotateX(${v.rx.toFixed(3)}deg) rotateY(${v.ry.toFixed(3)}deg)`;
    }, 0.12);
    card.addEventListener('pointerenter', () => { r = card.getBoundingClientRect(); card.classList.add('lit'); });
    card.addEventListener('pointermove', (e) => {
      r = r || card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      // The spotlight is a pre-painted circle that only moves (compositor).
      if (spot) spot.style.transform = `translate3d(${(x * r.width).toFixed(1)}px, ${(y * r.height).toFixed(1)}px, 0)`;
      tilt({ rx: (0.5 - y) * 5, ry: (x - 0.5) * 7 });
    });
    card.addEventListener('pointerleave', () => { r = null; tilt({ rx: 0, ry: 0 }); card.classList.remove('lit'); });
    window.addEventListener('resize', () => { r = null; }, { passive: true });
    document.querySelector('.home')?.addEventListener('scroll', () => { r = null; }, { passive: true });
  }

  /* Latest announcements from the team; the full list lives in the panel. */
  function announcements() {
    if (!window.Nav) return;
    $('annAll').onclick = () => Nav.openAnnouncements();
    Nav.onAnnouncements((list, ok) => {
      $('annSection').classList.toggle('hidden', !ok);
      let seen = ''; try { seen = localStorage.getItem('nx_ann_seen') || ''; } catch {}
      heroStats.ann = list.filter((a) => a.created_at > seen).length;
      $('stAnnWrap').classList.toggle('hidden', !ok);
      paintHeroStats();
      $('annFeed').innerHTML = list.length
        ? list.slice(0, 4).map((a) => Nav.annCard(a, true)).join('')
        : '<div class="ann-empty"><i class="fa-solid fa-bullhorn"></i>&nbsp; No announcements right now.</div>';
    });
  }

  // ---- modals ----
  function bindModal(id) {
    const m = $(id);
    m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => m.classList.add('hidden'); });
    m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
    return m;
  }
  const mCreate = bindModal('mCreate'), mJoin = bindModal('mJoin');

  const openCreate = () => {
    $('cName').value = ''; $('cDesc').value = ''; $('cErr').textContent = '';
    $('cIconPrev').innerHTML = '<i class="fa-solid fa-image"></i>'; iconFile = null;
    mCreate.classList.remove('hidden'); setTimeout(() => $('cName').focus(), 60);
  };
  const openJoin = () => {
    $('jCode').value = ''; $('jErr').textContent = '';
    mJoin.classList.remove('hidden'); setTimeout(() => $('jCode').focus(), 60);
  };
  $('btnCreate').onclick = openCreate; $('btnCreate2').onclick = openCreate;
  $('btnJoin').onclick = openJoin; $('btnJoin2').onclick = openJoin;

  let iconFile = null;
  $('cIcon').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    iconFile = f;
    const r = new FileReader();
    r.onload = (ev) => {
      $('cIconPrev').innerHTML = `<img src="${ev.target.result}" alt="">`;
      window.Tiff?.hydrateFile($('cIconPrev').querySelector('img'), f);
    };
    r.readAsDataURL(f);
  };

  $('cGo').onclick = async () => {
    const name = $('cName').value.trim();
    if (name.length < 2) return ($('cErr').textContent = 'Give it a name — at least 2 characters.');
    const btn = $('cGo'); btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const { data: srv, error } = await window.db.from('servers')
        .insert({ name, description: $('cDesc').value.trim() || null, owner_id: me.id })
        .select().single();
      if (error) throw error;

      if (iconFile) {
        try {
          const url = await UI.upload('server-icons', iconFile, srv.id);
          await window.db.from('servers').update({ icon_url: url }).eq('id', srv.id);
        } catch (_) { /* icon is optional — never block server creation on it */ }
      }
      UI.go(`server.html?id=${srv.id}`);
    } catch (err) {
      $('cErr').textContent = err.message || 'Could not create that server.';
      btn.disabled = false; btn.textContent = 'Create server';
    }
  };

  $('jGo').onclick = async () => {
    let code = $('jCode').value.trim();
    if (code.includes('/')) code = code.split('/').filter(Boolean).pop();
    if (code.includes('=')) code = code.split('=').pop();
    if (!code) return ($('jErr').textContent = 'Paste an invite code.');
    const btn = $('jGo'); btn.disabled = true; btn.textContent = 'Joining…';
    try {
      const { data: id, error } = await window.db.rpc('join_server_by_invite', { p_code: code });
      if (error) throw error;
      UI.go(`server.html?id=${id}`);
    } catch (err) {
      $('jErr').textContent = err.message || 'That code didn\u2019t work.';
      btn.disabled = false; btn.textContent = 'Join';
    }
  };

  $('btnOut').onclick = async () => { await window.db.auth.signOut(); UI.go('index.html'); };

  (async () => {
    const s = await UI.requireSession(); if (!s) return;
    me = await UI.myProfile(s.user.id);
    if (!me) { UI.toast('Profile missing — try signing out and back in.', true); return; }
    window.Notify?.start(me);
    window.Guard?.start(me);
    window.Presence?.start(me);
    applyDashboardBg(me.theme);
    window.Nav?.mount(me, { active: 'home', onAdd: openCreate });
    $('meAv').innerHTML = UI.avatar(me, 22, { halo: false });
    $('meName').textContent = me.display_name || me.username;
    const h = new Date().getHours();
    $('greet').textContent = h < 5 ? 'Up late?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    if (me.is_platform_admin) $('adminLink').style.display = '';
    $('homeBurger').onclick = () => window.Nav?.openDrawer();
    announcements();
    hero();

    // Deep links: ?invite=CODE opens the join box pre-filled; ?new=1 (the "+"
    // in the left bar on other pages) opens create.
    const inv = UI.params().get('invite');
    if (inv) { openJoin(); $('jCode').value = inv; }
    else if (UI.params().get('new')) openCreate();

    await load();
  })();
})();
