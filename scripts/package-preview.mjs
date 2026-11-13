// Builds the 2.x preview .vsix with the 2.x README (doc/next/README.md).
//
// While 2.x is a pre-release the repository root keeps the 1.x README.md,
// because GitHub and the Marketplace page of the stable release show it.
// vsce 2.15 has no option for another README, so this swaps the root file
// for the 2.x one while `vsce package --pre-release` runs and always puts
// the 1.x file back afterwards.
//
// The copy is adjusted for the extension page: the note about the repository
// layout becomes a preview note, and the two links that are relative to
// doc/next/ (README_en.md, CHANGELOG.md) become absolute. vsce resolves the
// remaining relative links (LICENSE, CONTRIBUTING.md) against the repository
// root, where those files are.
//
//   npm run package:preview

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const README = new URL("README.md", root);
const NEXT = new URL("doc/next/README.md", root);
const BLOB = "https://github.com/Shannon-toppo/PhySim/blob/main/doc/next/";

const NOTE = /^> これは2\.x（プレリリース）のREADMEです。.*$/m;
const PREVIEW_NOTE = "> PhySim 2.xのプレビュー版（プレリリース）のREADMEです。正式版の1.xとは、使い方も必要な拡張機能も違います。";

function previewReadme(text) {
  if (!NOTE.test(text)) throw new Error("doc/next/README.md: the 2.x note at the top was not found");
  return text
    .replace(NOTE, PREVIEW_NOTE)
    .replaceAll("](README_en.md)", `](${BLOB}README_en.md)`)
    .replaceAll("](CHANGELOG.md)", `](${BLOB}CHANGELOG.md)`);
}

const original = readFileSync(README);
let status;
try {
  writeFileSync(README, previewReadme(readFileSync(NEXT, "utf8")));
  const r = spawnSync("npx", ["vsce", "package", "--pre-release"],
    { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  status = r.status ?? 1;
} finally {
  writeFileSync(README, original);
}
process.exit(status);
