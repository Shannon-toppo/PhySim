// Localisation bookkeeping: every %key% in package.json has English and
// Japanese text, and every vscode.l10n.t() string has a Japanese entry. The
// English string is the key, so editing one in src/ silently orphans its
// translation — that is the case this catches.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const text = p => readFileSync(new URL(p, root), "utf8");
const json = p => JSON.parse(text(p));

const nlsEn = json("package.nls.json");
const nlsJa = json("package.nls.ja.json");
const bundleJa = json("l10n/bundle.l10n.ja.json");

const usedNlsKeys = [...new Set([...text("package.json").matchAll(/"%([^%"]+)%"/g)].map(m => m[1]))];

const sources = readdirSync(new URL("src/", root)).filter(f => f.endsWith(".ts")).map(f => text(`src/${f}`)).join("\n");
const callCount = [...sources.matchAll(/\bl10n\.t\(/g)].length;
// First argument as a plain string literal; anything else (a variable, a
// template literal) can't be looked up here and is rejected below.
const l10nKeys = [...sources.matchAll(/\bl10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(`"${m[1]}"`));

const args = s => [...new Set(s.match(/\{\d+\}/g) ?? [])].sort();

test("package.json: every %key% has English text", () => {
  assert.ok(usedNlsKeys.length > 0);
  assert.deepEqual(usedNlsKeys.filter(k => !(k in nlsEn)), []);
});

test("package.nls.json and package.nls.ja.json define the same keys", () => {
  assert.deepEqual(Object.keys(nlsJa).sort(), Object.keys(nlsEn).sort());
});

test("package.nls.json has no key package.json stopped using", () => {
  assert.deepEqual(Object.keys(nlsEn).filter(k => !usedNlsKeys.includes(k)), []);
});

test("every l10n.t() call passes a string literal", () => {
  assert.ok(callCount > 0);
  assert.equal(l10nKeys.length, callCount);
});

test("every l10n.t() string has a Japanese entry", () => {
  assert.deepEqual(l10nKeys.filter(k => !(k in bundleJa)), []);
});

test("the Japanese bundle has no entry src/ stopped using", () => {
  assert.deepEqual(Object.keys(bundleJa).filter(k => !l10nKeys.includes(k)), []);
});

test("a translation keeps the {n} arguments of its English string", () => {
  for (const [en, ja] of Object.entries(bundleJa)) assert.deepEqual(args(ja), args(en), en);
});
