/**
 * §shore-leave in play: a plain pacing voyage of three ship's days docks, plots its course within
 * seconds and still works its cargo and plot for a minute, and the off watch may spend that wait
 * ashore. At least one drink ashore starts, and at every cast-off nobody aboard is left on the dock
 * (§calling-the-crew-aboard ends the leave at prep). Stops are short and few of the crew are awake,
 * off watch and bored at one, so a drink is rare (seeds 1-4: 0, 1, 0, 0 started); seed 2 has one.
 */
import { type SimEvent, type World, isOnDock } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { runBeatsAsync } from "./beats";

const SHORE_LEAVE = "activity.shore_leave";

interface ShoreTally {
  sessions: number;
  undockings: number;
  leftOnDock: string[];
}

async function plainRun(seed: number): Promise<ShoreTally> {
  const tally: ShoreTally = { sessions: 0, undockings: 0, leftOnDock: [] };
  const observe = (events: readonly SimEvent[], world: World): void => {
    for (const event of events) {
      if (event.type === "sessionStarted" && event.payload.activityId === SHORE_LEAVE) {
        tally.sessions += 1;
      }
      if (event.type === "travelStageChanged" && event.payload.to === "undocking") {
        tally.undockings += 1;
        for (const actor of Object.values(world.state.actors)) {
          if (!actor.crew || actor.availability === "offShip" || actor.availability === "dead") {
            continue;
          }
          if (isOnDock(world.content, world.state, actor.location)) {
            tally.leftOnDock.push(`${actor.name} at tick ${world.state.tick}`);
          }
        }
      }
    }
  };
  await runBeatsAsync({ scenario: "plain", days: 3, seed, fields: "none", observe });
  return tally;
}

describe("shore leave in play (§shore-leave)", () => {
  it("three plain ship's days (seed 2): a drink ashore starts, and nobody is on the dock at cast-off", async () => {
    const tally = await plainRun(2);
    expect(tally.undockings).toBeGreaterThan(0);
    expect(tally.sessions).toBeGreaterThan(0);
    expect(tally.leftOnDock).toEqual([]);
  }, 600_000);
});
