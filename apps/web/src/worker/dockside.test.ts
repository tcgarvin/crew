/**
 * Kernel integration (§dock-alongside) on the real authored bundle and every V1 system: a new game
 * starts with the Hub's dock alongside, and a schema-3 save made docked mid-loading (freight still
 * in the warehouse store) restores with its dock and its freight moved to the staging area
 * (§offered-freight), finishes loading, leaves with the dock cast off, and arrives with the next
 * port's dock alongside. The travel invariant holds every tick.
 *
 * §offered-freight (Dockside §10): a full Hub → Kessler run with freight: staged on offer, loaded
 * by the crew from the staging area (in hand or on the hand truck, §hand-truck-trips), delivered to
 * the delivery bay, paid once. Every invariant, the commerce one included, holds every tick.
 *
 * §locals-table (Dockside phase 3): locals. A new game's Hub dock has its regulars at their posts
 * (Hal Petrosyan at the queue kiosk); the offer's crates are carted out by a dock hand; the staging
 * call is raised before every docking and no card comes up on the way in; Kessler's dock comes
 * alongside with its regulars and the delivery's receiver, who carts the crates in; and back at the
 * Hub, Hal is at his kiosk again.
 *
 * §offers-in-person (Dockside phase 4): the same run with the work offered in person: the captain
 * walks ashore, is asked about once, walks over to Hal at his kiosk, and his card comes up there;
 * loaded, delivered, paid once, and no card ever comes up in flight. The rest is
 * `captain-ashore.test.ts`.
 *
 * It lives here, not in `packages/sim`, for the same reason `fullSim.test.ts` does: the kernel
 * package may not depend on `@crew/content`.
 */
import type {
  Command,
  CommandId,
  ContentBundle,
  ItemId,
  Kernel,
  NarratorHook,
  PhysicalLocation,
  PortDefId,
  SaveEnvelope,
  SimEvent,
  World,
} from "@crew/sim";
import {
  commerceViolations,
  dockAlongside,
  getRenderFrame,
  isInDockArea,
  isOnDock,
  migrations,
  restore,
  travelViolations,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { createFullRegistry } from "./registry";
import { assertInvariants, captainOf, newGame } from "./testGame";

const HUB = "port.crossroads_hub" as PortDefId;
const HUB_DOCK = "dock.crossroads_hub";

/** §locals-table: the locals on the dock in the frame, by name, with their posts. */
function localsByName(world: World): Map<string, { postKey: string; x: number; y: number }> {
  return new Map(getRenderFrame(world).locals.map((l) => [l.name, l]));
}

/**
 * §locals-table: is this local standing at (or beside, when it was taken) that post on the dock?
 */
function nearPost(world: World, local: { x: number; y: number }, postKey: string): boolean {
  const berth = dockAlongside(world.content, world.state);
  const post = berth?.dock.posts.find((p) => p.key === postKey);
  if (berth === undefined || post === undefined) return false;
  const px = post.tile.x - berth.shipAt.x + 0.5;
  const py = post.tile.y - berth.shipAt.y + 0.5;
  return Math.abs(local.x - px) <= 2 && Math.abs(local.y - py) <= 2;
}

/** The stand-in narrator of `fullSim.test.ts`: one surfaced freight offer per `captainAshore`. */
function answerHook(world: World, hook: NarratorHook): Omit<Command, "id"> | undefined {
  if (hook.kind !== "captainAshore") return undefined;
  const portId = hook.context.portId as PortDefId;
  const port = world.content.ports[portId];
  if (port === undefined) return undefined;
  for (const template of port.jobTemplates) {
    const line = template.cargo[0];
    const distance = port.routes.find((r) => r.toPortId === template.toPortId)?.distance;
    const cargoClass =
      line === undefined ? undefined : world.content.items[line.itemDefId]?.cargoClass;
    if (line === undefined || distance === undefined || cargoClass === undefined) continue;
    const band = world.config.values.commerce.priceBands[cargoClass];
    return {
      source: "narrator",
      kind: "offerJob",
      payload: {
        job: {
          issuer: { name: "Stand-in Narrator", role: "dispatcher" },
          description: { key: "test.job", params: {} },
          fromPortId: portId,
          toPortId: template.toPortId,
          cargo: [{ itemDefId: line.itemDefId, count: 2 }],
          pay: Math.ceil(band.min * distance * 2),
        },
        surface: true,
      },
    };
  }
  return undefined;
}

let n = 0;

/** Advance tick by tick, answering hooks and accepting every card, checking every invariant. */
function drive(
  kernel: Kernel,
  world: World,
  ticks: number,
  until: (world: World) => boolean,
): SimEvent[] {
  const events: SimEvent[] = [];
  const send = (command: Omit<Command, "id">) => {
    n += 1;
    const result = kernel.enqueueCommand(world, {
      ...command,
      id: `cmd:dockside:${n}` as CommandId,
    } as Command);
    if (result.status !== "accepted") throw new Error(`${command.kind}: ${JSON.stringify(result)}`);
  };
  for (let i = 0; i < ticks; i++) {
    const result = kernel.advance(world, 1);
    events.push(...result.events);
    assertInvariants(world);
    if (result.halt.kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("hook halt without a pending hook");
      const answer = answerHook(world, hook);
      if (answer !== undefined) send(answer);
      send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
    } else if (result.halt.kind === "decision") {
      const head = world.state.decisions.queue[0];
      if (head === undefined) throw new Error("decision halt without a queued decision");
      send({
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: head, side: "left" },
      });
    }
    if (until(world)) break;
  }
  return events;
}

