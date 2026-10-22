#!/usr/bin/env node
/* Builds assets/deco/manifest.json, the list the Nitro shop reads.

     node tools/build-deco-manifest.js                       scan assets/deco/{pfp,profile}
     node tools/build-deco-manifest.js path/to/decos.zip     unzip first (needs the `unzip` command)

   Inside a zip, folders named pfpdeco / pfp (avatar frames) and profiledeco /
   profile (bio banners) are picked up wherever they sit. Only .png, .apng,
   .gif and .webp files are copied. APNGs are saved as .png so every server
   serves them as images. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DECO = path.join(ROOT, 'assets', 'deco');
const KINDS = {
  pfp: ['pfpdeco', 'pfp'],
  profile: ['profiledeco', 'profile'],
};
const EXT = /\.(png|apng|gif|webp)$/i;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const safeName = (n) => n.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-');
const titleOf = (file) => path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const idOf = (file) => safeName(path.basename(file, path.extname(file))).replace(/\.+/g, '-');

// An APNG is a PNG with an animation-control chunk (acTL) before the image data.
function isAnimated(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).equals(PNG_SIG)) return buf.indexOf('acTL') !== -1 && buf.indexOf('acTL') < buf.indexOf('IDAT');
  return /\.gif$/i.test(file) || /\.webp$/i.test(file); // GIF and WEBP are treated as animated
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function importZip(zip) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-deco-'));
  try {
    execFileSync('unzip', ['-q', '-o', zip, '-d', tmp], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`Could not unzip ${zip} (is the unzip command installed?): ${e.message}`);
  }
  let copied = 0;
  // Every folder in the archive whose name matches one of our kinds.
  const dirs = [];
  (function findDirs(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      dirs.push({ path: p, name: e.name.toLowerCase() });
      findDirs(p);
    }
  })(tmp);
  for (const [kind, names] of Object.entries(KINDS)) {
    for (const d of dirs.filter((x) => names.includes(x.name))) {
      const dest = path.join(DECO, kind);
      fs.mkdirSync(dest, { recursive: true });
      for (const f of walk(d.path)) {
        if (!EXT.test(f)) continue;
        const ext = /\.apng$/i.test(f) ? '.png' : path.extname(f).toLowerCase();
        fs.copyFileSync(f, path.join(dest, safeName(path.basename(f, path.extname(f))) + ext));
        copied++;
      }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Imported ${copied} file(s) from ${path.basename(zip)}.`);
}

function build() {
  const manifest = {};
  for (const kind of Object.keys(KINDS)) {
    const dir = path.join(DECO, kind);
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => EXT.test(f)).sort((a, b) => a.localeCompare(b))
      : [];
    manifest[kind === 'pfp' ? 'pfp' : 'profile'] = files.map((f) => {
      const abs = path.join(dir, f);
      return { id: idOf(f), name: titleOf(f), file: `assets/deco/${kind}/${f}`, animated: isAnimated(abs) };
    });
  }
  fs.writeFileSync(path.join(DECO, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote assets/deco/manifest.json: ${manifest.pfp.length} avatar frame(s), ${manifest.profile.length} bio banner(s).`);
}

const zipArg = process.argv[2];
if (zipArg) importZip(path.resolve(zipArg));
build();
