// The buttons and sliders of LifeBoatAPI's simulator window, as state a script
// reads through `simulator:getIsClicked(n)`, `getIsToggled(n)` and
// `getSlider(n)`. Pure module.
//
// LifeBoatAPI's STORMWORKS_Simulator.exe had ten buttons and ten sliders in
// its window. The rules kept from its Simulator.lua:
//   - a button and its toggle are one control: `getIsClicked(n)` is true while
//     button n is down, and every press of it flips `getIsToggled(n)`;
//   - a slider reads 0..1;
//   - a number outside 1..10 reads as unpressed / 0, without an error.
//
// Two things differ, both because PhySim has no window that always shows all
// twenty. The panel shows only the controls a script has asked about, so the
// board records which numbers were read. And a press is latched until a tick
// has had the chance to see it: a quick click between two ticks must not be
// lost, where the exe simply reported whatever it saw.

export const MAX_CONTROLS = 10;

/** What a panel needs to draw the controls a script uses. */
export interface ControlsInfo {
  buttons: Array<{
    number: number;
    /** The script reads `getIsToggled(n)`, so the toggle's state is worth showing. */
    showsToggle: boolean;
    toggled: boolean;
    /** Held down right now. A panel working its own buttons knows this itself; one that only watches does not. */
    down: boolean;
  }>;
  sliders: Array<{ number: number; value: number }>;
}

export const NO_CONTROLS: ControlsInfo = { buttons: [], sliders: [] };

/** A control number as LifeBoatAPI indexes them, or null. */
export function controlNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_CONTROLS ? v : null;
}

/** A slider position: finite, and clamped into 0..1. Null for anything that is not a number. */
export function sliderValue(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

export class ControlBoard {
  private pressed = new Set<number>();
  /** Pressed since the last tick ended, whether or not still down. */
  private latched = new Set<number>();
  private toggled = new Set<number>();
  private sliders = new Map<number, number>();
  private usedClick = new Set<number>();
  private usedToggle = new Set<number>();
  private usedSlider = new Set<number>();

  /** Fired when the script reads a control it had not read before. */
  onChange: ((info: ControlsInfo) => void) | null = null;

  /** @param sliders positions to start from — the panel's sliders stay where they were left across runs */
  constructor(sliders: Iterable<readonly [number, number]> = []) {
    for (const [n, v] of sliders) {
      const number = controlNumber(n), value = sliderValue(v);
      if (number !== null && value !== null) this.sliders.set(number, value);
    }
  }

  // --- What the script reads --------------------------------------------------

  readClicked(n: unknown): boolean {
    const number = controlNumber(n);
    if (number === null) return false;
    this.use(this.usedClick, number);
    return this.pressed.has(number) || this.latched.has(number);
  }

  readToggled(n: unknown): boolean {
    const number = controlNumber(n);
    if (number === null) return false;
    this.use(this.usedToggle, number);
    return this.toggled.has(number);
  }

  readSlider(n: unknown): number {
    const number = controlNumber(n);
    if (number === null) return 0;
    this.use(this.usedSlider, number);
    return this.sliders.get(number) ?? 0;
  }

  // --- What the panel (or an agent) does ------------------------------------------

  /** Press or release a button. A press flips its toggle. False when `n` is not a control number. */
  press(n: unknown, down: boolean): boolean {
    const number = controlNumber(n);
    if (number === null) return false;
    if (!down) { this.pressed.delete(number); return true; }
    if (this.pressed.has(number)) return true;
    this.pressed.add(number);
    this.latched.add(number);
    if (!this.toggled.delete(number)) this.toggled.add(number);
    return true;
  }

  /** A press and release at once: the next tick sees the button down, the one after does not. */
  click(n: unknown): boolean {
    return this.press(n, true) && this.press(n, false);
  }

  setSlider(n: unknown, v: unknown): boolean {
    const number = controlNumber(n), value = sliderValue(v);
    if (number === null || value === null) return false;
    this.sliders.set(number, value);
    return true;
  }

  /** A tick has run: presses it could see are no longer owed to anyone. */
  endTick(): void { this.latched.clear(); }

  info(): ControlsInfo {
    const numbers = (set: Set<number>): number[] => Array.from(set).sort((a, b) => a - b);
    return {
      buttons: numbers(new Set([...this.usedClick, ...this.usedToggle])).map(number => ({
        number, showsToggle: this.usedToggle.has(number), toggled: this.toggled.has(number),
        down: this.pressed.has(number)
      })),
      sliders: numbers(this.usedSlider).map(number => ({ number, value: this.sliders.get(number) ?? 0 }))
    };
  }

  private use(set: Set<number>, number: number): void {
    if (set.has(number)) return;
    set.add(number);
    this.onChange?.(this.info());
  }
}