/**
 * The envelope as schema 3 wrote it: no `deck.dock`, the ramps shut as they used to shut, and no
 * freight on a dock (§offered-freight): a taken job's crates still waiting to load are in the
 * port's warehouse store, where schema 3 spawned them, and the crew believe them there; an offer
 * has none.
 */
function asSchema3(envelope: SaveEnvelope, content: ContentBundle): SaveEnvelope {
  const state = structuredClone(envelope.state);
  const onDock = (location: PhysicalLocation) => isOnDock(content, envelope.state, location);
  // biome-ignore lint/performance/noDelete: a schema-3 save has no such key.
  delete state.deck.dock;
  for (const door of Object.values(state.doors)) {
    if (door.kind !== "ramp") continue;
    door.physicalState = "closed";
    door.requestedState = "closed";
  }
  for (const job of Object.values(state.jobs)) {
    if (job.status === "offered") {
      for (const itemId of job.cargoItemIds) delete state.items[itemId];
      job.cargoItemIds = [];
      continue;
    }
    if (job.status !== "accepted") continue;
    for (const itemId of job.cargoItemIds) {
      const item = state.items[itemId];
      if (item === undefined || !onDock(item.location)) continue;
      item.location = { kind: "inExternalStore", portId: job.fromPortId, storeKey: "warehouse" };
      for (const actor of Object.values(state.actors)) {
        const fact = actor.knowledge[`${itemId}/itemLocation`];
        if (fact?.factType === "itemLocation") fact.value = { location: item.location };
      }
    }
  }
  // Schema 3 had no locals.
  const raw = state as unknown as Record<string, unknown>;
  // biome-ignore lint/performance/noDelete: a schema-3 save has no such key.
  delete raw.dockside;
  const { local: _local, ...nextId } = state.nextId;
  raw.nextId = nextId;
  state.schemaVersion = 3;
  return { ...envelope, schemaVersion: 3, state };
}

const loadingOpen = (world: World) =>
  Object.values(world.state.work.problems).some(
    (p) => p.kind === "cargoToLoad" && p.status === "open",
  );

