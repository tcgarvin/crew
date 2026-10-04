/**
 * D25/D26/D24 on the kernel side: an offer from a person with a pitch makes a card that names
 * them, carries aftermaths and no pay; a bare string issuer is still accepted; and schema-1 saves
 * migrate to the person form. Who the person is comes from the narrator (D40; offline, the null
 * narrator draws from the content name table, tested in `@crew/narrator`).
 */
import { describe, expect, it } from "vitest";
import { migrateJobsToPeople } from "../../core/migrations";
import { migrateState } from "../../core/save";
import type { Command } from "../../core/types/commands";
import type { CommandId } from "../../core/types/ids";
import { SCHEMA_VERSION } from "../../core/types/state";
import type { Job } from "../../core/types/travel";
import { FIX, PORTS, freightTestWorld } from "../travel/fixtures";

function personOffer(): Command {
  return {
    id: "cmd:people-test:0" as CommandId,
    source: "narrator",
    kind: "offerJob",
    payload: {
      job: {
        issuer: { name: "Ysolde Maren", role: "dock foreman", org: "Alpha Freight Co-op" },
        pitch: {
          key: "narrator.job.pitch",
          params: {},
          prose: "Ship's been at the ramp all shift.",
        },
        urgency: "soon",
        description: { key: "test.job", params: {} },
        fromPortId: PORTS.a,
        toPortId: PORTS.b,
        cargo: [{ itemDefId: FIX.crate, count: 2 }],
        pay: 100,
      },
      surface: true,
    },
  } as Command;
}

describe("commerce: offers come from people (D25)", () => {
  it("the offer card names the person, carries aftermaths and never the pay (D24, D26)", () => {
    const { world, kernel } = freightTestWorld();
    const command = personOffer();
    expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
    kernel.advance(world, 1);
    const job = Object.values(world.state.jobs).find((j) => j.causeCommandId === command.id);
    if (job === undefined) throw new Error("no offer was made");
    expect(job.issuer).toBe("Ysolde Maren, Alpha Freight Co-op");
    const decision = Object.values(world.state.decisions.records).find((d) => d.jobId === job.id);
    if (decision === undefined) throw new Error("the offer was not surfaced");
    expect(decision.prompt.key).toBe("job.offer");
    expect(decision.prompt.params).toMatchObject({
      name: "Ysolde Maren",
      role: "dock foreman",
      org: "Alpha Freight Co-op",
      from: job.fromPortId,
      to: job.toPortId,
      urgency: "soon",
      pitch: "Ship's been at the ramp all shift.",
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
    // A schema-1 save predates `markets` (D47, schema 3).
    // biome-ignore lint/performance/noDelete: simulating an older save's shape.
    delete state.markets;
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
    const migrated = migrateState(schemaOneState(), 1, {
      content: freightTestWorld().world.content,
    }) as {
      schemaVersion: number;
      jobs: Record<string, Job>;
      markets: Record<string, unknown>;
    };
    // D47 (schema 3) added `markets`; a 1 → 4 upgrade passes through every migration.
    expect(SCHEMA_VERSION).toBe(6);
    expect(migrated.schemaVersion).toBe(6);
    expect(migrated.markets).toEqual({});
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
