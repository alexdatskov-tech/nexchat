/* Admin -> Storage endpoints.

   Storage groups (filled in order: group 1, then group 2 when group 1 is full),
   the endpoints inside each group (every endpoint has its own username and
   password), and the category NexChat stores its files under.

   Everything is saved through the functions in supabase/storage_groups.sql,
   which check the manage_storage_endpoints permission (Owner tab). CloudGate tests and measures an
   endpoint with the login typed here. After each change the storage client is
   refreshed, so new uploads follow the new layout straight away. */
(function () {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  const CAT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

  let host = null;        // the pane element
  let state = null;       // storage_admin_list() result
  let editor = null;      // { kind: 'group' | 'endpoint', id, groupId, current } or null
  let editCat = false;    // category form open while already confirmed
  let focusCat = false;   // put the cursor in the category field after the first endpoint

  const $ = (id) => document.getElementById(id);
  const esc = (s) => UI.esc(String(s ?? ''));
  const toast = (msg, isErr) => UI.toast(msg, !!isErr);

  function fmt(bytes) {
    const b = Number(bytes) || 0;
    if (b === 0) return '0 GB';
    if (b < GB) return (b / MB).toFixed(b < 10 * MB ? 1 : 0) + ' MB';
    return (b / GB).toFixed(b < 10 * GB ? 1 : 0) + ' GB';
  }

  function explain(error, fallback) {
    const m = error?.message || '';
    if (error?.code === 'PGRST202' || /could not find the function|schema cache/i.test(m)) {
      return 'Run supabase/storage_groups.sql in the Supabase SQL editor first.';
    }
    return m.replace(/^.*?exception:\s*/i, '') || fallback || 'That didn’t work.';
  }

  // Calls a database function; throws an Error with a readable message.
  async function rpc(name, args) {
    const { data, error } = await window.db.rpc(name, args);
    if (error) throw new Error(explain(error));
    return data;
  }

  const allEndpoints = (s) => (s?.groups || []).flatMap((g) => g.endpoints.map((e) => ({ ...e, groupId: g.id })));
  const groupOf = (id) => (state?.groups || []).find((g) => g.id === id) || null;

  // Measures what an endpoint already holds in our category and stores it as its baseline.
  async function measureEndpoint(ep) {
    const bytes = await window.CloudGate.measure(ep);
    await rpc('storage_admin_set_baseline', { p_endpoint: ep.id, p_measured: bytes });
    return bytes;
  }

  async function reload() {
    try {
      state = await rpc('storage_admin_list');
      if (!state) throw new Error('No storage data came back.');
    } catch (e) {
      host.querySelector('#seGroups').innerHTML = `<div class="empty"><div class="ico"><i class="fa-solid fa-database"></i></div><h3>Storage endpoints aren’t set up</h3><p>${esc(e.message)}</p></div>`;
      host.querySelector('#seCategory').innerHTML = '';
      return;
    }
    paint();
  }

  // Runs after any change: the storage client picks up the new layout, then the page reloads.
  async function changed() {
    await window.CloudGate?.refresh();
    await reload();
  }

  /* ---- painting ---- */
  function paint() {
    const groups = state.groups || [];
    const endpointCount = allEndpoints(state).length;
    host.querySelector('#seCategory').innerHTML = categoryCard(state, endpointCount);
    host.querySelector('#seGroups').innerHTML = groups.length
      ? groups.map((g, i) => groupCard(g, i, groups.length)).join('')
      : '<div class="empty"><div class="ico"><i class="fa-solid fa-hard-drive"></i></div><h3>No storage yet</h3><p>Add group 1, then add its endpoints. Uploads go to the first group that has room.</p></div>';
    if (focusCat) {
      focusCat = false;
      host.querySelector('#scName')?.focus();
      host.querySelector('.se-cat')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function categoryCard(s, endpointCount) {
    if (s.configured && !editCat) {
      return `<div class="se-card se-cat-view">
        <div><small>Category NexChat stores its files in</small><b class="mono">${esc(s.category)}</b>${s.cdn ? `<small class="mono">${esc(s.cdn)}</small>` : ''}</div>
        <button class="btn btn-quiet btn-sm" data-act="cat-edit"><i class="fa-solid fa-pen"></i> Change</button>
      </div>`;
    }
    const next = !s.configured && endpointCount > 0;
    const title = s.configured ? 'Change the category'
      : endpointCount ? 'Next step · Which category does NexChat use?'
      : 'Step 3 · Category';
    const sub = endpointCount
      ? 'Type the CloudGate category name NexChat stores its files under, for example <code>nexchats-us1</code>. Every endpoint uses the same category.'
      : 'Add a group and at least one endpoint first. Then NexChat asks for the category name here.';
    return `<div class="se-card se-cat ${next ? 'se-next' : ''}">
      <b>${esc(title)}</b>
      <p class="se-hint">${sub}</p>
      <div class="se-row">
        <label class="se-f"><span>Category</span><input id="scName" class="input mono" maxlength="63" spellcheck="false" autocomplete="off" value="${esc(s.category)}" ${endpointCount ? '' : 'disabled'}></label>
        <label class="se-f"><span>CDN host (optional)</span><input id="scCdn" class="input mono" spellcheck="false" autocomplete="off" placeholder="d1dncmkdpaif79.cloudfront.net" value="${esc(s.cdn || '')}" ${endpointCount ? '' : 'disabled'}></label>
      </div>
      <div class="se-acts">
        ${s.configured ? '<button class="btn btn-quiet btn-sm" data-act="cat-cancel">Cancel</button>' : ''}
        <button class="btn btn-primary btn-sm" data-act="cat-save" ${endpointCount ? '' : 'disabled'}><i class="fa-solid fa-check"></i> Save category</button>
      </div>
    </div>`;
  }

  const arrow = (act, id, dir, on) => `<button class="btn btn-ghost btn-icon btn-sm" title="${dir < 0 ? 'Move up' : 'Move down'}" data-act="${act}" data-id="${id}" ${on ? '' : 'disabled'}><i class="fa-solid ${dir < 0 ? 'fa-arrow-up' : 'fa-arrow-down'}"></i></button>`;

  function groupCard(g, i, n) {
    const cap = Number(g.capacity_bytes) || 0;
    const used = Number(g.used_bytes) || 0;
    const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
    const isFull = cap > 0 && used >= cap;
    return `<div class="se-card se-group">
      <div class="se-gh">
        <div class="se-gt">
          <span class="se-num">${i + 1}</span>
          <div><b>${esc(g.name)}</b><small>${fmt(used)} of ${fmt(cap)} used${g.measured_at ? ` · measured ${new Date(g.measured_at).toLocaleDateString()}` : ' · not measured yet'}${isFull ? ' · full, uploads move to the next group' : ''}</small></div>
        </div>
        <div class="se-acts-s">
          ${arrow('g-move', g.id, -1, i > 0)}${arrow('g-move', g.id, 1, i < n - 1)}
          <button class="btn btn-ghost btn-icon btn-sm" title="Add endpoint to this group" data-act="e-add" data-g="${g.id}"><i class="fa-solid fa-plus"></i></button>
          <button class="btn btn-ghost btn-icon btn-sm" title="Edit group" data-act="g-edit" data-id="${g.id}"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-ghost btn-icon btn-sm" title="Delete group" data-act="g-del" data-id="${g.id}"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
      <div class="se-bar ${isFull ? 'is-full' : ''}" title="${Math.round(pct)}% used"><span style="width:${pct.toFixed(1)}%"></span></div>
      ${g.endpoints.length
        ? g.endpoints.map((e, j) => endpointRow(g, e, j)).join('')
        : '<p class="se-hint">No endpoints in this group yet. Use the + button to add one.</p>'}
    </div>`;
  }

  function endpointRow(g, e, j) {
    const n = g.endpoints.length;
    // Endpoints in a group are mirrors of one storage, so sizes are shown per group, not per endpoint.
    const role = n > 1 ? 'mirror of this group’s storage' : 'the group’s only way in';
    return `<div class="se-ep">
      <div class="se-em">
        <b>${esc(e.name)}</b>
        <small class="mono">${esc(e.base_url)}</small>
        <small>login <span class="mono">${esc(e.username)}</span> · password set · ${role}</small>
      </div>
      <div class="se-eacts">
        ${arrow('e-move', e.id, -1, j > 0)}${arrow('e-move', e.id, 1, j < n - 1)}
        <button class="btn btn-ghost btn-sm" title="Check the login" data-act="e-test" data-id="${e.id}"><i class="fa-solid fa-plug"></i> Test</button>
        <button class="btn btn-ghost btn-sm" title="Read how much this endpoint holds" data-act="e-measure" data-id="${e.id}"><i class="fa-solid fa-gauge"></i> Measure</button>
        <button class="btn btn-ghost btn-icon btn-sm" title="Edit endpoint" data-act="e-edit" data-id="${e.id}"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-ghost btn-icon btn-sm" title="Delete endpoint" data-act="e-del" data-id="${e.id}"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>`;
  }

  /* ---- the one inline editor, at the top of the pane ---- */
  function showEditor(html) {
    host.querySelector('#seEditor').innerHTML = html;
    host.querySelector('#seEditor .se-editor')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    host.querySelector('#seEditor input')?.focus();
  }
  function closeEditor() {
    editor = null;
    host.querySelector('#seEditor').innerHTML = '';
  }
  const editorErr = (msg) => { const el = host.querySelector('#seEditErr'); if (el) el.textContent = msg; };

  function openGroupEditor(g) {
    editor = { kind: 'group', id: g?.id || null };
    showEditor(`<div class="se-card se-editor">
      <div class="se-eh"><b>${g ? 'Edit group' : 'New group'}</b></div>
      <div class="se-row">
        <label class="se-f"><span>Name</span><input id="sfName" class="input" maxlength="60" placeholder="Group 1" value="${esc(g?.name || `Group ${(state.groups || []).length + 1}`)}"></label>
        <label class="se-f"><span>Capacity (GB)</span><input id="sfCap" class="input" type="number" min="1" step="any" value="${g ? g.capacity_gb : 100}"></label>
      </div>
      <p class="se-hint">When this group runs out of room, uploads move to the next group. Usage counts everything NexChat stored here, plus what this group’s storage already held when you measured it. Its endpoints are mirrors of that one storage, so it is counted once.</p>
      <p class="err" id="seEditErr"></p>
      <div class="se-acts">
        <button class="btn btn-quiet btn-sm" data-act="cancel">Cancel</button>
        <button class="btn btn-primary btn-sm" data-act="save-group"><i class="fa-solid fa-check"></i> Save group</button>
      </div>
    </div>`);
  }

  function openEndpointEditor(ep, groupId) {
    const g = groupOf(groupId);
    editor = { kind: 'endpoint', id: ep?.id || null, groupId, current: ep || null };
    showEditor(`<div class="se-card se-editor">
      <div class="se-eh"><b>${ep ? 'Edit endpoint' : 'New endpoint'}</b><small>${g ? `in ${esc(g.name)}` : ''}</small></div>
      <div class="se-row">
        <label class="se-f"><span>Name</span><input id="sfName" class="input" maxlength="60" placeholder="wasmer" value="${esc(ep?.name || '')}"></label>
        <label class="se-f se-wide"><span>Address</span><input id="sfUrl" class="input mono" spellcheck="false" autocomplete="off" placeholder="https://alexd-us1-s3.wasmer.app" value="${esc(ep?.base_url || '')}"></label>
      </div>
      <div class="se-row">
        <label class="se-f"><span>Username</span><input id="sfUser" class="input mono" autocomplete="off" spellcheck="false" value="${esc(ep?.username || '')}"></label>
        <label class="se-f"><span>Password</span><input id="sfPass" class="input mono" type="password" autocomplete="new-password" placeholder="${ep ? 'Leave blank to keep the current password' : 'Required'}"></label>
      </div>
      <p class="se-hint">An endpoint is one way into its group’s storage, with its own username and password. A second endpoint in the same group is a mirror of the same storage (for example wasmer and nx-storage), so it adds no extra space.</p>
      <p class="err" id="seEditErr"></p>
      <p class="se-res" id="seEditRes"></p>
      <div class="se-acts">
        <button class="btn btn-quiet btn-sm" data-act="cancel">Cancel</button>
        <button class="btn btn-ghost btn-sm" data-act="test-form"><i class="fa-solid fa-plug"></i> Test login</button>
        <button class="btn btn-primary btn-sm" data-act="save-endpoint"><i class="fa-solid fa-check"></i> Save endpoint</button>
      </div>
    </div>`);
  }

  // The endpoint as typed in the editor. A blank password on edit keeps the stored one.
  function formEndpoint() {
    const cur = editor?.current;
    return {
      name: $('sfName').value.trim() || 'endpoint',
      base_url: $('sfUrl').value.trim().replace(/\/+$/, ''),
      username: $('sfUser').value.trim(),
      password: $('sfPass').value || cur?.password || '',
      id: cur?.id || null,
    };
  }

  /* ---- actions ---- */
  async function withButton(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } finally { if (btn) btn.disabled = false; }
  }

  async function saveGroup(btn) {
    const name = $('sfName').value.trim();
    const gb = Number($('sfCap').value);
    if (!name) return editorErr('Give the group a name.');
    if (!(gb > 0)) return editorErr('Capacity must be more than 0 GB.');
    await withButton(btn, async () => {
      try {
        await rpc('storage_admin_save_group', { p_id: editor.id, p_name: name, p_capacity_gb: gb });
      } catch (e) { return editorErr(e.message); }
      closeEditor();
      toast('Group saved.');
      await changed();
    });
  }

  async function saveEndpoint(btn) {
    const f = formEndpoint();
    if (!/^https?:\/\/[^/]+/.test(f.base_url)) return editorErr('The address must start with https://');
    if (!f.username) return editorErr('Enter the username for this endpoint.');
    if (!f.password) return editorErr('Enter the password for this endpoint.');
    await withButton(btn, async () => {
      let id;
      try {
        id = await rpc('storage_admin_save_endpoint', {
          p_id: editor.id, p_group: editor.groupId, p_name: f.name, p_base_url: f.base_url,
          p_username: f.username, p_password: $('sfPass').value,
        });
      } catch (e) { return editorErr(e.message); }
      const wasNew = !editor.id;
      closeEditor();
      // Read what this group’s storage already holds, so the group starts from the real number.
      let note = 'Endpoint saved.';
      let failed = false;
      try {
        await window.CloudGate?.refresh();
        const bytes = await measureEndpoint({ name: f.name, base_url: f.base_url, username: f.username, password: f.password, id });
        note = `Endpoint saved. The group already holds ${fmt(bytes)}.`;
      } catch (e) {
        failed = true;
        note = `Endpoint saved, but it couldn’t be measured yet: ${e.message}`;
      }
      toast(note, failed);
      if (wasNew && !state.configured) focusCat = true;
      await changed();
    });
  }

  // Checks an endpoint's login. From the editor the result shows under the form; from a row, as a toast.
  async function testLogin(ep, inEditor) {
    const say = (m, isErr) => {
      const el = inEditor ? host.querySelector('#seEditRes') : null;
      if (el) el.textContent = m; else toast(m, isErr);
    };
    say('Connecting…');
    try {
      await window.CloudGate.probe(ep);
      say(`Connected. The login for ${ep.name} works.`, false);
    } catch (e) {
      say(`Couldn’t connect: ${e.message}`, true);
    }
  }

  async function deleteGroup(g) {
    const n = g.endpoints.length;
    if (!confirm(`Delete “${g.name}”${n ? ` and its ${n} endpoint${n === 1 ? '' : 's'}` : ''}?\n\nFiles already stored there stay where they are. NexChat just stops using this group for new uploads.`)) return;
    try { await rpc('storage_admin_delete_group', { p_id: g.id }); } catch (e) { return toast(e.message, true); }
    toast('Group deleted.');
    await changed();
  }

  async function deleteEndpoint(ep) {
    if (!confirm(`Remove the endpoint “${ep.name}”?\n\nFiles it holds stay where they are. NexChat will look for them on the other endpoints.`)) return;
    try { await rpc('storage_admin_delete_endpoint', { p_id: ep.id }); } catch (e) { return toast(e.message, true); }
    toast('Endpoint removed.');
    await changed();
  }

  async function move(kind, id, dir, groupId) {
    const list = kind === 'g' ? state.groups : (groupOf(groupId)?.endpoints || []);
    const i = list.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const ids = list.map((x) => x.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try {
      await rpc(kind === 'g' ? 'storage_admin_reorder_groups' : 'storage_admin_reorder_endpoints', { p_ids: ids });
    } catch (e) { return toast(e.message, true); }
    await changed();
  }

  async function saveCategory(btn) {
    const name = $('scName').value.trim().toLowerCase();
    const cdn = $('scCdn').value.trim();
    if (!CAT_RE.test(name)) return toast('Use lowercase letters, numbers, - or _ (up to 63 characters).', true);
    if (state.configured && name !== state.category
      && !confirm(`Change the category from “${state.category}” to “${name}”?\n\nOnly new uploads go to the new category. Files already stored under “${state.category}” will not be listed in NexChat any more.`)) return;
    await withButton(btn, async () => {
      try {
        await rpc('storage_admin_set_category', { p_category: name, p_cdn: cdn || null });
      } catch (e) { return toast(e.message, true); }
      editCat = false;
      await window.CloudGate?.refresh();
      // Measurements were taken against the old category: take them again.
      let failed = 0;
      // Endpoints in a group share one storage, so each group is measured once.
      for (const g of state.groups || []) {
        const ep = g.endpoints[0];
        if (!ep) continue;
        try { await measureEndpoint(ep); } catch { failed++; }
      }
      toast(failed ? `Category saved. ${failed} endpoint${failed === 1 ? '' : 's'} couldn’t be measured; try Measure on each.` : `Category set to ${name}.`, failed > 0);
      await changed();
    });
  }

  function onClick(ev) {
    const b = ev.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    const id = b.dataset.id;
    const g = b.dataset.g;
    const epRow = () => allEndpoints(state).find((e) => e.id === id);
    switch (act) {
      case 'cancel': closeEditor(); break;
      case 'cat-edit': editCat = true; paint(); break;
      case 'cat-cancel': editCat = false; paint(); break;
      case 'cat-save': saveCategory(b); break;
      case 'g-move': move('g', id, b.title === 'Move up' ? -1 : 1); break;
      case 'g-add': openGroupEditor(null); break;
      case 'g-edit': openGroupEditor(groupOf(id)); break;
      case 'g-del': deleteGroup(groupOf(id)); break;
      case 'save-group': saveGroup(b); break;
      case 'e-add': openEndpointEditor(null, g || id); break;
      case 'e-move': move('e', id, b.title === 'Move up' ? -1 : 1, allEndpoints(state).find((e) => e.id === id)?.groupId); break;
      case 'e-edit': { const ep = epRow(); if (ep) openEndpointEditor(ep, ep.groupId); break; }
      case 'e-del': { const ep = epRow(); if (ep) deleteEndpoint(ep); break; }
      case 'e-test': { const ep = epRow(); if (ep) withButton(b, () => testLogin(ep, false)); break; }
      case 'e-measure': {
        const ep = epRow(); if (!ep) break;
        withButton(b, async () => {
          try {
            const bytes = await measureEndpoint(ep);
            toast(`${ep.name} holds ${fmt(bytes)} in ${state.category}.`);
            await changed();
          } catch (e) { toast(`Couldn’t measure ${ep.name}: ${e.message}`, true); }
        });
        break;
      }
      case 'save-endpoint': saveEndpoint(b); break;
      case 'test-form': withButton(b, () => testLogin(formEndpoint(), true)); break;
      default: break;
    }
  }

  /* ---- entry point ---- */
  function ensureHost() {
    if (host) return host;
    host = document.querySelector('[data-pane="endpoints"]');
    if (!host) return null;
    host.addEventListener('click', onClick);
    return host;
  }

  async function load() {
    if (!ensureHost()) return;
    await reload();
  }

  window.AdminStorage = { load };
})();
