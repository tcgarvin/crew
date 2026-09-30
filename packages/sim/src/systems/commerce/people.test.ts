/**
 * D25/D26/D24 on the kernel side: offers come from a person with a pitch (the null job source
 * draws them from the content name table), the offer card carries aftermaths and no pay, a bare
 * string issuer is still accepted, and schema-1 saves migrate to the person form.
 */
import { describe, expect, it } from "vitest";
import { createKernel } from "../../core/kernel";
import { migrateJobsToPeople } from "../../core/migrations";
import { createRegistry } from "../../core/registry";
import { migrateState } from "../../core/save";
import type { Command } from "../../core/types/commands";
import type { ContentBundle, PeopleTableDef } from "../../core/types/content";
import type { CommandId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { SCHEMA_VERSION } from "../../core/types/state";
import type { Job } from "../../core/types/travel";
import { registerTravel } from "../travel";
import {
  FIX,
  PORTS,
  advanceThroughHooks,
  fixtureConfig,
  fixtureContent,
  fixtureEffectiveConfig,
  freightTestWorld,
} from "../travel/fixtures";
import { registerCommerce } from "./index";

const PEOPLE: PeopleTableDef = {
  givenNames: ["Ysolde", "Tobiah", "Anouk", "Hamid", "Wren"],
  familyNames: ["Maren", "Okafor", "Lindqvist", "Duarte"],
  pitches: ["I've got {cargo} for {to} and nobody else I trust with it."],
  cargoWords: {
    general: "general freight",
    fragile: "fragile equipment",
    perishable: "fresh produce",
    hazardous: "hazardous cargo",
  },
  ports: {
    [PORTS.a]: {
      roles: ["dock foreman", "freight broker"],
      orgs: ["Alpha Freight Co-op", "Alpha Growers"],
      pitches: ["Ship's been sitting at the ramp all shift. Want something to carry to {to}?"],
    },
  },
};

function worldWithPeople(seed: number): { world: World; kernel: ReturnType<typeof createKernel> } {
  const registry = createRegistry();
  registerTravel(registry);
  registerCommerce(registry);
  const kernel = createKernel(registry);
  const config = fixtureConfig();
  const content: ContentBundle = { ...fixtureContent(config), people: PEOPLE };
  const world = kernel.createWorld(FIX.scenario, seed, content, fixtureEffectiveConfig(config));
  return { world, kernel };
}

/** Run until the job source's first offer is on the board and return it with its decision. */
function firstOffer(world: World, kernel: ReturnType<typeof createKernel>) {
  advanceThroughHooks(kernel, world, 200);
  const job = Object.values(world.state.jobs)[0];
  const decision = Object.values(world.state.decisions.records).find((d) => d.jobId === job?.id);
  if (job === undefined || decision === undefined) throw new Error("no offer was made");
  return { job, decision };
}

function personOf(job: Job) {
  return { issuer: job.issuer, person: job.issuerPerson, pitch: job.pitch, urgency: job.urgency };
}

describe("commerce: offers come from people (D25)", () => {
  it("the null job source draws a person and a pitch from the name table", () => {
    const { world, kernel } = worldWithPeople(7);
    const { job } = firstOffer(world, kernel);
    const person = job.issuerPerson;
    const [given, family] = person.name.split(" ");
    expect(PEOPLE.givenNames).toContain(given);
    expect(PEOPLE.familyNames).toContain(family);
    expect(PEOPLE.ports[PORTS.a]?.roles).toContain(person.role);
    expect(PEOPLE.ports[PORTS.a]?.orgs).toContain(person.org);
    expect(job.issuer).toBe(`${person.name}, ${person.org}`);
    // Placeholders are filled from content; no braces and no numbers survive.
    expect(job.pitch.prose).toBeDefined();
    expect(job.pitch.prose).not.toMatch(/[{}]|\d/);
    expect(job.pitch.prose).toMatch(/general freight|Beta Yard|Gamma Ring/);
  });

  it("is deterministic per seed", () => {
    const a = worldWithPeople(11);
    const b = worldWithPeople(11);
    expect(personOf(firstOffer(a.world, a.kernel).job)).toEqual(
      personOf(firstOffer(b.world, b.kernel).job),
    );
    const names = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) => {
        const w = worldWithPeople(seed);
        return firstOffer(w.world, w.kernel).job.issuerPerson.name;
      }),
    );
    expect(names.size).toBeGreaterThan(1);
  });

  it("the offer card names the person, carries aftermaths and never the pay (D24, D26)", () => {
    const { world, kernel } = worldWithPeople(3);
    const { job, decision } = firstOffer(world, kernel);
    expect(decision.prompt.key).toBe("job.offer");
    expect(decision.prompt.params).toMatchObject({
      name: job.issuerPerson.name,
      role: job.issuerPerson.role,
      org: job.issuerPerson.org,
      from: job.fromPortId,
      to: job.toPortId,
      urgency: job.urgency,
      pitch: job.pitch.prose,
    });
    expect(decision.prompt.params).not.toHaveProperty("pay");
    expect(Object.values(decision.prompt.params)).not.toContain(job.pay);
    expect(decision.left.aftermath).toEqual({ key: "job.accept.aftermath", params: {} });
    expect(decision.right.aftermath).toEqual({ key: "job.decline.aftermath", params: {} });
  });

  it("still accepts a bare string issuer and normalises it", () => {
    const { world, kernel } = freightTestWorld();
    const command = {
      id: "cmd:people-test:1" as CommandId,
      source: "scenario",
      kind: "offerJob",
      payload: {
        job: {
          issuer: "  Rendell Freight Co.  ",
          description: { key: "test.job", params: {} },
          fromPortId: PORTS.a,
          toPortId: PORTS.b,
          cargo: [{ itemDefId: FIX.crate, count: 2 }],
          pay: 100,
        },
        surface: false,
      },
    } as Command;
    expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
    kernel.advance(world, 1);
    const job = Object.values(world.state.jobs).find((j) => j.causeCommandId === command.id);
    expect(job?.issuerPerson).toEqual({ name: "Rendell Freight Co.", role: "shipper" });
    expect(job?.issuer).toBe("Rendell Freight Co., shipper");
    expect(job?.pitch).toEqual({ key: "job.pitch.default", params: {} });
    expect(job?.urgency).toBe("relaxed");
  });

  it("rejects an issuer without a name", () => {
    const { world, kernel } = freightTestWorld();
    const result = kernel.enqueueCommand(world, {
      id: "cmd:people-test:2" as CommandId,
      source: "narrator",
      kind: "offerJob",
      payload: {
        job: {
          issuer: { name: " ", role: "clerk" },
          description: { key: "test.job", params: {} },
          fromPortId: PORTS.a,
          toPortId: PORTS.b,
          cargo: [{ itemDefId: FIX.crate, count: 2 }],
          pay: 100,
        },
        surface: false,
      },
    } as Command);
    expect(result).toMatchObject({ status: "rejected", rejection: { code: "invalidPayload" } });
  });
});

