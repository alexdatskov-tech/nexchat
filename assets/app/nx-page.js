/* Shared frame for full-screen pages (user settings, server settings, admin).

   const pg = NX.pageShell(host, {
     sections: [{ title: 'User settings', items: [{ id: 'profile', label: 'Profile', icon: 'fa-user' }, …] }],
     active: 'profile',
     onSelect: (id) => …,        // called when a nav item is clicked
     wide: false,                // wider content column (tables)
   });
   pg.body      -> the content element to render the active tab into
   pg.setActive(id)
   pg.dirty(bool, { onSave, onReset })  -> shows / hides the "unsaved changes" bar
   pg.guard()   -> true when it is fine to leave (no unsaved changes, or the bar shook) */
(function () {
  const { esc } = NX;
  NX.pageShell = (host, o) => {
    host.innerHTML = `
      <nav class="page-nav"><div class="page-nav-in">${o.sections.map((s) => `
        ${s.title ? `<h6>${esc(s.title)}</h6>` : '<div class="sep"></div>'}
        ${s.items.filter((i) => !i.hidden).map((i) => `<button type="button" data-id="${esc(i.id)}" class="${i.danger ? 'danger' : ''}">${i.icon ? `<i class="fa-solid ${i.icon}"></i>` : ''}<span class="grow">${esc(i.label)}</span>${i.count ? `<span class="count">${i.count}</span>` : ''}</button>`).join('')}`).join('')}
      </div></nav>
      <div class="page-body"><div class="page-close"><button type="button" aria-label="Close"><i class="fa-solid fa-xmark"></i></button><span>ESC</span></div>
        <div class="page-body-in${o.wide ? ' wide' : ''}"></div></div>`;
    const body = host.querySelector('.page-body-in');
    let dirty = null;
    const api = {
      body,
      setActive(id) {
        host.querySelectorAll('.page-nav [data-id]').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
        host.querySelector('.page-body').scrollTop = 0;
      },
      dirty(on, handlers) {
        dirty = on ? handlers : null;
        let bar = body.querySelector('.save-bar');
        if (!on) { bar?.remove(); return; }
        if (!bar) {
          bar = NX.h(`<div class="save-bar"><span class="grow">Careful — you have unsaved changes!</span><button class="btn btn-quiet btn-sm" data-r>Reset</button><button class="btn btn-ok btn-sm" data-s>Save changes</button></div>`);
          body.appendChild(bar);
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
        const bar = body.querySelector('.save-bar');
        if (bar) { bar.classList.remove('shake'); void bar.offsetWidth; bar.classList.add('shake'); }
        return false;
      },
    };
    host.querySelector('.page-nav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      if (!api.guard()) return;
      o.onSelect?.(b.dataset.id);
    });
    host.querySelector('.page-close button').onclick = () => { if (api.guard()) NX.closePage(); };
    api.setActive(o.active);
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
