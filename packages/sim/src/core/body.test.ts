/**
 * Expeditions A1 (§7.1): the body's formulas, pinned to `core/body.ts`'s header at the default
 * bundle's numbers (tolerance 2 a limb or head, 3 the torso; a `serious` wound 1.2, a `grave`
 * 2.5; death below blood 0.25; floors 0.3 consciousness, 0.15 movement).
 */
import { describe, expect, it } from "vitest";
import {
  bodyCapacities,
  capacitiesOf,
  fatigueCapacity,
  incapacityOf,
  isDeadBy,
  partFunction,
  wholeBody,
  woundDamage,
  woundHealsFromTick,
} from "./body";
import { FIXTURE_BODIES } from "./fixtures/ship-life";
import type { Body } from "./types/actor";
import type { ConfigDef } from "./types/content";

const DAY = 3600;
const config: Pick<ConfigDef, "bodies" | "time" | "urgency" | "movement"> = {
  bodies: FIXTURE_BODIES,
  time: { tickRate: 20, daySeconds: DAY, watchesPerDay: 3 },
  urgency: { needSurvivalAbove: 0.9 } as ConfigDef["urgency"],
  movement: { fatigueSpeedFloor: 0.5 } as ConfigDef["movement"],
};

function body(edit: (b: Body) => void): Body {
  const b = wholeBody();
  edit(b);
  return b;
}

describe("body formulas (§7.1)", () => {
  it("a whole body is 1 across, alive and up", () => {
    const whole = wholeBody();
    expect(bodyCapacities(whole, config)).toEqual({
      movement: 1,
      manipulation: 1,
      consciousness: 1,
    });
    expect(isDeadBy(whole, config)).toBe(false);
    expect(incapacityOf(whole, config)).toBeUndefined();
  });

  it("a part works at 1 − damage / tolerance, clamped", () => {
    const hurt = body((b) => {
      b.parts.leftLeg.damage = 1.2;
      b.parts.rightArm.damage = 5;
    });
    expect(partFunction(hurt, "leftLeg", config)).toBeCloseTo(0.4, 12);
    expect(partFunction(hurt, "rightArm", config)).toBe(0);
    expect(partFunction(hurt, "head", config)).toBe(1);
  });

  it("one serious leg wound leaves movement at the legs' mean, 0.7, and hands alone", () => {
    const caps = bodyCapacities(
      body((b) => {
        b.parts.leftLeg.damage = 1.2;
      }),
      config,
    );
    expect(caps.movement).toBeCloseTo(0.7, 12);
    expect(caps.manipulation).toBe(1);
  });

  it("two serious wounds on one arm leave manipulation at half", () => {
    const caps = bodyCapacities(
      body((b) => {
        b.parts.rightArm.damage = 2.4;
      }),
      config,
    );
    expect(caps.manipulation).toBeCloseTo(0.5, 12);
    expect(caps.movement).toBe(1);
  });

  it("consciousness is the weakest of head, blood and stun, times 1 − pain / 2", () => {
    const at = (edit: (b: Body) => void) => bodyCapacities(body(edit), config).consciousness;
    expect(
      at((b) => {
        b.stun = 1;
      }),
    ).toBe(0);
    expect(
      at((b) => {
        b.stun = 0.5;
      }),
    ).toBeCloseTo(0.5, 12);
    expect(
      at((b) => {
        b.pain = 1;
      }),
    ).toBeCloseTo(0.5, 12);
    expect(
      at((b) => {
        b.blood = 0.25;
      }),
    ).toBe(0);
    expect(
      at((b) => {
        b.blood = 0.625;
      }),
    ).toBeCloseTo(0.5, 12);
    expect(
      at((b) => {
        b.parts.head.damage = 1.2;
      }),
    ).toBeCloseTo(0.4, 12);
    expect(
      at((b) => {
        b.parts.head.damage = 1;
        b.stun = 0.2;
        b.pain = 0.4;
      }),
    ).toBeCloseTo(0.5 * 0.8, 12);
  });

  it("death is a threshold: head or torso at tolerance, or blood below the floor", () => {
    expect(
      isDeadBy(
        body((b) => {
          b.parts.head.damage = 2;
        }),
        config,
      ),
    ).toBe(true);
    expect(
      isDeadBy(
        body((b) => {
          b.parts.torso.damage = 2.5;
        }),
        config,
      ),
    ).toBe(false);
    expect(
      isDeadBy(
        body((b) => {
          b.parts.torso.damage = 3;
        }),
        config,
      ),
    ).toBe(true);
    expect(
      isDeadBy(
        body((b) => {
          b.parts.leftLeg.damage = 10;
        }),
        config,
      ),
    ).toBe(false);
    expect(
      isDeadBy(
        body((b) => {
          b.blood = 0.25;
        }),
        config,
      ),
    ).toBe(false);
    expect(
      isDeadBy(
        body((b) => {
          b.blood = 0.2499;
        }),
        config,
      ),
    ).toBe(true);
  });

  it("incapacity names its cause: blood, stun, pain (the head), or movement", () => {
    expect(
      incapacityOf(
        body((b) => {
          b.blood = 0.4;
        }),
        config,
      ),
    ).toBe("blood");
    expect(
      incapacityOf(
        body((b) => {
          b.stun = 1;
        }),
        config,
      ),
    ).toBe("stun");
    expect(
      incapacityOf(
        body((b) => {
          b.parts.head.damage = 1.7;
        }),
        config,
      ),
    ).toBe("pain");
    const legless = body((b) => {
      b.parts.leftLeg.damage = 2;
      b.parts.rightLeg.damage = 1.8;
    });
    expect(bodyCapacities(legless, config).movement).toBeCloseTo(0.05, 12);
    expect(incapacityOf(legless, config)).toBe("movement");
    // One leg gone is a limp, not a fall.
    expect(
      incapacityOf(
        body((b) => {
          b.parts.leftLeg.damage = 2;
        }),
        config,
      ),
    ).toBeUndefined();
  });

  it("fatigue and a leg wound multiply; consciousness ignores fatigue", () => {
    const leg = body((b) => {
      b.parts.leftLeg.damage = 1.2;
    });
    const tired = { needs: { fatigue: 0.95 } as never, body: leg };
    const fatigue = fatigueCapacity(0.95, 0.9, 0.5);
    expect(fatigue).toBeCloseTo(0.75, 12);
    const caps = capacitiesOf(tired, config);
    expect(caps.movement).toBeCloseTo(fatigue * 0.7, 12);
    expect(caps.manipulation).toBeCloseTo(fatigue, 12);
    expect(caps.consciousness).toBe(1);
  });
});