describe("save migration 1 → 2 (D25)", () => {
  function schemaOneState(): Record<string, unknown> {
    const { world } = freightTestWorld();
    const state = JSON.parse(JSON.stringify(world.state)) as Record<string, unknown>;
    state.schemaVersion = 1;
    state.jobs = {
      j1: {
        id: "j1",
        origin: "portBoard",
        issuer: "Rendell Freight Co.",
        description: { key: "job.template", params: {} },
        fromPortId: PORTS.a,
        toPortId: PORTS.b,
        cargo: [{ itemDefId: FIX.crate, count: 2 }],
        cargoClass: "general",
        pay: 100,
        status: "offered",
        offeredTick: 0,
        expiresAtTick: 1000,
        cargoItemIds: [],
      },
    };
    // Keep the id counter ahead of the hand-made job, as the kernel's allocator would.
    (state.nextId as Record<string, number>).job = 2;
    return state;
  }

  it("turns an old issuer string into a person and keeps it as the label", () => {
    const migrated = migrateState(schemaOneState(), 1) as {
      schemaVersion: number;
      jobs: Record<string, Job>;
    };
    expect(SCHEMA_VERSION).toBe(2);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.jobs.j1).toMatchObject({
      issuer: "Rendell Freight Co.",
      issuerPerson: { name: "Rendell Freight Co.", role: "shipper" },
      pitch: { key: "job.pitch.default", params: {} },
      urgency: "relaxed",
    });
  });

  it("leaves already-migrated jobs and junk alone", () => {
    const person = { name: "Ysolde Maren", role: "grower" };
    const state = { jobs: { j1: { issuer: "Ysolde Maren, grower", issuerPerson: person } } };
    expect(migrateJobsToPeople(state)).toEqual(state);
    expect(migrateJobsToPeople(null)).toBeNull();
    expect(migrateJobsToPeople({ jobs: 3 })).toEqual({ jobs: 3 });
  });

  it("a schema-1 save restores through the kernel", () => {
    const { world, kernel } = freightTestWorld();
    const envelope = kernel.serialize(world);
    const old = { ...envelope, schemaVersion: 1, state: schemaOneState() as never };
    const restored = kernel.restore(old, world.content);
    expect(restored.state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Object.values(restored.state.jobs)[0]?.issuerPerson.name).toBe("Rendell Freight Co.");
  });
});
