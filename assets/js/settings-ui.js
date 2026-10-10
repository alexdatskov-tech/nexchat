/* Shared behaviour for the settings shells (profile, server settings, admin):
   - the save bar floats in only when something has actually changed,
   - image upload rows become click-or-drop tiles,
   - leaving with unsaved edits asks first.
   Page scripts call SettingsUI.clean() after a successful save or reset. */
window.SettingsUI = (function () {
  const bar = () => document.getElementById('saveBar');
  let dirty = false;

  function setDirty(on) {
    dirty = on;
    bar()?.classList.toggle('dirty', on);
  }

  function clean() { setDirty(false); }

  function wireDirty() {
    const main = document.querySelector('.set-main');
    if (!main || !bar()) return;
    const mark = (e) => {
      if (e.target.closest('[data-nosave], .ice-list, #uSearch, #memSearch')) return;
      const pane = e.target.closest('[data-pane]');
      if (pane && pane.dataset.nosave !== undefined) return;
      setDirty(true);
    };
    main.addEventListener('input', mark);
    main.addEventListener('change', mark);
    // Buttons and labels in editable panes change settings too (Nitro fonts,
    // presets, toggles). Save and Reset themselves do not count.
    main.addEventListener('click', (e) => {
      if (e.target.closest('#btnSave, #btnReset')) return;
      const pane = e.target.closest('[data-pane]');
      if (pane && pane.dataset.nosave !== undefined) return;
      if (e.target.closest('button, label, .swatch, .bg-preset, .style-opt, [data-dirty]')) setDirty(true);
    });
    bar().insertAdjacentHTML('afterbegin', '<span class="sb-msg"><i class="fa-solid fa-circle-exclamation"></i> You have unsaved changes</span>');
    window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  /* Upload rows: the preview becomes the drop target and the button. */
  function wireUploads() {
    document.querySelectorAll('.upload-row').forEach((row) => {
      const input = row.querySelector('input[type=file]');
      const prev = row.querySelector('.upload-prev');
      if (!input || !prev || row.dataset.wired) return;
      row.dataset.wired = '1';
      row.classList.add('drop');
      input.classList.add('vh');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm up-pick';
      btn.innerHTML = '<i class="fa-solid fa-arrow-up-from-bracket"></i> Choose image';
      input.insertAdjacentElement('afterend', btn);
      const hint = document.createElement('span');
      hint.className = 'up-hint';
      hint.textContent = 'or drop it on the preview';
      btn.insertAdjacentElement('afterend', hint);
      const pick = () => input.click();
      btn.onclick = pick;
      prev.addEventListener('click', pick);
      prev.title = 'Click or drop an image';
      ['dragenter', 'dragover'].forEach((t) => prev.addEventListener(t, (e) => { e.preventDefault(); prev.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((t) => prev.addEventListener(t, () => prev.classList.remove('over')));
      prev.addEventListener('drop', (e) => {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (!f) return;
        const dt = new DataTransfer();
        dt.items.add(f);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }

  function init() { wireDirty(); wireUploads(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  // Three-way prompt for leaving a pane with unsaved changes.
  // Resolves 'save' | 'discard' | 'stay'.
  function askLeave() {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'overlay';
      ov.innerHTML = `
        <div class="modal" style="max-width:400px;">
          <div class="modal-head"><h3>Save your changes?</h3></div>
          <div class="modal-body"><p style="font-size:13.5px;color:var(--txt-2);margin:0;">You have unsaved changes on this page. Save them before you switch?</p></div>
          <div class="modal-foot">
            <button class="btn btn-quiet" data-stay>Stay here</button>
            <button class="btn btn-ghost" data-discard>Discard</button>
            <button class="btn btn-primary" data-save>Save changes</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const done = (v) => { ov.remove(); resolve(v); };
      ov.querySelector('[data-stay]').onclick = () => done('stay');
      ov.querySelector('[data-discard]').onclick = () => done('discard');
      ov.querySelector('[data-save]').onclick = () => done('save');
      ov.onclick = (e) => { if (e.target === ov) done('stay'); };
    });
  }

  return { clean, setDirty, askLeave, get dirty() { return dirty; } };
})();
