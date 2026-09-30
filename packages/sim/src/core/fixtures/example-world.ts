/**
 * A small hand-built `WorldState` exercising most contract shapes. Used by the W0 JSON
 * round-trip test and available to W2+ as a starting fixture. Not a playable scenario: IDs refer
 * to content that does not exist in any bundle.
 */
import type {
  ActorId,
  ClaimId,
  CommandId,
  CompartmentId,
  CrewDefId,
  DecisionId,
  DeckDefId,
  DoorId,
  HookId,
  ItemDefId,
  ItemId,
  JobId,
  MachineDefId,
  MachineId,
  PortDefId,
  ProblemId,
  ScenarioDefId,
  TaskId,
  TraitDefId,
  TransactionId,
} from "../types/ids";
import { SCHEMA_VERSION, type WorldState } from "../types/state";

const deck = "deck.freighter.main" as DeckDefId;
const port = "port.kessel_yard" as PortDefId;
const port2 = "port.dantooine_ring" as PortDefId;
const a1 = "a1" as ActorId;
const a2 = "a2" as ActorId;
const m1 = "m1" as MachineId;
const d1 = "d1" as DoorId;
const c1 = "c1" as CompartmentId;
const i1 = "i1" as ItemId;
const i2 = "i2" as ItemId;
const i3 = "i3" as ItemId;
const p1 = "p1" as ProblemId;
const t1 = "t1" as TaskId;
const l1 = "l1" as ClaimId;
const j1 = "j1" as JobId;
const x1 = "x1" as DecisionId;
const k1 = "k1" as HookId;
const n1 = "n1" as TransactionId;

