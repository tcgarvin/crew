/**
 * Slice 4 (D84): where each off-watch activity can be held on a deck, checked at L3.
 *
 * An activity's `venue` is an ordered list of alternatives; the sim takes the first present on the
 * deck (ship life plan, slice 4 call 12). An alternative is **present** when the deck has a
 * machine carrying its `machineTag` (for an `own` venue, one standing in a compartment with a
 * bed, so it can be somebody's), a zone carrying its `zoneTag`, or a compartment carrying its
 * `compartmentTag`. A present alternative must **fit** the activity: some one machine with at
 * least `participants.max` `use` positions, or a zone with at least `max` tiles. Where an
 * activity is hosted, the zone its product is set down on (`produces.zoneTag`) must exist.
 *
 * A deck with no venue for an activity never offers it. That is an error on a scenario's deck,
 * which the crew live on, and only a note on any other (Mk1 has no lounge or gym): notes are
 * reported by `activityVenueNotes`, never by `validateBundle`.
 */
import type { ActivityDef, ContentBundle, DeckDef, TileCoord, VenueDef } from "@crew/sim";
import { type Path, type ValidationIssue, issue } from "./issues";
import { type MachineTagTable, bedPlacementKeys } from "./validate-hull";

/** One present venue alternative and the compartments it stands in, for messages and READMEs. */
export interface HostedVenue {
  readonly venue: VenueDef;
  readonly compartments: readonly string[];
}

function compartmentNameAt(deck: DeckDef, tile: TileCoord): string | undefined {
  const symbol = deck.tiles[tile.y]?.[tile.x];
  return deck.compartments.find((c) => c.symbol === symbol)?.name;
}

/** Names of the compartments holding a bed: the only places a machine can be someone's `own`. */
function berthCompartments(deck: DeckDef, machines: MachineTagTable): Set<string> {
  const beds = new Set(bedPlacementKeys(deck, machines));
  const names = deck.machines
    .filter((p) => beds.has(p.key))
    .map((p) => compartmentNameAt(deck, p.origin));
  return new Set(names.filter((name) => name !== undefined));
}

/** "gamesTable machine", "own desk machine", "viewport zone", "lounge compartment". */
function venueNoun(venue: VenueDef): string {
  if (venue.machineTag !== undefined) {
    return `${venue.own === true ? "own " : ""}${venue.machineTag} machine`;
  }
  if (venue.zoneTag !== undefined) return `${venue.zoneTag} zone`;
  return `${venue.compartmentTag ?? ""} compartment`;
}

interface VenueFit {
  /** Compartments the alternative stands in; empty when it is not on the deck. */
  readonly compartments: readonly string[];
  /** Places it stands, with how many people each holds (`use` positions or zone tiles). */
  readonly capacities: readonly number[];
}

function fitOf(deck: DeckDef, machines: MachineTagTable, venue: VenueDef): VenueFit {
  if (venue.machineTag !== undefined) {
    const tag = venue.machineTag;
    const berths = venue.own === true ? berthCompartments(deck, machines) : undefined;
    const placed = deck.machines.flatMap((p) => {
      const def = machines[p.machineDefId];
      if (def?.tags.includes(tag) !== true) return [];
      const compartment = compartmentNameAt(deck, p.origin);
      if (compartment === undefined) return []; // L3 tile checks report a machine off the grid
      if (berths !== undefined && !berths.has(compartment)) return [];
      const seats = def.interactionPositions.filter((q) => q.purposes.includes("use")).length;
      return [{ compartment, seats }];
    });
    return {
      compartments: [...new Set(placed.map((p) => p.compartment))],
      capacities: placed.map((p) => p.seats),
    };
  }
  if (venue.zoneTag !== undefined) {
    const tag = venue.zoneTag;
    const zones = deck.zones.filter((z) => z.tags.includes(tag));
    const names = zones.flatMap((z) => (z.tiles[0] === undefined ? [] : [z.tiles[0]]));
    return {
      compartments: [
        ...new Set(names.map((t) => compartmentNameAt(deck, t)).filter((n) => n !== undefined)),
      ],
      capacities: zones.map((z) => z.tiles.length),
    };
  }
  const tag = venue.compartmentTag;
  const rooms = deck.compartments.filter((c) => tag !== undefined && c.tags.includes(tag));
  return {
    compartments: rooms.map((c) => c.name),
    capacities: rooms.map(() => Number.POSITIVE_INFINITY),
  };
}

