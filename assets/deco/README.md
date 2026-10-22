# Nitro decorations

Files here power the **Nitro shop** (Profile -> Nitro shop).

| Folder | What it is | Shown |
|---|---|---|
| `pfp/` | Avatar decorations (APNG/GIF overlays that sit around the profile picture) | Over the avatar, everywhere it appears |
| `profile/` | Profile / bio banners (APNG overlays for the About me box) | Behind the bio on the profile card and user card |

`manifest.json` lists the files the shop offers. Rebuild it after adding or
removing files:

```bash
node tools/build-deco-manifest.js                      # scan pfp/ and profile/
node tools/build-deco-manifest.js ~/Downloads/decos.zip  # unzip, sort, then scan
```

The zip form expects folders named `pfpdeco` / `profiledeco` (or `pfp` /
`profile`) anywhere inside it. Animated PNGs are saved with a `.png` extension,
which every browser draws as an animation.
