/**
 * Bundle loader (W10). Imports every authored JSON def under `data/**`, strips the editor-only
 * `$schema` key, assembles a `ContentBundle`-shaped object keyed by definition ID, computes a
 * stable hash for cache-busting (not determinism, D4/D13), and runs full validation.
 *
 * `packages/content/src` may only import `@crew/sim` as types (dependency-cruiser
 * `content-sim-types-only`), so this module never imports the kernel at runtime.
 */
import { type ValidationResult, validateBundle } from "./schemas/validate";

// Decks
import deckFreighterMk1 from "../data/decks/freighter-mk1.json";

import machineBatteryBank from "../data/machines/battery-bank.json";
import machineBridgeConsole from "../data/machines/bridge-console.json";
import machineBunk from "../data/machines/bunk.json";
import machineCargoCrane from "../data/machines/cargo-crane.json";
import machineCoolantPump from "../data/machines/coolant-pump.json";
// Machines
import machineEngine from "../data/machines/engine.json";
import machineGalleyStove from "../data/machines/galley-stove.json";
import machineGenerator from "../data/machines/generator.json";
import machineLifeSupport from "../data/machines/life-support.json";
import machineMedbayBed from "../data/machines/medbay-bed.json";

import itemCoolantCanister from "../data/items/coolant-canister.json";
import itemCrateFragile from "../data/items/crate-fragile.json";
import itemCrateGeneral from "../data/items/crate-general.json";
import itemCrateHazardous from "../data/items/crate-hazardous.json";
import itemCratePerishable from "../data/items/crate-perishable.json";
import itemHandTruck from "../data/items/hand-truck.json";
import itemHarmonica from "../data/items/harmonica.json";
import itemMedKit from "../data/items/med-kit.json";
import itemOldPhotograph from "../data/items/old-photograph.json";
import itemRationPack from "../data/items/ration-pack.json";
import itemSparePartsStack from "../data/items/spare-parts-stack.json";
// Items
import itemToolkit from "../data/items/toolkit.json";
import itemWelderTorch from "../data/items/welder-torch.json";

import crewBettinaSolheim from "../data/crew/bettina-solheim.json";
import crewDaneWhitcross from "../data/crew/dane-whitcross.json";
import crewJaxOkonkwo from "../data/crew/jax-okonkwo.json";
// Crew
import crewMaraOsei from "../data/crew/mara-osei.json";
import crewOyelaranAbiodun from "../data/crew/oyelaran-abiodun.json";
import crewPriyaKessler from "../data/crew/priya-kessler.json";
import crewSunnivaPark from "../data/crew/sunniva-park.json";
import crewTomasRuiz from "../data/crew/tomas-ruiz.json";

import traitBriskWalker from "../data/traits/brisk-walker.json";
import traitEarlyRiser from "../data/traits/early-riser.json";
import traitHeartyAppetite from "../data/traits/hearty-appetite.json";
import traitLightEater from "../data/traits/light-eater.json";
import traitLoner from "../data/traits/loner.json";
import traitMethodical from "../data/traits/methodical.json";
import traitNightOwl from "../data/traits/night-owl.json";
import traitRestless from "../data/traits/restless.json";
import traitSocialButterfly from "../data/traits/social-butterfly.json";
// Traits
import traitSteady from "../data/traits/steady.json";

// Ports
import portCrossroadsHub from "../data/ports/crossroads-hub.json";
import portGreenMeridian from "../data/ports/green-meridian.json";
import portKesslerDrift from "../data/ports/kessler-drift.json";

// Scenarios
import scenarioDefault from "../data/scenarios/default.json";

// People (D25)
import peopleNameTable from "../data/people/name-table.json";

// Config
import configDefault from "../data/config/default.json";

const DECKS = [deckFreighterMk1];
const MACHINES = [
  machineEngine,
  machineCoolantPump,
  machineGenerator,
  machineBatteryBank,
  machineLifeSupport,
  machineGalleyStove,
  machineBunk,
  machineMedbayBed,
  machineCargoCrane,
  machineBridgeConsole,
];
const ITEMS = [
  itemToolkit,
  itemWelderTorch,
  itemHandTruck,
  itemSparePartsStack,
  itemCoolantCanister,
  itemRationPack,
  itemMedKit,
  itemCrateGeneral,
  itemCrateFragile,
  itemCratePerishable,
  itemCrateHazardous,
  itemHarmonica,
  itemOldPhotograph,
];
const CREW = [
  crewMaraOsei,
  crewDaneWhitcross,
  crewPriyaKessler,
  crewTomasRuiz,
  crewJaxOkonkwo,
  crewBettinaSolheim,
  crewOyelaranAbiodun,
  crewSunnivaPark,
];
const TRAITS = [
  traitSteady,
  traitRestless,
  traitNightOwl,
  traitEarlyRiser,
  traitHeartyAppetite,
  traitLightEater,
  traitSocialButterfly,
  traitLoner,
  traitBriskWalker,
  traitMethodical,
];
const PORTS = [portCrossroadsHub, portKesslerDrift, portGreenMeridian];
const SCENARIOS = [scenarioDefault];

/** Strips the editor-only `$schema` key that authored JSON carries but the Zod schemas reject. */
function stripSchemaKey(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const { $schema: _drop, ...rest } = value as Record<string, unknown>;
  return rest;
}

function keyById<T extends { id: string }>(defs: readonly unknown[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const raw of defs) {
    const def = stripSchemaKey(raw) as T;
    out[def.id] = def;
  }
  return out;
}

/**
 * Canonical JSON: object keys sorted recursively, so the hash is stable regardless of authoring
 * or import order. Not used for determinism (D4) — only cache-busting saves/build artifacts.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      out[key] = canonicalize(val);
    }
    return out;
  }
  return value;
}

/**
 * FNV-1a over the canonical JSON, in pure JS so it works identically in Node (CLI/server) and the
 * browser (this package is imported by `apps/web`). Not cryptographic: this is a cache-busting
 * fingerprint (D4/D13), not a determinism guarantee.
 */
function hashOf(value: unknown): string {
  const json = JSON.stringify(canonicalize(value));
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193 ^ json.length;
  for (let i = 0; i < json.length; i += 1) {
    const c = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  h1 >>>= 0;
  h2 >>>= 0;
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Assembles the raw (unvalidated) bundle shape from every imported JSON def. */
export function rawBundle(): Record<string, unknown> {
  const withoutHash = {
    decks: keyById(DECKS),
    machines: keyById(MACHINES),
    items: keyById(ITEMS),
    crew: keyById(CREW),
    traits: keyById(TRAITS),
    ports: keyById(PORTS),
    scenarios: keyById(SCENARIOS),
    people: stripSchemaKey(peopleNameTable),
    config: stripSchemaKey(configDefault),
  };
  return { ...withoutHash, hash: hashOf(withoutHash) };
}

/** Loads, validates (L1-L3) and returns the content bundle. Throws on any `NotImplementedError`. */
export function loadBundle(): ValidationResult {
  return validateBundle(rawBundle());
}
