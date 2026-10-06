// media/*.html against the two things that read it: the element registries
// (dom.js / monitorDom.js, which throw at load on a missing id) and the
// {{placeholder}} list physSimPanel.ts fills (src/template.ts).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMMON_PLACEHOLDERS, PAGE_PLACEHOLDERS, substituteTemplate } from "../out/template.js";

const html = page => readFileSync(new URL(`../media/${page}`, import.meta.url), "utf8");
const idsOf = source => [...source.replace(/<!--[\s\S]*?-->/g, "").matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const placeholdersOf = source => new Set([...source.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]));

// The registries look their elements up while the module loads, so loading
// them against a recording `document` yields every id they need — the
// computed ones (sliders, c1..c17) included.
const requested = [];
globalThis.document = {
  getElementById: id => { requested.push(id); return {}; },
  querySelectorAll: () => []
};
await import("../media/monitorDom.js");
const monitorIds = [...requested];
await import("../media/dom.js");
const panelIds = [...requested];
delete globalThis.document;

test("the registries were really exercised", () => {
  assert.equal(monitorIds.length, 5);
  assert.ok(panelIds.length > 50, `only ${panelIds.length} lookups recorded`);
  assert.ok(panelIds.includes("c17") && panelIds.includes("aaz-num"));
});

test("panel.html has every element dom.js and monitorDom.js look up", () => {
  const ids = new Set(idsOf(html("panel.html")));
  assert.deepEqual(panelIds.filter(id => !ids.has(id)), []);
});

test("monitors.html has every element monitorDom.js looks up", () => {
  const ids = new Set(idsOf(html("monitors.html")));
  assert.deepEqual(monitorIds.filter(id => !ids.has(id)), []);
});

for (const page of Object.keys(PAGE_PLACEHOLDERS)) {
  test(`${page}: no id is used twice`, () => {
    const ids = idsOf(html(page));
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  });

  test(`${page}: its placeholders are exactly the ones physSimPanel.ts fills`, () => {
    const expected = [...COMMON_PLACEHOLDERS, ...PAGE_PLACEHOLDERS[page]].sort();
    assert.deepEqual([...placeholdersOf(html(page))].sort(), expected);
  });

  test(`${page}: substituting them leaves nothing unresolved`, () => {
    const values = Object.fromEntries(
      [...COMMON_PLACEHOLDERS, ...PAGE_PLACEHOLDERS[page]].map(k => [k, `<${k}>`]));
    const out = substituteTemplate(html(page), values, page);
    assert.ok(!out.includes("{{"));
    for (const k of Object.keys(values)) assert.ok(out.includes(`<${k}>`), k);
  });
}

test("substituteTemplate: replaces every occurrence of a key", () => {
  assert.equal(substituteTemplate("{{a}}-{{b}}-{{a}}", { a: "1", b: "2" }, "x.html"), "1-2-1");
});

test("substituteTemplate: a leftover placeholder throws, naming it and the page", () => {
  assert.throws(() => substituteTemplate("{{a}} {{typo}}", { a: "1" }, "panel.html"),
    /unresolved placeholder \{\{typo\}\} in media\/panel\.html/);
});
