// Which monitor a verification page was shot on, from its name.
//
// Every card until E was shot on a 3x3 monitor (96x96), and its pages are
// named after the page alone ("A1", "D12"). A page shot on another monitor
// carries the monitor's size in blocks: "E2_5x3" is page E2 on a 5x3, which
// is 160x96 — every Stormworks monitor has 32 pixels per block. The same name
// is the screenshot's file name and the page's key in
// test/fixtures/ingame-raster.json, so the tools and the test agree on it.

/** Pixels per monitor block. */
export const BLOCK = 32;

const NAME_RE = /^([A-Z])(\d+)(?:_(\d+)x(\d+))?$/;

/**
 * @param {string} name e.g. "D4", "E2_5x3"
 * @returns {{ card: string, page: number, width: number, height: number }}
 */
export function parsePage(name) {
  const m = NAME_RE.exec(name);
  if (!m) throw new Error(`${name}: not a page name (like "D4" or "E2_5x3")`);
  const [, card, page, bw = "3", bh = "3"] = m;
  return { card, page: Number(page), width: BLOCK * Number(bw), height: BLOCK * Number(bh) };
}

/** Is this a page name at all? @param {string} name */
export const isPageName = (name) => NAME_RE.test(name);
