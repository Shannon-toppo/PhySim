// Builds the 2.x preview .vsix with the 2.x README and CHANGELOG
// (doc/next/README.md, doc/next/CHANGELOG.md).
//
// While 2.x is a pre-release the repository root keeps the 1.x README.md and
// CHANGELOG.md, because GitHub and the Marketplace page of the stable release
// show them. vsce 2.15 has no option for other files, so this swaps the root
// files for the 2.x ones while `vsce package --pre-release` runs and always
// puts the 1.x files back afterwards.
//
// The copies are adjusted for the extension page: the note about the
// repository layout at the top of each becomes a preview note, and the two
// README links that are relative to doc/next/ (README_en.md, CHANGELOG.md)
// become absolute. vsce resolves the remaining relative links (LICENSE,
// CONTRIBUTING.md, THIRD_PARTY_NOTICES.md) against the repository root, where
// those files are.
//
//   npm run package:preview

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const BLOB = "https://github.com/Shannon-toppo/PhySim/blob/main/doc/next/";

const swaps = [
  {
    name: "README.md",
    note: /^> これは2\.x（プレリリース）のREADMEです。.*$/m,
    previewNote: "> PhySim 2.xのプレビュー版（プレリリース）のREADMEです。正式版の1.xとは、使い方も必要な拡張機能も違います。",
    links: text => text
      .replaceAll("](README_en.md)", `](${BLOB}README_en.md)`)
      .replaceAll("](CHANGELOG.md)", `](${BLOB}CHANGELOG.md)`)
  },
  {
    name: "CHANGELOG.md",
    note: /^> 2\.x（プレリリース）の変更履歴です。.*$/m,
    previewNote: "> PhySim 2.xのプレビュー版（プレリリース）の変更履歴です。",
    links: text => text
  }
];

function previewText({ name, note, previewNote, links }, text) {
  if (!note.test(text)) throw new Error(`doc/next/${name}: the 2.x note at the top was not found`);
  return links(text.replace(note, previewNote));
}

// Build every copy before touching the root, so a bad doc/next file leaves it as it is.
const prepared = swaps.map(s => ({
  target: new URL(s.name, root),
  text: previewText(s, readFileSync(new URL(`doc/next/${s.name}`, root), "utf8"))
}));

const originals = prepared.map(p => ({ target: p.target, data: readFileSync(p.target) }));
let status;
try {
  for (const p of prepared) writeFileSync(p.target, p.text);
  const r = spawnSync("npx", ["vsce", "package", "--pre-release"],
    { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  status = r.status ?? 1;
} finally {
  for (const o of originals) writeFileSync(o.target, o.data);
}
process.exit(status);