/** The activity's venue alternatives present on the deck, in the def's order. */
export function hostedVenues(
  activity: ActivityDef,
  deck: DeckDef,
  machines: MachineTagTable,
): HostedVenue[] {
  return activity.venue.flatMap((venue) => {
    const { compartments } = fitOf(deck, machines, venue);
    return compartments.length === 0 ? [] : [{ venue, compartments }];
  });
}

function checkFit(
  activity: ActivityDef,
  deck: DeckDef,
  machines: MachineTagTable,
  issues: ValidationIssue[],
): void {
  const max = activity.participants.max;
  activity.venue.forEach((venue, i) => {
    const fit = fitOf(deck, machines, venue);
    if (fit.compartments.length === 0 || fit.capacities.some((c) => c >= max)) return;
    const unit = venue.machineTag !== undefined ? "use positions" : "tiles";
    issues.push(
      issue(
        "physical",
        ["activities", activity.id, "venue", i],
        `on "${deck.id}", the largest ${venueNoun(venue)} holds ${Math.max(...fit.capacities)} ${unit}; "${activity.id}" seats up to ${max}`,
      ),
    );
  });
  const product = activity.produces;
  if (product !== undefined && !deck.zones.some((z) => z.tags.includes(product.zoneTag))) {
    issues.push(
      issue(
        "physical",
        ["activities", activity.id, "produces", "zoneTag"],
        `"${deck.id}" has no "${product.zoneTag}" zone to set "${activity.id}"'s product on`,
      ),
    );
  }
}

function absenceMessage(activity: ActivityDef): string {
  const wanted = activity.venue.map(venueNoun).join(" or ");
  return `no venue for "${activity.id}": the deck has no ${wanted}`;
}

/** Decks some scenario sails: the crew live there, so every activity must have a venue. */
function scenarioDeckIds(bundle: ContentBundle): Set<string> {
  return new Set(Object.values(bundle.scenarios).map((s) => s.deckId));
}

/**
 * L3: every activity hosted on a deck fits its venue and has its product zone; on a scenario's deck
 * every activity is hosted.
 */
export function checkActivityVenues(
  deck: DeckDef,
  bundle: ContentBundle,
  issues: ValidationIssue[],
): void {
  const sailed = scenarioDeckIds(bundle).has(deck.id);
  for (const activity of Object.values(bundle.activities)) {
    if (hostedVenues(activity, deck, bundle.machines).length === 0) {
      if (sailed) issues.push(issue("physical", ["decks", deck.id], absenceMessage(activity)));
      continue;
    }
    checkFit(activity, deck, bundle.machines, issues);
  }
}

/**
 * Notes, not failures: each activity a deck no scenario sails cannot host (Mk1 has no lounge, gym,
 * book shelf or viewport). The bundle is valid with them; `crew content validate` prints them.
 */
export function activityVenueNotes(bundle: ContentBundle): readonly ValidationIssue[] {
  const sailed = scenarioDeckIds(bundle);
  const notes: ValidationIssue[] = [];
  for (const deck of Object.values(bundle.decks)) {
    if (sailed.has(deck.id)) continue;
    for (const activity of Object.values(bundle.activities)) {
      if (hostedVenues(activity, deck, bundle.machines).length > 0) continue;
      const path: Path = ["decks", deck.id];
      notes.push(issue("physical", path, absenceMessage(activity)));
    }
  }
  return notes;
}