describe("the dock alongside on real content (§dock-alongside)", { timeout: 20_000 }, () => {
  it("starts a new game with the Hub's dock alongside and its ramps down", () => {
    const { world } = newGame(20261003);
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: HUB });
    const frame = getRenderFrame(world);
    expect(frame.dock?.dockId).toBe(HUB_DOCK);
    expect(frame.actors.every((a) => !a.onDock)).toBe(true);
    const ramps = Object.values(world.state.doors).filter((d) => d.kind === "ramp");
    expect(ramps.map((d) => d.physicalState)).toEqual(["open", "open"]);
    expect(travelViolations(world)).toEqual([]);
    // §locals-table: the regulars are at their posts from tick 0, and none of them is crew.
    const locals = localsByName(world);
    const hal = locals.get("Hal Petrosyan");
    expect(hal?.postKey).toBe("queue_kiosk");
    if (hal !== undefined) expect(nearPost(world, hal, "queue_kiosk")).toBe(true);
    expect(locals.get("Anneke Vos")?.postKey).toBe("night_stall");
    expect(frame.actors.some((a) => locals.has(a.name))).toBe(false);
  });

  it("restores a schema-3 save docked mid-loading, loads, casts off and docks at the next port", () => {
    const { bundle, kernel, world } = newGame(20260930);
    drive(kernel, world, 20 * 120, loadingOpen);
    expect(loadingOpen(world)).toBe(true);

    const old = asSchema3(kernel.serialize(world), bundle);
    const inStore = Object.values(old.state.items).filter(
      (i) => i.jobId !== undefined && i.location.kind === "inExternalStore",
    );
    expect(inStore.length).toBeGreaterThan(0);
    // §save-migrations: the game refuses every save older than schema 7; the frozen 3 → 6
    // migrations are run here with that refusal passed through.
    const restored = restore(old, bundle, createFullRegistry(), {
      migrations: { ...migrations, 6: (raw: unknown) => raw },
    });
    expect(restored.state.deck.dock?.dockId).toBe(HUB_DOCK);
    // Migrated with an empty dockside; its first tick dresses the dock alongside.
    expect(restored.state.dockside.locals).toEqual({});
    // §offered-freight: the freight waiting in the warehouse store is on the staging area now, and
    // the crew know it is there.
    for (const item of inStore) {
      const location = restored.state.items[item.id]?.location;
      if (location === undefined) throw new Error(`lost ${item.id}`);
      expect(isInDockArea(bundle, restored.state, location, "freightStaging")).toBe(true);
      for (const actor of Object.values(restored.state.actors)) {
        const fact = actor.knowledge[`${item.id}/itemLocation`];
        if (fact?.factType === "itemLocation") expect(fact.value.location).toEqual(location);
      }
    }
    const events = drive(
      kernel,
      restored,
      20 * 300,
      (w) => w.state.travel.stage === "docked" && w.state.travel.portId !== HUB,
    );
    expect(loadingOpen(restored)).toBe(false);
    const stages = events
      .filter((e): e is Extract<SimEvent, { type: "travelStageChanged" }> => {
        return e.type === "travelStageChanged";
      })
      .map((e) => e.payload.to);
    expect(stages).toContain("departing");
    const travel = restored.state.travel;
    expect(travel.stage).toBe("docked");
    const here = travel.stage === "docked" ? travel.portId : undefined;
    const due = Object.values(bundle.docks ?? {}).find((d) => d.portId === here);
    expect(restored.state.deck.dock?.dockId).toBe(due?.id);
    // ~4 s alone, but near 20 s under the full suite's load on a 16-core machine.
  }, 60_000);
});

const KESSLER = "port.kessler_drift" as PortDefId;
const CRATE = "item.crate_general";

/** Where one crate was seen over the run, tick by tick. */
interface CrateLog {
  staged: boolean;
  inStoreBeforeDelivery: boolean;
  carriedOnDock: boolean;
  aboardAtUndock: boolean;
  firstInBayTick: number | undefined;
}

