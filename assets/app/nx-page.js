/* Shared frame for full-screen pages (user settings, server settings, admin).

   const pg = NX.pageShell(host, {
     sections: [{ title: 'User settings', items: [{ id: 'profile', label: 'Profile', icon: 'fa-user', tint: '#7c6cff' }, …] }],
     active: 'profile',
     onSelect: (id) => …,        // called when a nav item is clicked
     brand: '<html>',            // top of the sidebar (user card, server card, console logo)
     kind: 'settings' | 'admin' | 'server',
     wide: false,                // wider content column (tables)
     back: false,                // a "Back to NexChat" pill above the brand
     strip: false,               // phones: a swipeable strip of tabs instead of the slide-over list
   });
   Items can carry sub: 'one line under the label'.
   pg.body      -> the content element to render the active tab into
   pg.setActive(id)
   pg.dirty(bool, { onSave, onReset })  -> shows / hides the "unsaved changes" bar
   pg.guard()   -> true when it is fine to leave (no unsaved changes, or the bar shook)
   pg.hero({ icon, title, sub, tint, actions }) -> html for a tab header */
(function () {
  const { esc } = NX;
  const TINTS = ['#7c6cff', '#3b9ef5', '#2fbf87', '#e8659a', '#f0b232', '#5ac8d8', '#f2555a', '#a78bfa', '#94a3b8'];

  NX.pageShell = (host, o) => {
    let n = 0;
    const items = [];
    host.className = `page pg-${o.kind || 'settings'}`;
    host.innerHTML = `
      <aside class="pg-side">
        <div class="pg-side-in">
          ${o.back ? '<button class="pg-home" type="button"><i class="fa-solid fa-arrow-left"></i><span>Back to NexChat</span></button>' : ''}
          ${o.brand ? `<div class="pg-brand">${o.brand}</div>` : ''}
          <label class="pg-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" placeholder="Search" aria-label="Search settings"></label>
          <nav class="pg-nav">${o.sections.map((s) => `<div class="pg-group">
            ${s.title ? `<h6>${esc(s.title)}</h6>` : '<div class="pg-sep"></div>'}
            ${s.items.filter((i) => !i.hidden).map((i) => { items.push(i); const t = i.tint || (i.danger ? '#f2555a' : TINTS[n++ % TINTS.length]); return `<button type="button" data-id="${esc(i.id)}" data-label="${esc(i.label.toLowerCase())}" class="${i.danger ? 'danger' : ''}" style="--t:${t}">
              <span class="pg-ico"><i class="fa-solid ${i.icon || 'fa-circle'}"></i></span>${i.sub ? `<span class="grow pg-lbl"><b>${esc(i.label)}</b><small>${esc(i.sub)}</small></span>` : `<span class="grow">${esc(i.label)}</span>`}${i.count ? `<span class="count">${i.count}</span>` : ''}${i.badge ? `<span class="pg-badge">${esc(i.badge)}</span>` : ''}<i class="fa-solid fa-chevron-right pg-chev"></i></button>`; }).join('')}</div>`).join('')}
          </nav>
          <div class="pg-foot">NexChat v3 · <span class="kbd">Esc</span> to close</div>
        </div>
      </aside>
      <main class="pg-main">
        <header class="pg-top">
          <button class="icon-btn pg-back" type="button" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>
          <div class="pg-crumb"><span class="pg-crumb-sec"></span><i class="fa-solid fa-chevron-right"></i><b></b></div>
          <button class="pg-close" type="button" aria-label="Close" title="Close (Esc)"><i class="fa-solid fa-xmark"></i></button>
        </header>
        ${o.strip ? `<nav class="pg-strip" aria-label="Sections">${items.map((i) => `<button type="button" data-id="${esc(i.id)}"><span class="pg-ico"><i class="fa-solid ${i.icon || 'fa-circle'}"></i></span><span>${esc(i.label)}</span></button>`).join('')}</nav>` : ''}
        <div class="pg-scroll"><div class="pg-content${o.wide ? ' wide' : ''}"></div></div>
      </main>`;
    if (o.strip) {
      host.classList.add('pg-has-strip');
      // the strip uses the same colours as the side list
      host.querySelectorAll('.pg-strip [data-id]').forEach((b) => { b.style.setProperty('--t', host.querySelector(`.pg-nav [data-id="${CSS.escape(b.dataset.id)}"]`)?.style.getPropertyValue('--t') || 'var(--accent)'); });
    }
    const body = host.querySelector('.pg-content');
    let dirty = null;
    const secOf = (id) => o.sections.find((s) => s.items.some((i) => i.id === id));
    const api = {
      body,
      setActive(id) {
        host.querySelectorAll('.pg-nav [data-id], .pg-strip [data-id]').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
        host.querySelector(`.pg-strip [data-id="${CSS.escape(id || '')}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest' });
        const it = items.find((i) => i.id === id);
        host.querySelector('.pg-crumb b').textContent = it?.label || '';
        host.querySelector('.pg-crumb-sec').textContent = secOf(id)?.title || '';
        host.querySelector('.pg-scroll').scrollTop = 0;
        host.classList.add('pg-open');
      },
      showNav() { host.classList.remove('pg-open'); },
      dirty(on, handlers) {
        dirty = on ? handlers : null;
        let bar = host.querySelector('.save-bar');
        if (!on) { bar?.remove(); return; }
        if (!bar) {
          bar = NX.h(`<div class="save-bar"><i class="fa-solid fa-circle-exclamation"></i><span class="grow">Careful — you have unsaved changes!</span><button class="btn btn-quiet btn-sm" data-r>Reset</button><button class="btn btn-ok btn-sm" data-s>Save changes</button></div>`);
          host.querySelector('.pg-main').appendChild(bar);
        }
        bar.querySelector('[data-r]').onclick = () => dirty?.onReset?.();
        bar.querySelector('[data-s]').onclick = async (e) => {
          const b = e.currentTarget;
          b.classList.add('busy');
          try { await dirty?.onSave?.(); } catch (err) { NX.fail(err); }
          finally { b.classList.remove('busy'); }
        };
      },
      guard() {
        if (!dirty) return true;
        const bar = host.querySelector('.save-bar');
        if (bar) { bar.classList.remove('shake'); void bar.offsetWidth; bar.classList.add('shake'); }
        return false;
      },
      hero: (h) => `<div class="pg-hero" style="--t:${h.tint || 'var(--accent)'}"><span class="pg-hero-ico"><i class="fa-solid ${h.icon || 'fa-gear'}"></i></span>
        <div class="grow"><h1>${esc(h.title)}</h1><p>${h.sub || ''}</p></div>${h.actions || ''}</div>`,
    };
    // Any tab that starts with a plain <h1 class="page-title"> (and optional
    // <p class="lead">) gets the hero header in the active item's colour.
    let activeId = o.active;
    const heroify = () => {
      const h = body.querySelector(':scope > h1.page-title');
      if (!h) return;
      const it = items.find((i) => i.id === activeId);
      const btn = host.querySelector(`.pg-nav [data-id="${CSS.escape(activeId || '')}"]`);
      const lead = h.nextElementSibling?.classList.contains('lead') ? h.nextElementSibling : null;
      const hero = NX.h(api.hero({ icon: it?.icon, tint: btn?.style.getPropertyValue('--t') || 'var(--accent)', title: '', sub: '' }));
      hero.querySelector('h1').innerHTML = h.innerHTML;
      if (lead) { hero.querySelector('p').innerHTML = lead.innerHTML; lead.remove(); } else hero.querySelector('p').remove();
      h.replaceWith(hero);
    };
    new MutationObserver(heroify).observe(body, { childList: true });
    const setActive0 = api.setActive;
    api.setActive = (id) => { activeId = id; setActive0(id); };
    host.querySelector('.pg-home')?.addEventListener('click', () => { if (api.guard()) NX.closePage(); });
    host.querySelector('.pg-strip')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]');
      if (b && api.guard()) o.onSelect?.(b.dataset.id);
    });
    host.querySelector('.pg-nav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      if (!api.guard()) return;
      o.onSelect?.(b.dataset.id);
      host.classList.add('pg-open');
    });
    host.querySelector('.pg-search input').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      host.querySelectorAll('.pg-nav [data-id]').forEach((b) => { b.hidden = !!q && !b.dataset.label.includes(q); });
      host.querySelectorAll('.pg-group').forEach((g) => { g.hidden = !!q && !g.querySelector('[data-id]:not([hidden])'); });
    });
    host.querySelector('.pg-close').onclick = () => { if (api.guard()) NX.closePage(); };
    host.querySelector('.pg-back').onclick = () => { if (api.guard()) api.showNav(); };
    api.setActive(o.active);
    if (NX.isNarrow() && o.startOnNav && !o.strip) host.classList.remove('pg-open');
    return api;
  };

  /* Image picker row: preview + Upload / Remove. Returns { el, get(), set(url) }.
     onPick(file) -> Promise<url> is called when a file is chosen. */
  NX.imagePicker = ({ url, shape = 'round', label = 'Upload image', onPick, onClear, onChange, accept = 'image/*' }) => {
    const el = NX.h(`<div class="img-pick"><div class="ip-prev ${shape === 'wide' ? 'wide' : shape === 'square' ? 'sq' : ''}"><i class="fa-regular fa-image"></i></div>
      <div class="ip-acts"><label class="btn btn-ghost btn-sm"><i class="fa-solid fa-upload"></i>${esc(label)}<input type="file" accept="${accept}" hidden></label>
      <button class="btn btn-quiet btn-sm" type="button" data-clear>Remove</button></div></div>`);
    const prev = el.querySelector('.ip-prev');
    let cur = url || null;
    const paint = () => {
      el.querySelector('[data-clear]').hidden = !cur;
      if (!cur) { prev.style.backgroundImage = ''; prev.innerHTML = '<i class="fa-regular fa-image"></i>'; return; }
      prev.innerHTML = '';
      const setBg = (u) => { prev.style.backgroundImage = `url("${String(u).replace(/"/g, '%22')}")`; };
      if (/^blob:|^data:/.test(cur)) setBg(cur);
      else NX.files.resolved(cur).then(setBg).catch(() => setBg(cur));
    };
    el.querySelector('input').onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      const local = URL.createObjectURL(f);
      const before = cur;
      cur = local; paint();
      el.classList.add('busy');
      try { cur = await onPick(f); paint(); onChange?.(cur); }
      catch (err) { cur = before; paint(); NX.fail(err, 'Upload failed'); }
      finally { el.classList.remove('busy'); }
    };
    el.querySelector('[data-clear]').onclick = () => { cur = null; paint(); onClear?.(); };
    paint();
    return { el, get: () => cur, set: (u) => { cur = u; paint(); } };
  };
})();
