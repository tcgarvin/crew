/**
 * §treatment-at-the-medbay-bed, §convalescing: on the real game (the beats voyage, every system),
 * the wounded are treated soon, and the ship's medic is the one who treats them when he can. A
 * strike lands on the next crew member in turn every few minutes (alternately a bleeding blaster
 * wound, a `serious` blunt one and a graze), besides whatever accidents the voyage makes.
 */
import type {
  ActorId,
  Command,
  CommandId,
  SimEvent,
  World,
  WoundId,
  WoundSeverity,
} from "@crew/sim";
import { createKernel } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { runBeatsAsync } from "./beats";
import { createPacingRegistry } from "./pacing";

/** The ship's medic (medical 8). */
const MEDIC = "Oyelaran Abiodun";
const STRIKE_EVERY_SECONDS = 300;
const STRIKES: readonly { severity: WoundSeverity; type: "blaster" | "blunt" }[] = [
  { severity: "serious", type: "blaster" },
  { severity: "serious", type: "blunt" },
  { severity: "graze", type: "blunt" },
];

interface Treatment {
  readonly patient: string;
  readonly medic: string;
  readonly severity: WoundSeverity;
  readonly seconds: number;
}

interface MedicineRun {
  readonly treatments: readonly Treatment[];
  readonly untreated: number;
}

/** `medical` units on the ship's floor or in someone's hands. */
function kitsAboard(world: World): number {
  let units = 0;
  for (const item of Object.values(world.state.items)) {
    if (world.content.items[item.defId]?.tags.includes("medical") !== true) continue;
    const kind = item.location.kind;
    if (kind !== "onDeck" && kind !== "carriedBy") continue;
    units += item.stacking === "stack" ? item.count : 1;
  }
  return units;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? Number.NaN)
    : ((sorted[mid - 1] ?? Number.NaN) + (sorted[mid] ?? Number.NaN)) / 2;
}

async function medicineRun(seed: number): Promise<MedicineRun> {
  const kernel = createKernel(createPacingRegistry());
  const wounds = new Map<WoundId, { tick: number; actorId: ActorId; severity: WoundSeverity }>();
  const treatments: Treatment[] = [];
  let strikes = 0;
  let commands = 0;
  const strikeNext = (world: World): void => {
    const crew = Object.values(world.state.actors)
      .filter((a) => a.crew && a.passenger !== true && a.availability === "available")
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (let tried = 0; tried < crew.length; tried++) {
      const target = crew[(strikes + tried) % crew.length];
      if (target === undefined || target.body.wounds.length > 0) continue;
      const hit = STRIKES[strikes % STRIKES.length] ?? STRIKES[0];
      if (hit === undefined) throw new Error("no strike kinds");
      commands += 1;
      const result = kernel.enqueueCommand(world, {
        id: `cmd:medicine:${commands}` as CommandId,
        source: "narrator",
        kind: "strike",
        payload: {
          actorId: target.id,
          severity: hit.severity,
          type: hit.type,
          part: "leftArm",
          how: `${target.name} is hurt`,
        },
      } as Command);
      if (result.status === "accepted") {
        strikes += 1;
        return;
      }
    }
  };
  const observe = (events: readonly SimEvent[], world: World): void => {
    const rate = world.config.values.time.tickRate;
    for (const event of events) {
      if (event.type === "wounded" && event.payload.type !== "stun") {
        wounds.set(event.payload.woundId, {
          tick: event.tick,
          actorId: event.payload.actorId,
          severity: event.payload.severity,
        });
      } else if (event.type === "woundTreated") {
        for (const id of event.payload.woundIds) {
          const wound = wounds.get(id);
          if (wound === undefined) continue;
          wounds.delete(id);
          treatments.push({
            patient: world.state.actors[wound.actorId]?.name ?? wound.actorId,
            medic: world.state.actors[event.payload.byActorId]?.name ?? event.payload.byActorId,
            severity: wound.severity,
            seconds: (event.tick - wound.tick) / rate,
          });
        }
      }
    }
    // A strike lands only while a kit is aboard for it: this measures who treats and how soon, not
    // the restocking (§medical-supplies), which the strikes' pace would outrun.
    const every = STRIKE_EVERY_SECONDS * rate;
    if (world.state.tick >= (strikes + 1) * every && kitsAboard(world) > wounds.size) {
      strikeNext(world);
    }
  };
  await runBeatsAsync({ scenario: "freight", days: 2, seed, fields: "none", observe }, kernel);
  return { treatments, untreated: wounds.size };
}

describe("medicine on the real game (§treatment-at-the-medbay-bed, §convalescing)", () => {
  const runs = new Map<number, Promise<MedicineRun>>();
  const runOf = (seed: number): Promise<MedicineRun> => {
    let run = runs.get(seed);
    if (run === undefined) {
      run = medicineRun(seed);
      runs.set(seed, run);
    }
    return run;
  };

  it.each([1, 2, 3])(
    "seed %i: the wounded are treated within 150 s at the median",
    async (seed) => {
      const run = await runOf(seed);
      const seconds = run.treatments.map((t) => t.seconds);
      expect(run.treatments.length).toBeGreaterThanOrEqual(4);
      expect(median(seconds)).toBeLessThan(150);
      // A serious wound walks to the bed at once (essential) rather than after the watch's work.
      const serious = run.treatments.filter((t) => t.severity !== "graze").map((t) => t.seconds);
      expect(Math.max(...serious)).toBeLessThan(300);
    },
    600_000,
  );

  it.each([1, 2, 3])(
    "seed %i: the ship's medic treats someone else",
    async (seed) => {
      const run = await runOf(seed);
      expect(run.treatments.some((t) => t.medic === MEDIC && t.patient !== MEDIC)).toBe(true);
    },
    600_000,
  );
});