describe("port work is physical on real content (§offered-freight)", { timeout: 20_000 }, () => {
  it("runs Hub → Kessler freight: staged on offer, carried aboard, delivered to the bay, paid once", () => {
    const { bundle, kernel, world } = newGame(20261003);
    const send = (command: Omit<Command, "id">) => {
      n += 1;
      const result = kernel.enqueueCommand(world, {
        ...command,
        id: `cmd:d63:${n}` as CommandId,
      } as Command);
      if (result.status !== "accepted")
        throw new Error(`${command.kind}: ${JSON.stringify(result)}`);
    };
    const band = world.config.values.commerce.priceBands.general;
    send({
      source: "narrator",
      kind: "offerJob",
      payload: {
        job: {
          issuer: { name: "Hal Petrosyan", role: "queue clerk" },
          description: { key: "test.job", params: {} },
          fromPortId: HUB,
          toPortId: KESSLER,
          cargo: [{ itemDefId: CRATE as never, count: 3 }],
          pay: Math.ceil(band.min * 25 * 3),
        },
        surface: false,
      },
    });

    // §dock-hand-errands: the offer is applied on the first tick and a dock hand comes out of the
    // warehouse door with its crates; they are on the staging area once the hand has walked there.
    const events: SimEvent[] = [];
    const first = kernel.advance(world, 1);
    events.push(...first.events);
    const [job] = Object.values(world.state.jobs);
    if (job === undefined) throw new Error("no job offered");
    expect(job.status).toBe("offered");
    expect(job.cargoItemIds).toEqual([]);
    const hand = Object.values(world.state.dockside.locals).find(
      (l) => l.errand?.kind === "stageOffer" && l.errand.jobId === job.id,
    );
    expect(hand?.carrying).toHaveLength(3);
    expect(getRenderFrame(world).locals.find((l) => l.id === hand?.id)?.carrying).toBe(3);
    for (let i = 0; i < 20 * 30 && job.cargoItemIds.length === 0; i++) {
      events.push(...kernel.advance(world, 1).events);
      expect(commerceViolations(world)).toEqual([]);
    }
    expect(job.cargoItemIds).toHaveLength(3);
    expect(events.some((e) => e.type === "dockHandGaveUp")).toBe(false);
    const crates = new Map<ItemId, CrateLog>();
    for (const itemId of job.cargoItemIds) {
      const location = world.state.items[itemId]?.location;
      if (location === undefined) throw new Error(`no crate ${itemId}`);
      crates.set(itemId, {
        staged: isInDockArea(bundle, world.state, location, "freightStaging"),
        inStoreBeforeDelivery: false,
        carriedOnDock: false,
        aboardAtUndock: false,
        firstInBayTick: undefined,
      });
    }
    // Nobody's until taken: no load work, and the frame marks the crates as on offer.
    expect([...crates.values()].every((c) => c.staged)).toBe(true);
    const loadWork = () =>
      Object.values(world.state.work.problems).filter(
        (p) => p.kind === "cargoToLoad" && p.payload.jobId === job.id,
      );
    expect(loadWork()).toEqual([]);
    const frameCrates = getRenderFrame(world).items.filter((i) => i.jobId === job.id);
    expect(frameCrates).toHaveLength(3);
    expect(frameCrates.every((i) => i.offered === true && i.location.kind === "deck")).toBe(true);
    send({ source: "player", kind: "acceptContract", payload: { jobId: job.id } });
    send({ source: "player", kind: "setCourse", payload: { destinationPortId: KESSLER } });

    // Every hook on the way, every card, and what was on the dock as each one came in.
    const hooksRaised: { kind: string; tick: number }[] = [];
    const cardsQueued: number[] = [];
    let kesslerLocals: Map<string, { postKey: string; x: number; y: number }> | undefined;
    let receiverTookDelivery = false;
    let halt = first.halt;
    for (let i = 0; i < 20 * 600; i++) {
      if (halt.kind === "hook") {
        const hook = world.state.narrator.pendingHook;
        if (hook === undefined) throw new Error("hook halt without a pending hook");
        hooksRaised.push({ kind: hook.kind, tick: world.state.tick });
        send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
      } else if (halt.kind === "decision") {
        const head = world.state.decisions.queue[0];
        if (head === undefined) throw new Error("decision halt without a queued decision");
        send({
          source: "player",
          kind: "resolveDecision",
          payload: { decisionId: head, side: "left" },
        });
      }
      const result = kernel.advance(world, 1);
      events.push(...result.events);
      halt = result.halt;
      for (const e of result.events) {
        if (e.type === "decisionPending") cardsQueued.push(e.tick);
        if (e.type === "dockDressed" && e.payload.portId === KESSLER) {
          kesslerLocals = localsByName(world);
        }
        if (e.type === "cargoTransferred" && e.payload.to.kind === "inExternalStore") {
          const carrier = Object.values(world.state.dockside.locals).find(
            (l) => l.errand?.kind === "takeDelivery" && l.errand.jobId === job.id,
          );
          if (carrier?.origin.kind === "receiver") receiverTookDelivery = true;
        }
      }
      assertInvariants(world);
      const delivered = world.state.jobs[job.id]?.status === "paid";
      for (const [itemId, log] of crates) {
        const location = world.state.items[itemId]?.location;
        if (location === undefined) throw new Error(`crate ${itemId} vanished`);
        if (location.kind === "inExternalStore" && !delivered) log.inStoreBeforeDelivery = true;
        // In someone's hands, or (§hand-truck-trips) on the hand truck someone is pushing.
        const container =
          location.kind === "inContainer" ? world.state.items[location.containerId] : undefined;
        const held = container?.location ?? location;
        if (held.kind === "carriedBy") {
          const carrier = world.state.actors[held.actorId];
          if (carrier !== undefined && isOnDock(bundle, world.state, carrier.location)) {
            log.carriedOnDock = true;
          }
        }
      }
      // §hand-truck-trips: off the hand truck a crate lies in the bay before its haul completes
      // (the trip's own haul settles once the truck is parked), so the bay is read off positions
      // too.
      for (const [itemId, log] of crates) {
        const location = world.state.items[itemId]?.location;
        if (location === undefined || log.firstInBayTick !== undefined) continue;
        if (isInDockArea(bundle, world.state, location, "deliveryBay")) {
          log.firstInBayTick = world.state.tick;
        }
      }
      // The last crate is set down, paid on and carted in within one tick, so the bay is read off
      // the hauls and the port's carting rather than off the crates' end-of-tick positions.
      for (const e of result.events) {
        if (e.type === "taskCompleted" && e.payload.haul?.to === "port") {
          const log = crates.get(e.payload.haul.itemId);
          const location = world.state.items[e.payload.haul.itemId]?.location;
          const inBay =
            location !== undefined &&
            (isInDockArea(bundle, world.state, location, "deliveryBay") ||
              result.events.some(
                (t) =>
                  t.type === "cargoTransferred" &&
                  t.payload.itemId === e.payload.haul?.itemId &&
                  isInDockArea(bundle, world.state, t.payload.from, "deliveryBay"),
              ));
          if (log !== undefined && inBay && log.firstInBayTick === undefined) {
            log.firstInBayTick = e.tick;
          }
        }
      }
      const stageChange = result.events.find((e) => e.type === "travelStageChanged");
      if (stageChange?.type === "travelStageChanged" && stageChange.payload.to === "undocking") {
        for (const [itemId, log] of crates) {
          const location = world.state.items[itemId]?.location;
          log.aboardAtUndock =
            location?.kind === "onDeck" && !isOnDock(bundle, world.state, location);
        }
      }
      const stored = job.cargoItemIds.every((itemId) => {
        const location = world.state.items[itemId]?.location;
        return location?.kind === "inExternalStore" && location.portId === KESSLER;
      });
      if (delivered && stored) break;
    }

    const done = world.state.jobs[job.id];
    expect(done?.status).toBe("paid");
    for (const [itemId, log] of crates) {
      // Carried aboard by someone standing on the dock (in hand or on the truck), never
      // through a store.
      expect(log.carriedOnDock, `${itemId} carried on the dock`).toBe(true);
      expect(log.inStoreBeforeDelivery, `${itemId} never in a store before delivery`).toBe(false);
      expect(log.aboardAtUndock, `${itemId} aboard when the ship left the Hub`).toBe(true);
      expect(log.firstInBayTick, `${itemId} set down in Kessler's delivery bay`).toBeDefined();
      // ... and then carted into the warehouse store.
      expect(world.state.items[itemId]?.location).toEqual({
        kind: "inExternalStore",
        portId: KESSLER,
        storeKey: "warehouse",
      });
    }
    // Paid once, on the bay: not before the last crate was set down there.
    const payments = events.filter((e) => e.type === "paymentMade" && e.payload.jobId === job.id);
    const completions = events.filter(
      (e) => e.type === "contractCompleted" && e.payload.jobId === job.id,
    );
    expect(payments).toHaveLength(1);
    expect(completions).toHaveLength(1);
    const lastInBay = Math.max(
      ...[...crates.values()].map((c) => c.firstInBayTick ?? Number.POSITIVE_INFINITY),
    );
    expect(payments[0]?.tick).toBeGreaterThanOrEqual(lastInBay);
    const pay = Object.values(world.state.money.transactions).filter(
      (t) => t.reason === "jobPayment" && t.jobId === job.id,
    );
    expect(pay.map((t) => t.amount)).toEqual([done?.pay]);

    // The staging call came before Kessler's dock did, and no card on the way in.
    const kesslerArrival = events.find(
      (e) => e.type === "arrived" && e.payload.portId === KESSLER,
    )?.tick;
    if (kesslerArrival === undefined) throw new Error("never arrived at Kessler");
    const staging = hooksRaised.find((h) => h.kind === "stageDock");
    expect(staging).toBeDefined();
    expect(staging?.tick).toBeLessThan(kesslerArrival);
    expect(cardsQueued.filter((t) => t >= (staging?.tick ?? 0) && t <= kesslerArrival)).toEqual([]);
    // Kessler's dock came alongside with its regulars at their posts and the job's receiver,
    // who carted the delivery in.
    expect(kesslerLocals?.get("Greta Lindholm")?.postKey).toBe("shift_board");
    expect(kesslerLocals?.get("Osric Tan")?.postKey).toBe("assay_window");
    expect(receiverTookDelivery).toBe(true);
    expect(events.some((e) => e.type === "dockHandGaveUp")).toBe(false);

    // Back to the Hub: staged again on the way in, no card, Hal at the queue kiosk on arrival.
    send({ source: "player", kind: "setCourse", payload: { destinationPortId: HUB } });
    const home: SimEvent[] = [];
    const homeHooks: { kind: string; tick: number }[] = [];
    let atHub: Map<string, { postKey: string; x: number; y: number }> | undefined;
    for (let i = 0; i < 20 * 300 && atHub === undefined; i++) {
      const hook = world.state.narrator.pendingHook;
      if (hook !== undefined) {
        homeHooks.push({ kind: hook.kind, tick: world.state.tick });
        send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
      }
      const result = kernel.advance(world, 1);
      home.push(...result.events);
      if (result.halt.kind === "decision") throw new Error("a card came up on the way home");
      if (result.events.some((e) => e.type === "arrived" && e.payload.portId === HUB)) {
        atHub = localsByName(world);
      }
    }
    expect(homeHooks.map((h) => h.kind)).toContain("stageDock");
    expect(home.some((e) => e.type === "decisionPending")).toBe(false);
    const hal = atHub?.get("Hal Petrosyan");
    expect(hal?.postKey).toBe("queue_kiosk");
    if (hal !== undefined) expect(nearPost(world, hal, "queue_kiosk")).toBe(true);
    expect(travelViolations(world)).toEqual([]);
  });
});

