(function () {
  const $ = (id) => document.getElementById(id);
  let me = null, avatarFile = null, bannerFile = null;
  let clearAvatar = false, clearBanner = false;

  const PRESETS = ['#2FBF87', '#3B9EF5', '#8B7CF6', '#E8659A', '#E8B04B', '#E5484D', '#5AC8D8', '#94A3B8'];
  const BG_PRESETS = [
    { n: 'None',    v: '' },
    { n: 'Aurora',  v: 'linear-gradient(135deg,#0B3B2E,#0C2436 55%,#211B3D)' },
    { n: 'Ember',   v: 'linear-gradient(135deg,#3A1D14,#2A1520 60%,#161018)' },
    { n: 'Deep',    v: 'linear-gradient(135deg,#0A1A2F,#0B1220 60%,#0A0A12)' },
    { n: 'Moss',    v: 'linear-gradient(135deg,#16281B,#101E23 60%,#0D1014)' },
    { n: 'Dusk',    v: 'radial-gradient(120% 100% at 20% 0%,#2B2246,#141222 55%,#0B0A11)' },
  ];
  let wallpaperKey = '', wallpaperSelection = 0;
  let bgVal = '', bgDim = 0, bgBlur = 0, bgBright = 100, wpFile = null, devMode = false, manualStun = [];
  let uiStyle = 'solid';   // 'solid' (Midnight) or 'glass' (Liquid glass)
  // Chat-column overlay, defaulted from UI so the slider and the renderer agree.
  let chatBlur = UI.CHAT_BLUR_DEFAULT, chatDim = UI.CHAT_DIM_DEFAULT;

  // Same applier the rest of the app uses, fed from the in-progress edits so the
  // preview matches exactly what saving will produce.
  function applyBg() {
    UI.applyBackground({ dash_bg: bgVal, dash_wallpaper_key: wallpaperKey, dash_dim: bgDim, dash_blur: bgBlur, dash_bright: bgBright, chat_blur: chatBlur, chat_dim: chatDim, ui_style: uiStyle });
  }
  function paintBgUI() {
    document.querySelectorAll('.bg-preset').forEach((el) => el.classList.toggle('on', !wallpaperKey && !wpFile && el.dataset.v === bgVal));
    $('fBgDim').value = bgDim; $('bgDimV').textContent = bgDim + '%';
    $('fBgBlur').value = bgBlur; $('bgBlurV').textContent = bgBlur + 'px';
    $('fBgBright').value = bgBright; $('bgBrightV').textContent = bgBright + '%';
    $('fChatBlur').value = chatBlur; $('chatBlurV').textContent = chatBlur + 'px';
    $('fChatDim').value = chatDim; $('chatDimV').textContent = chatDim + '%';
    applyBg();
  }

  // ---- tabs ----
  document.querySelectorAll('.set-nav button[data-tab]').forEach((b) => {
    b.onclick = async () => {
      // Leaving an editable pane with unsaved changes: save, discard or stay.
      const cur = document.querySelector('[data-pane]:not(.hidden)');
      if (window.SettingsUI?.dirty && cur && cur.dataset.nosave === undefined && cur.dataset.pane !== b.dataset.tab) {
        const choice = await window.SettingsUI.askLeave();
        if (choice === 'stay') return;
        if (choice === 'save') {
          await $('btnSave').onclick();
          if (window.SettingsUI.dirty) return;   // the save failed: stay so nothing is lost
        } else {
          hydrate();                              // discard: back to the saved values
          window.SettingsUI.clean();
        }
      }
      document.querySelectorAll('.set-nav button[data-tab]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
      // Only the editable panes need the save bar.
      $('saveBar').classList.toggle('hidden', ['account', 'dev', 'drive', 'shop'].includes(b.dataset.tab));
      if (b.dataset.tab === 'shop') renderShop();
      document.querySelector('.set-wrap')?.classList.toggle('drive-open', b.dataset.tab === 'drive');
      if (b.dataset.tab === 'drive' && me) window.Drive?.mount(me, $('driveHost'));
      try { history.replaceState(null, '', b.dataset.tab === 'profile' ? location.pathname + location.search : '#' + b.dataset.tab); } catch {}
      document.querySelector('.set-main')?.scrollTo({ top: 0 });
    };
  });

  // ---- live preview ----
  function paint() {
    const display = $('fDisplay').value.trim() || me.username;
    const accent = $('fAccent').value;
    const bio = $('fBio').value.trim();
    const th = me.theme || {};
    const bioDeco = UI.nxDecoPath({ is_nitro: me.is_nitro, theme: th }, 'bio');
    const pfpDeco = UI.nxDecoPath({ is_nitro: me.is_nitro, theme: th }, 'pfp');

    // The name as it will appear (style, font, ASCII art), from the editor state.
    const who = { ...me, display_name: display, accent_color: accent, is_nitro: me.is_nitro, theme: { ...th, name_style: nameDraft } };
    $('pvName').innerHTML = UI.nxNameHtml(who);
    $('pvHandle').textContent = '@' + me.username;

    const bioEl = $('pvBio');
    bioEl.classList.toggle('bio-deco-box', !!bioDeco);
    bioEl.classList.toggle('hidden', !bio && !bioDeco);
    bioEl.innerHTML = `${bioDeco ? UI.bioDecoImgs(bioDeco) : ''}<span></span>`;
    bioEl.querySelector('span').textContent = bio || (bioDeco ? 'Your bio sits here.' : '');

    let badges = '';
    if (me.is_nitro) badges += ' <span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i> Nitro</span>';
    if (UI.rank(me)) badges += ' ' + UI.roleBadge(me);
    $('pvBadges').innerHTML = badges;

    const avUrl = clearAvatar ? null : (avatarFile?._preview || me.avatar_url);
    const bnUrl = clearBanner ? null : (bannerFile?._preview || me.banner_url);

    // Preview the halo from the in-progress fields, not just the saved row,
    // so editing the GIF URL or the custom CSS updates the card live.
    const haloPreview = { ...me, banner_gif_url: $('fHalo')?.value.trim() || me.banner_gif_url,
      theme: { ...(me.theme || {}), dev_mode: devMode, halo_css: $('fHaloCss')?.value.trim() || '' } };
    const wrap = $('pvAvWrap');
    wrap.className = 'pcard-av' + (me.is_nitro ? ' ' + UI.haloClass(haloPreview) : '');
    wrap.removeAttribute('style');
    const haloStyleText = me.is_nitro ? UI.haloStyleText(haloPreview) : '';
    if (haloStyleText) wrap.setAttribute('style', haloStyleText);
    const avInner = avUrl
      ? `<div class="av"><img src="${avUrl}" alt=""></div>`
      : `<div class="av" style="background:${accent};">${UI.initial(display)}</div>`;
    $('pvAvWrap').innerHTML = pfpDeco
      ? `<span class="av-decoed">${avInner}<img class="av-deco" src="${UI.esc(pfpDeco)}" alt=""></span>`
      : avInner;

    $('pvBanner').style.background = bnUrl
      ? `url('${bnUrl}') center/cover`
      : `linear-gradient(120deg, ${accent}, ${accent}22)`;

    // Sidebar identity card mirrors the preview.
    $('niName').textContent = display;
    paintNsEditor();
    $('niHandle').textContent = '@' + me.username;
    $('niAv').innerHTML = avUrl ? `<div class="av" style="width:44px;height:44px"><img src="${avUrl}" alt=""></div>` : UI.avatar({ ...me, display_name: display, accent_color: accent, avatar_url: null }, 44, { halo: false });
    $('niBanner').style.background = $('pvBanner').style.background;

    $('bioCount').textContent = bio.length;
  }

  ['fDisplay', 'fBio', 'fStatus'].forEach((id) => $(id).addEventListener('input', paint));

  // ---- accent ----
  function setAccent(hex) {
    $('fAccent').value = hex;
    $('fAccentHex').value = hex.toUpperCase();
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.c.toLowerCase() === hex.toLowerCase()));
    paint();
  }
  $('bgPresets').innerHTML = BG_PRESETS.map((b) =>
    `<div class="bg-preset" data-v="${b.v}" style="background:${b.v || 'var(--bg-2)'}"><span>${b.n}</span></div>`).join('');
  document.querySelectorAll('.bg-preset').forEach((el) => {
    el.onclick = () => { clearWallpaper(); bgVal = el.dataset.v; $('fBgUrl').value = ''; paintBgUI(); };
  });
  function clearWallpaper() {
    wallpaperSelection++;
    wallpaperKey = ''; wpFile = null;
    $('fWallpaper').value = '';
    $('wpPrev').innerHTML = '<i class="fa-regular fa-image"></i>';
  }
  $('fBgUrl').oninput = (e) => {
    clearWallpaper();
    const u = e.target.value.trim();
    bgVal = u ? `url(${UI.cssString(u)})` : '';
    paintBgUI();
  };
  $('fBgDim').oninput = (e) => { bgDim = +e.target.value; paintBgUI(); };
  $('fBgBright').oninput = (e) => { bgBright = +e.target.value; paintBgUI(); };
  $('fWallpaper').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 10 * 1024 * 1024) { UI.toast('That wallpaper is over 10 MB.', true); e.target.value = ''; return; }
    clearWallpaper();
    wpFile = f;
    const selection = wallpaperSelection;
    const preview = (src) => {
      if (selection !== wallpaperSelection) return;
      $('wpPrev').innerHTML = `<img src="${src}">`;
      bgVal = `url('${src}')`;   // instant local preview; uploads on save
      $('fBgUrl').value = '';
      paintBgUI();
    };
    if (window.Tiff?.isTiff(f.name)) {
      // CSS cannot paint a TIFF, so decode it before previewing.
      window.Tiff.toPngUrl(URL.createObjectURL(f))
        .then(preview)
        .catch(() => UI.toast('That TIFF could not be read. Try a PNG or JPEG.', true));
      return;
    }
    const r = new FileReader();
    r.onload = (ev) => preview(ev.target.result);
    r.readAsDataURL(f);
  };
  $('fBgBlur').oninput = (e) => { bgBlur = +e.target.value; paintBgUI(); };
  $('fChatBlur').oninput = (e) => { chatBlur = +e.target.value; paintBgUI(); };
  $('fChatDim').oninput = (e) => { chatDim = +e.target.value; paintBgUI(); };
  $('bgClear').onclick = () => {
    bgVal = ''; wpFile = null;
    $('fBgUrl').value = ''; $('fWallpaper').value = '';
    $('wpPrev').innerHTML = '<i class="fa-regular fa-image"></i>';
    paintBgUI();
  };

  /* ---------- developer mode / STUN picker ---------- */
  function paintIce() {
    const probed = ICE.lastProbe();
    const msOf = (u) => probed.find((p) => p.url === u)?.ms;
    $('iceList').innerHTML = ICE.STUN.map((u) => {
      const ms = msOf(u);
      const cls = ms == null ? 'dead' : ms < 80 ? 'fast' : ms < 220 ? 'mid' : 'slow';
      const label = ms == null ? 'untested' : ms + ' ms';
      return `<label class="ice-row">
        <input type="checkbox" value="${u}" ${manualStun.includes(u) ? 'checked' : ''}>
        <code>${UI.esc(u)}</code><span class="ms ${cls}">${label}</span></label>`;
    }).join('');
    $('iceList').querySelectorAll('input').forEach((c) => {
      c.onchange = async () => {
        manualStun = [...$('iceList').querySelectorAll('input:checked')].map((x) => x.value);
        if (window.Voice) await window.Voice.setManualStun(manualStun);
        UI.toast(manualStun.length ? `Using ${manualStun.length} manual server${manualStun.length === 1 ? '' : 's'}.` : 'Back to automatic selection.');
      };
    });
  }

  $('devToggle').onchange = (e) => {
    devMode = e.target.checked;
    $('devPanel').classList.toggle('hidden', !devMode);
    syncHaloCssField();
    paint();
    if (devMode) paintIce();
  };

  // The custom-halo box only exists for Nitro members in developer mode.
  function syncHaloCssField() {
    $('haloCssField').classList.toggle('hidden', !(devMode && me?.is_nitro));
  }
  $('fHalo').oninput = () => paint();
  $('fHaloCss').oninput = () => paint();

  /* Worked examples for the halo. Custom halo CSS is declarations-only -- no
     braces means no @keyframes of your own -- which is easy to trip over, so
     these all stick to the animations theme.css already defines (spin, pulse)
     and each chip previews the ring it produces. */
  const HALO_EGS = [
    { n: 'Prism',  css: 'background: conic-gradient(from 0deg,#F0F,#0FF,#FF0,#F0F); animation: spin 2.4s linear infinite;' },
    { n: 'Ember',  css: 'background: conic-gradient(from 90deg,#E8B04B,#FFE9A8,#C98A20,#E8B04B); animation: spin 6s linear infinite;' },
    { n: 'Tide',   css: 'background: linear-gradient(135deg,#2FBF87,#3B9EF5); animation: pulse 2s ease-in-out infinite;' },
    { n: 'Neon',   css: 'background: #E8659A; box-shadow: 0 0 9px 2px rgba(232,101,154,.8);' },
    { n: 'Static', css: 'background: linear-gradient(90deg,#8B7CF6,#5AC8D8);' },
  ];
  (function paintHaloEgs() {
    const wrap = $('haloEgs');
    if (!wrap) return;
    HALO_EGS.forEach((eg) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'halo-eg';
      b.title = eg.css;
      b.innerHTML = `<span class="ring"></span>${UI.esc(eg.n)}`;
      b.querySelector('.ring').style.cssText = eg.css;
      b.onclick = () => { $('fHaloCss').value = eg.css; paint(); };
      wrap.appendChild(b);
    });
  })();
  $('iceProbe').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Testing…';
    await ICE.rank(ICE.STUN, true);
    paintIce();
    b.disabled = false; b.innerHTML = '<i class="fa-solid fa-gauge-high"></i> Re-test all';
    UI.toast('Latency test finished.');
  };
  $('iceAuto').onclick = async () => {
    manualStun = [];
    if (window.Voice) await window.Voice.setManualStun([]);
    paintIce();
    UI.toast('Server selection is automatic again.');
  };

  /* ---- style: Midnight or Liquid glass (previewed live, saved with the profile) ---- */
  function paintStyle() {
    document.querySelectorAll('.style-opt').forEach((b) => b.classList.toggle('on', b.dataset.style === uiStyle));
    applyBg();
  }
  document.querySelectorAll('.style-opt').forEach((b) => {
    b.onclick = () => { uiStyle = b.dataset.style; paintStyle(); };
  });

  $('swatches').innerHTML = PRESETS.map((c) => `<div class="swatch" data-c="${c}" style="background:${c}" title="${c}"></div>`).join('');
  document.querySelectorAll('.swatch').forEach((s) => { s.onclick = () => setAccent(s.dataset.c); });
  $('fAccent').oninput = (e) => setAccent(e.target.value);
  $('fAccentHex').oninput = (e) => {
    const v = e.target.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setAccent(v);
  };

  // ---- uploads ----
  function wireUpload(inputId, prevId, clearId, kind) {
    $(inputId).onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const max = kind === 'avatar' ? 2 : 4;
      if (f.size > max * 1024 * 1024) { UI.toast(`That file is over ${max} MB.`, true); e.target.value = ''; return; }
      const r = new FileReader();
      r.onload = (ev) => {
        f._preview = ev.target.result;
        if (kind === 'avatar') { avatarFile = f; clearAvatar = false; } else { bannerFile = f; clearBanner = false; }
        $(prevId).innerHTML = `<img src="${ev.target.result}" alt="">`;
        window.Tiff?.hydrateFile($(prevId).querySelector('img'), f);
        $(clearId).classList.remove('hidden');
        paint();
      };
      r.readAsDataURL(f);
    };
    $(clearId).onclick = () => {
      if (kind === 'avatar') { avatarFile = null; clearAvatar = true; $(prevId).innerHTML = '<i class="fa-regular fa-user"></i>'; }
      else { bannerFile = null; clearBanner = true; $(prevId).innerHTML = '<i class="fa-regular fa-image"></i>'; }
      $(inputId).value = '';
      $(clearId).classList.add('hidden');
      paint();
    };
  }
  wireUpload('fAvatar', 'avPrev', 'avClear', 'avatar');
  wireUpload('fBanner', 'bnPrev', 'bnClear', 'banner');

  // ---- save ----
  $('btnSave').onclick = async () => {
    const btn = $('btnSave'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const patch = {
        display_name: $('fDisplay').value.trim() || me.username,
        bio: $('fBio').value.trim() || null,
        custom_status: $('fStatus').value.trim() || null,
        accent_color: $('fAccent').value,
        theme: { ...(me.theme || {}) },
      };

      // Persist the object key, never the temporary S3 signature. Keep it in
      // editor state too, so a failed profile save can be retried without upload.
      if (wpFile) {
        // TIFF is not renderable as a CSS background; store a PNG instead.
        if (window.Tiff?.isTiff(wpFile.name)) {
          try { wpFile = await window.Tiff.toPngFile(wpFile); }
          catch { throw new Error('That TIFF could not be read. Try a PNG or JPEG.'); }
        }
        const key = `nexchat/users/${me.id}/wallpaper-${Date.now()}-${wpFile.name.replace(/[^\w.\-]/g, '_')}`;
        const up = await window.Store.put(key, wpFile);
        wallpaperSelection++;
        if (window.CloudGate?.isOurs(up.url)) {
          // A CloudGate URL never expires, so it is saved like a preset.
          wallpaperKey = '';
          bgVal = `url(${UI.cssString(up.url)})`;
        } else {
          wallpaperKey = key;
          bgVal = '';
        }
        wpFile = null;
        $('fWallpaper').value = '';
      }
      patch.theme.dash_wallpaper_key = wallpaperKey || null;
      patch.theme.dash_bg = wallpaperKey ? null : bgVal;
      patch.theme.dash_dim = bgDim;
      patch.theme.dash_blur = bgBlur;
      patch.theme.dash_bright = bgBright;
      patch.theme.chat_blur = chatBlur;
      patch.theme.chat_dim = chatDim;
      patch.theme.ui_style = uiStyle;
      patch.theme.dev_mode = devMode;
      patch.theme.manual_stun = manualStun;
      if (me.is_nitro) {
        patch.theme.name_style = { ...nameDraft };
        patch.banner_gif_url = $('fHalo').value.trim() || null;
        const hc = $('fHaloCss').value.trim();
        if (hc && !UI.haloCss({ theme: { dev_mode: true, halo_css: hc } })) {
          throw new Error('That halo CSS is not allowed. Use plain declarations, with no selectors, braces or url().');
        }
        patch.theme.halo_css = hc || null;
      }

      if (avatarFile) patch.avatar_url = await UI.upload('avatars', avatarFile, me.id);
      else if (clearAvatar) patch.avatar_url = null;

      if (bannerFile) patch.banner_url = await UI.upload('banners', bannerFile, me.id);
      else if (clearBanner) patch.banner_url = null;

      const { error } = await window.db.from('profiles').update(patch).eq('id', me.id);
      if (error) throw error;

      Object.assign(me, patch);
      avatarFile = bannerFile = null; clearAvatar = clearBanner = false;
      $('avClear').classList.toggle('hidden', !me.avatar_url);
      $('bnClear').classList.toggle('hidden', !me.banner_url);
      UI.toast('Profile saved.');
      window.SettingsUI?.clean();
      paintBgUI();
      paint();
    } catch (err) {
      UI.toast(err.message || 'Could not save your profile.', true);
    } finally { btn.disabled = false; btn.textContent = 'Save changes'; }
  };

  $('btnReset').onclick = () => hydrate();

  // ---- nitro ----
  async function loadNitro() {
    ['nitroActive', 'nitroPending', 'nitroRequest', 'nitroDenied'].forEach((id) => ($(id).style.display = 'none'));

    if (me.is_nitro) {
      $('nitroActive').style.display = '';
      $('fHalo').value = me.banner_gif_url || '';
      $('fHaloCss').value = me.theme?.halo_css || '';
      syncHaloCssField();
      $('nitroSince').textContent = me.nitro_since
        ? 'Active since ' + new Date(me.nitro_since).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
        : 'Active on your account.';
      return;
    }

    const { data: reqs } = await window.db.from('nitro_requests')
      .select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(1);
    const last = reqs?.[0];

    if (last?.status === 'pending') { $('nitroPending').style.display = ''; return; }
    if (last?.status === 'denied') {
      $('nitroDenied').style.display = '';
      $('nitroDeniedNote').textContent = last.review_note || 'No reason was given.';
      return;
    }
    $('nitroRequest').style.display = '';
  }

  async function sendRequest() {
    const { error } = await window.db.from('nitro_requests')
      .insert({ user_id: me.id, message: $('fNitroMsg').value.trim() || null });
    if (error) return UI.toast(error.message, true);
    UI.toast('Request sent to the admins.');
    loadNitro();
  }
  $('btnNitro').onclick = sendRequest;
  $('btnNitroAgain').onclick = () => { $('nitroDenied').style.display = 'none'; $('nitroRequest').style.display = ''; };

  /* ---- nitro name style ----
     The draft lives here until Save, so the preview and the saved row agree. */
  const NS_FONTS = [['normal', 'Normal'], ['bold', 'Bold'], ['script', 'Script'], ['double', 'Double'], ['ascii', 'ASCII art']];
  const NS_PRESETS = [
    { n: 'Gold',     s: { font: 'bold',   color: '#F5B94A', color2: '#FF7A59', glow: '#F5B94A', bold: true } },
    { n: 'Aurora',   s: { font: 'normal', color: '#3DDC97', color2: '#4F9DFF', glow: '#3DDC97', shimmer: true, bold: true } },
    { n: 'Neon',     s: { font: 'script', color: '#E8659A', glow: '#E8659A' } },
    { n: 'Ice',      s: { font: 'double', color: '#5AC8D8', color2: '#8B7CF6' } },
    { n: 'Terminal', s: { font: 'ascii',  color: '#3DDC97', glow: '#3DDC97' } },
    { n: 'Plain',    s: { font: 'normal' } },
  ];
  let nameDraft = { font: 'normal' };
  const nsFromTheme = () => {
    const n = (me?.theme || {}).name_style || {};
    return { font: n.font || 'normal', color: n.color || null, color2: n.color2 || null, glow: n.glow || null,
      bold: !!n.bold, italic: !!n.italic, shimmer: !!n.shimmer };
  };

  function paintNsEditor() {
    const accent = $('fAccent').value || '#2FBF87';
    $('nxFonts').innerHTML = NS_FONTS.map(([k, t]) => `<button type="button" data-f="${k}" class="${nameDraft.font === k ? 'on' : ''}">${t}</button>`).join('');
    $('nxPresets').innerHTML = NS_PRESETS.map((p, i) => `<button type="button" data-p="${i}">${p.n}</button>`).join('');
    $('nxUseAcc').checked = !nameDraft.color;
    $('nxC1').value = nameDraft.color || accent;
    $('nxC1Wrap').classList.toggle('hidden', !nameDraft.color);
    $('nxGrad').checked = !!nameDraft.color2;
    $('nxC2').value = nameDraft.color2 || accent;
    $('nxC2Wrap').classList.toggle('hidden', !nameDraft.color2);
    $('nxBold').checked = nameDraft.bold;
    $('nxItalic').checked = nameDraft.italic;
    $('nxShimmer').checked = nameDraft.shimmer;
    $('nxShimmer').closest('label').classList.toggle('hidden', !nameDraft.color2);
    $('nxGlowOn').checked = !!nameDraft.glow;
    $('nxGlow').value = nameDraft.glow || '#F5B94A';
    $('nxGlowWrap').classList.toggle('hidden', !nameDraft.glow);
    $('nxPreview').innerHTML = UI.nxNameHtml({ ...me, display_name: $('fDisplay').value.trim() || me.username,
      accent_color: accent, is_nitro: true, theme: { ...(me.theme || {}), name_style: nameDraft } });
  }

  // Reads every control back into the draft, then repaints.
  function readNsEditor() {
    nameDraft = {
      font: nameDraft.font,
      color: $('nxUseAcc').checked ? null : $('nxC1').value,
      color2: $('nxGrad').checked ? $('nxC2').value : null,
      glow: $('nxGlowOn').checked ? $('nxGlow').value : null,
      bold: $('nxBold').checked, italic: $('nxItalic').checked, shimmer: $('nxShimmer').checked,
    };
    paintNsEditor(); paint();
  }
  ['nxUseAcc', 'nxC1', 'nxGrad', 'nxC2', 'nxGlowOn', 'nxGlow', 'nxBold', 'nxItalic', 'nxShimmer'].forEach((id) => {
    $(id).addEventListener('input', readNsEditor);
    $(id).addEventListener('change', readNsEditor);
  });
  $('nxFonts').onclick = (e) => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    nameDraft.font = b.dataset.f; paintNsEditor(); paint();
  };
  $('nxPresets').onclick = (e) => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    const pr = NS_PRESETS[+b.dataset.p].s;
    nameDraft = { font: 'normal', color: null, color2: null, glow: null, bold: false, italic: false, shimmer: false, ...pr };
    paintNsEditor(); paint();
  };

  /* ---- nitro shop ----
     Decorations are plain files under assets/deco/, listed in manifest.json
     (built by tools/build-deco-manifest.js). Equipping writes straight to the
     profile, so the shop has no Save step. */
  let decoManifest = null;
  async function loadDecoManifest() {
    if (decoManifest) return decoManifest;
    try {
      const r = await fetch('assets/deco/manifest.json', { cache: 'no-cache' });
      decoManifest = r.ok ? await r.json() : {};
    } catch { decoManifest = {}; }
    return decoManifest;
  }

  const shopEmpty = (what) => `<div class="shop-empty" style="grid-column:1/-1"><i class="fa-solid fa-hourglass-half"></i>
      <b>${what} are on the way</b><small>They show up here as soon as the decoration files are added to <code>assets/deco</code>.</small></div>`;

  // The shop renders a page of decorations at a time. Every APNG in view
  // decodes and animates, so rendering the whole catalogue at once makes the
  // page crawl. The first page shows straight away; the next one loads when the
  // "Loading more" marker scrolls near the viewport.
  const SHOP_PAGE = 9;
  let shopStops = [];
  const shopNear = (el) => el.offsetParent !== null && el.getBoundingClientRect().top < window.innerHeight + 300;

  function shopCard(it, kind, th) {
    const on = (kind === 'pfp' ? th.pfp_deco : th.bio_deco) === it.file;
    const prev = kind === 'pfp'
      ? `<div class="si-prev">${UI.avatar({ ...me, is_nitro: true, theme: { ...th, pfp_deco: it.file } }, 64, { halo: false })}</div>`
      : `<div class="si-bio"><div class="bio-deco-box">${UI.bioDecoImgs(it.file)}<span>Your bio</span></div></div>`;
    return `<div class="shop-item ${on ? 'on' : ''}">${prev}
      <b>${UI.esc(it.name || it.id)}</b><small>${on ? 'Equipped' : (kind === 'pfp' ? 'Avatar frame' : 'Bio banner')}</small>
      <button class="btn ${on ? 'btn-ghost' : 'btn-primary'} btn-sm" data-kind="${kind}" data-file="${UI.esc(it.file)}">${on ? 'Remove' : 'Equip'}</button>
    </div>`;
  }

  function shopSection(el, list, kind, th, countEl) {
    const usable = list.filter((it) => UI.nxDecoPath({ is_nitro: true, theme: kind === 'pfp' ? { pfp_deco: it.file } : { bio_deco: it.file } }, kind));
    if (countEl) countEl.textContent = usable.length ? `${usable.length}` : '';
    if (!usable.length) { el.innerHTML = shopEmpty(kind === 'pfp' ? 'Avatar frames' : 'Bio banners'); return; }
    el.innerHTML = '<div class="shop-cards"></div><div class="shop-more" hidden><i class="fa-solid fa-circle-notch fa-spin"></i> Loading more...</div>';
    const cards = el.querySelector('.shop-cards');
    const more = el.querySelector('.shop-more');
    let shown = 0;
    const showNext = () => {
      const batch = usable.slice(shown, shown + SHOP_PAGE);
      cards.insertAdjacentHTML('beforeend', batch.map((it) => shopCard(it, kind, th)).join(''));
      shown += batch.length;
      more.hidden = shown >= usable.length;
      if (shown >= usable.length) stop();
    };
    // Only scrolling loads the next page: the first page is exactly SHOP_PAGE.
    const onScroll = () => { if (shown < usable.length && shopNear(more)) showNext(); };
    const stop = () => document.removeEventListener('scroll', onScroll, true);
    document.addEventListener('scroll', onScroll, true);
    shopStops.push(stop);
    showNext();
  }

  async function renderShop() {
    if (!me?.is_nitro) return;
    shopStops.forEach((stop) => stop());
    shopStops = [];
    const m = await loadDecoManifest();
    const th = me.theme || {};
    shopSection($('shopPfp'), Array.isArray(m.pfp) ? m.pfp : [], 'pfp', th, $('shopPfpN'));
    shopSection($('shopBio'), Array.isArray(m.profile) ? m.profile : [], 'bio', th, $('shopBioN'));
  }

  async function equipDeco(kind, file) {
    const key = kind === 'pfp' ? 'pfp_deco' : 'bio_deco';
    const next = (me.theme || {})[key] === file ? null : file;
    const theme = { ...(me.theme || {}), [key]: next };
    const { error } = await window.db.from('profiles').update({ theme }).eq('id', me.id);
    if (error) return UI.toast(error.message, true);
    me.theme = theme;
    UI.toast(next ? 'Equipped.' : 'Removed.');
    renderShop(); paint();
  }
  ['shopPfp', 'shopBio'].forEach((id) => {
    $(id).onclick = (e) => {
      const b = e.target.closest('[data-kind]'); if (!b) return;
      equipDeco(b.dataset.kind, b.dataset.file);
    };
  });

  // ---- password ----
  $('btnPass').onclick = async () => {
    const a = $('fPass1').value, b = $('fPass2').value;
    $('passErr').textContent = '';
    if (a.length < 8) return ($('passErr').textContent = 'Use at least 8 characters.');
    if (a !== b) return ($('passErr').textContent = 'Those don\u2019t match.');
    const btn = $('btnPass'); btn.disabled = true; btn.textContent = 'Updating…';
    const { error } = await window.db.auth.updateUser({ password: a });
    btn.disabled = false; btn.textContent = 'Update password';
    if (error) return ($('passErr').textContent = error.message);
    $('fPass1').value = ''; $('fPass2').value = '';
    UI.toast('Password updated.');
  };

  $('btnOut').onclick = async () => { await window.db.auth.signOut(); UI.go('index.html'); };

  // ---- delete account ----
  const toAddr = (u) => `${u.trim().toLowerCase()}@users.nexchat-app.com`;

  $('btnDel').onclick = async () => {
    const pass = $('fDelPass').value;
    $('delErr').textContent = '';
    if (!pass) return ($('delErr').textContent = 'Enter your password to continue.');

    const okd = await UI.confirmDialog(
      'Delete account',
      'This will permanently remove your account, all your servers, messages, friends and profile data. This cannot be undone.',
      true, 'Delete my account');
    if (!okd) return;

    const btn = $('btnDel'); btn.disabled = true; btn.textContent = 'Deleting…';
    try {
      // Re-authenticate to verify the password is correct.
      const { error: signInErr } = await window.db.auth.signInWithPassword({
        email: toAddr(me.username), password: pass,
      });
      if (signInErr) throw new Error('Wrong password.');

      const { error: rpcErr } = await window.db.rpc('delete_my_account');
      if (rpcErr) throw rpcErr;

      UI.toast('Your account has been deleted.');
      UI.go('index.html');
    } catch (err) {
      $('delErr').textContent = err.message || 'Could not delete account.';
      btn.disabled = false; btn.textContent = 'Delete my account';
    }
  };

  function hydrate() {
    $('fDisplay').value = me.display_name || '';
    $('fBio').value = me.bio || '';
    $('fStatus').value = me.custom_status || '';
    setAccent(me.accent_color || '#2FBF87');
    const th = me.theme || {};
    clearWallpaper();
    wallpaperKey = UI.wallpaperKey(th);
    bgVal = wallpaperKey ? '' : (th.dash_bg || '');
    $('fBgUrl').value = '';
    if (wallpaperKey) {
      const selection = wallpaperSelection;
      UI.wallpaperUrl(wallpaperKey).then((url) => {
        if (selection !== wallpaperSelection) return;
        const img = document.createElement('img'); img.src = url;
        $('wpPrev').replaceChildren(img);
      }).catch(() => { /* shared background renderer retries */ });
    } else {
      const u = (bgVal.match(/^url\(\s*'(.*)'\s*\)$/) || [])[1];
      if (u && window.CloudGate?.isOurs(u)) { const img = document.createElement('img'); img.src = u; $('wpPrev').replaceChildren(img); }
    }
    bgDim = th.dash_dim ?? 0;
    bgBlur = th.dash_blur ?? 0;
    bgBright = th.dash_bright ?? 100;
    chatBlur = th.chat_blur ?? UI.CHAT_BLUR_DEFAULT;
    chatDim = th.chat_dim ?? UI.CHAT_DIM_DEFAULT;
    devMode = !!th.dev_mode;
    uiStyle = th.ui_style === 'glass' ? 'glass' : 'solid';
    document.querySelectorAll('.style-opt').forEach((b) => b.classList.toggle('on', b.dataset.style === uiStyle));
    manualStun = th.manual_stun || [];
    wpFile = null;
    if (bgVal.startsWith('url(')) {
      const u = bgVal.slice(5, -2);
      $('wpPrev').innerHTML = `<img src="${UI.esc(u)}">`;
      if (!wallpaperKey) $('fBgUrl').value = u;
    } else {
      $('wpPrev').innerHTML = '<i class="fa-regular fa-image"></i>';
    }
    $('devToggle').checked = devMode;
    $('devPanel').classList.toggle('hidden', !devMode);
    $('fHaloCss').value = th.halo_css || '';
    syncHaloCssField();
    nameDraft = nsFromTheme();
    paintNsEditor();
    if (devMode) paintIce();
    paintBgUI();
    avatarFile = bannerFile = null; clearAvatar = clearBanner = false;
    $('fAvatar').value = ''; $('fBanner').value = '';
    $('avPrev').innerHTML = me.avatar_url ? `<img src="${UI.esc(me.avatar_url)}" alt="">` : '<i class="fa-regular fa-user"></i>';
    $('bnPrev').innerHTML = me.banner_url ? `<img src="${UI.esc(me.banner_url)}" alt="">` : '<i class="fa-regular fa-image"></i>';
    $('avClear').classList.toggle('hidden', !me.avatar_url);
    $('bnClear').classList.toggle('hidden', !me.banner_url);
    paint();
    window.SettingsUI?.clean();
  }

  (async () => {
    const s = await UI.requireSession(); if (!s) return;
    me = await UI.myProfile(s.user.id);
    if (!me) return UI.toast('Could not load your profile.', true);
    window.Notify?.start(me);
    window.Guard?.start(me);
    document.querySelectorAll('.nitro-only').forEach((el) => el.classList.toggle('hidden', !me.is_nitro));
    $('acUser').textContent = '@' + me.username;
    $('acSince').textContent = new Date(me.created_at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
    hydrate();
    loadNitro();
    // Deep links: profile.html#drive, #appearance, ...
    const tab = location.hash.slice(1);
    if (tab) document.querySelector(`.set-nav button[data-tab="${CSS.escape(tab)}"]`)?.click();
  })();
})();
