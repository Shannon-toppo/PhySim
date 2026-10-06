// Checks the file list of the .vsix against what the extension needs at run
// time. Reads `vsce ls` output on stdin (npm run check:package):
//
//   - a file the extension loads but .vscodeignore (or a failed build step)
//     left out is only noticed after publishing, as a broken install;
//   - a development-only directory that slipped in bloats every download.
//
// vsce prints its prepublish log on the same stream, so lines that aren't
// paths are expected and ignored.

import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const ls = dir => readdirSync(new URL(dir, root));

const required = [
  "package.json",
  "package.nls.json",
  "package.nls.ja.json",
  "l10n/bundle.l10n.ja.json",
  "README.md",
  "LICENSE",
  "images/icon.png",
  "lua/PhySim.lua",
  "luasocket/darwin/socket/core.so",
  "luasocket/darwin/mime/core.so",
  // copied in by scripts/copy-three.js, not committed
  "media/three/three.module.js",
  "media/three/addons/controls/OrbitControls.js",
  "media/three/addons/controls/TransformControls.js",
  ...ls("src/").filter(f => f.endsWith(".ts")).map(f => `out/${f.slice(0, -3)}.js`),
  ...ls("media/").filter(f => /\.(js|html|css)$/.test(f)).map(f => `media/${f}`)
];

const forbidden = [
  /^(src|test|doc|tools|scripts|node_modules|\.github|\.vscode|\.claude)\//,
  /\.(ts|map|vsix)$/
];

const listed = new Set(readFileSync(0, "utf8").split(/\r?\n/).map(l => l.trim().replace(/\\/g, "/")));
const missing = required.filter(f => !listed.has(f));
const unwanted = [...listed].filter(f => !f.includes(" ") && forbidden.some(re => re.test(f)));

for (const f of missing) console.error(`missing from the package: ${f}`);
for (const f of unwanted) console.error(`should not be packaged: ${f}`);
if (missing.length || unwanted.length) process.exit(1);
console.log(`package contents OK (${required.length} required files present)`);