export function exampleWorldState(): WorldState {
  return {
    schemaVersion: SCHEMA_VERSION,
    scenarioId: "scenario.default" as ScenarioDefId,
    seed: 12345,
    tick: 400,
    rng: {
      setup: [1, 2, 3, 4],
      failures: [5, 6, 7, 8],
      perception: [9, 10, 11, 12],
      social: [13, 14, 15, 16],
      commerce: [17, 18, 19, 20],
      narrator: [21, 22, 23, 24],
    },
    nextId: {
      actor: 3,
      machine: 2,
      item: 4,
      door: 2,
      compartment: 2,
      task: 2,
      problem: 2,
      job: 2,
      decision: 2,
      hook: 2,
      claim: 2,
      transaction: 2,
      event: 57,
    },
    actors: {
      [a1]: {
        id: a1,
        defId: "crew.mara_voss" as CrewDefId,
        name: "Mara Voss",
        roleTags: ["captain"],
        location: { kind: "onDeck", deckId: deck, x: 4.5, y: 2.25 },
        movement: {
          kind: "moving",
          path: [
            { x: 4, y: 2 },
            { x: 5, y: 2 },
          ],
          segmentIndex: 0,
          segmentDistanceTravelled: 0.25,
          effectiveSpeed: 2,
          navigationKnowledgeRevision: 1,
          doorId: d1,
        },
        facing: 0,
        needs: { hunger: 0.2, fatigue: 0.1, comfort: 0, social: 0.3 },
        capacities: { movement: 1, manipulation: 1, consciousness: 1 },
        skills: { piloting: 6, cargo: 2 },
        traits: ["trait.steady" as TraitDefId],
        mood: 0.1,
        schedule: { shiftKey: "alpha" },
        activity: {
          kind: "task",
          taskId: t1,
          claimId: l1,
          urgency: "routineObligation",
          action: {
            kind: "walk",
            stage: "moving",
            progress: 0,
            startedTick: 390,
            interruptible: true,
          },
          sinceTick: 390,
        },
        lastPlannedTick: 390,
        knowledge: {
          "m1/machineStatus": {
            subjectId: m1,
            factType: "machineStatus",
            value: { status: "degraded", temperatureNorm: 0.6 },
            observedTick: 380,
            learnedTick: 380,
            sourceId: a1,
            evidence: "direct",
            certainty: "confirmed",
          },
          "p1/problem": {
            subjectId: p1,
            factType: "problem",
            value: { problemId: p1, revision: 1 },
            observedTick: 385,
            learnedTick: 386,
            sourceId: a2,
            evidence: "report",
            certainty: "reported",
          },
        },
        navigationKnowledgeRevision: 1,
        availability: "available",
        crew: true,
      },
      [a2]: {
        id: a2,
        defId: "crew.jonno_pell" as CrewDefId,
        name: "Jonno Pell",
        roleTags: ["engineer", "firstOfficer"],
        location: { kind: "onDeck", deckId: deck, x: 8.5, y: 3.5 },
        movement: { kind: "stationary" },
        facing: 3,
        needs: { hunger: 0.6, fatigue: 0.7, comfort: 0.2, social: 0.1 },
        capacities: { movement: 1, manipulation: 1, consciousness: 1 },
        skills: { engineering: 7, electrical: 4 },
        traits: [],
        mood: -0.2,
        schedule: { shiftKey: "beta" },
        activity: {
          kind: "personal",
          activity: "sleep",
          urgency: "essentialOperation",
          action: {
            kind: "sleep",
            stage: "asleep",
            progress: 0.4,
            startedTick: 200,
            interruptible: true,
          },
          sinceTick: 200,
        },
        lastPlannedTick: 380,
        knowledge: {},
        navigationKnowledgeRevision: 0,
        availability: "available",
        crew: true,
      },
    },
    compartments: { [c1]: { id: c1, deckId: deck, key: "engineering" } },
    deck: {
      tiles: { [deck]: { "6,3": { obstructed: true, floorIntegrity: 1 } } },
      geometryRevision: 2,
    },
    doors: {
      [d1]: {
        id: d1,
        deckId: deck,
        placementKey: "engDoor",
        kind: "interior",
        physicalState: "opening",
        requestedState: "open",
        transitionProgress: 0.5,
        integrity: 1,
        sealQuality: 1,
        actuatorFault: false,
        manualOperationSupported: true,
        occupants: [],
        closeAfterTick: 460,
      },
    },
    machines: {
      [m1]: {
        id: m1,
        defId: "machine.coolant_pump.mk1" as MachineDefId,
        deckId: deck,
        placementKey: "pump1",
        integrity: 0.9,
        condition: 0.5,
        desiredMode: "on",
        actualMode: "on",
        output: 0.5,
        powerAllocatedKw: 3,
        temperature: 0.6,
        faults: [
          {
            faultKey: "wornBearing",
            sinceTick: 300,
            diagnosed: true,
            repairStepIndex: 1,
            repairStepProgress: 0.3,
          },
        ],
        scheduledFaults: [
          {
            faultKey: "coolantLeak",
            fireAtTick: 900,
            causeCommandId: "cmd:narrator:c1:0" as CommandId,
          },
        ],
        failure: { accumulatedHazard: 0.12, threshold: 0.8 },
        lastMaintainedTick: 0,
        maintenanceProgress: 0,
        roleState: { role: "none" },
      },
    },
    power: {
      domains: {
        main: { key: "main", supplyKw: 20, demandKw: 12, batteryFlowKw: 0, tripped: false },
      },
    },
    items: {
      [i1]: {
        id: i1,
        defId: "item.wrench" as ItemDefId,
        stacking: "unique",
        location: { kind: "carriedBy", actorId: a1 },
        condition: 1,
      },
      [i2]: {
        id: i2,
        defId: "item.ration_pack" as ItemDefId,
        stacking: "stack",
        location: { kind: "onDeck", deckId: deck, x: 2.5, y: 5.5 },
        count: 12,
        reserved: 1,
      },
      [i3]: {
        id: i3,
        defId: "item.crate_machine_parts" as ItemDefId,
        stacking: "unique",
        location: { kind: "inExternalStore", portId: port, storeKey: "warehouse" },
        condition: 1,
        jobId: j1,
      },
    },
    work: {
      problems: {
        [p1]: {
          id: p1,
          kind: "machineFault",
          payload: { machineId: m1, faultKey: "wornBearing" },
          owner: "equipment",
          visibility: "discovered",
          dedupeKey: "machineFault:m1:wornBearing",
          status: "open",
          createdTick: 385,
          revision: 1,
          baseUrgency: "routineObligation",
          location: { kind: "machine", machineId: m1 },
        },
      },
      tasks: {
        [t1]: {
          id: t1,
          problemId: p1,
          derivationKey: "repair",
          type: "repair",
          target: { kind: "machine", machineId: m1 },
          createdTick: 386,
          revision: 1,
          status: "claimed",
          baseUrgency: "routineObligation",
          requiredSkills: [{ skill: "engineering", min: 2 }],
          requiredTools: ["wrench"],
          consumables: [],
          workerSlots: 1,
          interactionTiles: [{ x: 7, y: 3 }],
          dependencyIds: [],
          progressRef: { kind: "fault", machineId: m1, faultKey: "wornBearing" },
          claimState: { kind: "claimed", claimIds: [l1] },
          completion: { kind: "problemResolved" },
          estimatedWorkSeconds: 12,
        },
      },
      claims: {
        [l1]: {
          id: l1,
          taskId: t1,
          ownerActorId: a1,
          claimedTick: 390,
          expiresAtTick: 470,
          tile: { x: 7, y: 3 },
        },
      },
      plannerRotation: 1,
    },
    travel: { stage: "docked", portId: port, plannedDestinationId: port2 },
    jobs: {
      [j1]: {
        id: j1,
        origin: "portBoard",
        issuer: "Kessel Freight Cooperative",
        description: {
          key: "job.freight.generic",
          params: { count: 1, destination: "Dantooine Ring" },
        },
        fromPortId: port,
        toPortId: port2,
        cargo: [{ itemDefId: "item.crate_machine_parts" as ItemDefId, count: 1 }],
        cargoClass: "general",
        pay: 450,
        status: "accepted",
        offeredTick: 100,
        expiresAtTick: 5000,
        cargoItemIds: [i3],
      },
    },
    money: {
      balance: 1200,
      transactions: { [n1]: { id: n1, tick: 0, amount: 1200, reason: "scenario" } },
    },
    decisions: {
      records: {
        [x1]: {
          id: x1,
          origin: "narrator",
          perspectiveActorId: a1,
          prompt: {
            key: "decision.narrator.generic",
            params: {},
            prose: "A courier waits at the ramp.",
          },
          left: {
            label: { key: "decision.accept", params: {} },
            commands: [{ kind: "acceptContract", payload: { jobId: j1 } }],
          },
          right: { label: { key: "decision.decline", params: {} }, commands: [] },
          status: "pending",
          createdTick: 399,
          jobId: j1,
        },
      },
      queue: [x1],
    },
    narrator: {
      pendingHook: { id: k1, kind: "jobBoard", context: { portId: port }, tick: 400 },
      lastNarrativeTick: 250,
      budget: { spawnsRemaining: 3, faultsRemaining: 1 },
      recentHookIds: [],
    },
    commands: {
      queue: [
        {
          id: "cmd:player:1" as CommandId,
          source: "player",
          kind: "setCourse",
          payload: { destinationPortId: port2 },
          applyAtTick: 401,
          seq: 7,
        },
      ],
      recentIds: ["cmd:system:6" as CommandId],
      nextSeq: 8,
    },
    defs: { dynamic: { items: {}, crew: {} } },
  };
}