describe("the captain ashore on real content (§looking-for-work)", { timeout: 30_000 }, () => {
  it("runs Hub → Kessler with the offer made in person on the dock: loaded, delivered, paid once", () => {
    const { bundle, kernel, world } = newGame(20261003);
    const send = (command: Omit<Command, "id">) => {
      n += 1;
      const result = kernel.enqueueCommand(world, {
        ...command,
        id: `cmd:d70:${n}` as CommandId,
      } as Command);
      if (result.status !== "accepted")
        throw new Error(`${command.kind}: ${JSON.stringify(result)}`);
    };
    const captain = captainOf(world);
    const band = world.config.values.commerce.priceBands.general;
    const events: SimEvent[] = [];
    const asks: { portId: string; tick: number; captainOnDock: boolean }[] = [];
    const cards: { tick: number; docked: boolean; captainOnDock: boolean }[] = [];
    let jobId: string | undefined;
    for (let i = 0; i < 20 * 900; i++) {
      const result = kernel.advance(world, 1);
      events.push(...result.events);
      assertInvariants(world);
      const where = world.state.actors[captain.id]?.location;
      const onDock = where !== undefined && isOnDock(bundle, world.state, where);
      for (const e of result.events) {
        if (e.type === "decisionPending") {
          cards.push({
            tick: e.tick,
            docked: world.state.travel.stage === "docked",
            captainOnDock: onDock,
          });
        }
      }
      if (result.halt.kind === "hook") {
        const hook = world.state.narrator.pendingHook;
        if (hook === undefined) throw new Error("hook halt without a pending hook");
        if (hook.kind === "captainAshore") {
          asks.push({ portId: hook.context.portId, tick: hook.tick, captainOnDock: onDock });
          // Hal Petrosyan, at his kiosk on the dock, has work for the Drift.
          if (hook.context.portId === HUB && jobId === undefined) {
            send({
              source: "narrator",
              kind: "offerJob",
              payload: {
                job: {
                  issuer: { name: "Hal Petrosyan", role: "queue clerk" },
                  description: { key: "test.job", params: {} },
                  fromPortId: HUB,
                  toPortId: KESSLER,
                  cargo: [{ itemDefId: CRATE as never, count: 3 }],
                  pay: Math.ceil(band.min * 25 * 3),
                },
                surface: true,
              },
            });
          }
        }
        send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
      } else if (result.halt.kind === "decision") {
        const head = world.state.decisions.queue[0];
        if (head === undefined) throw new Error("decision halt without a queued decision");
        jobId ??= world.state.decisions.records[head]?.jobId;
        send({
          source: "player",
          kind: "resolveDecision",
          payload: { decisionId: head, side: "left" },
        });
      }
      if (jobId !== undefined && world.state.jobs[jobId as never]?.status === "paid") break;
    }
    // Asked once at the Hub, as the captain stepped onto the dock, and offered work there.
    const hubAsks = asks.filter((a) => a.portId === HUB);
    expect(hubAsks).toHaveLength(1);
    expect(hubAsks[0]?.captainOnDock).toBe(true);
    // The card came up on the dock, after the captain had walked over and talked with Hal.
    const talk = events.find((e) => e.type === "talkingWith");
    expect(talk?.type === "talkingWith" ? talk.payload.withName : undefined).toBe("Hal Petrosyan");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0]?.captainOnDock).toBe(true);
    expect(cards[0]?.tick ?? 0).toBeGreaterThan(talk?.tick ?? Number.POSITIVE_INFINITY);
    // Nothing arrives in flight.
    expect(cards.every((c) => c.docked)).toBe(true);
    // Taken, loaded, delivered, paid once.
    if (jobId === undefined) throw new Error("the offer was never carded");
    expect(world.state.jobs[jobId as never]?.status).toBe("paid");
    const paid = events.filter((e) => e.type === "contractCompleted");
    expect(paid).toHaveLength(1);
    expect(world.state.decisions.held).toEqual([]);
  });
});
