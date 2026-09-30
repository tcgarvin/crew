/** Event significance tiers (review §C.4). */

/**
 * `trace`: diagnostic ring only. `notable`: shown in the UI ticker and uploaded. `narrative`:
 * story-relevant; resets the quiet-too-long timer and is fed to the narrator digest.
 */
export type Significance = "trace" | "notable" | "narrative";

/** Default significance per event type of one system; an emit may override it. */
export type SignificanceCatalog<P> = { readonly [K in keyof P]: Significance };
