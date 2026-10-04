/**
 * The portrait screen's chrome (D72): fixed heights for the top bar and headline, and a compact
 * log that the player can expand, so a phone gives the canvas most of its height. The stylesheet
 * takes these numbers from the CSS custom properties `portraitCssVars` sets on `.app`, so the
 * canvas size `portraitCanvasSize` models (and the camera tests check legibility against) is the
 * one the app actually lays out.
 */

export const PORTRAIT_CHROME = {
  /** One row: speed buttons, clock, money and New game (border included). */
  topBarPx: 36,
  /** Two lines of 18 px headline, padding and border: the same height whether it wraps or not. */
  headlinePx: 45,
  /** Under the headline while the ship is not docked (`TravelBar`). */
  travelBarPx: 5,
  /** The compact log: one line and a peek of the next on a short phone... */
  logMinPx: 44,
  /** ...up to this on a tall one... */
  logMaxPx: 160,
  /** ...taking whatever the viewport has beyond this. */
  logReservePx: 660,
  /** Expanded, the log is as tall as it always was in portrait: 28% of the viewport, clamped. */
  logExpandedMinPx: 110,
  logExpandedMaxPx: 220,
  logExpandedFraction: 0.28,
} as const;

function clamp(min: number, value: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** The log's height on a portrait screen, CSS pixels; matches the stylesheet's `clamp()`s. */
export function portraitLogHeight(viewportHeight: number, expanded: boolean): number {
  const c = PORTRAIT_CHROME;
  return expanded
    ? clamp(c.logExpandedMinPx, viewportHeight * c.logExpandedFraction, c.logExpandedMaxPx)
    : clamp(c.logMinPx, viewportHeight - c.logReservePx, c.logMaxPx);
}

export interface PortraitCanvasOptions {
  /** The travel bar shows (the ship is not docked). */
  readonly travelBar: boolean;
  readonly logExpanded: boolean;
}

/** The canvas the portrait layout leaves between the chrome above and the log below. */
export function portraitCanvasSize(
  viewportWidth: number,
  viewportHeight: number,
  { travelBar, logExpanded }: PortraitCanvasOptions,
): { readonly width: number; readonly height: number } {
  const c = PORTRAIT_CHROME;
  const chrome = c.topBarPx + c.headlinePx + (travelBar ? c.travelBarPx : 0);
  return {
    width: viewportWidth,
    height: viewportHeight - chrome - portraitLogHeight(viewportHeight, logExpanded),
  };
}

/** The custom properties the stylesheet's portrait rules read, set on `.app`. */
export function portraitCssVars(): Readonly<Record<string, string>> {
  const c = PORTRAIT_CHROME;
  return {
    "--portrait-top-bar": `${c.topBarPx}px`,
    "--portrait-headline": `${c.headlinePx}px`,
    "--portrait-travel-bar": `${c.travelBarPx}px`,
    "--portrait-log-min": `${c.logMinPx}px`,
    "--portrait-log-max": `${c.logMaxPx}px`,
    "--portrait-log-reserve": `${c.logReservePx}px`,
    "--portrait-log-expanded-min": `${c.logExpandedMinPx}px`,
    "--portrait-log-expanded-max": `${c.logExpandedMaxPx}px`,
    "--portrait-log-expanded": `${c.logExpandedFraction * 100}vh`,
  };
}