describe("the wound clock (§7.1)", () => {
  const at = (seconds: number) => seconds * 20;

  it("a blaster serious bleeds 60 s, then heals half its damage a day", () => {
    const wound = { tick: 0, type: "blaster", severity: "serious" } as const;
    expect(woundHealsFromTick(wound, config)).toBe(at(60));
    expect(woundDamage(wound, at(60), config)).toBeCloseTo(1.2, 12);
    expect(woundDamage(wound, at(60 + DAY), config)).toBeCloseTo(0.6, 12);
    expect(woundDamage(wound, at(60 + 2 * DAY), config)).toBe(0);
    expect(woundDamage(wound, at(60 + 3 * DAY), config)).toBe(0);
  });

  it("a wound that never bled heals from its tick; a stun wound does no damage", () => {
    const graze = { tick: at(10), type: "blaster", severity: "graze" } as const;
    expect(woundHealsFromTick(graze, config)).toBe(at(10));
    expect(woundDamage(graze, at(10 + DAY), config)).toBeCloseTo(0.25, 12);
    const blunt = { tick: 0, type: "blunt", severity: "serious" } as const;
    expect(woundHealsFromTick(blunt, config)).toBe(0);
    expect(woundDamage({ tick: 0, type: "stun", severity: "serious" }, 0, config)).toBe(0);
  });

  it("a treated bleeder stops bleeding at its treatment and heals three times as fast from then", () => {
    const wound = { tick: 0, type: "blaster", severity: "serious", treatedTick: at(20) } as const;
    // §treatment-at-the-medbay-bed: the bleed stops at the treatment, 40 s early.
    expect(woundHealsFromTick(wound, config)).toBe(at(20));
    expect(woundDamage(wound, at(20), config)).toBeCloseTo(1.2, 12);
    // A third of a day treated heals what a whole day untreated would: half.
    expect(woundDamage(wound, at(20 + DAY / 3), config)).toBeCloseTo(0.6, 12);
    expect(woundDamage(wound, at(20 + (2 * DAY) / 3), config)).toBe(0);
  });

  it("a wound treated after its bleed stopped heals untreated until then, faster after", () => {
    const untreated = { tick: 0, type: "blaster", severity: "serious" } as const;
    const treated = { ...untreated, treatedTick: at(60 + DAY / 2) };
    expect(woundHealsFromTick(treated, config)).toBe(at(60));
    // Half a day at 0.5 a day (0.3 off), then a sixth of a day at three times that (0.3 more).
    expect(woundDamage(treated, at(60 + DAY / 2), config)).toBeCloseTo(0.9, 12);
    expect(woundDamage(treated, at(60 + DAY / 2 + DAY / 6), config)).toBeCloseTo(0.6, 12);
    expect(woundDamage(untreated, at(60 + DAY / 2 + DAY / 6), config)).toBeCloseTo(0.8, 12);
  });
});
