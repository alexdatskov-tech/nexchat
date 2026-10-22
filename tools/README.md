# tools

## build-emoji.js

Regenerates `assets/js/emoji-data.js` from the Unicode CLDR data in the
`emojibase-data` package (`npm i emojibase-data && node tools/build-emoji.js`).
Unicode <= 15.0 only, and the "component" group (skin tones, regional
letters) is dropped.

## build-deco-manifest.js

Rebuilds `assets/deco/manifest.json` from the files in `assets/deco/pfp` and
`assets/deco/profile`.

After adding decorations, also make the optimised copies the app actually
loads (`assets/deco/opt/<kind>/<name>.webp` animated, `<name>.still.webp`
for the shop grid). Any Python with Pillow can do it; the originals stay the
fallback, so a missing copy only costs speed:

```python
from PIL import Image, ImageSequence
# per file: resize every frame (pfp 128x128, profile 260x508 every 2nd frame),
# save as animated WebP quality 50, and the first frame at half size as .still.webp
```

## test-*.js

Node harnesses for the backend contracts that are still in use: the SQL files
(`test-sql.js`, `test-drive-sharing-sql.js`), drive sharing, storage groups and
live-call presence. `./runall.sh` runs them all (they need `jsdom` and
`pgsql-parser`: `npm i jsdom pgsql-parser`).

The v3 front end is tested by driving the real app in a browser against two
test accounts; see the overhaul notes in the pull request.
