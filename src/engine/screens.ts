// The microcontroller's monitors: which exist, how big they are, and where
// they are being touched. Pure module (no vscode, no engine) so the tests can
// drive it directly.
//
// Two parties declare monitors. The panel's layout is seeded before the script
// loads; the script's own `simulator:setScreen` calls then land on top of it.
// That is the precedence you want: the script under test describes the
// machine, the panel only fills in what the script left out.

/** Pixels per Stormworks monitor block. */
export const PX_PER_BLOCK = 32;

/**
 * Widest/tallest monitor accepted, in blocks. The game's largest is 9x5, and
 * the panel's dropdown only offers real sizes — but a script is free to call
 * `simulator:setScreen(1, "3x1")`, and the panel then shows that size back as
 * an extra option. The cap is what keeps a typo from asking for a frame the
 * engine has to rasterise every tick.
 */
export const MAX_BLOCKS = 9;

/** Cap on declared monitors; mirrors MAX_SCREENS in media/monitorConfig.js. */
export const MAX_SCREENS = 8;

/** What the webview is told about one monitor. */
export interface ScreenInfo {
  number: number;
  /** Pixels, after the portrait swap. */
  width: number;
  height: number;
  poweredOn: boolean;
  portrait: boolean;
  /** Block size as scripts spell it, e.g. "3x3". Drives the panel's size picker. */
  size: string;
}

/** One monitor somebody wants to exist. */
export interface ScreenRequest {
  number: number;
  size: string;
  poweredOn: boolean;
  portrait: boolean;
}

export interface TouchState {
  isTouched: boolean;
  isTouchedAlt: boolean;
  x: number;
  y: number;
  xAlt: number;
  yAlt: number;
}

export const NO_TOUCH: TouchState = Object.freeze({
  isTouched: false, isTouchedAlt: false, x: 0, y: 0, xAlt: 0, yAlt: 0
});

/** "3x2" → blocks, or null for anything that isn't a size inside the caps. */
export function parseBlocks(size: string): { bw: number; bh: number } | null {
  const m = /^(\d{1,2})x(\d{1,2})$/.exec(size);
  if (!m) return null;
  const bw = Number(m[1]), bh = Number(m[2]);
  if (bw < 1 || bh < 1 || bw > MAX_BLOCKS || bh > MAX_BLOCKS) return null;
  return { bw, bh };
}

/**
 * Validate a screen request arriving from the webview or from saved state.
 * Everything crossing that boundary is untrusted.
 */
export function sanitizeScreenRequest(v: unknown): ScreenRequest | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const number = Math.round(Number(o.number ?? o.screen));
  if (!Number.isFinite(number) || number < 1 || number > MAX_SCREENS) return null;
  const size = String(o.size ?? "");
  if (!parseBlocks(size)) return null;
  return { number, size, poweredOn: o.poweredOn !== false, portrait: o.portrait === true };
}

function toInfo(req: ScreenRequest): ScreenInfo {
  const blocks = parseBlocks(req.size);
  if (!blocks) throw new Error(`invalid screen size "${req.size}"`);
  const w = blocks.bw * PX_PER_BLOCK, h = blocks.bh * PX_PER_BLOCK;
  return {
    number: req.number,
    width: req.portrait ? h : w,
    height: req.portrait ? w : h,
    poweredOn: req.poweredOn,
    portrait: req.portrait,
    size: req.size
  };
}

interface Entry { info: ScreenInfo; touch: TouchState; }

export class ScreenRegistry {
  private screens = new Map<number, Entry>();

  /** Fired whenever the set of monitors, or one's size/power, changes. */
  onChange: ((screens: ScreenInfo[]) => void) | null = null;

  /** Sorted by number so the panel's monitor order never depends on declaration order. */
  list(): ScreenInfo[] {
    return Array.from(this.screens.values(), e => e.info).sort((a, b) => a.number - b.number);
  }

  get(number: number): ScreenInfo | undefined {
    return this.screens.get(number)?.info;
  }

  /** Add or reconfigure a monitor by its exact number (the panel's path). */
  configure(req: ScreenRequest): void {
    const info = toInfo(req);
    const old = this.screens.get(req.number);
    if (old && sameInfo(old.info, info)) return;
    // Powering off drops the touch, as a monitor losing power does.
    const touch = old && info.poweredOn ? old.touch : NO_TOUCH;
    this.screens.set(req.number, { info, touch });
    this.changed();
  }

  /**
   * `simulator:setScreen(n, size, poweredOn, portrait)`. Keeps LifeBoatAPI's
   * numbering rule: a number that names no existing monitor is not honoured,
   * the new monitor takes the next free one. Returns the number actually used.
   */
  declareFromScript(number: number, size: string, poweredOn: boolean, portrait: boolean): number {
    if (!parseBlocks(size)) {
      throw new Error(`setScreen: "${size}" is not a monitor size (expected e.g. "3x3", up to ${MAX_BLOCKS}x${MAX_BLOCKS})`);
    }
    let n = number;
    if (!this.screens.has(n)) {
      n = 1;
      while (this.screens.has(n)) n++;
      if (n > MAX_SCREENS) throw new Error(`setScreen: no more than ${MAX_SCREENS} monitors are supported`);
    }
    this.configure({ number: n, size, poweredOn, portrait });
    return n;
  }

  remove(number: number): void {
    if (this.screens.delete(number)) this.changed();
  }

  /** Pointer input from the webview. Ignored for a monitor that is off or gone. */
  setTouch(number: number, touch: TouchState): void {
    const e = this.screens.get(number);
    if (!e || !e.info.poweredOn) return;
    e.touch = {
      isTouched: touch.isTouched === true,
      isTouchedAlt: touch.isTouchedAlt === true,
      x: finiteInt(touch.x), y: finiteInt(touch.y),
      xAlt: finiteInt(touch.xAlt), yAlt: finiteInt(touch.yAlt)
    };
  }

  touch(number: number): TouchState {
    return this.screens.get(number)?.touch ?? NO_TOUCH;
  }

  private changed(): void {
    if (this.onChange) this.onChange(this.list());
  }
}

function sameInfo(a: ScreenInfo, b: ScreenInfo): boolean {
  return a.width === b.width && a.height === b.height && a.poweredOn === b.poweredOn
    && a.portrait === b.portrait && a.size === b.size;
}

function finiteInt(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
}
