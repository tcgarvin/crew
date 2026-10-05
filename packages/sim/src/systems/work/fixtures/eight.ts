/** The 8-crew, 2-minute headless scenario used by the soak test. */
import type { TestWorld } from "../../../core/fixtures/test-world";
import type { Needs } from "../../../core/types/actor";
import {
  CREW,
  type CrewWorldOptions,
  addCrateToLoad,
  addPumpSymptom,
  crewWorld,
  place,
} from "./crew-deck";

/** Starting needs per actor index: a mix of hungry, tired, bored and fine. */
const START_NEEDS: readonly Needs[] = [
  { hunger: 0.55, fatigue: 0.2, comfort: 0.1, social: 0.1, recreation: 0 },
  { hunger: 0.1, fatigue: 0.1, comfort: 0.1, social: 0.2, recreation: 0 },
  { hunger: 0.2, fatigue: 0.62, comfort: 0.3, social: 0.1, recreation: 0 },
  { hunger: 0.6, fatigue: 0.3, comfort: 0.6, social: 0.4, recreation: 0 },
  { hunger: 0.1, fatigue: 0.1, comfort: 0.1, social: 0.6, recreation: 0 },
  { hunger: 0.3, fatigue: 0.58, comfort: 0.2, social: 0.2, recreation: 0 },
  { hunger: 0.52, fatigue: 0.1, comfort: 0.55, social: 0.1, recreation: 0 },
  { hunger: 0.1, fatigue: 0.2, comfort: 0.2, social: 0.55, recreation: 0 },
];

const START_TILES = [
  { x: 0, y: 5 },
  { x: 2, y: 5 },
  { x: 4, y: 6 },
  { x: 6, y: 5 },
  { x: 8, y: 6 },
  { x: 5, y: 2 },
  { x: 1, y: 2 },
  { x: 9, y: 3 },
];

export function eightCrewWorld(options: CrewWorldOptions = {}): TestWorld {
  const tw = crewWorld({ scenario: CREW.scenario8, ...options });
  const actors = Object.values(tw.world.state.actors);
  actors.forEach((actor, i) => {
    actor.needs = { ...(START_NEEDS[i % START_NEEDS.length] as Needs) };
    place(tw.world, actor.id, START_TILES[i % START_TILES.length] as { x: number; y: number });
  });
  addCrateToLoad(tw.world, { x: 3, y: 6 });
  addCrateToLoad(tw.world, { x: 1, y: 6 });
  addPumpSymptom(tw.world);
  return tw;
}
