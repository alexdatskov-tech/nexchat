# tools

## build-emoji.js

Regenerates `assets/js/emoji-data.js` from the Unicode CLDR data shipped in
the `emojibase-data` package.

```bash
npm i emojibase-data      # not vendored; only needed to regenerate
node tools/build-emoji.js
```

The generated file is committed, so a normal checkout needs no build step
and no npm install.

Two filters are applied deliberately:

- **Unicode <= 15.0.** Newer emoji render as tofu boxes on systems that
  haven't shipped the font update, which looks broken. Raise `MAX_VERSION`
  once the newer sets are widespread.
- **The "component" group is dropped.** Skin-tone modifiers and regional
  indicator letters are combining parts, not standalone emoji, and would
  appear as stray colour swatches and letter tiles in the grid.

Ordering within each group is CLDR order, which is what Android and Windows
use in their own pickers.

## test-*.js

jsdom harnesses, one per feature area. They need `jsdom` on the module path,
and `test-sql.js` additionally needs `pgsql-parser`:

```bash
npm i jsdom pgsql-parser
node tools/test-halo.js
```

Some are parameterised by a `SOCKET` env var, which decides whether the mocked
Supabase channel delivers realtime events (`live`), stays quiet so the polling
fallback has to cover (`silent`), or is left unset for the default path:

```bash
SOCKET=silent node tools/test-guard.js
```

`test-server`, `test-dms`, `test-rx`, `test-editdel`, `test-presence` and
`test-guard` are the socket-parameterised ones; the rest run single-mode. Each
prints one line per assertion and exits non-zero on the first failure.

`runall.sh` runs the lot.

### History paging and optimistic send

`node tools/test-pagination.js` runs the real `server.js` and `dms.js` against
a mock Supabase that honours `order`/`limit`/`lt`. It pins the behaviour that
keeps long conversations usable: opening a channel or DM renders only the
latest 15 messages, scrolling to the top pages older history in one batch at
a time with the viewport anchored, the "beginning of the conversation" card
only appears once history is actually exhausted, and no row ever duplicates.
It also covers sending: a pending bubble must paint before the insert
resolves, survive a catch-up poll while in flight (the delete reconciler
skips `tmp-` rows), and be swapped for the real row when the insert lands —
with exactly one insert per send.

Two are not jsdom tests:

- `test-sql.js` parses every `nexchat_patch*.sql` with the real Postgres
  grammar, since those files are pasted into the Supabase editor by hand and a
  syntax error otherwise surfaces mid-migration. It also enforces pure ASCII (a
  smart dash once broke a paste), guarded/idempotent DDL, and `search_path`
  pinning on `security definer` functions.
- `test-admin.js` covers admin promotion, mostly as a privilege-escalation
  regression net: that `is_platform_admin` is never written from the client,
  that the trigger guarding the column is present, and that the last admin
  cannot be demoted.

### Appearance regressions

`node tools/test-appearance.js` runs the real profile/server settings editors
against mocked persistence and storage. It covers immediate font paste/save,
colour and uploaded-font round trips, wallpaper key-only persistence, legacy
expired-URL recovery, failed saves, stale asynchronous results, and switching
between uploads, presets, external URLs and None. It also guards the wallpaper
stacking rules used by server chat. No live account or storage credentials are
needed. Run alongside `test-fonts.js`, `test-srvname.js`, `test-chatbg.js` and
`test-bgperf.js` (all require `jsdom`).

### Storage links

`node tools/test-storage.js` pins the "files never expire" contract: uploads
persist a permanent object URL (no signature in the database), every stored
URL — including old rows holding an expired presigned link — is re-signed at
render time from the key in its path, signatures are anchored to the start of
the UTC day so a file's URL is stable and cacheable, and role icons rendered
from markup (`<img data-nx-src>`) are hydrated the same way.

### History paging

`test-pagination.js` now expects 15 messages per page, and pages through the
"Load earlier messages" marker (an IntersectionObserver in browsers, a button
too). The page query fetches `PAGE + 1` rows so the end of history is known
exactly, with no dead marker over a history that divides evenly into pages.
